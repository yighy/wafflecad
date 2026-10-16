// Draggable arrow tip for an extrusion: pull it along the sketch normal to set the distance.
import * as THREE from "three";
import type { SketchFeature } from "../types";
import { findRegions, sampleSegments, signedArea } from "../sketch/profiles";
import { SketchView } from "../sketch/model";
import { V, gridStep, type Viewport } from "../view/viewport";

type P2 = [number, number];

export class ExtrudeHandle {
  private svg: SVGSVGElement;
  private line: SVGLineElement;
  private dot: SVGCircleElement;
  private knob: HTMLDivElement;
  private base: THREE.Vector3;
  private normal: THREE.Vector3;
  private off: () => void;

  constructor(
    private vp: Viewport,
    sk: SketchFeature,
    private getDistance: () => number,
    onDrag: (d: number) => void,
  ) {
    const [cx, cy] = profileCentroid(sk);
    const xd = V(sk.plane.xDir);
    const yd = V(sk.plane.normal).cross(xd);
    this.normal = V(sk.plane.normal).normalize();
    this.base = V(sk.plane.origin).addScaledVector(xd, cx).addScaledVector(yd, cy);

    const ns = "http://www.w3.org/2000/svg";
    this.svg = document.createElementNS(ns, "svg");
    this.svg.classList.add("handle-layer");
    this.line = document.createElementNS(ns, "line");
    this.dot = document.createElementNS(ns, "circle");
    this.dot.setAttribute("r", "4");
    this.svg.append(this.line, this.dot);
    this.knob = document.createElement("div");
    this.knob.className = "drag-handle";
    this.knob.title = "Drag to change the distance";
    vp.container.append(this.svg, this.knob);

    let drag: { x: number; y: number; d0: number; dir: [number, number]; len2: number } | null = null;
    this.knob.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      try {
        this.knob.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer: no capture needed.
      }
      const [x0, y0] = vp.toScreen(this.base);
      const [x1, y1] = vp.toScreen(this.base.clone().add(this.normal));
      const dir: [number, number] = [x1 - x0, y1 - y0];
      drag = { x: e.clientX, y: e.clientY, d0: this.getDistance(), dir, len2: dir[0] ** 2 + dir[1] ** 2 };
    });
    this.knob.addEventListener("pointermove", (e) => {
      e.stopPropagation();
      if (!drag) return;
      // Seen end-on, the normal has no screen length: dragging would be meaningless.
      if (drag.len2 < 0.05) return;
      const mm = ((e.clientX - drag.x) * drag.dir[0] + (e.clientY - drag.y) * drag.dir[1]) / drag.len2;
      const step = Math.max(gridStep(vp.viewHeight) / 10, 0.1);
      let d = Math.round((drag.d0 + mm) / step) * step;
      if (Math.abs(d) < step) d = Math.sign(drag.d0 + mm || 1) * step;
      onDrag(d);
    });
    const end = (e: PointerEvent) => {
      e.stopPropagation();
      drag = null;
    };
    this.knob.addEventListener("pointerup", end);
    this.knob.addEventListener("pointercancel", end);

    this.off = vp.onCamera(() => this.update());
    this.update();
  }

  update() {
    const tip = this.base.clone().addScaledVector(this.normal, this.getDistance());
    const [bx, by] = this.vp.toScreen(this.base);
    const [tx, ty] = this.vp.toScreen(tip);
    this.line.setAttribute("x1", String(bx));
    this.line.setAttribute("y1", String(by));
    this.line.setAttribute("x2", String(tx));
    this.line.setAttribute("y2", String(ty));
    this.dot.setAttribute("cx", String(bx));
    this.dot.setAttribute("cy", String(by));
    this.knob.style.transform = `translate(${tx}px, ${ty}px)`;
  }

  dispose() {
    this.off();
    this.svg.remove();
    this.knob.remove();
  }
}

/** Area-weighted centre of the sketch's filled regions (or of its points). */
function profileCentroid(sk: SketchFeature): P2 {
  let ax = 0;
  let ay = 0;
  let total = 0;
  for (const r of findRegions(sk)) {
    const poly: P2[] =
      r.outer.kind === "circle"
        ? [[r.outer.c[0] + r.outer.r, r.outer.c[1]], [r.outer.c[0], r.outer.c[1] + r.outer.r], [r.outer.c[0] - r.outer.r, r.outer.c[1]], [r.outer.c[0], r.outer.c[1] - r.outer.r]]
        : sampleSegments(r.outer.segments);
    const a = Math.abs(signedArea(poly));
    const c = poly.reduce((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
    ax += c[0] * a;
    ay += c[1] * a;
    total += a;
  }
  if (total > 1e-9) return [ax / total, ay / total];
  const pts = new SketchView(sk).points();
  if (!pts.length) return [0, 0];
  return [pts.reduce((s, p) => s + p.x, 0) / pts.length, pts.reduce((s, p) => s + p.y, 0) / pts.length];
}
