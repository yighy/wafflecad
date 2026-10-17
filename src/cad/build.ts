// Geometric core: replays the feature list with replicad (OpenCascade).
// No DOM dependency: used by the worker, and testable under Node.
import { EdgeFinder, FaceFinder, Plane, Vector, basicFaceExtrusion, draw, drawCircle, makeCompound, makeVertex, measureDistanceBetween, type Drawing, type Face, type Shape3D } from "replicad";
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
    else if (s.kind === "bezier") pen.cubicBezierCurveTo(s.b, s.c1, s.c2);
    else if (i < n - 1) pen.lineTo(s.b);
  });
  return pen.close();
}

/** One drawing per closed region (its holes cut out). Regions never overlap. */
function regionDrawings(sk: SketchFeature): Drawing[] {
  return findRegions(sk).map((region) => {
    let d = loopDrawing(region.outer);
    for (const h of region.holes) d = d.cut(loopDrawing(h));
    return d;
  });
}

export function sketchDrawing(sk: SketchFeature): Drawing | null {
  const parts = regionDrawings(sk);
  return parts.length ? parts.slice(1).reduce((acc, d) => acc.fuse(d), parts[0]) : null;
}

const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Each region is extruded on its own and the solids are gathered without any boolean: they
 * cannot overlap. (Fusing many regions in 2D first cost seconds on imported drawings.)
 */
