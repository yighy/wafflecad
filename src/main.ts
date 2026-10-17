import "./style.css";
import * as THREE from "three";
import planegcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import type { Axis, BuildResult, CadDocument, ExtrudeFeature, RevolveFeature, ExtrudeOp, FaceRef, Feature, FilletFeature, HoleFeature, Parameter, PatternFeature, PlaneDef, PushPullFeature, ShellFeature, SketchFeature, Vec3, WorkerRequest, WorkerResponse } from "./types";
import { NAME_RE, applyParameters, expressionSlots, hasNames, renameInExpr, resolveParameters, usedNames } from "./params";
import { Viewport, cssVar, type LineBatch } from "./view/viewport";
import { InputRouter, type PointerTool, type Ptr } from "./view/input";
import { Solver } from "./sketch/solver";
import { SketchEditor, type Action, type SketchToolName } from "./sketch/editor";
import { SketchView, newSketch, sampleSpline, sketchLineWorld, uid } from "./sketch/model";
import { openKeypad, setKeypadHost, type KeypadHandle } from "./ui/keypad";
import { icon } from "./ui/icons";
import { createAxisGizmo } from "./ui/axisGizmo";
import { DistanceHandle, sketchArrow } from "./ui/distanceHandle";
import { findRegions } from "./sketch/profiles";
import { HOLE_SIZES, sketchHolePoints } from "./cad/holes";
import { atDistance, edgesInPlane, faceFrame, holeDims, snapHole, to2D, to3D, type EdgeDim } from "./cad/holePlace";

const STORAGE_KEY = "touch-cad.document";
const PREFS_KEY = "touch-cad.prefs";
const STD_PLANES: PlaneDef[] = [
  { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1], label: "XY" },
  { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0], label: "XZ" },
  { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0], label: "YZ" },
];
const PLANE_NAMES: Record<string, string> = { XY: "Top (XY)", XZ: "Front (XZ)", YZ: "Right (YZ)" };
const PLANE_COLORS: Record<string, string> = { XY: "#4c6ef5", XZ: "#2f9e44", YZ: "#e03131" };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const buttons = (sel: string) => [...document.querySelectorAll<HTMLButtonElement>(sel)];

// ---------- Preferences ----------

interface Prefs {
  theme: "light" | "dark";
  collapsed: boolean;
  /** Where the user dragged the side panel (top-left corner, CSS px); null = default place. */
  panelPos: { x: number; y: number } | null;
  perspective: boolean;
}
const prefs: Prefs = { theme: "light", collapsed: false, panelPos: null, perspective: false };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"));
} catch {
  // Defaults.
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered: fine.
  }
}
function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.body.classList.toggle("collapsed", prefs.collapsed);
  $<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", cssVar("--bg3d", "#e4e7eb"));
}
applyPrefs();

// ---------- State ----------

type Mode =
  | { kind: "part" }
  | { kind: "pickPlane" }
  | { kind: "sketch"; editor: SketchEditor }
  | { kind: "extrude"; feat: ExtrudeFeature; keypad: KeypadHandle }
  | { kind: "pushpull"; feat: PushPullFeature; keypad: KeypadHandle }
  | { kind: "shell"; feat: ShellFeature; keypad: KeypadHandle }
  | { kind: "fillet"; feat: FilletFeature; keypad: KeypadHandle }
  | { kind: "hole"; feat: HoleFeature; keypad: KeypadHandle }
  | { kind: "pattern"; feat: PatternFeature; keypad: KeypadHandle }
  | { kind: "revolve"; feat: RevolveFeature; keypad: KeypadHandle };

/** Modes where a feature is being edited with the keypad open. */
const isOperation = (m: Mode): m is Extract<Mode, { keypad: KeypadHandle }> => "keypad" in m;

let doc: CadDocument = loadDoc();
let mode: Mode = { kind: "part" };
let selectedFeature: string | null = null;
let selectedFace: { faceId: number; plane: PlaneDef | null; center: Vec3 | null; hit: Vec3 | null } | null = null;
/** A face tool chosen before any face was selected: it starts on the next face tapped. */
let pendingFaceTool: "pushpull" | "shell" | "hole" | null = null;
/** The right panel shows the parameter list. */
let showParams = false;
/** A feature left out of the preview build (the shell, while its faces are being chosen). */
let previewExclude: string | null = null;
let lastBuild: BuildResult | null = null;
let kernelMessage = "Loading geometry kernel…";
const undoStack: string[] = [JSON.stringify(doc)];
let undoPos = 0;

const vp = new Viewport($("#view"));
vp.perspective = prefs.perspective;
let solver: Solver;

// ---------- Worker ----------

const worker = new Worker(new URL("./cad/worker.ts", import.meta.url), { type: "module" });
let kernelReady = false;
let reqCounter = 0;
let latestBuild = 0;
const pendingFiles = new Map<number, (b: Blob | null, err?: string) => void>();
let buildTimer = 0;

worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  const m = ev.data;
  if (m.type === "ready") {
    kernelReady = true;
    kernelMessage = "";
    renderStatus();
    rebuild(true);
  } else if (m.type === "fatal") {
    kernelMessage = "Geometry kernel failed to load: " + m.message;
    renderStatus();
  } else if (m.type === "built") {
    if (m.reqId !== latestBuild) return;
    const first = lastBuild === null;
    lastBuild = m;
    vp.setModel(m, m.preview);
    if (isOperation(mode)) mode.keypad.setNote(m.preview?.error ?? null);
    if (first && m.mesh) vp.fit();
    if (mode.kind === "sketch") vp.setModelOpacity(0.45);
    if (mode.kind === "shell") highlightShellFaces(mode.feat);
    if (mode.kind === "fillet") highlightFilletEdges(mode.feat);
    renderTimeline();
    renderPanel();
    renderPartOverlays();
  } else if (m.type === "file") {
    pendingFiles.get(m.reqId)?.(m.blob, m.error);
    pendingFiles.delete(m.reqId);
  }
};

function rebuild(now = false) {
  clearTimeout(buildTimer);
  const go = () => {
    if (!kernelReady) return;
    latestBuild = ++reqCounter;
    worker.postMessage({ type: "build", reqId: latestBuild, doc, pickExclude: previewExclude ?? undefined } satisfies WorkerRequest);
  };
  if (now) go();
  else buildTimer = window.setTimeout(go, 120);
}

function exportFile(format: "step" | "stl") {
  if (!kernelReady) return toast("The geometry kernel is still loading");
  const reqId = ++reqCounter;
  pendingFiles.set(reqId, (blob, err) => {
    if (!blob) return toast(err ? "Export failed: " + err : "Nothing to export");
    download(blob, `model.${format}`);
  });
  worker.postMessage({ type: "export", reqId, doc, format } satisfies WorkerRequest);
}

// ---------- Document, history, persistence ----------

function loadDoc(): CadDocument {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as CadDocument;
      if (d.format === "touch-cad" && Array.isArray(d.features)) return d;
    }
  } catch {
    // Private mode or corrupt data: start empty.
  }
  return { format: "touch-cad", version: 1, features: [] };
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch {
    // Storage full or blocked: the document still lives in memory.
  }
}

function commit() {
  const snap = JSON.stringify(doc);
  if (snap === undoStack[undoPos]) return;
  undoStack.splice(undoPos + 1);
  undoStack.push(snap);
  if (undoStack.length > 200) undoStack.shift();
  undoPos = undoStack.length - 1;
  save();
  rebuild();
  renderAll();
}

function restore(pos: number) {
  if (isOperation(mode)) mode.keypad.close();
  undoPos = pos;
  doc = JSON.parse(undoStack[pos]);
  save();
  if (mode.kind === "sketch") {
    const id = mode.editor.sk.id;
    const sk = doc.features.find((f): f is SketchFeature => f.id === id && f.kind === "sketch");
    if (sk) mode.editor.load(sk);
    else exitSketch();
  }
  if (selectedFeature && !doc.features.some((f) => f.id === selectedFeature)) selectedFeature = null;
  rebuild();
  renderAll();
}

function undo() {
  if (undoPos > 0) restore(undoPos - 1);
  else toast("Nothing to undo");
}
function redo() {
  if (undoPos < undoStack.length - 1) restore(undoPos + 1);
}

function nextName(prefix: string) {
  let i = 1;
  while (doc.features.some((f) => f.name === `${prefix} ${i}`)) i++;
  return `${prefix} ${i}`;
}

// ---------- Modes ----------

function startNewSketch() {
  mode = { kind: "pickPlane" };
  selectedFeature = null;
  selectedFace = null;
  vp.highlightFace(null);
  vp.showPlanes(STD_PLANES.map((def) => ({ def, color: PLANE_COLORS[def.label] })));
  renderAll();
}

function pickPlaneAt(p: Ptr) {
  const label = vp.pickPlane(p.x, p.y);
  const faceId = vp.pickFace(p.x, p.y);
  let plane: PlaneDef | undefined;
  if (faceId != null) plane = lastBuild?.planarFaces.find((f) => f.faceId === faceId)?.plane;
  if (!plane && label) plane = STD_PLANES.find((s) => s.label === label);
  if (!plane) {
    if (faceId != null) toast("Only flat faces can hold a sketch");
    return;
  }
  createSketchOn(plane);
}

function createSketchOn(plane: PlaneDef) {
  vp.showPlanes(null);
  vp.highlightFace(null);
  selectedFace = null;
  const sk = newSketch(nextName("Sketch"), plane);
  doc.features.push(sk);
  commit();
  enterSketch(sk);
}

function enterSketch(sk: SketchFeature) {
  if (mode.kind === "sketch") mode.editor.dispose();
  vp.showPlanes(null);
  vp.highlightFace(null);
  selectedFace = null;
  const editor = new SketchEditor(vp, solver, sk, {
    commit,
    changed: () => {
      renderPanel();
      renderStatus();
    },
    toast,
    scope: paramScope,
  });
  mode = { kind: "sketch", editor };
  selectedFeature = sk.id;
  vp.setGridPlane(sk.plane);
  vp.viewNormalTo(sk.plane);
  vp.setModelOpacity(0.45);
  renderAll();
}

function exitSketch() {
  if (mode.kind !== "sketch") return;
  const sk = mode.editor.sk;
  mode.editor.dispose();
  mode = { kind: "part" };
  vp.setGridPlane(null);
  vp.setModelOpacity(1);
  commit();
  renderAll();
  const used = doc.features.some((f) => f.kind === "extrude" && f.sketchId === sk.id);
  if (!used && findRegions(sk).length)
    toast("Next: Extrude turns this sketch into a solid");
}

