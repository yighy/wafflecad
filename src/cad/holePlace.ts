// Placing holes on a flat face: snapping to useful places and measuring from the face's edges.
// Pure geometry (no DOM, no kernel): works on the mesh edges a build sends back.
import type { EdgeGroup, PlaneDef, Vec3 } from "../types";

type P2 = [number, number];

/** A frame on the face: sketch-like 2D coordinates (same convention as faces in the build). */
export function faceFrame(normal: Vec3, at: Vec3): PlaneDef {
  const n = normal;
  const k = at[0] * n[0] + at[1] * n[1] + at[2] * n[2];
  let xDir: Vec3;
  if (Math.abs(n[2]) > 0.9) xDir = [1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]];
  else {
    const up: Vec3 = [-n[2] * n[0], -n[2] * n[1], 1 - n[2] * n[2]];
    xDir = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  }
  const l = Math.hypot(...xDir);
  return { origin: [n[0] * k, n[1] * k, n[2] * k], xDir: [xDir[0] / l, xDir[1] / l, xDir[2] / l], normal: n, label: "Face" };
}

const yDirOf = (p: PlaneDef): Vec3 => {
  const [n, x] = [p.normal, p.xDir];
  return [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
};

export function to2D(p: PlaneDef, w: Vec3): P2 {
  const d = [w[0] - p.origin[0], w[1] - p.origin[1], w[2] - p.origin[2]];
  const y = yDirOf(p);
  return [d[0] * p.xDir[0] + d[1] * p.xDir[1] + d[2] * p.xDir[2], d[0] * y[0] + d[1] * y[1] + d[2] * y[2]];
}

export function to3D(p: PlaneDef, [u, v]: P2): Vec3 {
  const y = yDirOf(p);
  return [0, 1, 2].map((i) => p.origin[i] + p.xDir[i] * u + y[i] * v) as Vec3;
}

/** The model's edges lying in the face's plane, as straight segments or circles (2D). */
export interface FaceEdges {
  segments: { a: P2; b: P2 }[];
  circles: { c: P2; r: number }[];
}

export function edgesInPlane(p: PlaneDef, lines: Float32Array, groups: EdgeGroup[]): FaceEdges {
  const out: FaceEdges = { segments: [], circles: [] };
  const n = p.normal;
  const off = (w: Vec3) => (w[0] - p.origin[0]) * n[0] + (w[1] - p.origin[1]) * n[1] + (w[2] - p.origin[2]) * n[2];
  for (const g of groups) {
    const pts: Vec3[] = [];
    for (let k = g.start; k < g.start + g.count; k += 2) pts.push([lines[k * 3], lines[k * 3 + 1], lines[k * 3 + 2]]);
    const e = (g.start + g.count - 1) * 3;
    pts.push([lines[e], lines[e + 1], lines[e + 2]]);
    if (!pts.every((w) => Math.abs(off(w)) < 0.02)) continue;
    const q = pts.map((w) => to2D(p, w));
    const [a, b] = [q[0], q[q.length - 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const straight =
      L > 1e-6 && q.every((s) => Math.abs((b[0] - a[0]) * (s[1] - a[1]) - (b[1] - a[1]) * (s[0] - a[0])) / L < 0.02);
    if (straight) {
      out.segments.push({ a, b });
      continue;
    }
    const c = circleThrough(q[0], q[Math.floor(q.length / 3)], q[Math.floor((2 * q.length) / 3)]);
    if (c && q.every((s) => Math.abs(Math.hypot(s[0] - c[0], s[1] - c[1]) - c[2]) < 0.03)) out.circles.push({ c: [c[0], c[1]], r: c[2] });
  }
  return out;
}

function circleThrough(a: P2, b: P2, c: P2): [number, number, number] | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return [x, y, Math.hypot(a[0] - x, a[1] - y)];
}

export interface Snap {
  at: P2;
  /** What it snapped to, shown next to the hole. */
  label: string | null;
}

/**
 * Where a hole dropped at `at` goes: the face centre, a circle's centre or an edge's middle
 * when within `radius` (mm), else the nearest point of a 1 mm grid.
 */
export function snapHole(at: P2, edges: FaceEdges, faceCenter: P2 | null, radius: number): Snap {
  const cands: Snap[] = [];
  if (faceCenter) cands.push({ at: faceCenter, label: "Face centre" });
  for (const c of edges.circles) cands.push({ at: c.c, label: "Circle centre" });
  for (const s of edges.segments) cands.push({ at: [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], label: "Edge middle" });
  let best: Snap | null = null;
  let bestD = radius;
  for (const c of cands) {
    const d = Math.hypot(c.at[0] - at[0], c.at[1] - at[1]);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best ?? { at: [Math.round(at[0]), Math.round(at[1])], label: null };
}

export interface EdgeDim {
  /** Foot of the perpendicular on the edge's line. */
  foot: P2;
  /** Unit direction from the edge towards the hole. */
  dir: P2;
  dist: number;
}

/**
 * Distances from the hole to the nearest edge and to the nearest edge across it (at least 30°
 * from the first), measured square to each edge.
 */
export function holeDims(at: P2, edges: FaceEdges): EdgeDim[] {
  const all = edges.segments
    .map((s) => {
      const d: P2 = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
      const L = Math.hypot(...d);
      const u: P2 = [d[0] / L, d[1] / L];
      const t = (at[0] - s.a[0]) * u[0] + (at[1] - s.a[1]) * u[1];
      const foot: P2 = [s.a[0] + u[0] * t, s.a[1] + u[1] * t];
      const v: P2 = [at[0] - foot[0], at[1] - foot[1]];
      const dist = Math.hypot(...v);
      // The foot must fall on the edge (a little outside is fine).
      const onEdge = t > -0.25 * L && t < 1.25 * L;
      return { foot, dir: dist > 1e-9 ? ([v[0] / dist, v[1] / dist] as P2) : ([-u[1], u[0]] as P2), dist, u, onEdge };
    })
    .filter((x) => x.onEdge)
    .sort((p, q) => p.dist - q.dist);
  const first = all[0];
  if (!first) return [];
  const second = all.find((x) => Math.abs(x.u[0] * first.u[0] + x.u[1] * first.u[1]) < Math.cos(Math.PI / 6));
  return [first, second].filter((x): x is (typeof all)[number] => !!x).map(({ foot, dir, dist }) => ({ foot, dir, dist }));
}

/** The hole moved square to an edge so that it sits `value` mm from it. */
export function atDistance(dim: EdgeDim, value: number): P2 {
  return [dim.foot[0] + dim.dir[0] * value, dim.foot[1] + dim.dir[1] * value];
}
