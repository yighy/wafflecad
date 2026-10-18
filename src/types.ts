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
  /** Where two lines met before a fillet rounded the corner: kept on both lines, not a hole position. */
  sharp?: boolean;
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

/**
 * Smooth curve passing through its points, in order. Each span between two points is a
 * cubic Bézier whose tangents come from the neighbouring points (see `splineSpans`).
 */
export interface SkSpline {
  id: string;
  type: "spline";
  pts: string[];
  closed?: boolean;
  construction?: boolean;
}

/**
 * Cubic Bézier from p0 to p3, pulled by the control points c1 and c2 (exact: imported SVG
 * curves stay what they were, down to the STEP export).
 */
export interface SkBezier {
  id: string;
  type: "bezier";
  p0: string;
  c1: string;
  c2: string;
  p3: string;
  construction?: boolean;
}

/**
 * Ellipse around the point c: m is the end of its major axis (so the major radius and the tilt
 * follow that point), rb the minor radius.
 */
export interface SkEllipse {
  id: string;
  type: "ellipse";
  c: string;
  m: string;
  rb: number;
  construction?: boolean;
}

export type SkCurve = SkLine | SkCircle | SkArc | SkSpline | SkBezier | SkEllipse;
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
  /** Not labelled on the sketch unless what it holds is selected (imported drawings: many of them). */
  quiet?: boolean;
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
  body?: BodyTarget;
}

/**
 * Which body a step works on. Joining: "new" starts a body of its own (named after the step),
 * an id joins that body, none joins the first body. Cutting or intersecting: an id works on that
 * body only, none on every body.
 */
export type BodyTarget = "new" | string;

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

/** An edge of the solid, found again on rebuild by the point at the middle of its length. */
export interface EdgeRef {
  mid: Vec3;
}

/** Rounds (fillet) or bevels (chamfer) edges of the solid. */
export interface FilletFeature {
  id: string;
  kind: "fillet";
  name: string;
  mode: "fillet" | "chamfer";
  edges: EdgeRef[];
  /** Fillet radius, or chamfer distance. */
  radius: number;
  radiusExpr?: string;
}

/**
 * Screw holes. Positions come either from the free points of a sketch (precise, follow its
 * dimensions) or from points tapped on a flat face.
 */
export interface HoleFeature {
  id: string;
  kind: "hole";
  name: string;
  sketchId?: string;
  /** Tapped positions (world coordinates, on the face). */
  points?: Vec3[];
  /** Outward normal of the face (or the sketch normal): holes go the other way. */
  normal: Vec3;
  /** Drill along the normal instead (sketches on reference planes may face either way). */
  flip?: boolean;
  size: "M2.5" | "M3" | "M4" | "M5";
  /** Clearance for the screw to pass, or pilot hole to screw into plastic. */
  fit: "clearance" | "plastic";
  head: "none" | "counterbore" | "countersink";
  /** Blind depth in mm; 0 = through all. */
  depth: number;
  depthExpr?: string;
}

/** Turns a sketch's closed regions around a line of the sketch (or one of its axes). */
export interface RevolveFeature {
  id: string;
  kind: "revolve";
  name: string;
  sketchId: string;
  /** Id of a line of the sketch: "AX" / "AY" for the sketch axes, or any drawn line. */
  axisLine: string;
  /** Degrees; 360 = full turn. Negative turns the other way. */
  angle: number;
  angleExpr?: string;
  symmetric: boolean;
  op: ExtrudeOp;
  body?: BodyTarget;
}

export type Axis = "X" | "Y" | "Z";

/**
 * Repeats earlier features (their added or removed material) by translation, rotation or
 * mirror. A mirror with no feature chosen mirrors the whole solid.
 */
