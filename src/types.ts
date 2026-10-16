// Document model: an ordered list of features, rebuilt from scratch on every change.

export type Vec3 = [number, number, number];

/** A sketch plane. Sketch Y axis = normal × xDir. */
export interface PlaneDef {
  origin: Vec3;
  xDir: Vec3;
  normal: Vec3;
  /** Display name: "XY", "XZ", "YZ" or "Face". */
  label: string;
}

// ---------- Sketch entities (2D, in sketch coordinates, millimetres) ----------

export interface SkPoint {
  id: string;
  type: "point";
  x: number;
  y: number;
  /** Reference geometry (origin, axis ends): never moves, never deleted. */
  fixed?: boolean;
}

export interface SkLine {
  id: string;
  type: "line";
  p1: string;
  p2: string;
  construction?: boolean;
  /** Reference axis: drawn infinite, not part of profiles. */
  axis?: boolean;
}

export interface SkCircle {
  id: string;
  type: "circle";
  c: string;
  r: number;
  construction?: boolean;
}

/** Counter-clockwise arc from s to e around c. Its radius is |c→s|. */
export interface SkArc {
  id: string;
  type: "arc";
  c: string;
  s: string;
  e: string;
  construction?: boolean;
}

export type SkCurve = SkLine | SkCircle | SkArc;
export type SkEntity = SkPoint | SkCurve;

export type ConstraintType =
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "pointOn"
  | "midpoint"
  | "symmetric"
  | "fix"
  | "distance"
  | "distanceX"
  | "distanceY"
  | "radius"
  | "diameter"
  | "angle";

/** Dimensional constraints carry a value (mm, or degrees for angles). */
export const DIMENSION_TYPES: ConstraintType[] = ["distance", "distanceX", "distanceY", "radius", "diameter", "angle"];

export interface SkConstraint {
  id: string;
  type: ConstraintType;
  refs: string[];
  value?: number;
  /** For "fix": the locked coordinates. */
  at?: [number, number];
  /** Expression driving `value`, when it uses parameters (e.g. "width / 2"). */
  expr?: string;
}

export interface SketchFeature {
  id: string;
  kind: "sketch";
  name: string;
  plane: PlaneDef;
  entities: SkEntity[];
  constraints: SkConstraint[];
}

export type ExtrudeOp = "add" | "cut" | "intersect";

export interface ExtrudeFeature {
  id: string;
  kind: "extrude";
  name: string;
  sketchId: string;
  /** Signed: negative goes against the sketch normal. */
  distance: number;
  /** Expression for the distance's magnitude, when it uses parameters. */
  distanceExpr?: string;
  symmetric: boolean;
  op: ExtrudeOp;
}

/**
 * A flat face of the solid, found again on rebuild by a point on it and its normal
 * (a geometric reference: it fails, rather than guessing, if the face moved).
 */
export interface FaceRef {
  center: Vec3;
  normal: Vec3;
}

/** Pulls a face outwards (positive distance, adds material) or pushes it in (negative, removes). */
export interface PushPullFeature {
  id: string;
  kind: "pushpull";
  name: string;
  face: FaceRef;
  distance: number;
  /** Expression for the (signed) distance, when it uses parameters. */
  distanceExpr?: string;
}

/** Hollows the solid, opening the given faces, with walls of `thickness`. */
export interface ShellFeature {
  id: string;
  kind: "shell";
  name: string;
  faces: FaceRef[];
  thickness: number;
  thicknessExpr?: string;
}

export type Feature = SketchFeature | ExtrudeFeature | PushPullFeature | ShellFeature;

/** A named value usable in any dimension or feature value. */
export interface Parameter {
  id: string;
  name: string;
  /** A number or an expression of other parameters. */
  expr: string;
}

export interface CadDocument {
  format: "touch-cad";
  version: 1;
  features: Feature[];
  parameters?: Parameter[];
}

// ---------- Profiles: closed regions found in a sketch ----------

export type ProfileSegment =
  | { kind: "line"; a: [number, number]; b: [number, number] }
  | { kind: "arc"; a: [number, number]; b: [number, number]; mid: [number, number] };

export type ProfileLoop =
  | { kind: "circle"; c: [number, number]; r: number }
  | { kind: "path"; segments: ProfileSegment[] };

/** A filled region: an outer loop minus holes. */
export interface ProfileRegion {
  outer: ProfileLoop;
  holes: ProfileLoop[];
}

// ---------- Worker protocol ----------

export interface MeshData {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  /** Triangle ranges per B-rep face (start/count in triangle-index units). */
  faceGroups: { start: number; count: number; faceId: number }[];
}

export interface PlanarFace {
  faceId: number;
  plane: PlaneDef;
  /** A point inside the face (used to find it again). */
  center: Vec3;
}

export interface BuildResult {
  mesh: MeshData | null;
  /** Polylines of B-rep edges: pairs of points x,y,z,x,y,z… */
  edges: Float32Array;
  planarFaces: PlanarFace[];
  /** Feature id → error message, for features that could not be built. */
  errors: Record<string, string>;
}

export type WorkerRequest =
  | { type: "build"; reqId: number; doc: CadDocument }
  | { type: "export"; reqId: number; doc: CadDocument; format: "step" | "stl" };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | ({ type: "built"; reqId: number } & BuildResult)
  | { type: "file"; reqId: number; blob: Blob | null; error?: string };
