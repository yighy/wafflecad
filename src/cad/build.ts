// Geometric core: replays the feature list with replicad (OpenCascade).
// No DOM dependency: used by the worker, and testable under Node.
import { EdgeFinder, FaceFinder, Plane, Vector, basicFaceExtrusion, draw, drawCircle, type Drawing, type Face, type Shape3D } from "replicad";
import type { Axis, BuildResult, CadDocument, EdgeGroup, ExtrudeFeature, RevolveFeature, FaceRef, FilletFeature, HoleFeature, PatternFeature, PlanarFace, PlaneDef, ProfileLoop, PushPullFeature, ShellFeature, SketchFeature, Vec3 } from "../types";
import { holeDims, sketchHolePoints } from "./holes";
import { sketchLineWorld } from "../sketch/model";
import { findRegions } from "../sketch/profiles";

const MESH_OPTS = { tolerance: 0.01, angularTolerance: 0.1 };

function loopDrawing(loop: ProfileLoop): Drawing {
  if (loop.kind === "circle") return drawCircle(loop.r).translate(loop.c[0], loop.c[1]);
  const pen = draw(loop.segments[0].a);
  const n = loop.segments.length;
  loop.segments.forEach((s, i) => {
    if (s.kind === "arc") pen.threePointsArcTo(s.b, s.mid);
    else if (i < n - 1) pen.lineTo(s.b);
  });
  return pen.close();
}

export function sketchDrawing(sk: SketchFeature): Drawing | null {
  let result: Drawing | null = null;
  for (const region of findRegions(sk)) {
    let d = loopDrawing(region.outer);
    for (const h of region.holes) d = d.cut(loopDrawing(h));
    result = result ? result.fuse(d) : d;
  }
  return result;
}

const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function extrudeSolid(sk: SketchFeature, f: ExtrudeFeature): Shape3D {
  const drawing = sketchDrawing(sk);
  if (!drawing) throw new Error("The sketch has no closed region");
  const d = Math.abs(f.distance);
  if (d < 1e-6) throw new Error("Distance is zero");
  const n = sk.plane.normal;
  const dir = f.distance < 0 ? scale(n, -1) : n;
  const origin = f.symmetric ? add(sk.plane.origin, scale(dir, -d)) : sk.plane.origin;
  const plane = new Plane(origin, sk.plane.xDir, n);
  const sketch = drawing.sketchOnPlane(plane);
  return sketch.extrude(f.symmetric ? 2 * d : d, { extrusionDirection: dir }) as Shape3D;
}

function revolveSolid(sk: SketchFeature, f: RevolveFeature): Shape3D {
  const drawing = sketchDrawing(sk);
  if (!drawing) throw new Error("The sketch has no closed region");
  if (Math.abs(f.angle) < 1e-6) throw new Error("The angle is zero");
  if (Math.abs(f.angle) > 360) throw new Error("The angle is more than a full turn");
  const [a, b] = sketchLineWorld(sk, f.axisLine);
  const dir = add(b, scale(a, -1));
  const len = Math.hypot(...dir);
  if (len < 1e-9) throw new Error("The axis line has no length");
  const axis = scale(dir, 1 / len);
  const sketch = drawing.sketchOnPlane(new Plane(sk.plane.origin, sk.plane.xDir, sk.plane.normal));
  let solid: Shape3D;
  try {
    solid = (sketch as unknown as { revolve: (ax: Vec3, o: { origin: Vec3; angle: number }) => Shape3D }).revolve(axis, { origin: a, angle: f.angle });
  } catch {
    throw new Error("Cannot revolve: the profile must stay on one side of the axis");
  }
  return f.symmetric && Math.abs(f.angle) < 360 ? solid.rotate(-f.angle / 2, a, axis) : solid;
}

/** The flat face containing `ref.center` with the same outward normal, or an error. */
export function findFace(shape: Shape3D, ref: FaceRef): Face {
  const candidates = new FaceFinder().containsPoint(ref.center).find(shape);
  for (const f of candidates) {
    if (f.geomType !== "PLANE") continue;
    const n = f.normalAt(ref.center);
    if (dot([n.x, n.y, n.z], ref.normal) > 0.999) return f;
  }
  throw new Error("The face is no longer there (an earlier feature changed it)");
}

/** The prism swept by the face; added when pulled out, removed when pushed in. */
function pushPullTool(shape: Shape3D, f: PushPullFeature): Tool {
  if (Math.abs(f.distance) < 1e-6) throw new Error("Distance is zero");
  const face = findFace(shape, f.face);
  const prism = basicFaceExtrusion(face, new Vector(scale(f.face.normal, f.distance)));
  return { solid: prism, op: f.distance > 0 ? "add" : "cut" };
}

