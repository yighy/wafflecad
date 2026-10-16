// Metric screw holes: sizes from ISO 273 (clearance), ISO 4762 (socket head, counterbore)
// and ISO 10642 (countersunk head, 90°). "Plastic" holes are pilot diameters for screwing
// straight into printed parts.
import type { HoleFeature, SketchFeature, Vec3 } from "../types";
import { SketchView } from "../sketch/model";

export const HOLE_SIZES = ["M2.5", "M3", "M4", "M5"] as const;
export type HoleSize = (typeof HOLE_SIZES)[number];

interface SizeData {
  /** Medium clearance hole. */
  clearance: number;
  /** Pilot hole for a screw cut straight into plastic. */
  plastic: number;
  counterbore: { d: number; depth: number };
  /** Countersink diameter at the surface (90° cone). */
  countersink: number;
}

export const HOLE_TABLE: Record<HoleSize, SizeData> = {
  "M2.5": { clearance: 2.9, plastic: 2.1, counterbore: { d: 5, depth: 2.7 }, countersink: 5.5 },
  M3: { clearance: 3.4, plastic: 2.5, counterbore: { d: 6.5, depth: 3.3 }, countersink: 6.7 },
  M4: { clearance: 4.5, plastic: 3.3, counterbore: { d: 8, depth: 4.4 }, countersink: 9 },
  M5: { clearance: 5.5, plastic: 4.2, counterbore: { d: 10, depth: 5.4 }, countersink: 11.2 },
};

/** Diameters of a hole, from its size and options. */
export function holeDims(f: Pick<HoleFeature, "size" | "fit" | "head">) {
  const t = HOLE_TABLE[f.size];
  return {
    d: f.fit === "plastic" ? t.plastic : t.clearance,
    counterbore: f.head === "counterbore" ? t.counterbore : null,
    countersink: f.head === "countersink" ? t.countersink : null,
  };
}

/** World positions of a sketch's free points (points not used by any curve). */
export function sketchHolePoints(sk: SketchFeature): Vec3[] {
  const v = new SketchView(sk);
  const used = new Set(v.curves().flatMap((c) => v.defPoints(c)));
  const xd = sk.plane.xDir;
  const n = sk.plane.normal;
  const yd: Vec3 = [n[1] * xd[2] - n[2] * xd[1], n[2] * xd[0] - n[0] * xd[2], n[0] * xd[1] - n[1] * xd[0]];
  return v
    .points()
    .filter((p) => !used.has(p.id) && !p.fixed)
    .map((p) => [0, 1, 2].map((i) => sk.plane.origin[i] + xd[i] * p.x + yd[i] * p.y) as Vec3);
}
