// Trim: removes the piece of a curve between its nearest intersections on both sides of a tap.
// Pure sketch-model code (no DOM), so it can be tested under Node.
import type { ConstraintType, SkCurve, SketchFeature } from "../types";
import { SketchView, deleteEntities, isHiddenPoint, sampleSpline, uid } from "./model";

type P2 = [number, number];

/** What a curve looks like to the intersection code: segments (splines are sampled) or circular ranges. */
type Shape =
  | { kind: "seg"; a: P2; b: P2; infinite?: boolean }
  /** Counter-clockwise from a0 to a1; no range = full circle. */
  | { kind: "circ"; c: P2; r: number; a0?: number; a1?: number };

/** A place where the curve can be cut: its parameter, position, and what cuts it there. */
interface Cut {
  t: number;
  at: P2;
  /** Existing point at that place, reused (so the cut stays attached to it). */
  point?: string;
  /** Curve crossing there: the new point is constrained onto it. */
  cutter?: string;
}

export interface TrimPlan {
  /** The piece that goes away, as a polyline (for the preview). */
  removed: P2[];
  apply(sk: SketchFeature): void;
}

const TAU = Math.PI * 2;
const sub = (p: P2, q: P2): P2 => [p[0] - q[0], p[1] - q[1]];
const dist = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const lerp = (p: P2, q: P2, t: number): P2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
/** Angle brought into [from, from + 2π). */
const wrap = (a: number, from: number) => {
  let x = a;
  while (x < from) x += TAU;
  while (x >= from + TAU) x -= TAU;
  return x;
};

function shapesOf(v: SketchView, c: SkCurve): Shape[] {
  switch (c.type) {
    case "line":
      return [{ kind: "seg", a: v.xy(c.p1), b: v.xy(c.p2), infinite: !!c.axis }];
    case "circle":
      return [{ kind: "circ", c: v.xy(c.c), r: c.r }];
    case "arc": {
      const [a0, a1] = v.arcAngles(c);
      return [{ kind: "circ", c: v.xy(c.c), r: v.arcRadius(c), a0, a1 }];
    }
    case "spline": {
      const ps = sampleSpline(v, c, 32);
      return ps.slice(1).map((b, i): Shape => ({ kind: "seg", a: ps[i], b }));
    }
  }
}

/** Is `p` (known to be on the shape's carrier line or circle) within the shape's extent? */
function within(s: Shape, p: P2, tol: number) {
  if (s.kind === "seg") {
    if (s.infinite) return true;
    const d = sub(s.b, s.a);
    const L = Math.hypot(...d);
    if (L < 1e-12) return false;
    const t = ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]) / (L * L);
    return t >= -tol / L && t <= 1 + tol / L;
  }
  if (s.a0 === undefined || s.a1 === undefined) return true;
  const ang = wrap(Math.atan2(p[1] - s.c[1], p[0] - s.c[0]), s.a0);
  const eps = tol / Math.max(s.r, 1e-9);
  return ang <= s.a1 + eps || ang >= s.a0 + TAU - eps;
}

/** Intersections of the carriers (infinite line, full circle) of two shapes. */
function carrierHits(p: Shape, q: Shape): P2[] {
  if (p.kind === "seg" && q.kind === "seg") {
    const d1 = sub(p.b, p.a);
    const d2 = sub(q.b, q.a);
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-12 * Math.hypot(...d1) * Math.hypot(...d2)) return [];
    const w = sub(q.a, p.a);
    const t = (w[0] * d2[1] - w[1] * d2[0]) / den;
    return [lerp(p.a, p.b, t)];
  }
  if (p.kind === "circ" && q.kind === "seg") return carrierHits(q, p);
  if (p.kind === "seg" && q.kind === "circ") {
    const d = sub(p.b, p.a);
    const f = sub(p.a, q.c);
    const A = d[0] * d[0] + d[1] * d[1];
    if (A < 1e-24) return [];
    const B = 2 * (f[0] * d[0] + f[1] * d[1]);
    const C = f[0] * f[0] + f[1] * f[1] - q.r * q.r;
    const disc = B * B - 4 * A * C;
    if (disc < -1e-12 * A * q.r * q.r) return [];
    const s = Math.sqrt(Math.max(disc, 0));
    const ts = s < 1e-12 ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)];
    return ts.map((t) => lerp(p.a, p.b, t));
  }
  if (p.kind === "circ" && q.kind === "circ") {
    const d = dist(p.c, q.c);
    if (d < 1e-12 || d > p.r + q.r + 1e-9 || d < Math.abs(p.r - q.r) - 1e-9) return [];
    const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(p.r * p.r - a * a, 0));
    const u: P2 = [(q.c[0] - p.c[0]) / d, (q.c[1] - p.c[1]) / d];
    const m: P2 = [p.c[0] + u[0] * a, p.c[1] + u[1] * a];
    if (h < 1e-9) return [m];
    return [
      [m[0] - u[1] * h, m[1] + u[0] * h],
      [m[0] + u[1] * h, m[1] - u[0] * h],
    ];
  }
  return [];
}