function escape(): boolean {
  if (isOperation(mode)) {
    mode.keypad.close();
    return true;
  }
  if (pendingFaceTool) {
    pendingFaceTool = null;
    renderAll();
    return true;
  }
  if (showParams) {
    toggleParams();
    return true;
  }
  if (mode.kind === "sketch") {
    if (!mode.editor.escape()) exitSketch();
    renderAll();
    return true;
  }
  if (mode.kind === "pickPlane") {
    mode = { kind: "part" };
    vp.showPlanes(null);
    vp.highlightFace(null);
    renderAll();
    return true;
  }
  if (selectedFeature || selectedFace) {
    clearPartSelection();
    return true;
  }
  return false;
}

function clearPartSelection() {
  selectedFeature = null;
  selectedFace = null;
  vp.highlightFace(null);
  renderAll();
}

// ---------- Extrude ----------

async function extrude(existing?: ExtrudeFeature) {
  if (isOperation(mode)) return;
  let f = existing;
  if (!f) {
    const sk = pickSketchForExtrude();
    if (!sk) return toast("Draw a closed sketch first");
    if (mode.kind === "sketch") exitSketch();
    const onFace = sk.plane.label === "Face";
    f = { id: uid(), kind: "extrude", name: nextName("Extrude"), sketchId: sk.id, distance: onFace ? 5 : 10, symmetric: false, op: "add" };
    doc.features.push(f);
  }
  const feat = f;
  const sk = doc.features.find((x): x is SketchFeature => x.id === feat.sketchId && x.kind === "sketch");
  if (!sk) return toast("This extrusion's sketch is missing");
  const onFace = sk.plane.label === "Face";
  const before = { distance: feat.distance, distanceExpr: feat.distanceExpr, symmetric: feat.symmetric, op: feat.op };
  selectedFeature = feat.id;
  selectedFace = null;
  vp.highlightFace(null);

  let handle: DistanceHandle | null = null;
  const setDistance = (d: number, fromKeypad = false) => {
    feat.distance = d;
    if (!fromKeypad) kp.set(Math.abs(d));
    handle?.update();
    renderTimeline();
    rebuild();
  };
  const kp = openKeypad({
    title: feat.name,
    subtitle: `${sk.name} · ${sk.plane.label === "Face" ? "on a face" : PLANE_NAMES[sk.plane.label] ?? sk.plane.label}`,
    label: "Distance",
    value: Math.abs(feat.distance),
    expr: feat.distanceExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: [
          { value: "one", label: "One side" },
          { value: "sym", label: "Symmetric" },
        ],
        get: () => (feat.symmetric ? "sym" : "one"),
        set: (v) => {
          feat.symmetric = v === "sym";
          rebuild();
        },
      },
      {
        options: [
          { value: "add", label: "Join" },
          { value: "cut", label: "Cut" },
          { value: "intersect", label: "Intersect" },
        ],
        get: () => feat.op,
        set: (v) => {
          const op = v as ExtrudeOp;
          // A face normal points out of the solid: cutting goes the other way by default.
          if (onFace && (op === "cut") !== (feat.op === "cut")) feat.distance = -feat.distance;
          feat.op = op;
          handle?.update();
          rebuild();
        },
      },
    ],
    extras: [{ label: "Flip direction", icon: "flip", run: () => setDistance(-feat.distance) }],
    onInput: (v) => {
      if (v > 0) setDistance(Math.sign(feat.distance || 1) * v, true);
    },
  });
  mode = { kind: "extrude", feat, keypad: kp };
  const arrow = sketchArrow(sk);
  handle = new DistanceHandle(vp, arrow.base, arrow.normal, () => feat.distance, (d) => setDistance(d));
  renderAll();
  rebuild(true);

  const res = await kp.result;
  const value = res?.value ?? null;
  handle.dispose();
  mode = { kind: "part" };
  if (value === null || value <= 0) {
    if (value !== null) toast("The distance must be positive");
    if (existing) Object.assign(feat, before);
    else {
      doc.features = doc.features.filter((x) => x !== feat);
      selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.distance = Math.sign(feat.distance || 1) * value;
  feat.distanceExpr = res?.expr;
  commit();
}

// ---------- Press Pull and Shell (on faces of the solid) ----------

function faceRefOfSelection(): FaceRef | null {
  if (!selectedFace?.plane || !selectedFace.center) return null;
  return { center: selectedFace.center, normal: selectedFace.plane.normal };
}

/** Starts a face tool on the selected face, or waits for a face to be tapped. */
function faceTool(tool: "pushpull" | "shell" | "hole") {
  if (mode.kind !== "part") return;
  if (!hasSolid()) return toast(NEED_SOLID);
  const ref = faceRefOfSelection();
  if (!ref) {
    pendingFaceTool = tool;
    selectedFeature = null;
    renderAll();
    return;
  }
  pendingFaceTool = null;
  if (tool === "pushpull") void pushPull(undefined, ref);
  else if (tool === "shell") void shell(undefined, ref);
  else void holeTool(undefined, { normal: ref.normal, at: (selectedFace?.hit ?? ref.center).map((c) => Math.round(c * 100) / 100) as Vec3 });
}

async function pushPull(existing?: PushPullFeature, ref?: FaceRef) {
  const feat: PushPullFeature = existing ?? { id: uid(), kind: "pushpull", name: nextName("Press Pull"), face: ref!, distance: 5 };
  const before = { distance: feat.distance, distanceExpr: feat.distanceExpr };
  if (!existing) doc.features.push(feat);
  selectedFeature = feat.id;
  selectedFace = null;
  vp.highlightFace(null);

  let handle: DistanceHandle | null = null;
  const setDistance = (d: number, fromKeypad = false) => {
    feat.distance = d;
    if (!fromKeypad) kp.set(d);
    handle?.update();
    renderTimeline();
    rebuild();
  };
  const kp = openKeypad({
    title: feat.name,
    subtitle: "Positive pulls the face out, negative pushes it in",
    label: "Distance",
    value: feat.distance,
    expr: feat.distanceExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: [
          { value: "pull", label: "Pull (add)" },
          { value: "push", label: "Push (cut)" },
        ],
        get: () => (feat.distance >= 0 ? "pull" : "push"),
        set: (v) => {
          if ((v === "push") !== feat.distance < 0) setDistance(-feat.distance);
        },
      },
    ],
    onInput: (v) => {
      if (v !== 0) setDistance(v, true);
    },
  });
  mode = { kind: "pushpull", feat, keypad: kp };
  // The arrow starts on the face as it was before this feature.
  handle = new DistanceHandle(
    vp,
    new THREE.Vector3(...feat.face.center),
    new THREE.Vector3(...feat.face.normal),
    () => feat.distance,
    (d) => setDistance(d),
  );
  renderAll();
  rebuild(true);

  const res = await kp.result;
  const value = res?.value ?? null;
  handle.dispose();
  mode = { kind: "part" };
  if (value === null || value === 0) {
    if (existing) Object.assign(feat, before);
    else {
      doc.features = doc.features.filter((x) => x !== feat);
      selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.distance = value;
  feat.distanceExpr = res?.expr;
  commit();
}

async function shell(existing?: ShellFeature, ref?: FaceRef) {
  const feat: ShellFeature = existing ?? { id: uid(), kind: "shell", name: nextName("Shell"), faces: [ref!], thickness: 2 };
  const before = { thickness: feat.thickness, thicknessExpr: feat.thicknessExpr, faces: [...feat.faces] };
  if (!existing) doc.features.push(feat);
  selectedFeature = feat.id;
  selectedFace = null;
  // Faces are chosen on the solid as it is before the shell.
  previewExclude = feat.id;
  const kp = openKeypad({
    title: feat.name,
    subtitle: "Tap faces to open or close them",
    label: "Wall thickness",
    value: feat.thickness,
    expr: feat.thicknessExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    onInput: (v) => {
      if (v > 0) feat.thickness = v;
      rebuild();
    },
  });
  mode = { kind: "shell", feat, keypad: kp };
  renderAll();
  rebuild(true);

  const res = await kp.result;
  const value = res?.value ?? null;
  previewExclude = null;
  mode = { kind: "part" };
  vp.highlightFace(null);
  if (value === null || value <= 0 || !feat.faces.length) {
    if (value !== null && !feat.faces.length) toast("A shell needs at least one open face");
    if (existing) Object.assign(feat, before);
    else {
      doc.features = doc.features.filter((x) => x !== feat);
      selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.thickness = value;
  feat.thicknessExpr = res?.expr;
  commit();
}

// ---------- Holes ----------

/** Starts the hole tool: from the selected sketch's free points, the selected face, or the next face tapped. */
function startHoles() {
  if (mode.kind !== "part") return;
  const sel = doc.features.find((f) => f.id === selectedFeature);
  if (sel?.kind === "sketch") {
    if (!sketchHolePoints(sel).length) return toast("This sketch has no free points: add points where the holes go");
    return void holeTool(undefined, { sketch: sel });
  }
  faceTool("hole");
}

async function holeTool(existing?: HoleFeature, from?: { sketch: SketchFeature } | { normal: Vec3; at: Vec3 }) {
  if (mode.kind !== "part") return;
  const feat: HoleFeature =
    existing ??
    (from && "sketch" in from
      ? { id: uid(), kind: "hole", name: nextName("Hole"), sketchId: from.sketch.id, normal: from.sketch.plane.normal, size: "M3", fit: "clearance", head: "none", depth: 0 }
      : { id: uid(), kind: "hole", name: nextName("Hole"), points: [from!.at], normal: from!.normal, size: "M3", fit: "clearance", head: "none", depth: 0 });
  const before = structuredClone(feat);
  if (!existing) doc.features.push(feat);
  selectedFeature = feat.id;
  selectedFace = null;
  showParams = false;
  vp.highlightFace(null);
  // Positions are chosen on the solid as it is before the holes.
  previewExclude = feat.id;
  holeField = null;
  holeDrag = null;
  holeSnapLabel = null;
  holeSel = feat.points?.length && !existing ? feat.points.length - 1 : null;
  if (!existing && feat.points?.length) {
    const ctx = holeContext(feat);
    const s = snapHole(to2D(ctx.frame, feat.points[0]), ctx.edges, nearestCenter(ctx, feat.points[0]), 24 * vp.wpp);
    feat.points[0] = to3D(ctx.frame, s.at);
    holeSnapLabel = s.label;
  }
  const kp = openKeypad({
    title: feat.name,
    subtitle: feat.sketchId ? "At the free points of the sketch" : "Tap to add · drag to move · tap a distance to type it",
    label: "Depth (0 = through)",
    value: feat.depth,
    expr: feat.depthExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: HOLE_SIZES.map((s) => ({ value: s, label: s })),
        get: () => feat.size,
        set: (v) => {
          feat.size = v as HoleFeature["size"];
          rebuild();
        },
      },
      {
        options: [
          { value: "none", label: "Plain" },
          { value: "counterbore", label: "Counterbore" },
          { value: "countersink", label: "Countersink" },
        ],
        get: () => feat.head,
        set: (v) => {
          feat.head = v as HoleFeature["head"];
          rebuild();
        },
      },
      {
        options: [
          { value: "clearance", label: "Screw passes" },
          { value: "plastic", label: "Screw into plastic" },
        ],
        get: () => feat.fit,
        set: (v) => {
          feat.fit = v as HoleFeature["fit"];
          rebuild();
        },
      },
    ],
    extras: !feat.sketchId
      ? [{ label: "Remove hole", icon: "trash", run: () => removeSelectedHole(feat) }]
      : [
          {
            label: "Flip direction",
            icon: "flip",
            run: () => {
              feat.flip = !feat.flip;
              rebuild();
              toast(feat.flip ? "Drilling along the sketch normal" : "Drilling against the sketch normal");
            },
          },
        ],
    onInput: (v) => {
      if (v < 0) return;
      if (holeField && holeSel !== null && feat.points?.[holeSel]) {
        // The keypad is editing a distance to an edge: move the hole square to it.
        const ctx = holeContext(feat);
        feat.points[holeSel] = to3D(ctx.frame, atDistance(holeField.dim, v));
        holeSnapLabel = null;
        renderPartOverlays();
      } else feat.depth = v;
      rebuild();
    },
  });
  mode = { kind: "hole", feat, keypad: kp };
  renderAll();
  rebuild(true);

  const typed = await kp.result;
  // Confirmed while a distance was being typed: the depth is the one set before.
  const res = typed && holeField ? { value: feat.depth, expr: feat.depthExpr } : typed;
  holeField = null;
  holeSel = null;
  holeDrag = null;
  const value = res?.value ?? null;
  previewExclude = null;
  mode = { kind: "part" };
  const hasPoints = feat.sketchId ? true : !!feat.points?.length;
  if (value === null || value < 0 || !hasPoints) {
    if (value !== null && !hasPoints) toast("Tap at least one place on the face");
    if (value !== null && value < 0) toast("The depth cannot be negative");
    if (existing) Object.assign(feat, before);
    else {
      doc.features = doc.features.filter((x) => x !== feat);
      selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.depth = value;
  feat.depthExpr = res?.expr;
  commit();
}

// Placing holes on a face: tap to add (snapped), tap a hole to select it, drag it to move it,
// and tap one of its distances to edges to type an exact value.

/** The selected hole (index in its feature's points). */
let holeSel: number | null = null;
/** Set while the keypad edits a distance to an edge instead of the depth. */
let holeField: { dim: EdgeDim } | null = null;
let holeDrag: { index: number; moved: boolean } | null = null;
/** What the last placed or moved hole snapped to, shown next to it. */
let holeSnapLabel: string | null = null;

const hitRadiusPx = (p: Ptr) => (p.kind === "touch" ? 24 : p.kind === "pen" ? 14 : 9);

function holeContext(feat: HoleFeature) {
  const frame = faceFrame(feat.normal, feat.points?.[0] ?? [0, 0, 0]);
  const edges = lastBuild ? edgesInPlane(frame, lastBuild.edges, lastBuild.edgeGroups) : { segments: [], circles: [] };
  return { frame, edges };
}

/** Centre of the flat face (in the holes' plane) closest to a point, in the plane's 2D coordinates. */
function nearestCenter(ctx: ReturnType<typeof holeContext>, at: Vec3): [number, number] | null {
  const n = ctx.frame.normal;
  const off = (w: Vec3) => (w[0] - at[0]) * n[0] + (w[1] - at[1]) * n[1] + (w[2] - at[2]) * n[2];
  const a = to2D(ctx.frame, at);
  let best: [number, number] | null = null;
  for (const pf of lastBuild?.planarFaces ?? []) {
    const m = pf.plane.normal;
    if (m[0] * n[0] + m[1] * n[1] + m[2] * n[2] < 0.999 || Math.abs(off(pf.center)) > 1e-3) continue;
    const c = to2D(ctx.frame, pf.center);
    if (!best || Math.hypot(c[0] - a[0], c[1] - a[1]) < Math.hypot(best[0] - a[0], best[1] - a[1])) best = c;
  }
  return best;
}

/** The snapped place under the pointer, on the holes' plane. */
function holeSnapAt(feat: HoleFeature, p: Ptr) {
  const ctx = holeContext(feat);
  const raw = vp.screenToPlane(p.x, p.y, ctx.frame);
  if (!raw) return null;
  return snapHole(raw, ctx.edges, nearestCenter(ctx, to3D(ctx.frame, raw)), hitRadiusPx(p) * vp.wpp);
}

function holeUnder(feat: HoleFeature, p: Ptr): number | null {
  let best: number | null = null;
  let bestD = hitRadiusPx(p) + 6;
  (feat.points ?? []).forEach((q, i) => {
    const [x, y] = vp.toScreen(new THREE.Vector3(...q));
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

function selectHole(feat: HoleFeature, i: number | null) {
  holeSel = i;
  if (holeField && mode.kind === "hole") {
    holeField = null;
    mode.keypad.setLabel("Depth (0 = through)", "mm");
    mode.keypad.set(feat.depth);
  }
  renderPartOverlays();
  renderStatus();
}

function holeDown(feat: HoleFeature, p: Ptr) {
  if (feat.sketchId) return;
  const i = holeUnder(feat, p);
  holeDrag = i === null ? null : { index: i, moved: false };
}

function holeMove(feat: HoleFeature, p: Ptr) {
  if (!holeDrag || !feat.points) return;
  const s = holeSnapAt(feat, p);
  if (!s) return;
  if (!holeDrag.moved) selectHole(feat, holeDrag.index);
  holeDrag.moved = true;
  feat.points[holeDrag.index] = to3D(holeContext(feat).frame, s.at);
  holeSnapLabel = s.label;
  renderPartOverlays();
  rebuild();
}

/** A tap: selects the hole under it, or adds one there (snapped). */
function holeUp(feat: HoleFeature, p: Ptr) {
  if (feat.sketchId) return toast("These holes follow the sketch points: edit the sketch to move them");
  const drag = holeDrag;
  holeDrag = null;
  if (drag?.moved) return;
  if (drag) return selectHole(feat, drag.index);
  const hit = vp.pickPoint(p.x, p.y);
  if (!hit) return selectHole(feat, null);
  const pts = (feat.points ??= []);
  const n = feat.normal;
  const pf = hit.faceId == null ? undefined : lastBuild?.planarFaces.find((f) => f.faceId === hit.faceId);
  const sameNormal = pf && pf.plane.normal[0] * n[0] + pf.plane.normal[1] * n[1] + pf.plane.normal[2] * n[2] > 0.999;
  const ref = pts[0] ?? hit.point;
  const offPlane = Math.abs((hit.point[0] - ref[0]) * n[0] + (hit.point[1] - ref[1]) * n[1] + (hit.point[2] - ref[2]) * n[2]);
  if (!sameNormal || offPlane > 1e-3) return toast("All holes of one feature go on the same flat face");
  const s = holeSnapAt(feat, p);
  if (!s) return;
  pts.push(to3D(holeContext(feat).frame, s.at));
  holeSnapLabel = s.label;
  selectHole(feat, pts.length - 1);
  rebuild();
}

function removeSelectedHole(feat: HoleFeature) {
  const pts = feat.points ?? [];
  if (holeSel === null || !pts[holeSel]) return toast("Tap a hole first to select it");
  if (pts.length === 1) return toast("This is the last hole: Cancel drops the whole feature");
  pts.splice(holeSel, 1);
  selectHole(feat, null);
  rebuild();
}

/** Distances from the selected hole to the face's edges, as tappable labels. */
function holeDimLabels(feat: HoleFeature, batch: LineBatch) {
  const at = holeSel === null ? undefined : feat.points?.[holeSel];
  if (!at || feat.sketchId) return [];
  const ctx = holeContext(feat);
  const p = to2D(ctx.frame, at);
  const acc = rgb("--accent");
  const items: { el: HTMLElement; at: THREE.Vector3; dx?: number; dy?: number }[] = [];
  for (const dim of holeDims(p, ctx.edges)) {
    const foot = to3D(ctx.frame, dim.foot);
    batch.positions.push(...foot, ...at);
    batch.colors.push(...acc, ...acc);
    const el = document.createElement("button");
    el.className = "sk-label dim";
    if (holeField && Math.hypot(holeField.dim.dir[0] - dim.dir[0], holeField.dim.dir[1] - dim.dir[1]) < 1e-6) el.classList.add("sel");
    el.textContent = fmtNum(Math.round(dim.dist * 100) / 100);
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (mode.kind !== "hole") return;
      holeField = { dim };
      mode.keypad.setLabel("Distance to this edge", "mm");
      mode.keypad.set(Math.round(dim.dist * 100) / 100);
      renderPartOverlays();
    });
    const mid = to3D(ctx.frame, [(dim.foot[0] + p[0]) / 2, (dim.foot[1] + p[1]) / 2]);
    items.push({ el, at: new THREE.Vector3(...mid) });
  }
  if (holeSnapLabel) {
    const el = document.createElement("div");
    el.className = "sk-label hint";
    el.textContent = holeSnapLabel;
    items.push({ el, at: new THREE.Vector3(...at), dx: 0, dy: -28 });
  }
  return items;
}

// ---------- Revolve ----------

function axisName(sk: SketchFeature, lineId: string) {
  if (lineId === "AX") return "the sketch X axis";
  if (lineId === "AY") return "the sketch Y axis";
  return sk.entities.some((e) => e.id === lineId) ? "a line of the sketch" : "a missing line";
}

async function revolveTool(existing?: RevolveFeature) {
  if (isOperation(mode)) return;
  let feat = existing;
  if (!feat) {
    const sk = pickSketchForExtrude();
    if (!sk) return toast("Draw a closed sketch first (half of the profile, next to the axis)");
    if (mode.kind === "sketch") exitSketch();
    // A construction line is the usual way to draw a revolve axis.
    const axis = sk.entities.find((e) => e.type === "line" && e.construction && !e.axis)?.id ?? "AY";
    feat = { id: uid(), kind: "revolve", name: nextName("Revolve"), sketchId: sk.id, axisLine: axis, angle: 360, symmetric: false, op: "add" };
    doc.features.push(feat);
  }
  const f = feat;
  const sk = doc.features.find((x): x is SketchFeature => x.id === f.sketchId && x.kind === "sketch");
  if (!sk) return toast("This revolve's sketch is missing");
  const before = structuredClone(f);
  selectedFeature = f.id;
  selectedFace = null;
  showParams = false;
  vp.highlightFace(null);
  let drawnLine = f.axisLine !== "AX" && f.axisLine !== "AY" ? f.axisLine : null;
  const subtitle = () => `${sk.name} · around ${axisName(sk, f.axisLine)}`;
  const kp = openKeypad({
    title: f.name,
    subtitle: subtitle(),
    label: "Angle (360 = full turn)",
    unit: "°",
    value: Math.abs(f.angle),
    expr: f.angleExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: [
          { value: "AX", label: "Sketch X" },
          { value: "AY", label: "Sketch Y" },
          { value: "line", label: "Tapped line" },
        ],
        get: () => (f.axisLine === "AX" || f.axisLine === "AY" ? f.axisLine : "line"),
        set: (v) => {
          if (v === "line") {
            if (!drawnLine) return toast("Tap a line of the sketch to use it as the axis");
            f.axisLine = drawnLine;
          } else f.axisLine = v;
          kp.setSubtitle(subtitle());
          renderPartOverlays();
          rebuild();
        },
      },
      {
        options: [
          { value: "one", label: "One side" },
          { value: "sym", label: "Symmetric" },
        ],
        get: () => (f.symmetric ? "sym" : "one"),
        set: (v) => {
          f.symmetric = v === "sym";
          rebuild();
        },
      },
      {
        options: [
          { value: "add", label: "Join" },
          { value: "cut", label: "Cut" },
          { value: "intersect", label: "Intersect" },
        ],
        get: () => f.op,
        set: (v) => {
          f.op = v as ExtrudeOp;
          rebuild();
        },
      },
    ],
    extras: [
      {
        label: "Flip direction",
        icon: "flip",
        run: () => {
          f.angle = -f.angle;
          rebuild();
        },
      },
    ],
    onInput: (v) => {
      if (v > 0 && v <= 360) {
        f.angle = Math.sign(f.angle || 1) * v;
        rebuild();
      }
    },
  });
  mode = { kind: "revolve", feat: f, keypad: kp };
  const pickAxis = (lineId: string) => {
    drawnLine = lineId;
    f.axisLine = lineId;
    kp.setSubtitle(subtitle());
    renderPartOverlays();
    rebuild();
  };
  revolveAxisPicker = pickAxis;
  renderAll();
  rebuild(true);

  const res = await kp.result;
  revolveAxisPicker = null;
  mode = { kind: "part" };
  const value = res?.value ?? null;
  if (value === null || value <= 0 || value > 360) {
    if (value !== null) toast("The angle must be between 0 and 360°");
    if (existing) Object.assign(f, before);
    else {
      doc.features = doc.features.filter((x) => x !== f);
      selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  f.angle = Math.sign(f.angle || 1) * value;
  f.angleExpr = res?.expr;
  commit();
}

/** Set while a revolve is being edited: receives the line tapped as the new axis. */
let revolveAxisPicker: ((lineId: string) => void) | null = null;

/** A line of the sketch near a screen point (drawn and construction lines). */
function pickSketchLine(sk: SketchFeature, p: Ptr): string | null {
  const R = p.kind === "touch" ? 24 : p.kind === "pen" ? 14 : 9;
  let best: { id: string; d: number } | null = null;
  for (const e of sk.entities) {
    if (e.type !== "line" || e.axis) continue;
    const [a, b] = sketchLineWorld(sk, e.id).map((q) => vp.toScreen(new THREE.Vector3(...q)));
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L2)) : 0;
    const d = Math.hypot(a[0] + t * dx - p.x, a[1] + t * dy - p.y);
    if (d < R && (!best || d < best.d)) best = { id: e.id, d };
  }
  return best?.id ?? null;
}

// ---------- Mirror and patterns ----------

/** Features whose material can be repeated by a pattern. */
const repeatable = (f: Feature) => (f.kind === "extrude" && f.op !== "intersect") || f.kind === "pushpull" || f.kind === "hole" || f.kind === "pattern";

type PatternField = "count" | "spacing" | "count2" | "spacing2" | "angle" | "offset";
const FIELD_LABEL: Record<PatternField, [string, string]> = {
  count: ["Count (original included)", ""],
  spacing: ["Spacing", "mm"],
  count2: ["Count, 2nd direction", ""],
  spacing2: ["Spacing, 2nd direction", "mm"],
  angle: ["Total angle (360 = all around)", "°"],
  offset: ["Plane position", "mm"],
};

function patternSummary(f: PatternFeature) {
  const n = f.featureIds.length;
  const what = n ? `${n} feature${n > 1 ? "s" : ""}` : f.type === "mirror" ? "whole solid" : "no feature yet";
  if (f.type === "mirror") return `${what} · ${{ X: "YZ", Y: "XZ", Z: "XY" }[f.axis]} plane at ${fmtNum(f.offset)} mm`;
  if (f.type === "circular") return `${what} · ${f.count} around ${f.axis} · ${fmtNum(f.angle)}°`;
  const second = f.count2 > 1 ? ` × ${f.count2} along ${f.axis2}` : "";
  return `${what} · ${f.count} along ${f.axis}${second}`;
}

async function patternTool(type: PatternFeature["type"], existing?: PatternFeature) {
  if (mode.kind !== "part") return;
  if (!existing && !hasSolid()) return toast(NEED_SOLID);
  const sel = doc.features.find((f) => f.id === selectedFeature);
  const prefix = { linear: "Linear pattern", circular: "Circular pattern", mirror: "Mirror" }[type];
  const feat: PatternFeature = existing ?? {
    id: uid(),
    kind: "pattern",
    name: nextName(prefix),
    type,
    featureIds: sel && repeatable(sel) ? [sel.id] : [],
    axis: type === "circular" ? "Z" : "X",
    count: type === "circular" ? 6 : 3,
    spacing: 10,
    axis2: "Y",
    count2: 1,
    spacing2: 10,
    angle: 360,
    offset: 0,
  };
  const before = structuredClone(feat);
  if (!existing) doc.features.push(feat);
  selectedFeature = feat.id;
  selectedFace = null;
  showParams = false;
  vp.highlightFace(null);

  let field: PatternField = type === "mirror" ? "offset" : "count";
  const axisSeg = (get: () => Axis, set: (a: Axis) => void, labels: [string, string, string]) => ({
    options: (["X", "Y", "Z"] as Axis[]).map((a, i) => ({ value: a, label: labels[i] })),
    get,
    set: (v: string) => {
      set(v as Axis);
      update();
    },
  });
  const fieldSeg = (fields: PatternField[], labels: string[]) => ({
    options: fields.map((f, i) => ({ value: f, label: labels[i] })),
    get: () => field,
    set: (v: string) => {
      field = v as PatternField;
      kp.set(feat[field]);
      kp.setLabel(...FIELD_LABEL[field]);
    },
  });
  const segments =
    type === "mirror"
      ? [axisSeg(() => feat.axis, (a) => (feat.axis = a), ["YZ plane", "XZ plane", "XY plane"])]
      : type === "circular"
        ? [fieldSeg(["count", "angle"], ["Count", "Angle"]), axisSeg(() => feat.axis, (a) => (feat.axis = a), ["X axis", "Y axis", "Z axis"])]
        : [
            fieldSeg(["count", "spacing", "count2", "spacing2"], ["Count", "Spacing", "Count 2", "Spacing 2"]),
            axisSeg(() => feat.axis, (a) => (feat.axis = a), ["Along X", "Along Y", "Along Z"]),
            axisSeg(() => feat.axis2, (a) => (feat.axis2 = a), ["2nd X", "2nd Y", "2nd Z"]),
          ];
  const setField = (v: number) => {
    feat[field] = field === "count" || field === "count2" ? Math.max(1, Math.round(v)) : v;
  };
  const update = () => {
    kp.setSubtitle(patternSummary(feat));
    renderTimeline();
    rebuild();
  };
  const kp = openKeypad({
    title: feat.name,
    subtitle: patternSummary(feat),
    label: FIELD_LABEL[field][0],
    unit: FIELD_LABEL[field][1],
    value: feat[field],
    confirmLabel: "Confirm",
    segments,
    onInput: (v) => {
      setField(v);
      update();
    },
  });
  mode = { kind: "pattern", feat, keypad: kp };
  renderAll();
  rebuild(true);

  const res = await kp.result;
  mode = { kind: "part" };
  const needsFeatures = feat.type !== "mirror" && !feat.featureIds.length;
  if (res === null || needsFeatures) {
    if (res !== null) toast("Tap the features to repeat in the timeline");
    if (existing) Object.assign(feat, before);
    else {
      doc.features = doc.features.filter((x) => x !== feat);
      selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  setField(res.value);
  commit();
}

/** In a pattern, tapping a timeline step adds it to (or removes it from) the repeated features. */
function togglePatternFeature(feat: PatternFeature, f: Feature) {
  const idx = doc.features.indexOf(feat);
  if (doc.features.indexOf(f) >= idx) return toast("Only earlier features can be repeated");
  if (!repeatable(f)) return toast(`${f.name} cannot be repeated (only extrusions, Press Pull, holes and patterns)`);
  const i = feat.featureIds.indexOf(f.id);
  if (i >= 0) feat.featureIds.splice(i, 1);
  else feat.featureIds.push(f.id);
  if (mode.kind === "pattern") mode.keypad.setSubtitle(patternSummary(feat));
  renderTimeline();
  renderStatus();
  rebuild();
}

// ---------- Fillet / chamfer (on edges of the solid) ----------

async function filletTool(existing?: FilletFeature) {
  if (mode.kind !== "part") return;
  if (!existing && !hasSolid()) return toast(NEED_SOLID);
  const feat: FilletFeature = existing ?? { id: uid(), kind: "fillet", name: nextName("Fillet"), mode: "fillet", edges: [], radius: 1 };
  const before = { mode: feat.mode, radius: feat.radius, radiusExpr: feat.radiusExpr, edges: [...feat.edges], name: feat.name };
  if (!existing) doc.features.push(feat);
  selectedFeature = feat.id;
  selectedFace = null;
  showParams = false;
  vp.highlightFace(null);
  // Edges are chosen on the solid as it is before the fillet.
  previewExclude = feat.id;
  const kp = openKeypad({
    title: feat.name,
    subtitle: "Tap the edges to round or bevel",
    label: "Size",
    value: feat.radius,
    expr: feat.radiusExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: [
          { value: "fillet", label: "Fillet (round)" },
          { value: "chamfer", label: "Chamfer (bevel)" },
        ],
        get: () => feat.mode,
        set: (v) => {
          feat.mode = v as FilletFeature["mode"];
          rebuild();
          // Keep the default names in step with the choice.
          if (!existing && /^(Fillet|Chamfer) \d+$/.test(feat.name)) {
            feat.name = nextName(feat.mode === "fillet" ? "Fillet" : "Chamfer");
            renderTimeline();
          }
        },
      },
    ],
    onInput: (v) => {
      if (v > 0) feat.radius = v;
      rebuild();
    },
  });
  mode = { kind: "fillet", feat, keypad: kp };
  renderAll();
  rebuild(true);

  const res = await kp.result;
  const value = res?.value ?? null;
  previewExclude = null;
  mode = { kind: "part" };
  vp.highlightEdges([]);
  if (value === null || value <= 0 || !feat.edges.length) {
    if (value !== null && !feat.edges.length) toast("Tap at least one edge");
    if (existing) Object.assign(feat, before);
    else {
      doc.features = doc.features.filter((x) => x !== feat);
      selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.radius = value;
  feat.radiusExpr = res?.expr;
  commit();
}

function highlightFilletEdges(feat: FilletFeature) {
  vp.highlightEdges(feat.edges.map((e) => vp.edgeAt(e.mid)).filter((i): i is number => i !== null));
}

function toggleFilletEdge(feat: FilletFeature, p: Ptr) {
  const i = vp.pickEdge(p.x, p.y, p.kind === "touch" ? 24 : p.kind === "pen" ? 14 : 9);
  if (i === null) return;
  const mid = vp.edgeMid(i);
  const k = feat.edges.findIndex((e) => Math.hypot(e.mid[0] - mid[0], e.mid[1] - mid[1], e.mid[2] - mid[2]) < 0.05);
  if (k >= 0) feat.edges.splice(k, 1);
  else feat.edges.push({ mid });
  highlightFilletEdges(feat);
  rebuild();
  renderStatus();
}

const sameFace = (a: FaceRef, center: Vec3, normal: Vec3) =>
  Math.hypot(a.center[0] - center[0], a.center[1] - center[1], a.center[2] - center[2]) < 1e-3 &&
  a.normal[0] * normal[0] + a.normal[1] * normal[1] + a.normal[2] * normal[2] > 0.999;

function highlightShellFaces(feat: ShellFeature) {
  const ids = (lastBuild?.planarFaces ?? [])
    .filter((pf) => feat.faces.some((r) => sameFace(r, pf.center, pf.plane.normal)))
    .map((pf) => pf.faceId);
  vp.highlightFaces(ids);
}

function toggleShellFace(feat: ShellFeature, faceId: number) {
  const pf = lastBuild?.planarFaces.find((f) => f.faceId === faceId);
  if (!pf) return toast("Only flat faces can be opened");
  const i = feat.faces.findIndex((r) => sameFace(r, pf.center, pf.plane.normal));
  if (i >= 0) feat.faces.splice(i, 1);
  else feat.faces.push({ center: pf.center, normal: pf.plane.normal });
  highlightShellFaces(feat);
  rebuild();
}

// ---------- Parameters ----------

function paramScope() {
  return resolveParameters(doc.parameters ?? []).scope;
}

/** Re-evaluates the whole document after a parameter change; undoes it if something breaks. */
function applyParamChange(change: () => void) {
  const backup = JSON.stringify(doc);
  change();
  const problems = applyParameters(doc, solver);
  if (problems.length) {
    doc = JSON.parse(backup);
    toast(problems[0]);
    renderAll();
    return false;
  }
  commit();
  return true;
}

function askName(title: string, initial: string, except?: string): string | null {
  const name = prompt(title, initial)?.trim();
  if (!name) return null;
  if (!NAME_RE.test(name)) {
    toast("Use letters, digits and _ (not starting with a digit)");
    return null;
  }
  if ((doc.parameters ?? []).some((p) => p.name === name && p.name !== except)) {
    toast(`${name} already exists`);
    return null;
  }
  return name;
}

async function newParameter() {
  const params = (doc.parameters ??= []);
  let n = params.length + 1;
  while (params.some((p) => p.name === `p${n}`)) n++;
  const name = askName("Parameter name (e.g. width, wall, hole_d)", `p${n}`);
  if (!name) return;
  const res = await openKeypad({ title: name, subtitle: "New parameter", label: "Value", value: 10, scope: paramScope(), confirmLabel: "Add" }).result;
  if (!res) return;
  const p: Parameter = { id: uid(), name, expr: res.expr ?? String(res.value) };
  applyParamChange(() => (doc.parameters ??= []).push(p));
}

async function editParameter(p: Parameter) {
  const scope = paramScope();
  delete scope[p.name];
  const res = await openKeypad({
    title: p.name,
    subtitle: "Every dimension using it updates",
    label: "Value",
    value: paramScope()[p.name] ?? 0,
    expr: hasNames(p.expr) ? p.expr : undefined,
    scope,
    confirmLabel: "Apply",
  }).result;
  if (!res) return;
  const expr = res.expr ?? String(res.value);
  applyParamChange(() => {
    const live = doc.parameters?.find((x) => x.id === p.id);
    if (live) live.expr = expr;
  });
}

function renameParameter(p: Parameter) {
  const name = askName("New name", p.name, p.name);
  if (!name || name === p.name) return;
  for (const slot of expressionSlots(doc)) slot.set(renameInExpr(slot.get(), p.name, name));
  const live = doc.parameters?.find((x) => x.id === p.id);
  if (live) live.name = name;
  commit();
}

function deleteParameter(p: Parameter) {
  const used = usedNames(doc, p.name).has(p.name);
  if (used && !confirm(`${p.name} is used. Replace it by its current value everywhere?`)) return;
  const value = paramScope()[p.name];
  applyParamChange(() => {
    doc.parameters = (doc.parameters ?? []).filter((x) => x.id !== p.id);
    for (const slot of expressionSlots(doc)) {
      const e = renameInExpr(slot.get(), p.name, value === undefined ? "0" : `(${value})`);
      slot.set(e);
    }
    // Feature values that no longer use any parameter become plain numbers.
    for (const f of doc.features) {
      if (f.kind === "sketch") for (const c of f.constraints) if (c.expr && !hasNames(c.expr)) c.expr = undefined;
      if ((f.kind === "extrude" || f.kind === "pushpull") && f.distanceExpr && !hasNames(f.distanceExpr)) f.distanceExpr = undefined;
      if (f.kind === "shell" && f.thicknessExpr && !hasNames(f.thicknessExpr)) f.thicknessExpr = undefined;
    }
  });
}

function toggleParams() {
  showParams = !showParams;
  if (showParams) {
    selectedFeature = null;
    selectedFace = null;
    vp.highlightFace(null);
  }
  renderAll();
}

function renderParamsPanel(el: HTMLElement) {
  const params = doc.parameters ?? [];
  const { scope, errors } = resolveParameters(params);
  const h = document.createElement("div");
  h.className = "p-head";
  h.innerHTML = `<div><div class="p-title">Parameters</div><div class="p-sub">Use them in any dimension or value</div></div>`;
  const x = document.createElement("button");
  x.className = "p-close";
  x.innerHTML = icon("close", 20);
  x.setAttribute("aria-label", "Close");
  x.onclick = toggleParams;
  h.appendChild(x);
  el.appendChild(h);
  const list = document.createElement("div");
  list.className = "param-list";
  if (!params.length) {
    const hint = document.createElement("p");
    hint.className = "p-hint";
    hint.textContent = "Name the values you reuse (width, wall, screw diameter…). Change one, and the whole part follows.";
    list.appendChild(hint);
  }
  for (const p of params) {
    const row = document.createElement("div");
    row.className = "param-row";
    const main = document.createElement("button");
    main.className = "param-main";
    const val = scope[p.name];
    main.innerHTML = `<span class="param-name"></span><span class="param-expr"></span><span class="param-val"></span>`;
    main.querySelector(".param-name")!.textContent = p.name;
    main.querySelector(".param-expr")!.textContent = hasNames(p.expr) ? p.expr : "";
    const v = main.querySelector(".param-val")!;
    v.textContent = errors[p.id] ?? (val === undefined ? "?" : fmtNum(val));
    v.classList.toggle("err", !!errors[p.id]);
    main.onclick = () => void editParameter(p);
    const ren = document.createElement("button");
    ren.className = "param-icon";
    ren.innerHTML = icon("rename", 18);
    ren.title = "Rename";
    ren.onclick = () => renameParameter(p);
    const del = document.createElement("button");
    del.className = "param-icon danger";
    del.innerHTML = icon("trash", 18);
    del.title = "Delete";
    del.onclick = () => deleteParameter(p);
    row.append(main, ren, del);
    list.appendChild(row);
  }
  el.appendChild(list);
  const add = document.createElement("div");
  add.className = "p-actions";
  const b = document.createElement("button");
  b.className = "primary";
  b.innerHTML = icon("plus", 20) + "<span>New parameter</span>";
  b.onclick = () => void newParameter();
  add.appendChild(b);
  el.appendChild(add);
}

/** The selected sketch, or the last sketch not yet used by a feature. */
const NEED_SOLID = "Make a solid first (Sketch, then Extrude)";
const hasSolid = () => doc.features.some((f) => f.kind === "extrude" || f.kind === "revolve");

function pickSketchForExtrude(): SketchFeature | null {
  if (mode.kind === "sketch") return mode.editor.sk;
  const sel = doc.features.find((f) => f.id === selectedFeature);
  if (sel?.kind === "sketch") return sel;
  const used = new Set(doc.features.flatMap((f) => (f.kind === "extrude" || f.kind === "revolve" ? [f.sketchId] : [])));
  const free = doc.features.filter((f): f is SketchFeature => f.kind === "sketch" && !used.has(f.id));
  return free[free.length - 1] ?? null;
}

function renameFeature(f: Feature) {
  const name = prompt("Name", f.name);
  if (name && name.trim()) {
    f.name = name.trim();
    commit();
  }
}

function deleteFeature(f: Feature) {
  const dependents = doc.features.filter((x) => x.kind === "extrude" && x.sketchId === f.id);
  doc.features = doc.features.filter((x) => x !== f && !dependents.includes(x));
  selectedFeature = null;
  if (dependents.length) toast(`Also deleted ${dependents.map((d) => d.name).join(", ")}`);
  commit();
}

// ---------- Rendering ----------

/** What each area last showed: enter animations play only when it changes, not on every refresh. */
const shownKey = new Map<string, string>();
function playEnter(slot: string, key: string, el: HTMLElement) {
  if (shownKey.get(slot) === key) return;
  shownKey.set(slot, key);
  el.classList.remove("enter");
  void el.offsetWidth; // restart the animation
  el.classList.add("enter");
}

function renderAll() {
  document.body.dataset.mode = mode.kind;
  vp.forceOrtho = mode.kind === "sketch";
  document.body.classList.toggle("busy", mode.kind !== "part");
  renderTools();
  renderPanel();
  renderTimeline();
  renderStatus();
  renderViewButtons();
  renderPartOverlays();
}

const SKETCH_TOOLS: { tool: SketchToolName; icon: string; label: string; key: string }[] = [
  { tool: "select", icon: "select", label: "Select", key: "Esc" },
  { tool: "line", icon: "line", label: "Line", key: "L" },
  { tool: "rect", icon: "rect", label: "Rectangle", key: "R" },
  { tool: "circle", icon: "circle", label: "Circle", key: "C" },
  { tool: "arc", icon: "arc", label: "Arc", key: "A" },
  { tool: "spline", icon: "spline", label: "Spline", key: "S" },
  { tool: "point", icon: "point", label: "Point", key: "P" },
  { tool: "trim", icon: "trim", label: "Trim", key: "T" },
  { tool: "fillet", icon: "fillet", label: "Fillet", key: "F" },
  { tool: "project", icon: "project", label: "Use edges", key: "U" },
];

/** `disabled`: why the tool cannot be used now; it stays in place, greyed, and tapping it says why. */
function toolRow(ic: string, label: string, run: () => void, opts: { active?: boolean; on?: boolean; key?: string; disabled?: string } = {}) {
  const b = document.createElement("button");
  b.className = "tool";
  if (opts.disabled) {
    b.classList.add("disabled");
    b.setAttribute("aria-disabled", "true");
    const why = opts.disabled;
    run = () => toast(why);
  }
  if (opts.active) b.classList.add("active");
  if (opts.on) b.classList.add("on");
  b.innerHTML = `<span class="tile">${icon(ic)}</span><span class="label"></span>`;
  b.querySelector(".label")!.textContent = label;
  b.title = opts.key ? `${label} (${opts.key})` : label;
  b.setAttribute("aria-label", label);
  b.onclick = run;
  return b;
}

function section(title: string) {
  const s = document.createElement("div");
  s.className = "section";
  s.textContent = title;
  return s;
}

function renderTools() {
  const el = $("#tools");
  el.replaceChildren();
  // During an operation everything (confirm, cancel, options) is in the right panel.
  el.hidden = isOperation(mode);
  if (el.hidden) return;
  const collapse = document.createElement("button");
  collapse.id = "collapse";
  collapse.innerHTML = icon(prefs.collapsed ? "expand" : "collapse", 20);
  collapse.title = prefs.collapsed ? "Show labels" : "Icons only";
  collapse.onclick = () => {
    prefs.collapsed = !prefs.collapsed;
    savePrefs();
    applyPrefs();
    renderTools();
    renderStatus();
  };
  el.appendChild(collapse);

  if (mode.kind === "sketch") {
    const ed = mode.editor;
    el.appendChild(section("Draw"));
    for (const t of SKETCH_TOOLS) {
      if (t.tool === "trim") el.appendChild(section("Modify"));
      el.appendChild(
        toolRow(t.icon, t.label, () => {
          // Tapping the active tool again puts it down.
          ed.setTool(ed.tool === t.tool ? "select" : t.tool);
          renderAll();
        }, { active: ed.tool === t.tool, key: t.key }),
      );
    }
    el.appendChild(section("Options"));
    el.appendChild(
      toolRow("construction", "Construction", () => {
        ed.construction = !ed.construction;
        renderTools();
      }, { on: ed.construction, key: "G" }),
    );
  } else if (mode.kind === "pickPlane") {
    el.appendChild(section("Sketch plane"));
    for (const p of STD_PLANES) el.appendChild(toolRow("plane", PLANE_NAMES[p.label], () => createSketchOn(p)));
    el.appendChild(toolRow("close", "Cancel", () => escape()));
  } else {
    el.appendChild(section("Sketch"));
    el.appendChild(toolRow("sketch", "New sketch", startNewSketch, { key: "S" }));
    const needSketch = pickSketchForExtrude() ? undefined : "Draw a closed sketch first";
    const needSolid = hasSolid() ? undefined : NEED_SOLID;
    el.appendChild(section("Features"));
    el.appendChild(toolRow("extrude", "Extrude", () => void extrude(), { key: "E", disabled: needSketch }));
    el.appendChild(toolRow("revolve", "Revolve", () => void revolveTool(), { key: "V", disabled: needSketch }));
    // A tool waiting for a face is put down by tapping it again.
    const faceToggle = (tool: NonNullable<typeof pendingFaceTool>, start: () => void) => () => {
      if (pendingFaceTool !== tool) return start();
      pendingFaceTool = null;
      renderAll();
    };
    el.appendChild(toolRow("pushpull", "Press Pull", faceToggle("pushpull", () => faceTool("pushpull")), { active: pendingFaceTool === "pushpull", key: "Q", disabled: needSolid }));
    el.appendChild(toolRow("shell", "Shell", faceToggle("shell", () => faceTool("shell")), { active: pendingFaceTool === "shell", key: "K", disabled: needSolid }));
    el.appendChild(toolRow("fillet", "Fillet / Chamfer", () => void filletTool(), { key: "R", disabled: needSolid }));
    el.appendChild(toolRow("hole", "Hole", faceToggle("hole", startHoles), { active: pendingFaceTool === "hole", key: "H", disabled: needSolid }));
    el.appendChild(section("Repeat"));
    el.appendChild(toolRow("mirror", "Mirror", () => void patternTool("mirror"), { key: "M", disabled: needSolid }));
    el.appendChild(toolRow("linear", "Linear pattern", () => void patternTool("linear"), { key: "L", disabled: needSolid }));
    el.appendChild(toolRow("circular", "Circular pattern", () => void patternTool("circular"), { key: "O", disabled: needSolid }));
    el.appendChild(section("Design"));
    el.appendChild(toolRow("variable", "Parameters", toggleParams, { active: showParams, key: "P" }));
  }
  // Consecutive tools of a section share one icon column; their labels stay separate cards.
  let group: HTMLElement | null = null;
  for (const child of [...el.children]) {
    if (!child.classList.contains("tool")) {
      group = null;
      continue;
    }
    if (!group) {
      group = document.createElement("div");
      group.className = "tool-group";
      child.before(group);
    }
    group.appendChild(child);
  }
  // Staggered entrance when the set of tools changes (sketch, plane choice, model).
  [...el.children].forEach((c, i) => (c as HTMLElement).style.setProperty("--i", String(i)));
  playEnter("tools", mode.kind === "sketch" ? "sketch" : mode.kind === "pickPlane" ? "plane" : "part", el);
}

/** Right panel: what can be done with the current selection. */
function renderPanel() {
  const el = $("#panel-content");
  el.replaceChildren();
  const what =
    mode.kind === "sketch"
      ? `sketch:${mode.editor.sk.id}`
      : isOperation(mode)
        ? `op:${mode.feat.id}`
        : `${mode.kind}:${showParams}:${selectedFeature}:${selectedFace?.faceId ?? ""}`;
  playEnter("panel", what, el);
  const head = (title: string, sub = "", err = false, closable = false) => {
    const h = document.createElement("div");
    h.className = "p-head";
    h.innerHTML = `<div><div class="p-title"></div><div class="p-sub"></div></div>`;
    h.querySelector(".p-title")!.textContent = title;
    const s = h.querySelector(".p-sub")!;
    s.textContent = sub;
    s.classList.toggle("err", err);
    if (closable) {
      const x = document.createElement("button");
      x.className = "p-close";
      x.innerHTML = icon("close", 20);
      x.setAttribute("aria-label", "Close");
      x.onclick = clearPartSelection;
      h.appendChild(x);
    }
    el.appendChild(h);
  };
  const actions = (items: [string, string, () => void, string?][]) => {
    const box = document.createElement("div");
    box.className = "p-actions";
    for (const [ic, label, run, cls] of items) {
      const b = document.createElement("button");
      b.innerHTML = icon(ic, 20) + "<span></span>";
      b.querySelector("span")!.textContent = label;
      if (cls) b.className = cls;
      b.onclick = run;
      box.appendChild(b);
    }
    el.appendChild(box);
  };

  if (mode.kind === "sketch") {
    const ed = mode.editor;
    head(ed.sk.name, dofText(ed.dof));
    const acts = ed.actions();
    if (ed.tool === "line")
      acts.unshift({ id: "endline", label: "⏎", title: "End line", key: "Enter", run: () => ed.escape() });
    if (ed.tool === "spline" && ed.pending >= 2)
      acts.unshift({ id: "endspline", label: "⏎", title: "Finish spline", key: "Enter", run: () => ed.escape() });
    if (acts.length) {
      const grid = document.createElement("div");
      grid.className = "p-grid";
      for (const a of acts) grid.appendChild(actionTile(a));
      el.appendChild(grid);
    } else {
      const hint = document.createElement("p");
      hint.className = "p-hint";
      hint.textContent =
        ed.tool === "select"
          ? "Tap lines, circles or points to constrain them. Drag a point to move it."
          : ed.tool === "trim"
            ? "Press a piece of a curve: it turns red, and goes when you lift, up to the nearest crossings."
            : ed.tool === "fillet"
              ? "Tap the corner point between two lines, then type the radius."
              : ed.tool === "project"
                ? "Tap edges of the model: each one is added to the sketch, flattened onto its plane and fixed."
          : "Tap or drag to draw. Points snap to existing geometry.";
      el.appendChild(hint);
    }
    actions([["check", "Finish sketch", exitSketch, "primary"]]);
    return;
  }
  if (mode.kind !== "part") return;
  if (showParams) return renderParamsPanel(el);

  if (selectedFace) {
    const plane = selectedFace.plane;
    head("Face", plane ? "Flat face" : "Curved face", false, true);
    const items: [string, string, () => void, string?][] = [];
    if (plane) {
      items.push(["sketch", "Sketch on this face", () => createSketchOn(plane)]);
      items.push(["pushpull", "Press Pull", () => faceTool("pushpull")]);
      items.push(["shell", "Shell (open this face)", () => faceTool("shell")]);
      items.push(["hole", "Hole here", () => faceTool("hole")]);
      items.push(["lookAt", "Look at", () => vp.viewNormalTo(plane)]);
    }
    actions(items);
    return;
  }
  const f = doc.features.find((x) => x.id === selectedFeature);
  if (f) {
    const err = lastBuild?.errors[f.id] ?? lastBuild?.warnings?.[f.id];
    head(f.name, err ?? featureDetail(f), !!err, true);
    const items: [string, string, () => void, string?][] = [];
    if (f.kind === "sketch") {
      items.push(["edit", "Edit sketch", () => enterSketch(f)]);
      items.push(["extrude", "Extrude", () => void extrude()]);
      items.push(["revolve", "Revolve", () => void revolveTool()]);
      if (sketchHolePoints(f).length) items.push(["hole", "Holes at its points", startHoles]);
    } else if (f.kind === "extrude") items.push(["edit", "Edit", () => void extrude(f)]);
    else if (f.kind === "pushpull") items.push(["edit", "Edit", () => void pushPull(f)]);
    else if (f.kind === "fillet") items.push(["edit", "Edit", () => void filletTool(f)]);
    else if (f.kind === "hole") items.push(["edit", "Edit", () => void holeTool(f)]);
    else if (f.kind === "pattern") items.push(["edit", "Edit", () => void patternTool(f.type, f)]);
    else if (f.kind === "revolve") items.push(["edit", "Edit", () => void revolveTool(f)]);
    else items.push(["edit", "Edit", () => void shell(f)]);
    items.push(["rename", "Rename", () => renameFeature(f)]);
    items.push(["trash", "Delete", () => deleteFeature(f), "danger"]);
    actions(items);
  }
}

function actionTile(a: Action) {
  const b = document.createElement("button");
  if (a.id === "del") b.classList.add("danger");
  const glyph = a.id === "del" ? icon("trash", 20) : a.id === "constr" ? icon("construction", 20) : "";
  b.innerHTML = `<span class="glyph">${glyph}</span><span class="cap"></span>`;
  if (!glyph) b.querySelector(".glyph")!.textContent = a.label;
  b.querySelector(".cap")!.textContent = a.title;
  b.title = a.key ? `${a.title} (${a.key})` : a.title;
  b.onclick = () => {
    a.run();
    renderPanel();
  };
  return b;
}

function dofText(dof: number) {
  return dof === 0 ? "Fully constrained" : dof < 0 ? "Over-constrained" : `${dof} degree${dof > 1 ? "s" : ""} of freedom left`;
}

function featureDetail(f: Feature) {
  if (f.kind === "sketch") return f.plane.label === "Face" ? "Sketch on a face" : `Sketch on ${PLANE_NAMES[f.plane.label]}`;
  if (f.kind === "pushpull") return `${f.distance >= 0 ? "Pull" : "Push"} · ${fmtNum(Math.abs(f.distance))} mm`;
  if (f.kind === "shell") return `${fmtNum(f.thickness)} mm walls · ${f.faces.length} open face${f.faces.length > 1 ? "s" : ""}`;
  if (f.kind === "pattern") return patternSummary(f);
  if (f.kind === "revolve") {
    const sk = doc.features.find((x): x is SketchFeature => x.id === f.sketchId && x.kind === "sketch");
    const op = f.op === "add" ? "Join" : f.op === "cut" ? "Cut" : "Intersect";
    return `${op} · ${fmtNum(Math.abs(f.angle))}°${f.symmetric ? " symmetric" : ""} around ${sk ? axisName(sk, f.axisLine) : "?"}`;
  }
  if (f.kind === "hole") {
    const n = f.sketchId ? "at sketch points" : `× ${f.points?.length ?? 0}`;
    const head = f.head === "counterbore" ? " · counterbore" : f.head === "countersink" ? " · countersink" : "";
    return `${f.size} ${n}${head} · ${f.depth > 0 ? `${fmtNum(f.depth)} mm deep` : "through"}`;
  }
  if (f.kind === "fillet")
    return `${f.mode === "fillet" ? "Radius" : "Chamfer"} ${fmtNum(f.radius)} mm · ${f.edges.length} edge${f.edges.length > 1 ? "s" : ""}`;
  const op = f.op === "add" ? "Join" : f.op === "cut" ? "Cut" : "Intersect";
  return `${op} · ${fmtNum(Math.abs(f.distance))} mm${f.symmetric ? " · symmetric" : ""}`;
}

function featureIcon(f: Feature) {
  if (f.kind === "sketch") return "rect";
  if (f.kind === "pushpull") return "pushpull";
  if (f.kind === "shell") return "shell";
  if (f.kind === "fillet") return f.mode === "fillet" ? "fillet" : "chamfer";
  if (f.kind === "hole") return "hole";
  if (f.kind === "pattern") return f.type;
  if (f.kind === "revolve") return "revolve";
  return f.op === "cut" ? "cut" : f.op === "intersect" ? "intersect" : "extrude";
}

/** Steps shown at the last refresh (null before the first one: nothing pops in on load). */
let chipsShown: Set<string> | null = null;

function renderTimeline() {
  const el = $("#chips");
  el.replaceChildren();
  if (!doc.features.length) {
    const e = document.createElement("span");
    e.className = "empty";
    e.textContent = "Your feature history appears here. Start with New sketch.";
    el.appendChild(e);
  }
  const current = mode.kind === "sketch" ? mode.editor.sk.id : isOperation(mode) ? mode.feat.id : selectedFeature;
  doc.features.forEach((f, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "chip-sep";
      sep.innerHTML = icon("chevron", 16);
      el.appendChild(sep);
    }
    const b = document.createElement("button");
    b.className = "chip";
    // A step that was not there at the last refresh pops in.
    if (chipsShown && !chipsShown.has(f.id)) b.classList.add("pop");
    if (f.id === current) b.classList.add("sel");
    if (mode.kind === "pattern" && mode.feat.featureIds.includes(f.id)) b.classList.add("picked");
    if (lastBuild?.errors[f.id]) b.classList.add("error");
    else if (lastBuild?.warnings?.[f.id]) b.classList.add("warn");
    b.innerHTML = icon(featureIcon(f), 20) + "<span></span>";
    b.querySelector("span")!.textContent = f.kind === "extrude" ? `${f.name} · ${fmtNum(Math.abs(f.distance))}` : f.name;
    b.onclick = () => {
      if (mode.kind === "pattern") return togglePatternFeature(mode.feat, f);
      if (mode.kind !== "part") return toast("Finish the current step first");
      selectedFace = null;
      vp.highlightFace(null);
      selectedFeature = selectedFeature === f.id ? null : f.id;
      showParams = false;
      renderAll();
    };
    el.appendChild(b);
    if (f.id === current) requestAnimationFrame(() => b.scrollIntoView({ inline: "nearest", block: "nearest" }));
  });
  chipsShown = new Set(doc.features.map((f) => f.id));
  for (const b of buttons(".undo-btn")) b.disabled = undoPos === 0;
  for (const b of buttons(".redo-btn")) b.disabled = undoPos >= undoStack.length - 1;
}

function renderStatus() {
  let s = kernelMessage;
  if (mode.kind === "pickPlane") s = "New sketch · tap a plane or a flat face";
  else if (mode.kind === "sketch") {
    const ed = mode.editor;
    const tool = SKETCH_TOOLS.find((t) => t.tool === ed.tool)!.label;
    s = `${ed.sk.name} · ${tool} · ${dofText(ed.dof).toLowerCase()}`;
  } else if (mode.kind === "extrude") s = "Extrude · drag the handle or type a value";
  else if (mode.kind === "pushpull") s = "Press Pull · drag the handle or type a value";
  else if (mode.kind === "shell") s = "Shell · tap the faces to open, type the wall thickness";
  else if (mode.kind === "revolve") s = "Revolve · tap a line of the sketch to use it as the axis";
  else if (mode.kind === "pattern") {
    const f = mode.feat;
    s = f.featureIds.length || f.type === "mirror" ? `${f.name} · tap timeline steps to add or remove them` : `${f.name} · tap the features to repeat in the timeline`;
  } else if (mode.kind === "hole") {
    const f = mode.feat;
    s = f.sketchId ? `Hole · ${f.size} at the sketch points` : `Hole · ${f.size} × ${f.points?.length ?? 0} · tap to add, drag a hole to move it`;
  } else if (mode.kind === "fillet") {
    const n = mode.feat.edges.length;
    s = `${mode.feat.mode === "fillet" ? "Fillet" : "Chamfer"} · ${n ? `${n} edge${n > 1 ? "s" : ""} chosen` : "tap the edges"}, type the size`;
  }
  else if (pendingFaceTool) s = `${{ shell: "Shell", pushpull: "Press Pull", hole: "Hole" }[pendingFaceTool]} · tap a flat face`;
  $("#status").textContent = s;
}

function renderViewButtons() {
  const el = $("#view-buttons");
  el.replaceChildren();
  const add = (ic: string, title: string, run: () => void, on = false) => {
    const b = document.createElement("button");
    b.innerHTML = icon(ic, 22);
    b.title = title;
    b.setAttribute("aria-label", title);
    if (on) b.classList.add("on");
    b.onclick = run;
    el.appendChild(b);
  };
  add("fit", "Fit (F)", () => vp.fit());
  // Sketches are always shown without perspective, so the toggle is only offered outside them.
  if (mode.kind !== "sketch")
    add("perspective", vp.perspective ? "Perspective (tap for orthographic)" : "Orthographic (tap for perspective)", () => {
      vp.perspective = prefs.perspective = !vp.perspective;
      savePrefs();
      renderViewButtons();
    }, vp.perspective);
  add("grid", "Grid", () => {
    vp.setGridVisible(!vp.isGridVisible);
    renderViewButtons();
  }, vp.isGridVisible);
  if (mode.kind === "sketch") {
    const plane = mode.editor.sk.plane;
    add("lookAt", "Look at sketch", () => vp.viewNormalTo(plane));
  }
}

/** Sketches not consumed by a feature stay visible in the part view. */
function renderPartOverlays() {
  if (mode.kind === "sketch") return;
  const used = new Set(doc.features.flatMap((f) => (f.kind === "extrude" || f.kind === "revolve" ? [f.sketchId] : [])));
  const sel = doc.features.find((f) => f.id === selectedFeature);
  const highlight = sel?.kind === "sketch" ? sel.id : sel?.kind === "extrude" || sel?.kind === "revolve" ? sel.sketchId : null;
  const batch: LineBatch = { positions: [], colors: [], width: 2, overlay: true };
  const hi = rgb("--sk-selected");
  const normal = rgb("--sk-line");
  for (const f of doc.features) {
    if (f.kind !== "sketch") continue;
    if (used.has(f.id) && f.id !== highlight) continue;
    appendSketchLines(batch, f, f.id === highlight ? hi : normal);
  }
  if (mode.kind === "revolve") {
    const f = mode.feat;
    const sk = doc.features.find((x): x is SketchFeature => x.id === f.sketchId && x.kind === "sketch");
    if (sk) {
      const muted = rgb("--sk-construction");
      for (const e of sk.entities) {
        if (e.type !== "line" || !e.construction || e.axis) continue;
        const [a, b] = sketchLineWorld(sk, e.id);
        batch.positions.push(...a, ...b);
        batch.colors.push(...muted, ...muted);
      }
      try {
        // The axis, drawn long in the accent colour.
        const [a, b] = sketchLineWorld(sk, f.axisLine);
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const len = Math.hypot(d[0], d[1], d[2]) || 1;
        const L = vp.viewHeight * 2;
        const acc = rgb("--accent");
        batch.positions.push(...[0, 1, 2].map((i) => a[i] - (d[i] / len) * L), ...[0, 1, 2].map((i) => a[i] + (d[i] / len) * L));
        batch.colors.push(...acc, ...acc);
      } catch {
        // Missing axis line: the build reports it.
      }
    }
  }
  const marks = { positions: [] as number[], colors: [] as number[], size: 14 };
  let labels: { el: HTMLElement; at: THREE.Vector3; dx?: number; dy?: number }[] = [];
  if (mode.kind === "hole") {
    const f = mode.feat;
    const sk = f.sketchId ? doc.features.find((x): x is SketchFeature => x.id === f.sketchId && x.kind === "sketch") : undefined;
    const acc = rgb("--accent");
    const sel = rgb("--sk-selected");
    (sk ? sketchHolePoints(sk) : f.points ?? []).forEach((q, i) => {
      marks.positions.push(...q);
      marks.colors.push(...(!sk && i === holeSel ? sel : acc));
    });
    labels = holeDimLabels(f, batch);
  }
  vp.setSketchLayer([batch], [marks]);
  vp.setLabels(labels);
}

function rgb(name: string) {
  const c = new THREE.Color(cssVar(name, "#888888"));
  return [c.r, c.g, c.b];
}

function appendSketchLines(b: LineBatch, sk: SketchFeature, col: number[]) {
  const v = new SketchView(sk);
  const { origin, xDir, normal } = sk.plane;
  const yDir = [normal[1] * xDir[2] - normal[2] * xDir[1], normal[2] * xDir[0] - normal[0] * xDir[2], normal[0] * xDir[1] - normal[1] * xDir[0]];
  const w = ([x, y]: [number, number]) => [0, 1, 2].map((i) => origin[i] + xDir[i] * x + yDir[i] * y);
  const seg = (p: [number, number], q: [number, number]) => {
    b.positions.push(...w(p), ...w(q));
    b.colors.push(...col, ...col);
  };
  const arc = (c: [number, number], r: number, a0: number, a1: number) => {
    const n = Math.max(12, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 72));
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      seg([c[0] + r * Math.cos(t0), c[1] + r * Math.sin(t0)], [c[0] + r * Math.cos(t1), c[1] + r * Math.sin(t1)]);
    }
  };
  for (const c of v.curves()) {
    if (c.construction) continue;
    if (c.type === "line") seg(v.xy(c.p1), v.xy(c.p2));
    else if (c.type === "circle") arc(v.xy(c.c), c.r, 0, 2 * Math.PI);
    else if (c.type === "spline") {
      const ps = sampleSpline(v, c);
      for (let i = 0; i + 1 < ps.length; i++) seg(ps[i], ps[i + 1]);
    } else arc(v.xy(c.c), v.arcRadius(c), ...v.arcAngles(c));
  }
}

// ---------- Part-mode pointer tool: pick planes and faces ----------

const partTool: PointerTool = {
  down(p) {
    if (mode.kind === "hole") holeDown(mode.feat, p);
  },
  move(p) {
    if (mode.kind === "hole") holeMove(mode.feat, p);
  },
  up(p) {
    if (mode.kind === "pickPlane") return pickPlaneAt(p);
    const face = vp.pickFace(p.x, p.y);
    if (mode.kind === "shell") {
      if (face != null) toggleShellFace(mode.feat, face);
      return;
    }
    if (mode.kind === "fillet") return toggleFilletEdge(mode.feat, p);
    if (mode.kind === "hole") return holeUp(mode.feat, p);
    if (mode.kind === "revolve") {
      const sk = doc.features.find((x): x is SketchFeature => x.id === (mode as { feat: RevolveFeature }).feat.sketchId && x.kind === "sketch");
      const line = sk ? pickSketchLine(sk, p) : null;
      if (line) revolveAxisPicker?.(line);
      return;
    }
    if (mode.kind !== "part") return;
    vp.highlightFace(face);
    selectedFeature = null;
    if (face != null) showParams = false;
    const pf = face == null ? undefined : lastBuild?.planarFaces.find((f) => f.faceId === face);
    const hit = face == null ? null : vp.pickPoint(p.x, p.y)?.point ?? null;
    selectedFace = face == null ? null : { faceId: face, plane: pf?.plane ?? null, center: pf?.center ?? null, hit };
    if (pendingFaceTool && face != null) {
      if (!pf) return toast("Only flat faces work here");
      return faceTool(pendingFaceTool);
    }
    renderAll();
  },
  cancel() {
    holeDrag = null;
  },
  hover(p) {
    if (mode.kind !== "pickPlane" || !p) return;
    vp.highlightFace(vp.pickFace(p.x, p.y));
  },
};

// ---------- Menu, files ----------

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function openFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.tcad,application/json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text()) as CadDocument;
      if (d.format !== "touch-cad") throw new Error("not a touch-cad file");
      if (mode.kind === "sketch") exitSketch();
      doc = d;
      selectedFeature = null;
      commit();
      vp.fit();
    } catch (e) {
      toast("Cannot open this file: " + (e instanceof Error ? e.message : e));
    }
  };
  input.click();
}

