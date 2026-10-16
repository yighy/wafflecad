// Pure helpers over the sketch data model (no DOM, no solver).
import type { PlaneDef, SkArc, SkConstraint, SkCurve, SkEntity, SkPoint, SkSpline, SketchFeature, Vec3 } from "../types";

export const ORIGIN = "O";
export const X_AXIS = "AX";
export const Y_AXIS = "AY";
/** Hidden fixed points that define the axis directions. */
const X_END = "XE";
const Y_END = "YE";

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function newSketch(name: string, plane: PlaneDef): SketchFeature {
  return {
    id: uid(),
    kind: "sketch",
    name,
    plane,
    entities: [
      { id: ORIGIN, type: "point", x: 0, y: 0, fixed: true },
      { id: X_END, type: "point", x: 1, y: 0, fixed: true },
      { id: Y_END, type: "point", x: 0, y: 1, fixed: true },
      { id: X_AXIS, type: "line", p1: ORIGIN, p2: X_END, axis: true, construction: true },
      { id: Y_AXIS, type: "line", p1: ORIGIN, p2: Y_END, axis: true, construction: true },
    ],
    constraints: [],
  };
}

/** Points that are only there to define an axis: not drawn, not selectable. */
export function isHiddenPoint(id: string) {
  return id === X_END || id === Y_END;
}

export class SketchView {
  readonly byId = new Map<string, SkEntity>();
  constructor(readonly sketch: SketchFeature) {
    for (const e of sketch.entities) this.byId.set(e.id, e);
  }
  get(id: string) {
    return this.byId.get(id);
  }
  pt(id: string): SkPoint {
    const p = this.byId.get(id);
    if (!p || p.type !== "point") throw new Error(`point ${id} not found`);
    return p;
  }
  xy(id: string): [number, number] {
    const p = this.pt(id);
    return [p.x, p.y];
  }
  curves(): SkCurve[] {
    return this.sketch.entities.filter((e): e is SkCurve => e.type !== "point");
  }
  points(): SkPoint[] {
    return this.sketch.entities.filter((e): e is SkPoint => e.type === "point" && !isHiddenPoint(e.id));
  }
  arcRadius(a: SkArc) {
    const [cx, cy] = this.xy(a.c);
    const [sx, sy] = this.xy(a.s);
    return Math.hypot(sx - cx, sy - cy);
  }
  /** Start and end angles, with end > start (CCW sweep). */
  arcAngles(a: SkArc): [number, number] {
    const [cx, cy] = this.xy(a.c);
    const [sx, sy] = this.xy(a.s);
    const [ex, ey] = this.xy(a.e);
    const s = Math.atan2(sy - cy, sx - cx);
    let e = Math.atan2(ey - cy, ex - cx);
    while (e <= s + 1e-9) e += Math.PI * 2;
    return [s, e];
  }
  /** Point ids an entity depends on (its definition points). */
  defPoints(e: SkEntity): string[] {
    switch (e.type) {
      case "point":
        return [e.id];
      case "line":
        return [e.p1, e.p2];
      case "circle":
        return [e.c];
      case "arc":
        return [e.c, e.s, e.e];
      case "spline":
        return e.pts;
    }
  }
  /** The Bézier spans of a spline, with the ids of the points each one joins. */
  splineSpans(s: SkSpline) {
    const ids = s.pts;
    const ends = s.closed ? {} : this.splineEndTangents(s);
    return splineSpans(ids.map((id) => this.xy(id)), !!s.closed, ends.start, ends.end).map((sp, i) => ({ ...sp, from: ids[i], to: ids[(i + 1) % ids.length] }));
  }
  /**
   * Directions forced at the ends of an open spline by tangent constraints with a line or an
   * arc ending at the same point: the spline carries on smoothly from that curve.
   */
  splineEndTangents(s: SkSpline): { start?: P2; end?: P2 } {
    const out: { start?: P2; end?: P2 } = {};
    for (const c of this.sketch.constraints) {
      if (c.type !== "tangent" || !c.refs.includes(s.id)) continue;
      const other = this.get(c.refs.find((r) => r !== s.id) ?? "");
      if (!other) continue;
      const first = s.pts[0];
      const last = s.pts[s.pts.length - 1];
      const intoStart = this.directionInto(other, first);
      const intoEnd = this.directionInto(other, last);
      if (intoStart) out.start = [-intoStart[0], -intoStart[1]];
      else if (intoEnd) out.end = intoEnd;
    }
    return out;
  }
  /** Unit direction going from point `at` into curve `c`, when `at` is one of its ends. */
  directionInto(c: SkEntity, at: string): P2 | null {
    const unitOf = (x: number, y: number): P2 | null => {
      const l = Math.hypot(x, y);
      return l < 1e-12 ? null : [x / l, y / l];
    };
    if (c.type === "line" && (c.p1 === at || c.p2 === at)) {
      const [a, b] = c.p1 === at ? [c.p1, c.p2] : [c.p2, c.p1];
      const [ax, ay] = this.xy(a);
      const [bx, by] = this.xy(b);
      return unitOf(bx - ax, by - ay);
    }
    if (c.type === "arc" && (c.s === at || c.e === at)) {
      const [cx, cy] = this.xy(c.c);
      const [px, py] = this.xy(at);
      // From s the arc turns counter-clockwise; from e it comes back clockwise.
      return c.s === at ? unitOf(-(py - cy), px - cx) : unitOf(py - cy, -(px - cx));
    }
    return null;
  }
}

