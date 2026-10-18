// The Select tool's ways of picking: box, crossing box, lasso, connected contour, region.
import type { SkCurve, SkEntity, SketchFeature } from "../types";
import { SketchView, isHiddenPoint, isReference, sampleCurve } from "./model";
import { findRegions, loopPolygon, pointInPolygon } from "./profiles";

type P2 = [number, number];

export type SelectMode = "box" | "crossing" | "lasso" | "contour" | "region";

/** What a box, crossing box or lasso may pick: not the axes, the origin or hidden points. */
export function selectable(e: SkEntity) {
  return !isReference(e) && !(e.type === "point" && isHiddenPoint(e.id));
}

/** A few points along an entity, to tell whether it lies inside an outline. */
export function samplePoints(v: SketchView, e: SkEntity): P2[] {
  if (e.type === "point") return [v.xy(e.id)];
  if (e.type === "line") {
    const a = v.xy(e.p1);
    const b = v.xy(e.p2);
    return [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b];
  }
  if (e.type === "circle" || e.type === "arc") {
    const c = v.xy(e.c);
    const r = e.type === "circle" ? e.r : v.arcRadius(e);
    const [t0, t1] = e.type === "circle" ? [0, Math.PI * 2] : v.arcAngles(e);
    return Array.from({ length: 9 }, (_, i): P2 => [c[0] + r * Math.cos(t0 + ((t1 - t0) * i) / 8), c[1] + r * Math.sin(t0 + ((t1 - t0) * i) / 8)]);
  }
  return sampleCurve(v, e, 6);
}

/** Whether the path through `pts` touches the box (a point inside, or a piece crossing an edge). */
export function pathTouchesBox(pts: P2[], [xa, ya, xb, yb]: [number, number, number, number]) {
  const inBox = (p: P2) => p[0] >= xa && p[0] <= xb && p[1] >= ya && p[1] <= yb;
  if (pts.some(inBox)) return true;
  const corners: P2[] = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]];
  for (let i = 0; i + 1 < pts.length; i++)
    for (let k = 0; k < 4; k++) if (segmentsCross(pts[i], pts[i + 1], corners[k], corners[(k + 1) % 4])) return true;
  return false;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2) {
  const side = (p: P2, q: P2, r: P2) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0;
}

/** The two ends of an open curve (where it joins others); none for a closed one. */
function curveEnds(e: SkCurve): string[] {
  if (e.type === "line") return [e.p1, e.p2];
  if (e.type === "arc") return [e.s, e.e];
  if (e.type === "bezier") return [e.p0, e.p3];
  if (e.type === "spline") return e.closed ? [] : [e.pts[0], e.pts[e.pts.length - 1]];
  return [];
}

/**
 * The curves joined end to end with `id` (sharing a point, or ends at the same place), of the
 * same kind (solid or construction): the whole contour one of them belongs to.
 */
export function connectedContour(sk: SketchFeature, id: string): string[] {
  const v = new SketchView(sk);
  const start = v.curves().find((c) => c.id === id);
  if (!start || isReference(start)) return [];
  const curves = v.curves().filter((c) => !isReference(c) && !!c.construction === !!start.construction);
  // Ends meet when they share a point, or sit at the same place (imported drawings).
  const place = (pid: string) => {
    const [x, y] = v.xy(pid);
    return `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
  };
  const byPlace = new Map<string, SkCurve[]>();
  for (const c of curves)
    for (const p of curveEnds(c)) {
      const k = place(p);
      byPlace.set(k, [...(byPlace.get(k) ?? []), c]);
    }
  const seen = new Set([start.id]);
  const todo = [start];
  while (todo.length) {
    const c = todo.pop()!;
    for (const p of curveEnds(c))
      for (const n of byPlace.get(place(p)) ?? [])
        if (!seen.has(n.id)) {
          seen.add(n.id);
          todo.push(n);
        }
  }
  return [...seen];
}

/** The closed outlines the selected curves make (as polygons), if any. */
export function selectionOutlines(sk: SketchFeature, sel: Set<string>): P2[][] {
  if (!sk.entities.some((e) => e.type !== "point" && sel.has(e.id))) return [];
  // The sketch with only the selected curves left solid: its regions are the selection's.
  const only: SketchFeature = { ...sk, entities: sk.entities.map((e) => (e.type !== "point" && !sel.has(e.id) ? { ...e, construction: true } : e)) };
  return findRegions(only).map((r) => loopPolygon(r.outer));
}

/**
 * The entities lying wholly inside the outline(s) the selection makes: not the outline itself,
 * nor its own points, nor the sketch's axes and origin.
 */
export function entitiesInside(sk: SketchFeature, sel: Set<string>): string[] {
  const outlines = selectionOutlines(sk, sel);
  if (!outlines.length) return [];
  const v = new SketchView(sk);
  // The outline's own points (ends of its lines and arcs, centres) are not "inside".
  const own = new Set<string>();
  for (const e of sk.entities) if (sel.has(e.id) && e.type !== "point") for (const p of v.defPoints(e)) own.add(p);
  const within = (e: SkEntity) => {
    if (sel.has(e.id) || own.has(e.id) || !selectable(e)) return false;
    const pts = samplePoints(v, e);
    return pts.length > 0 && outlines.some((poly) => pts.every((p) => pointInPolygon(p, poly)));
  };
  const curves = sk.entities.filter((e) => e.type !== "point" && within(e));
  const inCurves = new Set(curves.map((e) => e.id));
  // A point inside counts only if every curve using it is inside too (the end of a line that
  // crosses the outline is not: deleting it would break that line).
  const usedOutside = new Set<string>();
  for (const e of sk.entities) if (e.type !== "point" && !inCurves.has(e.id)) for (const p of v.defPoints(e)) usedOutside.add(p);
  const points = sk.entities.filter((e) => e.type === "point" && !usedOutside.has(e.id) && within(e));
  return [...curves, ...points].map((e) => e.id);
}

function distToPolygon(p: P2, poly: P2[]) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/**
 * The smallest closed area around `at`: its outline's curves, then everything inside it (holes,
 * text, construction…). Empty when `at` is in no closed area.
 */
export function regionAt(sk: SketchFeature, at: P2): string[] {
  let best: { poly: P2[]; area: number } | null = null;
  // A hole is an area too: tapping inside it takes the hole.
  for (const loop of findRegions(sk).flatMap((r) => [r.outer, ...r.holes])) {
    const poly = loopPolygon(loop);
    if (!pointInPolygon(at, poly)) continue;
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      area += x1 * y2 - x2 * y1;
    }
    area = Math.abs(area / 2);
    if (!best || area < best.area) best = { poly, area };
  }
  if (!best) return [];
  const { poly } = best;
  // The outline: the solid curves lying along the area's edge.
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const tol = 2e-3 * Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const v = new SketchView(sk);
  const outline = v
    .curves()
    .filter((c) => !c.construction && !isReference(c) && samplePoints(v, c).every((p) => distToPolygon(p, poly) <= tol))
    .map((c) => c.id);
  return [...outline, ...entitiesInside(sk, new Set(outline))];
}
