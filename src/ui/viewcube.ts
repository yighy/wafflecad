// Navigation cube: a CSS 3D cube that follows the camera; tapping a face looks from that side.
import * as THREE from "three";
import type { Vec3 } from "../types";
import type { Viewport } from "../view/viewport";

interface FaceDef {
  label: string;
  n: Vec3;
  /** Face's local right and down directions, in world coordinates. */
  u: Vec3;
  v: Vec3;
}

const FACES: FaceDef[] = [
  { label: "Top", n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  { label: "Front", n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { label: "Right", n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, -1] },
  { label: "Back", n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, -1] },
  { label: "Left", n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, -1] },
  { label: "Bottom", n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
];

export function createViewCube(el: HTMLElement, vp: Viewport, size = 64) {
  el.classList.add("viewcube");
  el.style.width = el.style.height = `${size}px`;
  const faces = FACES.map((f) => {
    const d = document.createElement("button");
    d.className = "vc-face";
    d.textContent = f.label;
    d.style.width = d.style.height = `${size}px`;
    d.title = `${f.label} view`;
    // Looking from a face: eye along its normal, screen up = opposite of its "down".
    d.onclick = () => vp.viewAlong(f.n, [-f.v[0], -f.v[1], -f.v[2]]);
    el.appendChild(d);
    return { def: f, el: d };
  });

  const half = size / 2;
  const update = () => {
    // World → view rotation, then flip Y for CSS (y down).
    const r = new THREE.Matrix4().makeRotationFromQuaternion(vp.quat.clone().invert());
    const toCss = (w: Vec3) => {
      const p = new THREE.Vector3(...w).applyMatrix4(r);
      return [p.x, -p.y, p.z];
    };
    for (const { def, el: d } of faces) {
      const u = toCss(def.u);
      const v = toCss(def.v);
      const n = toCss(def.n);
      const m = [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, n[0] * half, n[1] * half, n[2] * half, 1];
      d.style.transform = `matrix3d(${m.map((x) => x.toFixed(5)).join(",")})`;
    }
  };
  vp.onCamera(update);
  update();
}