export interface PatternFeature {
  id: string;
  kind: "pattern";
  name: string;
  type: "linear" | "circular" | "mirror";
  featureIds: string[];
  /** Linear: first direction. Circular: rotation axis (through the origin). Mirror: plane normal. */
  axis: Axis;
  /** Instances, the original included. */
  count: number;
  /** Linear: distance between instances (negative = the other way). */
  spacing: number;
  /** Linear: second direction of a rectangular pattern (count2 = 1 means none). */
  axis2: Axis;
  count2: number;
  spacing2: number;
  /** Circular: total angle in degrees (360 = evenly around). */
  angle: number;
  /** Mirror: position of the plane along its normal. */
  offset: number;
}

/** A solid read from a STEP file, joined to the model (or cut from it) as placed in the file. */
export interface ImportFeature {
  id: string;
  kind: "import";
  name: string;
  /** Key of the file's text in the document's `files`. */
  fileId: string;
  op: "add" | "cut";
  body?: BodyTarget;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | PushPullFeature
  | ShellFeature
  | FilletFeature
  | HoleFeature
  | PatternFeature
  | ImportFeature;

/** A named value usable in any dimension or feature value. */
export interface Parameter {
  id: string;
  name: string;
  /** A number or an expression of other parameters. */
  expr: string;
}

export interface CadDocument {
  /** "touch-cad" (the app's first name) is still read, and saved again as "waffle". */
  format: "waffle";
  version: 1;
  features: Feature[];
  parameters?: Parameter[];
  /** Imported files (STEP text) by id. Kept out of undo snapshots: they only ever get added. */
  files?: Record<string, string>;
  /** Names given to bodies (by body id); unnamed bodies are "Body 1", "Body 2"… in order. */
  bodyNames?: Record<string, string>;
  /** An assembly places parts (other projects) instead of having steps of its own. */
  kind?: "assembly";
  instances?: PartInstance[];
  /** How the assembly's parts are tied together. */
  mates?: Mate[];
}

/** A part placed in an assembly: another project, turned and then moved. */
export interface PartInstance {
  id: string;
  /** The project the part comes from; its latest saved version is always used. */
  project: string;
  name: string;
  /** Where the part's origin goes (mm). */
  at: Vec3;
  /**
   * Turns about the X, Y and Z axes through the part's origin (degrees): Z first, then Y, then X,
   * each about the fixed axes (the same as a three.js "XYZ" Euler angle).
   */
  rot: Vec3;
  /** Held where it is: mates move the other parts to it. */
  fixed?: boolean;
  /** Only this body of the part (its id in the part), when the part's bodies were inserted apart. */
  body?: string;
}

/**
 * A flat face (plane: a point on it and its outward normal) or a round face or edge, a hole or a
 * pin (axis: a point on it and its direction) of a part, in the part's own coordinates, so it
 * follows the part wherever it is placed.
 */
export interface MateRef {
  part: string;
  kind: "plane" | "axis";
  origin: Vec3;
  dir: Vec3;
}

/**
 * A mate between two parts. touch: faces facing each other, `value` mm apart (0: in contact);
 * align: faces turned the same way, `value` mm apart (0: flush); axis: on the same axis (a pin in
 * its hole); angle: faces at `value` degrees.
 */
export interface Mate {
  id: string;
  name: string;
  kind: "touch" | "align" | "axis" | "angle";
  a: MateRef;
  b: MateRef;
  value: number;
  /**
   * Limits instead of an exact value (a drawer's travel, a lid's opening): the gap or angle may be
   * anywhere between them, and `value` is only where it started.
   */
  min?: number;
  max?: number;
}

/** A separate solid of the part, and the faces that belong to it (B-rep hash codes). */
export interface BodyInfo {
  id: string;
  name: string;
  faceIds: number[];
  edgeIds: number[];
}

// ---------- Profiles: closed regions found in a sketch ----------

export type ProfileSegment =
  | { kind: "line"; a: [number, number]; b: [number, number] }
  | { kind: "arc"; a: [number, number]; b: [number, number]; mid: [number, number] }
  | { kind: "bezier"; a: [number, number]; b: [number, number]; c1: [number, number]; c2: [number, number] };

export type ProfileLoop =
  | { kind: "circle"; c: [number, number]; r: number }
  /** ra along the direction at `angle` (radians), rb across. */
  | { kind: "ellipse"; c: [number, number]; ra: number; rb: number; angle: number }
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

export interface EdgeGroup {
  start: number;
  count: number;
  mid: Vec3;
  /** The B-rep edge's hash code in this build (to find it again in the worker). */
  id: number;
}

/** Something tapped to be measured: a face or an edge of the last build (by hash code), or a corner. */
export type MeasurePick = { kind: "face"; id: number } | { kind: "edge"; id: number } | { kind: "point"; p: Vec3 };

export interface MeasureRow {
  label: string;
  value: number;
  unit: "mm" | "mm²" | "°";
}

export interface MeasureResult {
  rows: MeasureRow[];
  /** Where the distance was measured, to draw it. */
  line?: [Vec3, Vec3];
  error?: string;
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
  /** One entry per B-rep edge: its segments in `edges` (in points) and its mid-length point. */
  edgeGroups: EdgeGroup[];
  planarFaces: PlanarFace[];
  /** The part's separate solids, in the order they were started. */
  bodies?: BodyInfo[];
  /** Feature id → error message, for features that could not be built. */
  errors: Record<string, string>;
  /** Steps that built, but only after finding a moved face or edge again. */
  warnings?: Record<string, string>;
}

/** The model with the operation being edited, shown while picking happens on the model without it. */
export interface PreviewResult {
  mesh: MeshData | null;
  edges: Float32Array;
  edgeGroups: EdgeGroup[];
  bodies?: BodyInfo[];
  /** Why the operation fails with the current values, if it does. */
  error?: string;
}

/** "plate": a 3MF with every part laid flat on its largest face, side by side, ready to print. */
export type ExportFormat = "step" | "stl" | "3mf" | "plate";

export type WorkerRequest =
  /** With pickExclude: the main result leaves that feature out (to pick faces and edges on), and
   * `preview` shows the whole document, so an operation being edited is seen live. `draft`: a
   * coarser mesh and no flat faces, for builds made while a value is being dragged. */
  | { type: "build"; reqId: number; doc: CadDocument; pickExclude?: string; draft?: boolean }
  | { type: "export"; reqId: number; doc: CadDocument; format: ExportFormat; name: string }
  /** The documents of the parts the open assembly uses, by project id (kept until replaced). */
  | { type: "parts"; parts: Record<string, CadDocument> }
  | { type: "measure"; reqId: number; doc: CadDocument; picks: MeasurePick[] }
  /** The bodies of a part (to insert them apart). */
  | { type: "bodies"; reqId: number; doc: CadDocument }
  /** The solids of a STEP file, each as a STEP file of its own (an assembly read as parts). */
  | { type: "split"; reqId: number; text: string }
  /** Parts of the assembly that overlap (the hidden ones left out). */
  | { type: "clash"; reqId: number; doc: CadDocument; skip: string[] }
  /** The plane or axis of a face or edge of the model (world coordinates), to mate it. */
  | { type: "ref"; reqId: number; doc: CadDocument; pick: Exclude<MeasurePick, { kind: "point" }> };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | ({ type: "built"; reqId: number; preview?: PreviewResult } & BuildResult)
  | { type: "file"; reqId: number; blob: Blob | null; error?: string }
  | { type: "measured"; reqId: number; result: MeasureResult }
  | { type: "ref"; reqId: number; ref: Omit<MateRef, "part"> | null; error?: string }
  | { type: "clash"; reqId: number; clashes: Clash[]; error?: string }
  | { type: "split"; reqId: number; parts: string[]; error?: string }
  | { type: "bodies"; reqId: number; bodies: { id: string; name: string }[] };

/** Two parts that overlap: how much, and the shape of the overlap (to draw it). */
export interface Clash {
  a: string;
  b: string;
  volume: number;
  vertices: Float32Array;
  triangles: Uint32Array;
}
