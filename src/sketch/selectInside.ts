// "Select inside": what a closed outline of the sketch encloses (holes, text, construction…).
import type { SkEntity, SketchFeature } from "../types";
import { SketchView, isHiddenPoint, isReference, sampleCurve } from "./model";
import { findRegions, loopPolygon, pointInPolygon } from "./profiles";

type P2 = [number, number];

/** The closed outlines the selected curves make (as polygons), if any. */
export function selectionOutlines(sk: SketchFeature, sel: Set<string>): P2[][] {
  if (!sk.entities.some((e) => e.type !== "point" && sel.has(e.id))) return [];
  // The sketch with only the selected curves left solid: its regions are the selection's.
  const only: SketchFeature = { ...sk, entities: sk.entities.map((e) => (e.type !== "point" && !sel.has(e.id) ? { ...e, construction: true } : e)) };
  return findRegions(only).map((r) => loopPolygon(r.outer));
}

/** A few points along an entity, to tell whether it lies inside an outline. */
function samplePoints(v: SketchView, e: SkEntity): P2[] {
  if (e.type === "point") return [v.xy(e.id)];
  if (e.type === "line") {
    const a = v.xy(e.p1);
    const b = v.xy(e.p2);
    return [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]];
  }
  if (e.type === "circle" || e.type === "arc") {
    const c = v.xy(e.c);
    const r = e.type === "circle" ? e.r : v.arcRadius(e);
    const [t0, t1] = e.type === "circle" ? [0, Math.PI * 2] : v.arcAngles(e);
    const span = t1 > t0 ? t1 - t0 : t1 - t0 + Math.PI * 2;
    return Array.from({ length: 9 }, (_, i): P2 => [c[0] + r * Math.cos(t0 + (span * i) / 8), c[1] + r * Math.sin(t0 + (span * i) / 8)]);
  }
  return sampleCurve(v, e, 6);
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
  for (const e of sk.entities)
    if (sel.has(e.id) && e.type !== "point") for (const k of ["p1", "p2", "c", "a", "b"]) if (k in e) own.add((e as unknown as Record<string, string>)[k]);
  const within = (e: SkEntity) => {
    if (sel.has(e.id) || own.has(e.id) || isReference(e) || (e.type === "point" && isHiddenPoint(e.id))) return false;
    const pts = samplePoints(v, e);
    return pts.length > 0 && outlines.some((poly) => pts.every((p) => pointInPolygon(p, poly)));
  };
  const curves = sk.entities.filter((e) => e.type !== "point" && within(e));
  const inCurves = new Set(curves.map((e) => e.id));
  // A point inside counts only if every curve using it is inside too (the end of a line that
  // crosses the outline is not: deleting it would break that line).
  const usedOutside = new Set<string>();
  for (const e of sk.entities)
    if (e.type !== "point" && !inCurves.has(e.id)) for (const k of ["p1", "p2", "c", "a", "b"]) if (k in e) usedOutside.add((e as unknown as Record<string, string>)[k]);
  const points = sk.entities.filter((e) => e.type === "point" && !usedOutside.has(e.id) && within(e));
  return [...curves, ...points].map((e) => e.id);
}
