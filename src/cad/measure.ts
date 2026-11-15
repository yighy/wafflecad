// Measurements on the built model (exact B-rep geometry, not the display mesh), and on mesh
// bodies (STL) by their flat faces and the spots tapped on them.
// No DOM dependency: runs in the worker, and is testable under Node.
import { getOC, makeVertex, measureArea, type AnyShape, type Edge, type Face, type Shape3D } from "replicad";
import { type AnySolid, flatRegion, isMesh, meshVolume, triangleAt } from "./mesh";
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
  /** A point of its plane (flat faces), and where it was tapped (meshes). */
  planeAt?: Vec3;
  tapped?: Vec3;
  /** Picked on a mesh: distances are taken from the spot tapped, or across flat faces. */
  mesh?: boolean;
  outline?: Float32Array;
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
const adaptor = (s: Face | Edge) => (s as unknown as { _geomAdaptor(): { Circle(): Circ; Cylinder(): Circ; Cone(): Circ } })._geomAdaptor();

function faceItem(face: Face): Item {
  const rows: MeasureRow[] = [{ label: "Area", value: measureArea(face), unit: "mm²" }];
  const item: Item = { shape: face, rows };
  if (face.geomType === "PLANE") {
    item.dir = { kind: "plane", d: unit(v3(face.normalAt(face.center))) };
    item.planeAt = v3(face.center);
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

/**
 * A spot tapped on a mesh body: the flat face it is on (its area), else the spot alone on a curved
 * surface; and the size of the whole body.
 */
function meshItem(body: AnySolid, p: Vec3): Item {
  if (!isMesh(body)) throw new Error("The model changed: pick again");
  const r = flatRegion(body, triangleAt(body, p));
  const [lo, hi] = body.bounds();
  const rows: MeasureRow[] = [];
  if (!r.curved) rows.push({ label: "Flat face area", value: r.area, unit: "mm²" });
  rows.push(
    { label: "Mesh size X", value: hi[0] - lo[0], unit: "mm" },
    { label: "Mesh size Y", value: hi[1] - lo[1], unit: "mm" },
    { label: "Mesh size Z", value: hi[2] - lo[2], unit: "mm" },
  );
  if (body.closed) rows.push({ label: "Mesh volume", value: meshVolume(body), unit: "mm³" });
  const item: Item = { shape: makeVertex(p), rows, tapped: p, mesh: true };
  if (!r.curved) {
    item.dir = { kind: "plane", d: r.normal };
    item.planeAt = r.point;
    item.outline = r.outline;
  }
  return item;
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
export function measure(shape: Shape3D | null, picks: MeasurePick[], bodies: { id: string; shape: AnySolid }[] = []): MeasureResult {
  if (!shape && !bodies.some((b) => isMesh(b.shape))) return { rows: [], error: "There is no solid" };
  const items: Item[] = [];
  for (const pk of picks) {
    if (pk.kind === "point") items.push(pointItem(pk.p));
    else if (pk.kind === "mesh") {
      const body = bodies.find((b) => b.id === pk.body)?.shape;
      if (!body) return { rows: [], error: "The model changed: pick again" };
      items.push(meshItem(body, pk.p));
    } else if (!shape) return { rows: [], error: "The model changed: pick again" };
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
  const outlines = items.flatMap((i) => (i.outline ? [...i.outline] : []));
  const extra = outlines.length ? { outlines } : {};
  if (items.length === 1) return { rows: items[0].rows, ...extra };
  if (items.length !== 2) return { rows: [] };
  const [a, b] = items;
  if (a.mesh || b.mesh) return { ...meshDistance(a, b), ...extra };
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

/**
 * Between two picks, one at least on a mesh. Two parallel flat faces: the gap between their
 * planes, from the spot tapped. Otherwise the shortest distance from the spot tapped on the mesh
 * (and, to a point, its distance from the mesh's flat face).
 */
function meshDistance(a: Item, b: Item): MeasureResult {
  const rows: MeasureRow[] = [];
  let line: [Vec3, Vec3];
  const from = (i: Item) => i.tapped ?? i.point ?? i.planeAt ?? i.centre;
  if (a.dir?.kind === "plane" && b.dir?.kind === "plane" && a.planeAt && b.planeAt && Math.abs(dot(a.dir.d, b.dir.d)) > 1 - 1e-6) {
    const n = a.dir.d;
    const gap = dot([b.planeAt[0] - a.planeAt[0], b.planeAt[1] - a.planeAt[1], b.planeAt[2] - a.planeAt[2]], n);
    rows.push({ label: "Distance", value: Math.abs(gap), unit: "mm" });
    // Drawn from the spot tapped on the mesh straight across to the other plane.
    const [mine, other] = a.mesh ? [a, b] : [b, a];
    const s = from(mine)!;
    const k = dot([s[0] - other.planeAt![0], s[1] - other.planeAt![1], s[2] - other.planeAt![2]], n);
    line = [s, [s[0] - n[0] * k, s[1] - n[1] * k, s[2] - n[2] * k]];
  } else {
    const c = closest(a.shape, b.shape);
    rows.push({ label: "Distance", value: c.d, unit: "mm" });
    line = [c.p, c.q];
    const [plane, pt] = a.dir?.kind === "plane" && a.mesh && b.point ? [a, b.point] : b.dir?.kind === "plane" && b.mesh && a.point ? [b, a.point] : [null, null];
    if (plane?.dir && plane.planeAt && pt) {
      const off = dot([pt[0] - plane.planeAt[0], pt[1] - plane.planeAt[1], pt[2] - plane.planeAt[2]], plane.dir.d);
      rows.push({ label: "Distance to the flat face's plane", value: Math.abs(off), unit: "mm" });
    }
  }
  if (a.dir && b.dir) rows.push({ label: "Angle", value: angle(a.dir, b.dir), unit: "°" });
  return { rows, line };
}

/** A plane (a flat face) or an axis (a round face or edge), for a mate. */
type RefGeom = { kind: "plane" | "axis"; origin: Vec3; dir: Vec3 };

function faceRef(face: Face): RefGeom | null {
  if (face.geomType === "PLANE") return { kind: "plane", origin: v3(face.center), dir: unit(v3(face.normalAt(face.center))) };
  if (face.geomType === "CYLINDRE" || face.geomType === "CONE") {
    const c = adaptor(face)[face.geomType === "CONE" ? "Cone" : "Cylinder"]();
    return { kind: "axis", origin: gp(c.Location()), dir: unit(gp(c.Axis().Direction())) };
  }
  return null;
}

function edgeRef(edge: Edge): RefGeom | null {
  if (edge.geomType === "CIRCLE") {
    const c = adaptor(edge).Circle();
    return { kind: "axis", origin: gp(c.Location()), dir: unit(gp(c.Axis().Direction())) };
  }
  // Straight edges are left out: a tap near one means the face beside it.
  return null;
}

/** The plane or axis of a face or edge of the model, or null for shapes that have none. */
export function refGeometry(shape: Shape3D | null, pick: Extract<MeasurePick, { kind: "face" | "edge" }>): RefGeom | null {
  if (!shape) return null;
  if (pick.kind === "face") {
    const f = shape.faces.find((x) => x.hashCode === pick.id);
    return f ? faceRef(f) : null;
  }
  const e = shape.edges.find((x) => x.hashCode === pick.id);
  return e ? edgeRef(e) : null;
}

/**
 * The plane of the flat face of a mesh body around a spot tapped on it (origin: the middle of
 * that face), or null on a curved surface.
 */
export function meshRef(body: AnySolid | undefined, p: Vec3): RefGeom | null {
  if (!isMesh(body)) return null;
  const r = flatRegion(body, triangleAt(body, p));
  if (r.curved) return null;
  // The middle of its border's points, put back on the plane.
  const o = r.outline;
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < o.length; i += 3) for (let k = 0; k < 3; k++) c[k] += o[i + k] / (o.length / 3);
  const off = dot([c[0] - r.point[0], c[1] - r.point[1], c[2] - r.point[2]], r.normal);
  return { kind: "plane", origin: [c[0] - r.normal[0] * off, c[1] - r.normal[1] * off, c[2] - r.normal[2] * off], dir: r.normal };
}

/** Whether a part still has the plane or axis a mate uses (its own coordinates). */
export function hasRef(shape: Shape3D, ref: Omit<RefGeom, "kind"> & { kind: string }): boolean {
  const close = (g: RefGeom | null) => {
    if (!g || g.kind !== ref.kind) return false;
    const off: Vec3 = [g.origin[0] - ref.origin[0], g.origin[1] - ref.origin[1], g.origin[2] - ref.origin[2]];
    if (ref.kind === "plane") return dot(g.dir, ref.dir) > 1 - 1e-6 && Math.abs(dot(off, ref.dir)) < 1e-3;
    if (Math.abs(dot(g.dir, ref.dir)) < 1 - 1e-6) return false;
    const along = dot(off, ref.dir);
    return Math.hypot(off[0] - along * ref.dir[0], off[1] - along * ref.dir[1], off[2] - along * ref.dir[2]) < 1e-3;
  };
  return shape.faces.some((f) => close(faceRef(f))) || (ref.kind === "axis" && shape.edges.some((e) => close(edgeRef(e))));
}