function newDocument() {
  if (doc.features.length && !confirm("Start a new document? (Undo can bring the current one back.)")) return;
  if (mode.kind === "sketch") exitSketch();
  doc = { format: "touch-cad", version: 1, features: [] };
  selectedFeature = null;
  commit();
}

function setTheme(theme: Prefs["theme"]) {
  prefs.theme = theme;
  savePrefs();
  applyPrefs();
  vp.applyThemeColors();
  if (mode.kind === "sketch") mode.editor.render();
  renderAll();
}

function setupMenu() {
  const menu = $("#menu-panel");
  const items: [string, () => void][] = [
    ["New document", newDocument],
    ["Open…", openFile],
    ["Save (.json)", () => download(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }), "model.tcad.json")],
    ["Export STEP", () => exportFile("step")],
    ["Export STL", () => exportFile("stl")],
    ["Light / dark theme", () => setTheme(prefs.theme === "light" ? "dark" : "light")],
    ["Help", () => $("#help").classList.add("open")],
  ];
  for (const [label, run] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      menu.classList.remove("open");
      run();
    };
    menu.appendChild(b);
  }
  const btn = $("#menu");
  btn.innerHTML = icon("menu", 22);
  btn.onclick = (e) => {
    e.stopPropagation();
    menu.classList.toggle("open");
  };
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target as Node) && !btn.contains(e.target as Node)) menu.classList.remove("open");
  });
}

