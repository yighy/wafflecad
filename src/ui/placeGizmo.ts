// Handles to place a part of an assembly: an arrow along each axis to slide it, and a ring around
// each axis to turn it about its centre. Big knobs for the finger; exact values go on the keypad.
import * as THREE from "three";
import { gridStep, type Viewport } from "../view/viewport";

const AXES = [
  { name: "X", dir: new THREE.Vector3(1, 0, 0), color: "#e03131" },
  { name: "Y", dir: new THREE.Vector3(0, 1, 0), color: "#2f9e44" },
  { name: "Z", dir: new THREE.Vector3(0, 0, 1), color: "#4c6ef5" },
];
/** Arrow length and ring radius, in screen pixels. */
const ARROW_PX = 130;
const RING_PX = 72;
/** Turns snap to this many degrees. */
const TURN_STEP = 15;

export class PlaceGizmo {
  private svg: SVGSVGElement;
  private lines: SVGLineElement[] = [];
  private rings: SVGPolylineElement[] = [];
  private moveKnobs: HTMLDivElement[] = [];
  private turnKnobs: HTMLDivElement[] = [];
  private label: HTMLDivElement;
  private off: () => void;
  /** The move made by the drag under way (from where the part was built). */
  private delta = new THREE.Matrix4();
  /** The angle shown by each ring's knob (degrees, during a turn). */
  private turned = [0, 0, 0];

  constructor(
    private vp: Viewport,
    private center: THREE.Vector3,
    onMove: (m: THREE.Matrix4) => void,
    onDone: (m: THREE.Matrix4) => void,
  ) {
    const ns = "http://www.w3.org/2000/svg";
    this.svg = document.createElementNS(ns, "svg");
    this.svg.classList.add("handle-layer", "place-layer");
    this.label = document.createElement("div");
    this.label.className = "gizmo-label";
    this.label.hidden = true;
    vp.container.append(this.svg);
    AXES.forEach((a, i) => {
      const ring = document.createElementNS(ns, "polyline");
      ring.style.stroke = a.color;
      this.rings.push(ring);
      const line = document.createElementNS(ns, "line");
      line.style.stroke = a.color;
      this.lines.push(line);
      this.svg.append(ring, line);
      const move = this.knob(`Slide along ${a.name}`, a.color, "move");
      const turn = this.knob(`Turn about ${a.name}`, a.color, "turn");
      this.moveKnobs.push(move);
      this.turnKnobs.push(turn);
      this.drag(move, (start) => {
        // Pixels per millimetre along the axis, on screen.
        const [x0, y0] = vp.toScreen(this.center);
        const [x1, y1] = vp.toScreen(this.center.clone().add(a.dir));
        const dir = [x1 - x0, y1 - y0];
        const len2 = dir[0] ** 2 + dir[1] ** 2;
        const step = Math.max(gridStep(vp.viewHeight) / 10, 0.1);
        return (x, y) => {
          // Seen end-on, the axis has no length on screen: sliding along it means nothing.
          if (len2 < 0.05) return null;
          const mm = Math.round(((x - start[0]) * dir[0] + (y - start[1]) * dir[1]) / len2 / step) * step;
          this.showLabel(`${a.name} ${mm >= 0 ? "+" : "−"}${fmt(Math.abs(mm))} mm`, x, y);
          return new THREE.Matrix4().makeTranslation(a.dir.clone().multiplyScalar(mm));
        };
      }, onMove, onDone);
      this.drag(turn, (start) => {
        const [cx, cy] = vp.toScreen(this.center);
        const [u, v] = ringBasis(a.dir);
        // Which way a positive turn goes on screen (the ring may be seen from either side).
        const su = vp.toScreen(this.center.clone().add(u));
        const sv = vp.toScreen(this.center.clone().add(v));
        const cross = (su[0] - cx) * (sv[1] - cy) - (su[1] - cy) * (sv[0] - cx);
        const sign = Math.sign(cross);
        const a0 = Math.atan2(start[1] - cy, start[0] - cx);
        let last = a0;
        let total = 0;
        return (x, y) => {
          if (Math.abs(cross) < 1e-6) return null; // ring seen edge-on
          const ang = Math.atan2(y - cy, x - cx);
          let d = ang - last;
          if (d > Math.PI) d -= 2 * Math.PI;
          if (d < -Math.PI) d += 2 * Math.PI;
          total += d;
          last = ang;
          const deg = Math.round((THREE.MathUtils.radToDeg(total) * sign) / TURN_STEP) * TURN_STEP;
          this.turned[i] = deg;
          this.showLabel(`Turn ${a.name} ${deg >= 0 ? "+" : "−"}${fmt(Math.abs(deg))}°`, x, y);
          const c = this.center;
          return new THREE.Matrix4()
            .makeTranslation(c.x, c.y, c.z)
            .multiply(new THREE.Matrix4().makeRotationAxis(a.dir, THREE.MathUtils.degToRad(deg)))
            .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
        };
      }, onMove, onDone);
    });
    vp.container.append(this.label);
    this.off = vp.onCamera(() => this.update());
    this.update();
  }

