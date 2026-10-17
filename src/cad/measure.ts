// Measurements on the built model (exact B-rep geometry, not the display mesh).
// No DOM dependency: runs in the worker, and is testable under Node.
import { getOC, makeVertex, measureArea, type AnyShape, type Edge, type Face, type Shape3D } from "replicad";
import type { MeasurePick, MeasureResult, MeasureRow, Vec3 } from "../types";

type Dir = { kind: "plane" | "line"; d: Vec3 };

interface Item {
  shape: AnyShape;
  rows: MeasureRow[];
  /** Normal of a flat face, direction of a straight edge or of a cylinder's axis. */
  dir?: Dir;
  /** Centre of a circle (or of a point). */
  centre?: Vec3;
  point?: Vec3;
}

const v3 = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const gp = (p: { X(): number; Y(): number; Z(): number }): Vec3 => [p.X(), p.Y(), p.Z()];

// The OpenCascade adaptors behind replicad's faces and edges (circle and cylinder data).
interface Circ {
  Radius(): number;
  Location(): { X(): number; Y(): number; Z(): number };
  Axis(): { Direction(): { X(): number; Y(): number; Z(): number } };
}
const adaptor = (s: Face | Edge) => (s as unknown as { _geomAdaptor(): { Circle(): Circ; Cylinder(): Circ } })._geomAdaptor();

function faceItem(face: Face): Item {
  const rows: MeasureRow[] = [{ label: "Area", value: measureArea(face), unit: "mm²" }];
  const item: Item = { shape: face, rows };
  if (face.geomType === "PLANE") {
    item.dir = { kind: "plane", d: unit(v3(face.normalAt(face.center))) };
  } else if (face.geomType === "CYLINDRE") {
    const c = adaptor(face).Cylinder();
    rows.unshift({ label: "Radius", value: c.Radius(), unit: "mm" }, { label: "Diameter", value: 2 * c.Radius(), unit: "mm" });
    item.dir = { kind: "line", d: unit(gp(c.Axis().Direction())) };
  }
  return item;
}

function edgeItem(edge: Edge): Item {
  const rows: MeasureRow[] = [{ label: "Length", value: edge.length, unit: "mm" }];
  const item: Item = { shape: edge, rows };
  if (edge.geomType === "LINE") {
    item.dir = { kind: "line", d: unit(v3(edge.tangentAt(0.5))) };
  } else if (edge.geomType === "CIRCLE") {
    const c = adaptor(edge).Circle();
    rows.unshift({ label: "Radius", value: c.Radius(), unit: "mm" }, { label: "Diameter", value: 2 * c.Radius(), unit: "mm" });
    item.centre = gp(c.Location());
    item.dir = { kind: "plane", d: unit(gp(c.Axis().Direction())) };
  }
  return item;
}

function pointItem(p: Vec3): Item {
  return {
    shape: makeVertex(p),
    point: p,
    centre: p,
    rows: [
      { label: "X", value: p[0], unit: "mm" },
      { label: "Y", value: p[1], unit: "mm" },
      { label: "Z", value: p[2], unit: "mm" },
    ],
  };
}

/** Shortest distance between two shapes, with the two closest points. */
function closest(a: AnyShape, b: AnyShape): { d: number; p: Vec3; q: Vec3 } {
  const oc = getOC();
  const t = new oc.BRepExtrema_DistShapeShape();
  try {
    t.LoadS1(a.wrapped);
    t.LoadS2(b.wrapped);
    t.Perform();
    return { d: t.Value(), p: gp(t.PointOnShape1(1)), q: gp(t.PointOnShape2(1)) };
  } finally {
    t.delete();
  }
}

/** Angle between two directions (faces by their normals, lines by their direction), 0–90°. */
function angle(a: Dir, b: Dir) {
  const c = Math.min(1, Math.abs(dot(a.d, b.d)));
  const between = (Math.acos(c) * 180) / Math.PI;
  return a.kind === b.kind ? between : 90 - between;
}

/**
 * One pick: its own sizes. Two picks: the distance between them (with the closest points, to
 * draw), centre to centre for circles and points, the X/Y/Z offsets of two points, and the angle
 * between flat faces and straight edges.
 */
export function measure(shape: Shape3D | null, picks: MeasurePick[]): MeasureResult {
  if (!shape) return { rows: [], error: "There is no solid" };
  const items: Item[] = [];
  for (const pk of picks) {
    if (pk.kind === "point") items.push(pointItem(pk.p));
    else if (pk.kind === "face") {
      const f = shape.faces.find((x) => x.hashCode === pk.id);
      if (!f) return { rows: [], error: "The model changed: pick again" };
      items.push(faceItem(f));
    } else {
      const e = shape.edges.find((x) => x.hashCode === pk.id);
      if (!e) return { rows: [], error: "The model changed: pick again" };
      items.push(edgeItem(e));
    }
  }
  if (items.length === 1) return { rows: items[0].rows };
  if (items.length !== 2) return { rows: [] };
  const [a, b] = items;
  const rows: MeasureRow[] = [];
  let line: [Vec3, Vec3] | undefined;
  if (a.centre && b.centre && !(a.point && b.point)) {
    const d = Math.hypot(b.centre[0] - a.centre[0], b.centre[1] - a.centre[1], b.centre[2] - a.centre[2]);
    rows.push({ label: "Centre distance", value: d, unit: "mm" });
    line = [a.centre, b.centre];
  }
  const c = closest(a.shape, b.shape);
  rows.push({ label: rows.length ? "Shortest distance" : "Distance", value: c.d, unit: "mm" });
  line ??= [c.p, c.q];
  if (a.point && b.point) {
    rows.push(
      { label: "ΔX", value: Math.abs(b.point[0] - a.point[0]), unit: "mm" },
      { label: "ΔY", value: Math.abs(b.point[1] - a.point[1]), unit: "mm" },
      { label: "ΔZ", value: Math.abs(b.point[2] - a.point[2]), unit: "mm" },
    );
  }
  if (a.dir && b.dir) rows.push({ label: "Angle", value: angle(a.dir, b.dir), unit: "°" });
  return { rows, line };
}