function shell(shape: Shape3D, f: ShellFeature): Shape3D {
  if (!f.faces.length) throw new Error("Choose at least one face to open");
  if (f.thickness <= 0) throw new Error("The thickness must be positive");
  for (const ref of f.faces) findFace(shape, ref);
  // Positive thickness: the walls grow inwards, the outside keeps its size.
  return shape.shell(f.thickness, (finder) => finder.either(f.faces.map((ref) => (g: FaceFinder) => g.containsPoint(ref.center))));
}

/** Distance (mm) between a stored edge midpoint and the edge it designates. */
const EDGE_MATCH_TOL = 0.05;

function fillet(shape: Shape3D, f: FilletFeature): Shape3D {
  if (!f.edges.length) throw new Error("Choose at least one edge");
  if (f.radius <= 0) throw new Error(f.mode === "fillet" ? "The radius must be positive" : "The distance must be positive");
  for (const e of f.edges) {
    if (!new EdgeFinder().withinDistance(EDGE_MATCH_TOL, e.mid).find(shape).length)
      throw new Error("An edge is no longer there (an earlier feature changed it)");
  }
  const filter = new EdgeFinder().either(f.edges.map((e) => (g: EdgeFinder) => g.withinDistance(EDGE_MATCH_TOL, e.mid)));
  try {
    return f.mode === "fillet" ? shape.fillet({ filter, radius: f.radius }) : shape.chamfer({ filter, radius: f.radius });
  } catch {
    throw new Error(`${f.mode === "fillet" ? "Radius" : "Distance"} too large for these edges`);
  }
}

/** One hole as a solid of revolution: profile (radius, depth) turned around the drilling axis. */
function holeTool(p: Vec3, dir: Vec3, f: HoleFeature, length: number): Shape3D {
  const { d, counterbore, countersink } = holeDims(f);
  const r = d / 2;
  const e = 0.05; // start just above the surface so the cut is clean
  const prof: [number, number][] = [[0, -e]];
  if (counterbore) prof.push([counterbore.d / 2, -e], [counterbore.d / 2, counterbore.depth], [r, counterbore.depth]);
  else if (countersink) prof.push([countersink / 2 + e, -e], [r, countersink / 2 - r]);
  else prof.push([r, -e]);
  prof.push([r, length], [0, length]);
  // A plane containing the axis: x = radial direction, y = drilling direction.
  let u: Vec3 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  u = add(u, scale(dir, -dot(u, dir)));
  u = scale(u, 1 / Math.hypot(...u));
  const normal: Vec3 = [u[1] * dir[2] - u[2] * dir[1], u[2] * dir[0] - u[0] * dir[2], u[0] * dir[1] - u[1] * dir[0]];
  const pen = draw(prof[0]);
  for (const q of prof.slice(1)) pen.lineTo(q);
  const sketch = pen.close().sketchOnPlane(new Plane(p, u, normal));
  return (sketch as unknown as { revolve: (axis: Vec3, o: { origin: Vec3 }) => Shape3D }).revolve(dir, { origin: p });
}

function holes(shape: Shape3D, f: HoleFeature, sketches: Map<string, SketchFeature>): { shape: Shape3D; tool: Shape3D } {
  let pts: Vec3[];
  if (f.sketchId) {
    const sk = sketches.get(f.sketchId);
    if (!sk) throw new Error("Sketch not found");
    pts = sketchHolePoints(sk);
    if (!pts.length) throw new Error("The sketch has no free points to drill at");
  } else pts = f.points ?? [];
  if (!pts.length) throw new Error("No hole position");
  const sign = f.flip ? 1 : -1;
  const dir = scale(f.normal, sign / Math.hypot(...f.normal));
  const bb = shape.boundingBox;
  const through = Math.hypot(bb.width, bb.height, bb.depth) * 2 + 10;
  if (f.depth < 0) throw new Error("The depth must be positive");
  const length = f.depth > 0 ? f.depth : through;
  const tool = fuseAll(pts.map((p) => holeTool(p, dir, f, length)));
  return { shape: shape.cut(tool), tool };
}

/** The material a feature adds or removes, kept so patterns can repeat it. */
interface Tool {
  solid: Shape3D;
  op: "add" | "cut";
}

const AXIS: Record<Axis, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const MIRROR_PLANE: Record<Axis, "YZ" | "XZ" | "XY"> = { X: "YZ", Y: "XZ", Z: "XY" };

