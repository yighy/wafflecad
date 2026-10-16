// Pure helpers over the sketch data model (no DOM, no solver).
import type { PlaneDef, SkArc, SkConstraint, SkCurve, SkEntity, SkPoint, SketchFeature } from "../types";

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
    }
  }
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
        default:
          return e;
      }
    });
  // Lines that collapsed to a single point are removed.
  const collapsed = sk.entities.filter((e) => e.type === "line" && e.p1 === e.p2).map((e) => e.id);
  sk.constraints = sk.constraints
    .map((c) => ({ ...c, refs: c.refs.map(sub) }))
    .filter((c) => new Set(c.refs).size === c.refs.length || c.type === "symmetric");
  if (collapsed.length) deleteEntities(sk, collapsed);
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
