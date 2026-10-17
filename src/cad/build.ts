// Geometric core: replays the feature list with replicad (OpenCascade).
// No DOM dependency: used by the worker, and testable under Node.
import { exportSTEP, measureArea, measureVolume, EdgeFinder, FaceFinder, Plane, Vector, basicFaceExtrusion, cast, draw, drawCircle, drawEllipse, getOC, isShape3D, makeCompound, makeVertex, measureDistanceBetween, type Drawing, type Face, type Shape3D } from "replicad";
import type { Axis, BuildResult, CadDocument, Clash, PartInstance, EdgeGroup, ExportFormat, ExtrudeFeature, RevolveFeature, FaceRef, FilletFeature, HoleFeature, PatternFeature, PlanarFace, PlaneDef, ProfileLoop, PushPullFeature, ShellFeature, SketchFeature, Vec3 } from "../types";
import { holeDims, sketchHolePoints } from "./holes";
import { make3mf } from "./threemf";
import { hasRef } from "./measure";
import { sketchLineWorld } from "../sketch/model";
import { findRegions } from "../sketch/profiles";

const MESH_OPTS = { tolerance: 0.01, angularTolerance: 0.1 };

function loopDrawing(loop: ProfileLoop): Drawing {
  if (loop.kind === "circle") return drawCircle(loop.r).translate(loop.c[0], loop.c[1]);
  if (loop.kind === "ellipse")
    return drawEllipse(loop.ra, loop.rb)
      .rotate((loop.angle * 180) / Math.PI, [0, 0])
      .translate(loop.c[0], loop.c[1]);
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

function holes(shape: Shape3D, f: HoleFeature, sketches: Map<string, SketchFeature>): Tool {
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
  return { solid: fuseAll(pts.map((p) => holeTool(p, dir, f, length))), op: "cut" };
}

/** The material a feature adds or removes, kept so patterns can repeat it (into the same body; none: every body). */
interface Tool {
  solid: Shape3D;
  op: "add" | "cut";
  body?: string;
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

/**
 * Repeats the chosen steps' material into the bodies it went into. A mirror with no step chosen
 * mirrors every body onto itself.
 */
function pattern(bodies: Bodies, f: PatternFeature, tools: Map<string, Tool>, names: Map<string, string>): Tool | null {
  if (f.type === "mirror" && !f.featureIds.length) {
    for (const [id, b] of bodies) bodies.set(id, b.fuse(b.clone().mirror(MIRROR_PLANE[f.axis], scale(AXIS[f.axis], f.offset))).simplify());
    return null;
  }
  if (!f.featureIds.length) throw new Error("Choose the features to repeat");
  const made: Record<"add" | "cut", Shape3D[]> = { add: [], cut: [] };
  const into = new Set<string | undefined>();
  for (const id of f.featureIds) {
    const t = tools.get(id);
    if (!t) throw new Error(`${names.get(id) ?? "This feature"} cannot be repeated (only extrusions, Press Pull, holes and patterns)`);
    made[t.op].push(t.solid);
    into.add(t.body);
    for (const c of patternCopies(t.solid, f)) {
      applyTool(bodies, { ...t, solid: c });
      made[t.op].push(c);
    }
  }
  // A pattern made of a single kind of operation, into one body, can itself be repeated.
  const ops = (["add", "cut"] as const).filter((o) => made[o].length);
  return ops.length === 1 && into.size === 1 ? { op: ops[0], solid: fuseAll(made[ops[0]]), body: [...into][0] } : null;
}

/** The part's separate solids by id (the id of the step that started each), in that order. */
type Bodies = Map<string, Shape3D>;

/** Adds or removes a tool's material in its body (or, cutting with no body, in all of them). */
function applyTool(bodies: Bodies, t: Tool) {
  const ids = t.body ? [t.body] : [...bodies.keys()];
  for (const id of ids) {
    const b = bodies.get(id);
    if (!b) throw new Error("Its body is not there any more");
    setBody(bodies, id, t.op === "add" ? b.fuse(t.solid) : b.cut(t.solid));
  }
}

/** Stores a body's new shape; a body cut or intersected down to nothing goes. */
function setBody(bodies: Bodies, id: string, shape: Shape3D) {
  const s = shape.simplify();
  if (s.faces.length) bodies.set(id, s);
  else bodies.delete(id);
}

/** All the bodies as one shape (for display, measures, references and exports). */
function combined(bodies: Bodies): Shape3D | null {
  const all = [...bodies.values()];
  // makeCompound deletes what it is given: copies (sharing the same faces) go in.
  return all.length === 0 ? null : all.length === 1 ? all[0] : (makeCompound(all.map((b) => b.clone())) as Shape3D);
}

/** The body a face or edge of the combined shape belongs to. */
function bodyWith(bodies: Bodies, hashCode: number, kind: "faces" | "edges"): string {
  for (const [id, b] of bodies) if (b[kind].some((x) => x.hashCode === hashCode)) return id;
  throw new Error("The face is no longer there (an earlier feature changed it)");
}

/** Replays the features; a failing feature is skipped and reported. */
/** Everything the replay carries from one step to the next. */
interface ReplayState {
  bodies: Bodies;
  /** The bodies as one shape (kept, so an unchanged model is the same object and its mesh is reused). */
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
  bodies: new Map(st.bodies),
  shape: st.shape,
  errors: { ...st.errors },
  warnings: { ...st.warnings },
  sketches: new Map(st.sketches),
  tools: new Map(st.tools),
});

/** The solids of a STEP file (its text), as one shape. */
export function readStep(text: string): Shape3D {
  const oc = getOC();
  const name = `/import-${Math.random().toString(36).slice(2)}.step`;
  oc.FS.writeFile(name, text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new (oc as any).STEPControl_Reader();
  try {
    if (!reader.ReadFile(name)) throw new Error("This STEP file could not be read");
    reader.TransferRoots();
    let shape;
    try {
      shape = cast(reader.OneShape());
    } catch {
      throw new Error("This STEP file holds no shape that can be read");
    }
    if (!isShape3D(shape) || !shape.faces.length) throw new Error("This STEP file holds no solid");
    return shape;
  } finally {
    reader.delete();
    oc.FS.unlink(name);
  }
}

/** Replays the features (from the cache where possible); a failing feature is skipped and reported. */
export function buildShape(doc: CadDocument) {
  if (doc.kind === "assembly") return assemblyShape(doc);
  const names = new Map(doc.features.map((f) => [f.id, f.name]));
  const keys: string[] = [];
  let key = "";
  // An imported file counts by its size, start and end (cheap even for a large file).
  const fileKey = (id: string) => {
    const t = doc.files?.[id] ?? "";
    return `${t.length}:${hash(t.slice(0, 4096) + t.slice(-4096))}`;
  };
  for (const f of doc.features) keys.push((key = hash(key + JSON.stringify(f) + (f.kind === "import" ? fileKey(f.fileId) : ""))));
  // Start after the longest run of steps already built.
  let start = keys.length;
  while (start > 0 && !stepCache.has(keys[start - 1])) start--;
  const cached = start > 0 ? stepCache.get(keys[start - 1])! : null;
  const st: ReplayState = cached
    ? snapshot(cached)
    : { bodies: new Map(), shape: null, errors: {}, warnings: {}, sketches: new Map(), tools: new Map() };
  const { bodies, errors, warnings, sketches, tools } = st;
  let shape = st.shape;
  const fail = (f: { id: string }, e: unknown) => (errors[f.id] = e instanceof Error ? e.message : String(e));
  /** Material made by a step from a sketch or a file: a new body, joined to one, or cut from them. */
  const solidStep = (f: { id: string; op: "add" | "cut" | "intersect"; body?: string }, solid: Shape3D) => {
    if (f.op === "add") {
      if (f.body === "new" || !bodies.size) {
        bodies.set(f.id, solid);
        tools.set(f.id, { solid, op: "add", body: f.id });
        return;
      }
      const id = f.body ?? [...bodies.keys()][0];
      const b = bodies.get(id);
      if (!b) throw new Error("The body it joins is not there");
      setBody(bodies, id, b.fuse(solid));
      tools.set(f.id, { solid, op: "add", body: id });
      return;
    }
    if (!bodies.size) throw new Error("Nothing to " + f.op);
    const target = f.body && f.body !== "new" ? f.body : undefined;
    if (target && !bodies.has(target)) throw new Error("The body it works on is not there");
    if (f.op === "cut") {
      tools.set(f.id, { solid, op: "cut", body: target });
      applyTool(bodies, { solid, op: "cut", body: target });
    } else for (const id of target ? [target] : [...bodies.keys()]) setBody(bodies, id, bodies.get(id)!.intersect(solid));
  };
  const step = (f: CadDocument["features"][number]) => {
    noteMoved = () => (warnings[f.id] = "Its face or edge moved: the closest one was used. Check it, or edit the step to pick again.");
    if (f.kind === "sketch") {
      sketches.set(f.id, f);
      return;
    }
    try {
      if (f.kind === "pattern") {
        if (!shape) throw new Error("There is no solid yet");
        const t = pattern(bodies, f, tools, names);
        if (t) tools.set(f.id, t);
      } else if (f.kind === "import") {
        const text = doc.files?.[f.fileId];
        if (!text) throw new Error("The imported file is missing");
        solidStep(f, readStep(text));
      } else if (f.kind === "hole") {
        // Holes go through every body in their way (a lid and its box, drilled together).
        if (!shape) throw new Error("There is no solid yet");
        const t = holes(shape, f, sketches);
        tools.set(f.id, t);
        applyTool(bodies, t);
      } else if (f.kind === "pushpull") {
        if (!shape) throw new Error("There is no solid yet");
        const face = findFace(shape, f.face);
        const id = bodyWith(bodies, face.hashCode, "faces");
        const t = { ...pushPullTool(shape, f), body: id };
        applyTool(bodies, t);
        tools.set(f.id, t);
      } else if (f.kind === "shell") {
        if (!shape) throw new Error("There is no solid yet");
        if (!f.faces.length) throw new Error("Choose at least one face to open");
        const id = bodyWith(bodies, findFace(shape, f.faces[0]).hashCode, "faces");
        setBody(bodies, id, shell(bodies.get(id)!, f));
      } else if (f.kind === "fillet") {
        if (!shape) throw new Error("There is no solid yet");
        if (!f.edges.length) throw new Error("Choose at least one edge");
        // The body holding the first edge (all of a fillet's edges are on one body).
        const p = edgeAnchor(shape, f.edges[0].mid);
        const id = [...bodies.keys()].find((k) => new EdgeFinder().withinDistance(EDGE_MATCH_TOL, p).find(bodies.get(k)!).length);
        if (!id) throw new Error("An edge is no longer there (an earlier feature changed it)");
        // Simplifying after a fillet would merge its faces with flat neighbours: kept as is.
        const next = fillet(bodies.get(id)!, f);
        bodies.set(id, next);
      } else {
        const sk = sketches.get(f.sketchId);
        if (!sk) throw new Error("Sketch not found");
        solidStep(f, f.kind === "revolve" ? revolveSolid(sk, f) : extrudeSolid(sk, f));
      }
    } catch (e) {
      fail(f, e);
    }
    shape = combined(bodies);
  };
  doc.features.forEach((f, i) => {
    if (i < start) return;
    step(f);
    stepCache.delete(keys[i]);
    stepCache.set(keys[i], snapshot({ bodies, shape, errors, warnings, sketches, tools }));
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
  return { shape, bodies: [...bodies].map(([id, s]) => ({ id, shape: s })), errors, warnings };
}

// ---------- Assemblies ----------

/** Documents of the parts the open assembly uses, by project id (sent by the app). */
let partDocs: Record<string, CadDocument> = {};
export function setPartDocs(parts: Record<string, CadDocument>) {
  partDocs = parts;
}

/** A part's solid turned and moved into place (a copy: the part's own solid stays as it is). */
export function placeShape(part: Shape3D, p: Pick<PartInstance, "at" | "rot">): Shape3D {
  let s = part.clone();
  const [rx, ry, rz] = p.rot;
  if (rz) s = s.rotate(rz, [0, 0, 0], [0, 0, 1]);
  if (ry) s = s.rotate(ry, [0, 0, 0], [0, 1, 0]);
  if (rx) s = s.rotate(rx, [0, 0, 0], [1, 0, 0]);
  if (p.at.some((v) => v !== 0)) s = s.translate(p.at);
  return s;
}

/** Whether a part's solid still has a mate's face or axis (found once per solid). */
const refChecks = new WeakMap<Shape3D, Map<string, boolean>>();

/** Each placed part, kept while neither the part nor its place change. */
const placedCache = new Map<string, { part: Shape3D; key: string; shape: Shape3D }>();
/** The last assembly as one shape: the same object while no part moved, so its mesh is reused. */
let lastAssembly: { parts: Shape3D[]; shape: Shape3D | null } = { parts: [], shape: null };

/** An assembly: each part built from its own project (from the cache when unchanged), then placed. */
function assemblyShape(doc: CadDocument) {
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  const bodies: { id: string; shape: Shape3D }[] = [];
  /** Each part's solid in its own coordinates (to check the faces mates use). */
  const own = new Map<string, Shape3D>();
  for (const inst of doc.instances ?? []) {
    const part = partDocs[inst.project];
    if (!part) {
      errors[inst.id] = "Its project is no longer there";
      continue;
    }
    if (part.kind === "assembly") {
      errors[inst.id] = "An assembly cannot be placed in another one yet";
      continue;
    }
    const r = buildShape(part);
    if (!r.shape) {
      errors[inst.id] = "The part has no solid yet";
      continue;
    }
    if (Object.keys(r.errors).length) warnings[inst.id] = "Some steps of the part fail: open it to fix them";
    own.set(inst.id, r.shape);
    const key = JSON.stringify([inst.at, inst.rot]);
    let p = placedCache.get(inst.id);
    if (!p || p.part !== r.shape || p.key !== key) placedCache.set(inst.id, (p = { part: r.shape, key, shape: placeShape(r.shape, inst) }));
    bodies.push({ id: inst.id, shape: p.shape });
  }
  // A mate whose face or axis is no longer in its part (the part was changed) still holds the
  // parts where they were, and says so.
  for (const m of doc.mates ?? []) {
    const lost = [m.a, m.b].some((ref) => {
      const s = own.get(ref.part);
      if (!s) return false;
      const key = JSON.stringify([ref.kind, ref.origin, ref.dir]);
      let known = refChecks.get(s);
      if (!known) refChecks.set(s, (known = new Map()));
      if (!known.has(key)) known.set(key, hasRef(s, ref));
      return !known.get(key);
    });
    if (lost) warnings[m.id] = "A face it uses changed in its part: delete it and mate again";
  }
  const used = new Set(bodies.map((b) => b.id));
  for (const id of placedCache.keys()) if (!used.has(id)) placedCache.delete(id);
  const parts = bodies.map((b) => b.shape);
  if (parts.length !== lastAssembly.parts.length || parts.some((s, i) => s !== lastAssembly.parts[i]))
    lastAssembly = { parts, shape: combined(new Map(bodies.map((b) => [b.id, b.shape]))) };
  return { shape: lastAssembly.shape, bodies, errors, warnings };
}

/**
 * Pairs of parts (or bodies) that overlap, with the overlap's volume and mesh. Only pairs whose
 * boxes meet are intersected; parts that only touch (flush faces) have no volume and are left out.
 */
export function interferences(doc: CadDocument, skip: string[] = []): Clash[] {
  const list = buildShape(doc).bodies.filter((b) => !skip.includes(b.id));
  const boxes = list.map((b) => b.shape.boundingBox.bounds);
  const out: Clash[] = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const [la, ha] = boxes[i];
      const [lb, hb] = boxes[j];
      if ([0, 1, 2].some((k) => ha[k] <= lb[k] + 1e-6 || hb[k] <= la[k] + 1e-6)) continue;
      let x: Shape3D;
      try {
        x = list[i].shape.intersect(list[j].shape);
      } catch {
        continue;
      }
      const volume = x.faces.length ? measureVolume(x) : 0;
      if (volume < 1e-3) continue;
      const m = x.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
      out.push({ a: list[i].id, b: list[j].id, volume, vertices: new Float32Array(m.vertices), triangles: new Uint32Array(m.triangles) });
    }
  return out;
}

/** The solids of a STEP file, each written as a STEP file of its own (none when it has only one). */
export async function splitStep(text: string): Promise<string[]> {
  const solids = readStep(text).solids;
  if (solids.length < 2) return [];
  return Promise.all(solids.map((s) => s.blobSTEP().text()));
}

/** Display data of a shape: meshes at each quality, and its flat faces once asked for. */
interface Meshed {
  fine?: Pick<BuildResult, "mesh" | "edges" | "edgeGroups">;
  draft?: Pick<BuildResult, "mesh" | "edges" | "edgeGroups">;
  planar?: PlanarFace[];
  /** Face and edge hash codes of each body (empty with a single body). */
  bodyFaces?: number[][];
  bodyEdges?: number[][];
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
/** Names of the bodies: the ones given, else "Body 1", "Body 2"… in order. */
function bodyNames(doc: CadDocument, ids: string[]) {
  if (doc.kind === "assembly") return ids.map((id) => doc.instances?.find((i) => i.id === id)?.name ?? "Part");
  return ids.map((id, i) => doc.bodyNames?.[id] ?? `Body ${i + 1}`);
}

export function buildResult(doc: CadDocument, opts: { draft?: boolean; planar?: boolean } = {}): BuildResult {
  const { shape, bodies, errors, warnings } = buildShape(doc);
  if (!shape) return { mesh: null, edges: new Float32Array(), edgeGroups: [], planarFaces: [], errors, warnings };
  const m = meshed(shape);
  // A fine mesh already made is used even for a draft.
  const view = m.fine ?? (opts.draft ? (m.draft ??= meshShape(shape, true)) : (m.fine = meshShape(shape, false)));
  if (!opts.draft && opts.planar !== false) m.planar ??= planarFaces(shape);
  // Which faces and edges belong to which body (to colour or hide them apart), when there are several.
  // (An assembly's parts are always told apart: a single one is still picked and moved.)
  const apart = bodies.length > 1 || doc.kind === "assembly";
  m.bodyFaces ??= apart ? bodies.map((b) => b.shape.faces.map((f) => f.hashCode)) : [];
  m.bodyEdges ??= apart ? bodies.map((b) => b.shape.edges.map((e) => e.hashCode)) : [];
  const names = bodyNames(doc, bodies.map((b) => b.id));
  const bodyInfo = bodies.map((b, i) => ({ id: b.id, name: names[i], faceIds: m.bodyFaces![i] ?? [], edgeIds: m.bodyEdges![i] ?? [] }));
  const mesh = view.mesh && {
    vertices: view.mesh.vertices.slice(),
    normals: view.mesh.normals.slice(),
    triangles: view.mesh.triangles.slice(),
    faceGroups: view.mesh.faceGroups,
  };
  return { mesh, edges: view.edges.slice(), edgeGroups: view.edgeGroups, planarFaces: m.planar ?? [], bodies: bodyInfo, warnings, errors };
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

/** Colours of the parts in a STEP file: the app's model colour with each body's tint. */
const STEP_COLORS = ["#9fb0c6", "#d2ac8f", "#89d0a2", "#b297e6", "#7cc5d6", "#c2c28b"];

/** A solid turned to rest on its largest flat face (the one facing down first), its corner at 0. */
export function layFlat(s: Shape3D): Shape3D {
  let best: { area: number; n: Vec3 } | null = null;
  for (const f of s.faces) {
    if (f.geomType !== "PLANE") continue;
    const v = f.normalAt(f.center);
    const n: Vec3 = [v.x, v.y, v.z];
    // A face already facing down wins a tie.
    const area = measureArea(f) * (n[2] < -0.999 ? 1.001 : 1);
    if (!best || area > best.area + 1e-6) best = { area, n };
  }
  let out = s.clone();
  if (best) {
    const [nx, ny, nz] = best.n;
    if (nz > 1 - 1e-9) out = out.rotate(180, [0, 0, 0], [1, 0, 0]);
    else if (nz > -1 + 1e-9) out = out.rotate((Math.acos(-nz) * 180) / Math.PI, [0, 0, 0], [-ny, nx, 0]);
  }
  const [lo] = out.boundingBox.bounds;
  return out.translate([-lo[0], -lo[1], -lo[2]]);
}

/** Every part (or body) laid flat and set out in rows on a 220 mm plate, 5 mm apart. */
function plate(bodies: { shape: Shape3D }[]): Shape3D[] {
  const flat = bodies.map((b) => layFlat(b.shape));
  const size = (s: Shape3D) => {
    const [lo, hi] = s.boundingBox.bounds;
    return [hi[0] - lo[0], hi[1] - lo[1]];
  };
  const order = flat.map((s, i) => i).sort((a, b) => size(flat[b])[1] - size(flat[a])[1]);
  const out: Shape3D[] = [];
  let x = 0;
  let y = 0;
  let row = 0;
  for (const i of order) {
    const [w, d] = size(flat[i]);
    if (x > 0 && x + w > 220) {
      x = 0;
      y += row + 5;
      row = 0;
    }
    out[i] = flat[i].translate([x, y, 0]);
    x += w + 5;
    row = Math.max(row, d);
  }
  return out;
}

export function exportFile(doc: CadDocument, format: ExportFormat, name = "model"): Blob | null {
  const { shape, bodies } = buildShape(doc);
  if (!shape) return null;
  const apart = bodies.length > 1 || doc.kind === "assembly";
  if (format === "plate") {
    const names = apart ? bodyNames(doc, bodies.map((b) => b.id)) : [name];
    const objects = plate(bodies).map((s, i) => {
      const m = s.mesh(MESH_OPTS);
      return { name: names[i], vertices: m.vertices, triangles: m.triangles };
    });
    return new Blob([make3mf(objects, name)], { type: "model/3mf" });
  }
  if (format === "step" && apart) {
    // Named and coloured parts, which other CAD software shows as an assembly.
    const names = bodyNames(doc, bodies.map((b) => b.id));
    return exportSTEP(bodies.map((b, i) => ({ shape: b.shape.clone(), name: names[i], color: STEP_COLORS[i % STEP_COLORS.length] })));
  }
  if (format === "3mf") {
    // One object per body, so the slicer can place and set each one apart.
    const names = bodies.length > 1 ? bodyNames(doc, bodies.map((b) => b.id)) : [name];
    const objects = bodies.map((b, i) => {
      const m = b.shape.mesh(MESH_OPTS);
      return { name: names[i], vertices: m.vertices, triangles: m.triangles };
    });
    return new Blob([make3mf(objects, name)], { type: "model/3mf" });
  }
  return format === "stl" ? shape.blobSTL({ ...MESH_OPTS, binary: true }) : shape.blobSTEP();
}