function extrudeSolid(sk: SketchFeature, f: ExtrudeFeature): Shape3D {
  const parts = regionDrawings(sk);
  if (!parts.length) throw new Error("The sketch has no closed region (an outline is open, or its ends do not meet)");
  const d = Math.abs(f.distance);
  if (d < 1e-6) throw new Error("Distance is zero");
  const n = sk.plane.normal;
  const dir = f.distance < 0 ? scale(n, -1) : n;
  const origin = f.symmetric ? add(sk.plane.origin, scale(dir, -d)) : sk.plane.origin;
  const plane = new Plane(origin, sk.plane.xDir, n);
  const solids = parts.map((p) => p.sketchOnPlane(plane).extrude(f.symmetric ? 2 * d : d, { extrusionDirection: dir }) as Shape3D);
  return solids.length === 1 ? solids[0] : (makeCompound(solids) as Shape3D);
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

/** Called when a reference had to be found again after an earlier change moved it. */
let noteMoved: (() => void) | null = null;

/** How far a referenced face or edge may have moved and still be found: a share of the model's size. */
function moveLimit(shape: Shape3D) {
  const [lo, hi] = shape.boundingBox.bounds;
  return 0.3 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/**
 * The flat face containing `ref.center` with the same outward normal. If an earlier change
 * moved it (a taller block, a longer extrusion…), the closest flat face facing the same way.
 */
export function findFace(shape: Shape3D, ref: FaceRef): Face {
  const candidates = new FaceFinder().containsPoint(ref.center).find(shape);
  for (const f of candidates) {
    if (f.geomType !== "PLANE") continue;
    const n = f.normalAt(ref.center);
    if (dot([n.x, n.y, n.z], ref.normal) > 0.999) return f;
  }
  const at = makeVertex(ref.center);
  let best: { face: Face; d: number } | null = null;
  for (const f of shape.faces) {
    if (f.geomType !== "PLANE") continue;
    const n = f.normalAt();
    if (dot([n.x, n.y, n.z], ref.normal) < 0.999) continue;
    const d = measureDistanceBetween(f, at);
    if (!best || d < best.d) best = { face: f, d };
  }
  if (best && best.d <= moveLimit(shape)) {
    noteMoved?.();
    return best.face;
  }
  throw new Error("The face is no longer there (an earlier feature changed it)");
}

/** A point inside the face that `ref` designates now (see findFace). */
function faceAnchor(shape: Shape3D, ref: FaceRef): Vec3 {
  const face = findFace(shape, ref);
  const c = face.center;
  return interiorPoint(face, [c.x, c.y, c.z]);
}

/** The point to look an edge up by: its stored midpoint, or a point of the closest edge if it moved. */
function edgeAnchor(shape: Shape3D, mid: Vec3): Vec3 {
  if (new EdgeFinder().withinDistance(EDGE_MATCH_TOL, mid).find(shape).length) return mid;
  const at = makeVertex(mid);
  let best: { p: Vec3; d: number } | null = null;
  for (const e of shape.edges) {
    const d = measureDistanceBetween(e, at);
    if (!best || d < best.d) {
      const p = e.pointAt(0.5);
      best = { p: [p.x, p.y, p.z], d };
    }
  }
  if (best && best.d <= moveLimit(shape)) {
    noteMoved?.();
    return best.p;
  }
  throw new Error("An edge is no longer there (an earlier feature changed it)");
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
  const anchors = f.faces.map((ref) => faceAnchor(shape, ref));
  // Positive thickness: the walls grow inwards, the outside keeps its size.
  return shape.shell(f.thickness, (finder) => finder.either(anchors.map((p) => (g: FaceFinder) => g.containsPoint(p))));
}

/** Distance (mm) between a stored edge midpoint and the edge it designates. */
const EDGE_MATCH_TOL = 0.05;

function fillet(shape: Shape3D, f: FilletFeature): Shape3D {
  if (!f.edges.length) throw new Error("Choose at least one edge");
  if (f.radius <= 0) throw new Error(f.mode === "fillet" ? "The radius must be positive" : "The distance must be positive");
  const anchors = f.edges.map((e) => edgeAnchor(shape, e.mid));
  const filter = new EdgeFinder().either(anchors.map((p) => (g: EdgeFinder) => g.withinDistance(EDGE_MATCH_TOL, p)));
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
/** Everything the replay carries from one step to the next. */
interface ReplayState {
  shape: Shape3D | null;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  sketches: Map<string, SketchFeature>;
  tools: Map<string, Tool>;
}

/**
 * States after each step, keyed by the steps that led there. Editing a step (dragging Press
 * Pull, typing a fillet radius…) then only replays from that step on: the earlier ones are
 * taken from here. Shapes are never changed in place (operations return new ones), so sharing
 * them is safe.
 */
const stepCache = new Map<string, ReplayState>();
const STEP_CACHE_MAX = 150;

/** Short hash of a string (FNV-1a, two 32-bit halves). */
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x1234567;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

const snapshot = (st: ReplayState): ReplayState => ({
  shape: st.shape,
  errors: { ...st.errors },
  warnings: { ...st.warnings },
  sketches: new Map(st.sketches),
  tools: new Map(st.tools),
});

/** Replays the features (from the cache where possible); a failing feature is skipped and reported. */
export function buildShape(doc: CadDocument) {
  const names = new Map(doc.features.map((f) => [f.id, f.name]));
  const keys: string[] = [];
  let key = "";
  for (const f of doc.features) keys.push((key = hash(key + JSON.stringify(f))));
  // Start after the longest run of steps already built.
  let start = keys.length;
  while (start > 0 && !stepCache.has(keys[start - 1])) start--;
  const cached = start > 0 ? stepCache.get(keys[start - 1])! : null;
  const st: ReplayState = cached
    ? snapshot(cached)
    : { shape: null, errors: {}, warnings: {}, sketches: new Map(), tools: new Map() };
  const { errors, warnings, sketches, tools } = st;
  let shape = st.shape;
  const step = (f: CadDocument["features"][number]) => {
    noteMoved = () => (warnings[f.id] = "Its face or edge moved: the closest one was used. Check it, or edit the step to pick again.");
    if (f.kind === "pattern") {
      try {
        if (!shape) throw new Error("There is no solid yet");
        const r = pattern(shape, f, tools, names);
        shape = r.shape.simplify();
        if (r.tool) tools.set(f.id, r.tool);
      } catch (e) {
        errors[f.id] = e instanceof Error ? e.message : String(e);
      }
      return;
    }
    if (f.kind === "sketch") {
      sketches.set(f.id, f);
      return;
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
      return;
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
      return;
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
  };
  doc.features.forEach((f, i) => {
    if (i < start) return;
    step(f);
    stepCache.delete(keys[i]);
    stepCache.set(keys[i], snapshot({ shape, errors, warnings, sketches, tools }));
    if (stepCache.size > STEP_CACHE_MAX) stepCache.delete(stepCache.keys().next().value!);
  });
  // Keep the steps just used at the young end of the cache.
  for (const k of keys.slice(0, start)) {
    const v = stepCache.get(k);
    if (v) {
      stepCache.delete(k);
      stepCache.set(k, v);
    }
  }
  noteMoved = null;
  for (const id of Object.keys(errors)) delete warnings[id];
  return { shape, errors, warnings };
}

/** Display data of a shape: meshes at each quality, and its flat faces once asked for. */
interface Meshed {
  fine?: Pick<BuildResult, "mesh" | "edges" | "edgeGroups">;
  draft?: Pick<BuildResult, "mesh" | "edges" | "edgeGroups">;
  planar?: PlanarFace[];
}

/**
 * Meshing is most of the time of a build once the steps come from the cache, and the same shape
 * often comes back: the model under an operation being edited is rebuilt on every drag tick, and
 * a build that settles remeshes what a draft already replayed. Shapes are never changed in place,
 * so the shape object itself is the key. Only the last few are kept.
 */
const meshCache = new Map<Shape3D, Meshed>();
const MESH_CACHE_MAX = 6;

function meshed(shape: Shape3D): Meshed {
  let m = meshCache.get(shape);
  if (m) meshCache.delete(shape);
  else m = {};
  meshCache.set(shape, m);
  if (meshCache.size > MESH_CACHE_MAX) meshCache.delete(meshCache.keys().next().value!);
  return m;
}

/**
 * Faces are meshed for display with a deflection relative to the model's size: a fixed 0.01 mm
 * took seconds on drawings with many curved walls. Edges are meshed finer (their midpoints are
 * what fillets and chamfers refer to), which is cheap once the faces are. A draft (while a value
 * is being dragged) is about three times faster: coarser faces, and edges at the same setting —
 * finer edges would make OpenCascade mesh the whole shape again.
 */
function meshShape(shape: Shape3D, draft: boolean): Pick<BuildResult, "mesh" | "edges" | "edgeGroups"> {
  const [lo, hi] = shape.boundingBox.bounds;
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const draftOpts = { tolerance: Math.max(0.05, diag * 2e-3), angularTolerance: 0.5 };
  const m = shape.mesh(draft ? draftOpts : { tolerance: Math.max(MESH_OPTS.tolerance, diag * 4e-4), angularTolerance: 0.2 });
  const e = shape.meshEdges(draft ? draftOpts : MESH_OPTS);
  return {
    mesh: {
      vertices: new Float32Array(m.vertices),
      normals: new Float32Array(m.normals),
      triangles: new Uint32Array(m.triangles),
      faceGroups: m.faceGroups,
    },
    edges: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((g): EdgeGroup => ({ start: g.start, count: g.count, mid: polylineMid(e.lines, g.start, g.count), id: g.edgeId })),
  };
}

/**
 * `draft`: a coarser mesh, and no flat faces unless already known (a drag only needs to see the
 * shape; the build sent once it settles has them). `planar: false` never computes them (previews).
 * The arrays returned are copies, free to be transferred.
 */
export function buildResult(doc: CadDocument, opts: { draft?: boolean; planar?: boolean } = {}): BuildResult {
  const { shape, errors, warnings } = buildShape(doc);
  if (!shape) return { mesh: null, edges: new Float32Array(), edgeGroups: [], planarFaces: [], errors, warnings };
  const m = meshed(shape);
  // A fine mesh already made is used even for a draft.
  const view = m.fine ?? (opts.draft ? (m.draft ??= meshShape(shape, true)) : (m.fine = meshShape(shape, false)));
  if (!opts.draft && opts.planar !== false) m.planar ??= planarFaces(shape);
  const mesh = view.mesh && {
    vertices: view.mesh.vertices.slice(),
    normals: view.mesh.normals.slice(),
    triangles: view.mesh.triangles.slice(),
    faceGroups: view.mesh.faceGroups,
  };
  return { mesh, edges: view.edges.slice(), edgeGroups: view.edgeGroups, planarFaces: m.planar ?? [], warnings, errors };
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
    let xDir: Vec3;
    if (Math.abs(normal[2]) > 0.9) {
      // Flat-lying face: sketch X along world X.
      xDir = add([1, 0, 0], scale(normal, -normal[0]));
    } else {
      // Standing face: sketch Y points up (world Z), so the view looking at it is never upside down.
      const up = add([0, 0, 1], scale(normal, -normal[2]));
      xDir = [up[1] * normal[2] - up[2] * normal[1], up[2] * normal[0] - up[0] * normal[2], up[0] * normal[1] - up[1] * normal[0]];
    }
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