type P2 = [number, number];
export interface BezierSpan {
  a: P2;
  c1: P2;
  c2: P2;
  b: P2;
}

/**
 * Cubic Bézier spans through the points. The tangent at a point follows the line between
 * its neighbours, scaled by the chord lengths so uneven spacing does not overshoot; the
 * ends of an open spline point at their neighbour.
 */
export function splineSpans(pts: P2[], closed: boolean, startTan?: P2, endTan?: P2): BezierSpan[] {
  const n = pts.length;
  if (n < 2) return [];
  const at = (i: number) => pts[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  const dist = (p: P2, q: P2) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  // Unit-speed tangent at each point.
  const tan = pts.map((p, i): P2 => {
    const prev = at(i - 1);
    const next = at(i + 1);
    const len = dist(prev, p) + dist(p, next);
    if (len < 1e-12) return [0, 0];
    return [(next[0] - prev[0]) / len, (next[1] - prev[1]) / len];
  });
  if (!closed && startTan) tan[0] = startTan;
  if (!closed && endTan) tan[n - 1] = endTan;
  const spans: BezierSpan[] = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    const a = pts[i];
    const b = pts[j];
    const k = dist(a, b) / 3;
    spans.push({ a, b, c1: [a[0] + tan[i][0] * k, a[1] + tan[i][1] * k], c2: [b[0] - tan[j][0] * k, b[1] - tan[j][1] * k] });
  }
  return spans;
}

/** Points along a cubic Bézier, both ends included. */
export function sampleBezier(s: BezierSpan, n: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    out.push([
      w[0] * s.a[0] + w[1] * s.c1[0] + w[2] * s.c2[0] + w[3] * s.b[0],
      w[0] * s.a[1] + w[1] * s.c1[1] + w[2] * s.c2[1] + w[3] * s.b[1],
    ]);
  }
  return out;
}

/** Polyline of a whole spline (for drawing and picking). */
export function sampleSpline(view: SketchView, s: SkSpline, perSpan = 16): P2[] {
  const out: P2[] = [];
  for (const sp of view.splineSpans(s)) {
    const ps = sampleBezier(sp, perSpan);
    out.push(...(out.length ? ps.slice(1) : ps));
  }
  return out;
}

export function isReference(e: SkEntity) {
  return (e.type === "point" && !!e.fixed) || (e.type === "line" && !!e.axis);
}

/**
 * Deletes entities and everything that depends on them: curves using a deleted point,
 * constraints referencing a deleted entity, and points no longer used by anything.
 */
export function deleteEntities(sk: SketchFeature, ids: Iterable<string>) {
  const doomed = new Set(ids);
  for (const e of sk.entities) if (isReference(e)) doomed.delete(e.id);
  // Deleting a point of a spline only takes it out of the spline, while enough points remain.
  for (const e of sk.entities) {
    if (e.type !== "spline" || doomed.has(e.id) || !e.pts.some((p) => doomed.has(p))) continue;
    const left = e.pts.filter((p) => !doomed.has(p));
    if (left.length >= (e.closed ? 3 : 2)) e.pts = left;
  }
  const view = new SketchView(sk);
  // Deleting a point also deletes the curves built on it.
  for (const e of sk.entities) {
    if (e.type !== "point" && view.defPoints(e).some((p) => doomed.has(p))) doomed.add(e.id);
  }
  const removedCurves = sk.entities.filter((e) => e.type !== "point" && doomed.has(e.id));
  // Definition points of deleted curves go too, unless still used elsewhere.
  const candidates = new Set(removedCurves.flatMap((c) => view.defPoints(c)));
  sk.entities = sk.entities.filter((e) => !doomed.has(e.id));
  const after = new SketchView(sk);
  const stillUsed = new Set(after.curves().flatMap((e) => after.defPoints(e)));
  for (const p of candidates) {
    const pe = view.get(p);
    if (pe && pe.type === "point" && !pe.fixed && !stillUsed.has(p)) doomed.add(p);
  }
  sk.entities = sk.entities.filter((e) => !doomed.has(e.id));
  sk.constraints = sk.constraints.filter((c) => !c.refs.some((r) => doomed.has(r)) && !doomed.has(c.id));
  return doomed;
}

