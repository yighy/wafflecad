// Putting imported 2D drawings (DXF, later SVG) into a sketch.
// Pure sketch-model code (no DOM), testable under Node.
import type { SkConstraint, SkEntity, SketchFeature } from "../types";
import { uid } from "./model";

type P2 = [number, number];

/** One piece of an imported drawing, in the file's own coordinates. Arcs run counter-clockwise from s to e. */
export type ImportShape =
  | { kind: "line"; a: P2; b: P2; layer?: string }
  | { kind: "circle"; c: P2; r: number; layer?: string }
  | { kind: "arc"; c: P2; r: number; s: P2; e: P2; layer?: string }
  | { kind: "spline"; pts: P2[]; closed: boolean; layer?: string };

export interface ImportOptions {
  /** Millimetres per drawing unit. */
  scale: number;
  /** Where the drawing goes: as placed in the file, or with its bounding box centred on the origin. */
  place: "file" | "centre";
  /** Fixed: points pinned where they land. Free: plain geometry, to constrain afterwards. */
  fixed: boolean;
}

function pointsOf(s: ImportShape): P2[] {
  switch (s.kind) {
    case "line":
      return [s.a, s.b];
    case "circle":
      return [
        [s.c[0] - s.r, s.c[1] - s.r],
        [s.c[0] + s.r, s.c[1] + s.r],
      ];
    case "arc":
      return [s.s, s.e, s.c];
    case "spline":
      return s.pts;
  }
}

export function bounds(shapes: ImportShape[]): { min: P2; max: P2 } | null {
  const pts = shapes.flatMap(pointsOf);
  if (!pts.length) return null;
  return {
    min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))],
    max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))],
  };
}

/**
 * Adds the shapes to the sketch. Ends that meet (within a small tolerance) become one point, so
 * outlines close and can be extruded. Returns how many curves were added.
 */
export function insertShapes(sk: SketchFeature, shapes: ImportShape[], opt: ImportOptions): number {
  const b = bounds(shapes);
  if (!b) return 0;
  const k = opt.scale;
  const shift: P2 = opt.place === "centre" ? [-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2] : [0, 0];
  const T = ([x, y]: P2): P2 => [(x + shift[0]) * k, (y + shift[1]) * k];
  const size = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1]) * k;
  const tol = Math.max(size * 1e-5, 1e-4);

  const added: SkEntity[] = [];
  const cons: SkConstraint[] = [];
  // Points on a coarse grid of the tolerance, to find a match quickly.
  const grid = new Map<string, { id: string; p: P2 }[]>();
  const cell = (p: P2) => `${Math.round(p[0] / (tol * 10))},${Math.round(p[1] / (tol * 10))}`;
  const pointAt = (raw: P2, pin = opt.fixed): string => {
    const p = T(raw);
    const [cx, cy] = cell(p).split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(q.p[0] - p[0], q.p[1] - p[1]) < tol) return q.id;
    const id = uid();
    added.push({ id, type: "point", x: p[0], y: p[1] });
    if (pin) cons.push({ id: uid(), type: "fix", refs: [id], at: [p[0], p[1]], quiet: true });
    const key = cell(p);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push({ id, p });
    return id;
  };

  let count = 0;
  for (const s of shapes) {
    switch (s.kind) {
      case "line": {
        const a = pointAt(s.a);
        const e = pointAt(s.b);
        if (a === e) continue;
        added.push({ id: uid(), type: "line", p1: a, p2: e });
        break;
      }
      case "circle": {
        if (s.r * k < tol) continue;
        const id = uid();
        added.push({ id, type: "circle", c: pointAt(s.c), r: s.r * k });
        if (opt.fixed) cons.push({ id: uid(), type: "radius", refs: [id], value: s.r * k, quiet: true });
        break;
      }
      case "arc": {
        const a = pointAt(s.s);
        const e = pointAt(s.e);
        if (a === e) continue;
        added.push({ id: uid(), type: "arc", c: pointAt(s.c), s: a, e });
        break;
      }
      case "spline": {
        const ids = s.pts.map((p) => pointAt(p)).filter((id, i, l) => i === 0 || id !== l[i - 1]);
        let closed = s.closed;
        if (ids.length > 2 && ids[0] === ids[ids.length - 1]) {
          ids.pop();
          closed = true;
        }
        if (ids.length < (closed ? 3 : 2)) continue;
        added.push({ id: uid(), type: "spline", pts: ids, closed: closed || undefined });
        break;
      }
    }
    count++;
  }
  sk.entities.push(...added.filter((e) => e.type === "point"), ...added.filter((e) => e.type !== "point"));
  sk.constraints.push(...cons);
  return count;
}