/** Copies of a solid for each instance of the pattern (the original excluded). */
function patternCopies(solid: Shape3D, f: PatternFeature): Shape3D[] {
  const out: Shape3D[] = [];
  if (f.type === "mirror") {
    out.push(solid.clone().mirror(MIRROR_PLANE[f.axis], scale(AXIS[f.axis], f.offset)));
    return out;
  }
  const n = Math.round(f.count);
  if (n < 1 || n > 200) throw new Error("The count must be between 1 and 200");
  if (f.type === "circular") {
    if (n < 2) throw new Error("A circular pattern needs at least 2 instances");
    const full = Math.abs(Math.abs(f.angle) - 360) < 1e-9;
    const step = full ? 360 / n : f.angle / (n - 1);
    for (let i = 1; i < n; i++) out.push(solid.clone().rotate(step * i, [0, 0, 0], AXIS[f.axis]));
    return out;
  }
  const n2 = Math.max(1, Math.round(f.count2));
  if (n2 > 200 || n * n2 > 400) throw new Error("Too many instances (400 at most)");
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n2; j++) {
      if (i === 0 && j === 0) continue;
      out.push(solid.clone().translate(add(scale(AXIS[f.axis], f.spacing * i), scale(AXIS[f.axis2], f.spacing2 * j))));
    }
  }
  return out;
}

function fuseAll(parts: Shape3D[]): Shape3D {
  return parts.slice(1).reduce((acc, p) => acc.fuse(p), parts[0]);
}

function pattern(shape: Shape3D, f: PatternFeature, tools: Map<string, Tool>, names: Map<string, string>): { shape: Shape3D; tool: Tool | null } {
  if (f.type === "mirror" && !f.featureIds.length) {
    // Whole solid: mirror it and join both halves.
    return { shape: shape.fuse(shape.clone().mirror(MIRROR_PLANE[f.axis], scale(AXIS[f.axis], f.offset))), tool: null };
  }
  if (!f.featureIds.length) throw new Error("Choose the features to repeat");
  let result = shape;
  const made: Record<"add" | "cut", Shape3D[]> = { add: [], cut: [] };
  for (const id of f.featureIds) {
    const t = tools.get(id);
    if (!t) throw new Error(`${names.get(id) ?? "This feature"} cannot be repeated (only extrusions, Press Pull, holes and patterns)`);
    made[t.op].push(t.solid);
    for (const c of patternCopies(t.solid, f)) {
      result = t.op === "add" ? result.fuse(c) : result.cut(c);
      made[t.op].push(c);
    }
  }
  // A pattern made of a single kind of operation can itself be repeated (e.g. mirrored).
  const ops = (["add", "cut"] as const).filter((o) => made[o].length);
  const tool = ops.length === 1 ? { op: ops[0], solid: fuseAll(made[ops[0]]) } : null;
  return { shape: result, tool };
}

/** Replays the features; a failing feature is skipped and reported. */
export function buildShape(doc: CadDocument) {
  let shape: Shape3D | null = null;
  const errors: Record<string, string> = {};
  const sketches = new Map<string, SketchFeature>();
  const tools = new Map<string, Tool>();
  const names = new Map(doc.features.map((f) => [f.id, f.name]));
  for (const f of doc.features) {
    if (f.kind === "pattern") {
      try {
        if (!shape) throw new Error("There is no solid yet");
        const r = pattern(shape, f, tools, names);
        shape = r.shape.simplify();
        if (r.tool) tools.set(f.id, r.tool);
      } catch (e) {
        errors[f.id] = e instanceof Error ? e.message : String(e);
      }
      continue;
    }
    if (f.kind === "sketch") {
      sketches.set(f.id, f);
      continue;
    }
    if (f.kind === "hole") {
      try {
        if (!shape) throw new Error("There is no solid yet");
        const r = holes(shape, f, sketches);
        shape = r.shape.simplify();
        tools.set(f.id, { op: "cut", solid: r.tool });
      } catch (e) {
        errors[f.id] = e instanceof Error ? e.message : String(e);
      }
      continue;
    }
    if (f.kind === "pushpull" || f.kind === "shell" || f.kind === "fillet") {
      try {
        if (!shape) throw new Error("There is no solid yet");
        let next: Shape3D;
        if (f.kind === "pushpull") {
          const t = pushPullTool(shape, f);
          next = t.op === "add" ? shape.fuse(t.solid) : shape.cut(t.solid);
          tools.set(f.id, t);
        } else next = f.kind === "shell" ? shell(shape, f) : fillet(shape, f);
        // Simplifying after a fillet would merge its faces with flat neighbours: skip it there.
        shape = f.kind === "fillet" ? next : next.simplify();
      } catch (e) {
        errors[f.id] = e instanceof Error ? e.message : String(e);
      }
      continue;
    }
    try {
      const sk = sketches.get(f.sketchId);
      if (!sk) throw new Error("Sketch not found");
      const solid = f.kind === "revolve" ? revolveSolid(sk, f) : extrudeSolid(sk, f);
      if (f.op !== "intersect") tools.set(f.id, { solid, op: f.op });
      if (f.op === "add" || !shape) {
        if (f.op !== "add") throw new Error("Nothing to " + f.op);
        shape = shape ? shape.fuse(solid) : solid;
      } else if (f.op === "cut") shape = shape.cut(solid);
      else shape = shape.intersect(solid);
      shape = shape.simplify();
    } catch (e) {
      errors[f.id] = e instanceof Error ? e.message : String(e);
    }
  }
  return { shape, errors };
}