/** Replaces point `drop` by `keep` everywhere (coincidence by sharing the point). */
export function mergePoints(sk: SketchFeature, keep: string, drop: string) {
  if (keep === drop) return;
  const view = new SketchView(sk);
  const dropPt = view.get(drop);
  if (dropPt?.type === "point" && dropPt.fixed) [keep, drop] = [drop, keep];
  const sub = (id: string) => (id === drop ? keep : id);
  sk.entities = sk.entities
    .filter((e) => e.id !== drop)
    .map((e) => {
      switch (e.type) {
        case "line":
          return { ...e, p1: sub(e.p1), p2: sub(e.p2) };
        case "circle":
          return { ...e, c: sub(e.c) };
        case "arc":
          return { ...e, c: sub(e.c), s: sub(e.s), e: sub(e.e) };
        case "spline": {
          const pts = e.pts.map(sub).filter((p, i, a) => i === 0 || p !== a[i - 1]);
          let closed = e.closed;
          // Joining the two ends closes the spline.
          if (pts.length > 2 && pts[0] === pts[pts.length - 1]) {
            pts.pop();
            closed = true;
          }
          return { ...e, pts, closed };
        }
        default:
          return e;
      }
    });
  // Lines and splines that collapsed to a single point are removed.
  const collapsed = sk.entities
    .filter((e) => (e.type === "line" && e.p1 === e.p2) || (e.type === "spline" && e.pts.length < (e.closed ? 3 : 2)))
    .map((e) => e.id);
  sk.constraints = sk.constraints
    .map((c) => ({ ...c, refs: c.refs.map(sub) }))
    .filter((c) => new Set(c.refs).size === c.refs.length || c.type === "symmetric");
  if (collapsed.length) deleteEntities(sk, collapsed);
}

/** World points of a sketch line's two ends. */
export function sketchLineWorld(sk: SketchFeature, lineId: string): [Vec3, Vec3] {
  const line = sk.entities.find((e) => e.id === lineId);
  if (!line || line.type !== "line") throw new Error("The revolve axis line is no longer in the sketch");
  const pt = (id: string): [number, number] => {
    const p = sk.entities.find((e) => e.id === id);
    if (!p || p.type !== "point") throw new Error("The revolve axis line is broken");
    return [p.x, p.y];
  };
  const { origin: o, xDir: xd, normal: n } = sk.plane;
  const yd: Vec3 = [n[1] * xd[2] - n[2] * xd[1], n[2] * xd[0] - n[0] * xd[2], n[0] * xd[1] - n[1] * xd[0]];
  const w = ([x, y]: [number, number]): Vec3 => [0, 1, 2].map((i) => o[i] + xd[i] * x + yd[i] * y) as Vec3;
  return [w(pt(line.p1)), w(pt(line.p2))];
}

export function constraintLabel(c: SkConstraint): string {
  switch (c.type) {
    case "horizontal":
      return "H";
    case "vertical":
      return "V";
    case "parallel":
      return "∥";
    case "perpendicular":
      return "⊥";
    case "equal":
      return "=";
    case "tangent":
      return "T";
    case "pointOn":
      return "•";
    case "midpoint":
      return "M";
    case "symmetric":
      return "⇹";
    case "fix":
      return "⚓";
    case "distance":
    case "distanceX":
    case "distanceY":
      return fmt(c.value ?? 0);
    case "radius":
      return "R" + fmt(c.value ?? 0);
    case "diameter":
      return "⌀" + fmt(c.value ?? 0);
    case "angle":
      return fmt(c.value ?? 0) + "°";
  }
}

export function fmt(v: number) {
  return String(Math.round(v * 1000) / 1000);
}