// ---------- Movable side panel ----------

/** Phones show the panel as a bottom sheet: no free placement there. */
const narrow = window.matchMedia("(max-width: 760px)");

function placePanel() {
  const panel = $("#panel");
  const pos = prefs.panelPos;
  if (!pos || narrow.matches) {
    panel.style.left = panel.style.top = panel.style.right = panel.style.transform = "";
    return;
  }
  const w = panel.offsetWidth || 272;
  const h = panel.offsetHeight || 200;
  // Stay clear of the timeline at the bottom when there is room for it.
  const bottom = window.innerHeight - ($("#timeline").offsetHeight + 24);
  const x = Math.min(Math.max(pos.x, 8), window.innerWidth - w - 8);
  const y = Math.max(Math.min(pos.y, (h <= bottom - 8 ? bottom : window.innerHeight - 8) - h), 8);
  Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, right: "auto", transform: "none" });
}

function setupPanelDrag() {
  const panel = $("#panel");
  const grip = panel.querySelector<HTMLElement>(".panel-grip")!;
  let drag: { id: number; dx: number; dy: number } | null = null;
  grip.addEventListener("pointerdown", (e) => {
    if (narrow.matches) return;
    e.preventDefault();
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer.
    }
    const r = panel.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    panel.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    prefs.panelPos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    placePanel();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    panel.classList.remove("dragging");
    savePrefs();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  // Double tap on the bar puts the panel back in its default place.
  grip.addEventListener("dblclick", () => {
    prefs.panelPos = null;
    savePrefs();
    placePanel();
  });
  window.addEventListener("resize", placePanel);
  narrow.addEventListener("change", placePanel);
  // The panel changes height with its content (keypad, constraints): keep it on screen.
  new MutationObserver(placePanel).observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
}

// ---------- Toasts ----------

let toastTimer = 0;
function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 2600);
}