/** Closest point of a shape's carrier to p. */
function carrierProject(s: Shape, p: P2): P2 {
  if (s.kind === "seg") {
    const d = sub(s.b, s.a);
    const t = ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]) / Math.max(d[0] * d[0] + d[1] * d[1], 1e-24);
    return lerp(s.a, s.b, t);
  }
  const ang = Math.atan2(p[1] - s.c[1], p[0] - s.c[0]);
  return [s.c[0] + s.r * Math.cos(ang), s.c[1] + s.r * Math.sin(ang)];
}

/**
 * The plan for trimming curve `curveId` at sketch position `at` (a tap on the curve), or null
 * when that curve cannot be trimmed (splines, reference axes).
 */
export function trimPlan(sk: SketchFeature, curveId: string, at: P2): TrimPlan | null {
  const v = new SketchView(sk);
  const C = v.get(curveId);
  if (!C || C.type === "point" || C.type === "spline" || (C.type === "line" && C.axis)) return null;
  const [T] = shapesOf(v, C);
  const size = T.kind === "seg" ? dist(T.a, T.b) : T.r;
  const tol = Math.max(size, 1) * 1e-6;

  // Parameter along the target: 0..1 for a line, an angle for a circle or an arc.
  const base = T.kind === "circ" ? (T.a0 ?? Math.atan2(at[1] - T.c[1], at[0] - T.c[0])) : 0;
  const param = (p: P2) => {
    if (T.kind === "seg") {
      const d = sub(T.b, T.a);
      return ((p[0] - T.a[0]) * d[0] + (p[1] - T.a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1]);
    }
    return wrap(Math.atan2(p[1] - T.c[1], p[0] - T.c[0]), base);
  };
  const lo = 0;
  const hi = T.kind === "seg" ? 1 : T.a1 !== undefined ? T.a1 - base : TAU;
  const pEps = T.kind === "seg" ? tol / Math.max(size, 1e-9) : tol / Math.max(T.r, 1e-9);

  const cuts: Cut[] = [];
  const addCut = (p: P2, cut: Omit<Cut, "t" | "at">) => {
    if (!within(T, p, tol)) return;
    const t = param(p) - (T.kind === "circ" ? base : 0);
    const isFull = T.kind === "circ" && T.a0 === undefined;
    if (!isFull && (t <= lo + pEps || t >= hi - pEps)) return;
    if (cuts.some((k) => dist(k.at, p) < tol * 10)) {
      // Same place: prefer an existing point.
      const k = cuts.find((x) => dist(x.at, p) < tol * 10)!;
      if (cut.point && !k.point) k.point = cut.point;
      return;
    }
    cuts.push({ t, at: p, ...cut });
  };

  // Existing points lying on the curve (other curves' ends, points constrained on it).
  // The origin alone does not cut: only when a curve is attached to it.
  const own = new Set(v.defPoints(C));
  const attached = new Set(v.curves().flatMap((c) => (c.id === C.id ? [] : v.defPoints(c))));
  for (const p of v.points()) {
    if (own.has(p.id) || isHiddenPoint(p.id) || (p.fixed && !attached.has(p.id))) continue;
    const xy: P2 = [p.x, p.y];
    if (dist(carrierProject(T, xy), xy) < tol * 10) addCut(xy, { point: p.id });
  }
  // Crossings with every other curve (the reference axes do not cut).
  for (const other of v.curves()) {
    if (other.id === C.id || (other.type === "line" && other.axis)) continue;
    for (const s of shapesOf(v, other)) {
      for (const p of carrierHits(T, s)) {
        if (within(s, p, tol)) addCut(p, { cutter: other.type === "spline" ? undefined : other.id });
      }
    }
  }

  const t0 = param(at) - (T.kind === "circ" ? base : 0);
  const full = T.kind === "circ" && T.a0 === undefined;
  let below: Cut | undefined;
  let above: Cut | undefined;
  for (const k of cuts) {
    if (full) {
      // Around a circle: the next cut counter-clockwise, and the previous one.
      const d = wrap(k.t - t0, 0);
      if (!above || d < wrap(above.t - t0, 0)) above = k;
      if (!below || d > wrap(below.t - t0, 0)) below = k;
    } else if (k.t < t0 && (!below || k.t > below.t)) below = k;
    else if (k.t > t0 && (!above || k.t < above.t)) above = k;
  }

  // Preview polyline of the removed piece.
  const from = below ? below.t : full ? t0 : lo;
  let to = above ? above.t : full ? t0 + TAU : hi;
  if (full && cuts.length < 2) to = from + TAU;
  else if (full) to = from + wrap(to - from, 0);
  const removed: P2[] = [];
  const n = T.kind === "seg" ? 1 : Math.max(8, Math.ceil(((to - from) / TAU) * 96));
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n;
    if (T.kind === "seg") removed.push(lerp(T.a, T.b, t));
    else removed.push([T.c[0] + T.r * Math.cos(base + t), T.c[1] + T.r * Math.sin(base + t)]);
  }

  const apply = (sk: SketchFeature) => {
    const target = sk.entities.find((e) => e.id === curveId) as SkCurve;
    const pointAt = (k: Cut) => {
      if (k.point) return k.point;
      const id = uid();
      sk.entities.push({ id, type: "point", x: k.at[0], y: k.at[1] });
      if (k.cutter) sk.constraints.push({ id: uid(), type: "pointOn", refs: [id, k.cutter] });
      k.point = id;
      return id;
    };
    const dropIfOrphan = (id: string) => {
      const view = new SketchView(sk);
      const used = view.curves().some((c) => view.defPoints(c).includes(id));
      const p = view.get(id);
      if (!used && p?.type === "point" && !p.fixed) deleteEntities(sk, [id]);
    };
    const add = (type: ConstraintType, refs: string[]) => sk.constraints.push({ id: uid(), type, refs });

    if (target.type === "line") {
      if (!below && !above) return void deleteEntities(sk, [target.id]);
      // Its length is no longer what was dimensioned; equal length and midpoint neither.
      sk.constraints = sk.constraints.filter(
        (c) => !c.refs.includes(target.id) || !((c.type === "distance" && c.refs.length === 1) || c.type === "equal" || c.type === "midpoint"),
      );
      if (below && above) {
        const rest = { id: uid(), type: "line" as const, p1: pointAt(above), p2: target.p2, construction: target.construction };
        target.p2 = pointAt(below);
        sk.entities.push(rest);
        // The two pieces stay on one line.
        const hv = sk.constraints.find((c) => c.refs.length === 1 && c.refs[0] === target.id && (c.type === "horizontal" || c.type === "vertical"));
        if (hv) add(hv.type, [rest.id]);
        else add("parallel", [target.id, rest.id]);
        add("pointOn", [rest.p1, target.id]);
      } else if (below) {
        const old = target.p2;
        target.p2 = pointAt(below);
        dropIfOrphan(old);
      } else {
        const old = target.p1;
        target.p1 = pointAt(above!);
        dropIfOrphan(old);
      }
    } else if (target.type === "arc") {
      if (!below && !above) return void deleteEntities(sk, [target.id]);
      if (below && above) {
        const rest = { id: uid(), type: "arc" as const, c: target.c, s: pointAt(above), e: target.e, construction: target.construction };
        target.e = pointAt(below);
        sk.entities.push(rest);
        add("equal", [target.id, rest.id]);
      } else if (below) {
        const old = target.e;
        target.e = pointAt(below);
        dropIfOrphan(old);
      } else {
        const old = target.s;
        target.s = pointAt(above!);
        dropIfOrphan(old);
      }
    } else if (target.type === "circle") {
      if (cuts.length < 2 || !below || !above) return void deleteEntities(sk, [target.id]);
      // What remains goes counter-clockwise from the next cut round to the previous one.
      const i = sk.entities.indexOf(target);
      sk.entities[i] = { id: target.id, type: "arc", c: target.c, s: pointAt(above), e: pointAt(below), construction: target.construction };
    }
  };
  return { removed, apply };
}
