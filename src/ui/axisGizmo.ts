// Axis gizmo: X/Y/Z bubbles that follow the camera. Tap a bubble to look along that axis,
// tap the house for the isometric view, drag the gizmo with one finger to rotate the view.
import * as THREE from "three";
import type { Vec3 } from "../types";
import type { Viewport } from "../view/viewport";
import { icon } from "./icons";

interface Axis {
  label: string;
  dir: Vec3;
  /** Screen "up" when looking from this axis. */
  up: Vec3;
  color: string;
  positive: boolean;
}

const AXES: Axis[] = [
  { label: "X", dir: [1, 0, 0], up: [0, 0, 1], color: "var(--axis-x)", positive: true },
  { label: "Y", dir: [0, 1, 0], up: [0, 0, 1], color: "var(--axis-y)", positive: true },
  { label: "Z", dir: [0, 0, 1], up: [0, 1, 0], color: "var(--axis-z)", positive: true },
  { label: "-X", dir: [-1, 0, 0], up: [0, 0, 1], color: "var(--axis-x)", positive: false },
  { label: "-Y", dir: [0, -1, 0], up: [0, 0, 1], color: "var(--axis-y)", positive: false },
  { label: "-Z", dir: [0, 0, -1], up: [0, -1, 0], color: "var(--axis-z)", positive: false },
];

const NS = "http://www.w3.org/2000/svg";

export function createAxisGizmo(el: HTMLElement, vp: Viewport, size = 120) {
  el.classList.add("gizmo");
  const home = document.createElement("button");
  home.className = "gizmo-home";
  home.innerHTML = icon("home", 22);
  home.title = "Isometric view";
  home.setAttribute("aria-label", "Isometric view");
  home.onclick = () => vp.setStandardView("iso");

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.classList.add("gizmo-svg");
  el.append(home, svg);

  const c = size / 2;
  const R = size / 2 - 17; // bubble centre distance
  const r = 15; // bubble radius

  const lines = AXES.filter((a) => a.positive).map((a) => {
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", String(c));
    l.setAttribute("y1", String(c));
    l.style.stroke = a.color;
    l.classList.add("gizmo-line");
    return l;
  });
  const bubbles = AXES.map((a) => {
    const g = document.createElementNS(NS, "g");
    g.classList.add("gizmo-bubble", a.positive ? "pos" : "neg");
    g.style.setProperty("--c", a.color);
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("r", String(r));
    const text = document.createElementNS(NS, "text");
    text.textContent = a.label;
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    g.append(circle, text);
    return { a, g };
  });

  const update = () => {
    const m = new THREE.Matrix4().makeRotationFromQuaternion(vp.quat.clone().invert());
    const proj = bubbles.map(({ a, g }) => {
      const p = new THREE.Vector3(...a.dir).applyMatrix4(m);
      return { a, g, x: c + p.x * R, y: c - p.y * R, z: p.z };
    });
    for (const [i, l] of lines.entries()) {
      const p = proj[i];
      l.setAttribute("x2", String(p.x));
      l.setAttribute("y2", String(p.y));
    }
    // Painter's order: bubbles nearer to the viewer drawn last.
    const order = [...proj].sort((p, q) => p.z - q.z);
    svg.replaceChildren(...lines, ...order.map((p) => p.g));
    for (const p of proj) p.g.setAttribute("transform", `translate(${p.x} ${p.y})`);
  };
  vp.onCamera(update);
  update();

  // Tap = look along an axis; drag = orbit.
  let press: { id: number; x: number; y: number; moved: boolean; target: Axis | null } | null = null;
  svg.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer.
    }
    const hit = bubbles.find((b) => b.g.contains(e.target as Node));
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, target: hit?.a ?? null };
  });
  svg.addEventListener("pointermove", (e) => {
    if (!press || press.id !== e.pointerId) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < 6) return;
    press.moved = true;
    vp.orbit(dx * 1.6, dy * 1.6);
    press.x = e.clientX;
    press.y = e.clientY;
  });
  const end = (e: PointerEvent) => {
    if (!press || press.id !== e.pointerId) return;
    if (!press.moved && press.target) vp.viewAlong(press.target.dir, press.target.up);
    press = null;
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", () => (press = null));
}