function fmtNum(v: number) {
  return String(Math.round(v * 1000) / 1000);
}

// ---------- Keyboard (optional) ----------

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest("input, textarea")) return;
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k.toLowerCase() === "z") {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (ctrl && k.toLowerCase() === "y") {
    e.preventDefault();
    return redo();
  }
  if (ctrl || e.altKey) return;
  if (k === "Escape") return void escape();
  if (mode.kind === "sketch") {
    const ed = mode.editor;
    if (k === "Enter") {
      if (!ed.escape()) exitSketch();
      return renderAll();
    }
    if (k === "Delete" || k === "Backspace") return ed.deleteSelection();
    if (ed.selection.size && ed.runShortcut(k)) return renderPanel();
    const t = SKETCH_TOOLS.find((x) => x.key.toLowerCase() === k.toLowerCase());
    if (t) ed.setTool(t.tool);
    else if (k.toLowerCase() === "g") ed.construction = !ed.construction;
    else return;
    return renderAll();
  }
  if (mode.kind === "part") {
    const key = k.toLowerCase();
    if (key === "s") startNewSketch();
    else if (key === "e") void extrude();
    else if (key === "q") faceTool("pushpull");
    else if (key === "p") toggleParams();
    else if (key === "r") void filletTool();
    else if (key === "h") startHoles();
    else if (key === "m") void patternTool("mirror");
    else if (key === "l") void patternTool("linear");
    else if (key === "o") void patternTool("circular");
    else if (key === "v") void revolveTool();
    else if (key === "k") faceTool("shell");
    else if (key === "f") vp.fit();
    else if (key === "delete" && selectedFeature) {
      const f = doc.features.find((x) => x.id === selectedFeature);
      if (f) deleteFeature(f);
    }
  }
});

// Android back gesture = Escape (one history entry is kept in reserve).
history.replaceState({ base: true }, "");
history.pushState({ guard: true }, "");
window.addEventListener("popstate", () => {
  if (escape()) history.pushState({ guard: true }, "");
});

// ---------- Boot ----------

async function boot() {
  setKeypadHost($("#panel"));
  setupPanelDrag();
  placePanel();
  setupMenu();
  for (const b of buttons(".undo-btn")) {
    b.innerHTML = icon("undo", 22);
    b.onclick = undo;
  }
  for (const b of buttons(".redo-btn")) {
    b.innerHTML = icon("redo", 22);
    b.onclick = redo;
  }
  createAxisGizmo($("#gizmo"), vp, 124);
  $("#help-close").onclick = () => $("#help").classList.remove("open");
  renderAll();
  solver = await Solver.create(planegcsWasm);
  new InputRouter(vp, $("#view"), {
    is2D: () => mode.kind === "sketch",
    tool: () => (mode.kind === "sketch" ? mode.editor : partTool),
    onUndo: undo,
    onRedo: redo,
  });
  if (!doc.features.length) $("#help").classList.add("open");
  if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("./sw.js");
}

void boot();