export function buildResult(doc: CadDocument): BuildResult {
  const { shape, errors } = buildShape(doc);
  if (!shape) return { mesh: null, edges: new Float32Array(), edgeGroups: [], planarFaces: [], errors };
  const m = shape.mesh(MESH_OPTS);
  const e = shape.meshEdges(MESH_OPTS);
  return {
    mesh: {
      vertices: new Float32Array(m.vertices),
      normals: new Float32Array(m.normals),
      triangles: new Uint32Array(m.triangles),
      faceGroups: m.faceGroups,
    },
    edges: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((g): EdgeGroup => ({ start: g.start, count: g.count, mid: polylineMid(e.lines, g.start, g.count) })),
    planarFaces: planarFaces(shape),
    errors,
  };
}

/** Planes of the flat faces, so a sketch can be started on them. */
function planarFaces(shape: Shape3D): PlanarFace[] {
  const out: PlanarFace[] = [];
  for (const face of shape.faces) {
    const faceId = face.hashCode;
    if (face.geomType !== "PLANE") continue;
    const c = face.center;
    const nv = face.normalAt(c);
    const normal: Vec3 = [nv.x, nv.y, nv.z];
    const center: Vec3 = [c.x, c.y, c.z];
    // Keep the world origin's projection as sketch origin, so dimensions read naturally.
    const origin = scale(normal, dot(center, normal));
    let xDir: Vec3 = [1, 0, 0];
    if (Math.abs(dot(xDir, normal)) > 0.9) xDir = [0, 1, 0];
    xDir = add(xDir, scale(normal, -dot(xDir, normal)));
    const len = Math.hypot(...xDir);
    out.push({ faceId, center: interiorPoint(face, center), plane: { origin, xDir: scale(xDir, 1 / len), normal, label: "Face" } satisfies PlaneDef });
  }
  return out;
}

/** Point at half the length of an edge polyline (within the mesh tolerance of the real edge). */
function polylineMid(lines: number[], start: number, count: number): Vec3 {
  const seg = lines.slice(start * 3, (start + count) * 3);
  const n = seg.length / 6;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 6;
    const l = Math.hypot(seg[j + 3] - seg[j], seg[j + 4] - seg[j + 1], seg[j + 5] - seg[j + 2]);
    lengths.push(l);
    total += l;
  }
  let target = total / 2;
  for (let i = 0; i < n; i++) {
    const j = i * 6;
    if (target <= lengths[i] || i === n - 1) {
      const t = lengths[i] > 0 ? Math.min(target / lengths[i], 1) : 0;
      return [seg[j] + (seg[j + 3] - seg[j]) * t, seg[j + 1] + (seg[j + 4] - seg[j + 1]) * t, seg[j + 2] + (seg[j + 5] - seg[j + 2]) * t];
    }
    target -= lengths[i];
  }
  return [seg[0], seg[1], seg[2]];
}

/**
 * A point inside a flat face. The centre of mass can fall outside (an L-shaped or ring face):
 * then a point of the face's own mesh, at a triangle centre, is used instead.
 */
function interiorPoint(face: Face, center: Vec3): Vec3 {
  if (new FaceFinder().containsPoint(center).find(face).length) return center;
  const m = face.mesh({ tolerance: 0.1, angularTolerance: 0.5 });
  let best: Vec3 = center;
  let bestArea = -1;
  for (let i = 0; i < m.triangles.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => m.triangles[i + k] * 3).map((j) => [m.vertices[j], m.vertices[j + 1], m.vertices[j + 2]] as Vec3);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
    if (area > bestArea) {
      bestArea = area;
      best = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    }
  }
  return best;
}

export function exportFile(doc: CadDocument, format: "step" | "stl"): Blob | null {
  const { shape } = buildShape(doc);
  if (!shape) return null;
  return format === "stl" ? shape.blobSTL({ ...MESH_OPTS, binary: true }) : shape.blobSTEP();
}
