// Geometric core: replays the feature list with replicad (OpenCascade).
// No DOM dependency: used by the worker, and testable under Node.
import { FaceFinder, Plane, Vector, basicFaceExtrusion, draw, drawCircle, type Drawing, type Face, type Shape3D } from "replicad";
import type { BuildResult, CadDocument, ExtrudeFeature, FaceRef, PlanarFace, PlaneDef, ProfileLoop, PushPullFeature, ShellFeature, SketchFeature, Vec3 } from "../types";
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

function pushPull(shape: Shape3D, f: PushPullFeature): Shape3D {
  if (Math.abs(f.distance) < 1e-6) throw new Error("Distance is zero");
  const face = findFace(shape, f.face);
  const prism = basicFaceExtrusion(face, new Vector(scale(f.face.normal, f.distance)));
  return f.distance > 0 ? shape.fuse(prism) : shape.cut(prism);
}

function shell(shape: Shape3D, f: ShellFeature): Shape3D {
  if (!f.faces.length) throw new Error("Choose at least one face to open");
  if (f.thickness <= 0) throw new Error("The thickness must be positive");
  for (const ref of f.faces) findFace(shape, ref);
  // Positive thickness: the walls grow inwards, the outside keeps its size.
  return shape.shell(f.thickness, (finder) => finder.either(f.faces.map((ref) => (g: FaceFinder) => g.containsPoint(ref.center))));
}

/** Replays the features; a failing feature is skipped and reported. */
export function buildShape(doc: CadDocument) {
  let shape: Shape3D | null = null;
  const errors: Record<string, string> = {};
  const sketches = new Map<string, SketchFeature>();
  for (const f of doc.features) {
    if (f.kind === "sketch") {
      sketches.set(f.id, f);
      continue;
    }
    if (f.kind === "pushpull" || f.kind === "shell") {
      try {
        if (!shape) throw new Error("There is no solid yet");
        shape = (f.kind === "pushpull" ? pushPull(shape, f) : shell(shape, f)).simplify();
      } catch (e) {
        errors[f.id] = e instanceof Error ? e.message : String(e);
      }
      continue;
    }
    try {
      const sk = sketches.get(f.sketchId);
      if (!sk) throw new Error("Sketch not found");
      const solid = extrudeSolid(sk, f);
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
  if (!shape) return { mesh: null, edges: new Float32Array(), planarFaces: [], errors };
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
