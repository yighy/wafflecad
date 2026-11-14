// The app's shared state: the open document and project, what is being done (the mode), and what
// is selected. One object, so every module reads and changes the same values (S.mode = …).
import type { BuildResult, CadDocument, CombineFeature, ExtrudeFeature, Feature, FilletFeature, HoleFeature, LoftFeature, Mate, MateRef, PartInstance, PatternFeature, PlaneDef, PushPullFeature, RevolveFeature, ShellFeature, SweepFeature, Vec3 } from "../types";
import type { ProjectMeta } from "../projects";
import type { SketchEditor } from "../sketch/editor";
import type { KeypadHandle } from "../ui/keypad";
import { emptyDoc } from "./util";

export type Mode =
  | { kind: "part" }
  | { kind: "pickPlane"; offset: number; tiltX: number; tiltY: number }
  | { kind: "sketch"; editor: SketchEditor }
  | { kind: "extrude"; feat: ExtrudeFeature; keypad: KeypadHandle }
  | { kind: "pushpull"; feat: PushPullFeature; keypad: KeypadHandle }
  | { kind: "shell"; feat: ShellFeature; keypad: KeypadHandle }
  | { kind: "fillet"; feat: FilletFeature; keypad: KeypadHandle }
  | { kind: "hole"; feat: HoleFeature; keypad: KeypadHandle }
  | { kind: "pattern"; feat: PatternFeature; keypad: KeypadHandle }
  | { kind: "revolve"; feat: RevolveFeature; keypad: KeypadHandle }
  /** Choosing the sketches of a sweep or a loft in the panel (no keypad: nothing to type). */
  | { kind: "sweep"; feat: SweepFeature }
  | { kind: "loft"; feat: LoftFeature }
  | { kind: "place"; feat: PartInstance; keypad: KeypadHandle }
  /** Choosing the two faces or holes of a new mate. */
  | { kind: "mate"; picks: MatePick[] }
  | { kind: "mateEdit"; feat: Mate; keypad: KeypadHandle }
  /** Lining parts up: the parts chosen, the first one staying put. */
  | { kind: "align"; ids: string[] }
  /** Combining parts into a new part: the one it is made from, and the ones it is joined with or cut by. */
  | { kind: "combine"; target: string | null; tools: string[]; op: CombineFeature["op"]; clearance: number; replace: boolean; existing: ProjectMeta | null };

/** A face or hole chosen for a mate: its plane or axis, and what to highlight. */
export interface MatePick {
  ref: MateRef;
  face?: number;
  edge?: number;
}

/** Modes where a feature is being edited with the keypad open. */
export const isOperation = (m: Mode): m is Extract<Mode, { keypad: KeypadHandle }> => "keypad" in m;
/** The sketches a feature is made from: hidden in the part view once used, deleted with them. */
export const usedSketchIds = (f: Feature): string[] =>
  f.kind === "extrude" || f.kind === "revolve" ? [f.sketchId] : f.kind === "sweep" ? (f.helix ? [f.sketchId] : [f.sketchId, f.pathSketchId]) : f.kind === "loft" ? f.sketchIds : [];

export const S = {
  doc: emptyDoc() as CadDocument,
  /** The open project; null until the saved ones are read (or when this browser cannot store them). */
  project: null as ProjectMeta | null,
  mode: { kind: "part" } as Mode,
  selectedFeature: null as string | null,
  selectedFace: null as { faceId: number; plane: PlaneDef | null; center: Vec3 | null; hit: Vec3 | null } | null,
  /** A face tool chosen before any face was selected: it starts on the next face tapped. */
  pendingFaceTool: null as "pushpull" | "shell" | "hole" | null,
  /** The right panel shows the parameter list. */
  showParams: false,
  /** A feature left out of the preview build (the shell, while its faces are being chosen). */
  previewExclude: null as string | null,
  lastBuild: null as BuildResult | null,
};