  private knob(title: string, color: string, kind: "move" | "turn") {
    const k = document.createElement("div");
    k.className = `gizmo-knob ${kind}`;
    k.style.color = color;
    k.title = title;
    k.setAttribute("aria-label", title);
    this.vp.container.append(k);
    return k;
  }

  /**
   * A knob dragged: `begin` gets where the drag starts and returns the move for each pointer
   * position (null: no move). The part follows live; it is placed when the knob is let go.
   */
  private drag(
    el: HTMLElement,
    begin: (start: [number, number]) => (x: number, y: number) => THREE.Matrix4 | null,
    onMove: (m: THREE.Matrix4) => void,
    onDone: (m: THREE.Matrix4) => void,
  ) {
    let follow: ((x: number, y: number) => THREE.Matrix4 | null) | null = null;
    let origin: DOMRect | null = null;
    const at = (e: PointerEvent): [number, number] => [e.clientX - origin!.left, e.clientY - origin!.top];
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer: no capture needed.
      }
      origin = this.vp.container.getBoundingClientRect();
      follow = begin(at(e));
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      e.stopPropagation();
      if (!follow) return;
      const m = follow(...at(e));
      if (!m) return;
      this.delta = m;
      onMove(m);
      this.update();
    });
    const end = (e: PointerEvent) => {
      e.stopPropagation();
      if (!follow) return;
      follow = null;
      el.classList.remove("dragging");
      this.label.hidden = true;
      const m = this.delta;
      this.delta = new THREE.Matrix4();
      this.turned = [0, 0, 0];
      // The handles stay where the part went, until the build places it.
      this.center.applyMatrix4(m);
      this.update();
      if (!isIdentity(m)) onDone(m);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  private showLabel(text: string, x: number, y: number) {
    this.label.hidden = false;
    this.label.textContent = text;
    this.label.style.transform = `translate(${x}px, ${y - 56}px)`;
  }

  update() {
    const c = this.center.clone().applyMatrix4(this.delta);
    const [cx, cy] = this.vp.toScreen(c);
    const wpp = this.vp.wpp;
    AXES.forEach((a, i) => {
      const [tx, ty] = this.vp.toScreen(c.clone().addScaledVector(a.dir, ARROW_PX * wpp));
      const line = this.lines[i];
      line.setAttribute("x1", String(cx));
      line.setAttribute("y1", String(cy));
      line.setAttribute("x2", String(tx));
      line.setAttribute("y2", String(ty));
      this.moveKnobs[i].style.transform = `translate(${tx}px, ${ty}px)`;
      const [u, v] = ringBasis(a.dir);
      const r = RING_PX * wpp;
      const pts: string[] = [];
      for (let k = 0; k <= 64; k++) {
        const t = (k / 64) * Math.PI * 2;
        const p = this.vp.toScreen(c.clone().addScaledVector(u, r * Math.cos(t)).addScaledVector(v, r * Math.sin(t)));
        pts.push(`${p[0]},${p[1]}`);
      }
      this.rings[i].setAttribute("points", pts.join(" "));
      // The turn knob sits on its ring between the two other axes, and goes round with the turn.
      const t = THREE.MathUtils.degToRad(45 + this.turned[i]);
      const [kx, ky] = this.vp.toScreen(c.clone().addScaledVector(u, r * Math.cos(t)).addScaledVector(v, r * Math.sin(t)));
      this.turnKnobs[i].style.transform = `translate(${kx}px, ${ky}px)`;
    });
  }

  dispose() {
    this.off();
    this.svg.remove();
    this.label.remove();
    for (const k of [...this.moveKnobs, ...this.turnKnobs]) k.remove();
  }
}

/** Two directions across an axis, in turning order (u to v is a positive turn about it). */
function ringBasis(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  if (axis.x) return [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  if (axis.y) return [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)];
  return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
}

function isIdentity(m: THREE.Matrix4) {
  return m.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
