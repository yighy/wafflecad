import "./style.css";
import * as THREE from "three";
import planegcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import type { Axis, BuildResult, CadDocument, Clash, Mate, MateRef, PartInstance, ExtrudeFeature, RevolveFeature, ExtrudeOp, FaceRef, Feature, FilletFeature, HoleFeature, Parameter, PatternFeature, PlaneDef, PushPullFeature, ShellFeature, SketchFeature, Vec3, WorkerRequest, WorkerResponse } from "./types";
import { NAME_RE, applyParameters, expressionSlots, hasNames, renameInExpr, resolveParameters, usedNames } from "./params";
import { Viewport, cssVar, type DisplayMode, type LineBatch } from "./view/viewport";
import { InputRouter, type PointerTool, type Ptr } from "./view/input";
import { Solver } from "./sketch/solver";
import { SketchEditor, type Action, type SketchToolName } from "./sketch/editor";
import { SketchView, newSketch, sampleCurve, sketchLineWorld, uid } from "./sketch/model";
import { openKeypad, setKeypadHost, type KeypadHandle, type Segmented } from "./ui/keypad";
import { icon } from "./ui/icons";
import { createAxisGizmo } from "./ui/axisGizmo";
import { scrollHints } from "./ui/scrollHints";
import { DistanceHandle, sketchArrow } from "./ui/distanceHandle";
import { PlaceGizmo } from "./ui/placeGizmo";
import { instanceMatrix, localRef, placementOf, solveMates, worldRef } from "./cad/mates";
import { findRegions } from "./sketch/profiles";
import { HOLE_SIZES, sketchHolePoints } from "./cad/holes";
import { parseDxf } from "./sketch/dxf";
import { parseSvg } from "./sketch/svg";
import { bounds, insertShapes, type ImportOptions, type ImportShape } from "./sketch/importShapes";
import { textShapes } from "./sketch/text";
import { FONTS, loadFont, type FontId } from "./sketch/fonts";
import type { Font } from "opentype.js";
import type { ExportFormat, MeasurePick, MeasureResult, MeasureRow } from "./types";
import { deleteProject, freeName, getProject, listProjects, newProjectId, putProject, type ProjectMeta } from "./projects";
import { atDistance, edgesInPlane, faceFrame, holeDims, snapHole, to2D, to3D, type EdgeDim } from "./cad/holePlace";

/** Where versions before projects kept their one document (moved into a project at start). */
const STORAGE_KEY = "waffle.document";
const PREFS_KEY = "waffle.prefs";

// The app was called "Touch CAD" first: move what that version saved in this browser.
try {
  for (const [from, to] of [
    ["touch-cad.document", STORAGE_KEY],
    ["touch-cad.prefs", PREFS_KEY],
  ]) {
    const v = localStorage.getItem(from);
    if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v);
    localStorage.removeItem(from);
  }
} catch {
  // Private mode: nothing saved anyway.
}

/** Documents saved by the first versions say "touch-cad"; read them as WaffleCAD documents. */
function asDocument(d: unknown): CadDocument | null {
  const x = d as { format?: string; features?: unknown } | null;
  if (!x || (x.format !== "waffle" && x.format !== "touch-cad") || !Array.isArray(x.features)) return null;
  return { ...(x as CadDocument), format: "waffle" };
}
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
  display: DisplayMode;
  /** The project open last. */
  project: string | null;
}
const prefs: Prefs = { theme: "light", collapsed: false, panelPos: null, perspective: false, display: "shaded-edges", project: null };
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
  | { kind: "revolve"; feat: RevolveFeature; keypad: KeypadHandle }
  | { kind: "place"; feat: PartInstance; keypad: KeypadHandle }
  /** Choosing the two faces or holes of a new mate. */
  | { kind: "mate"; picks: MatePick[] }
  | { kind: "mateEdit"; feat: Mate; keypad: KeypadHandle };

/** A face or hole chosen for a mate: its plane or axis, and what to highlight. */
interface MatePick {
  ref: MateRef;
  face?: number;
  edge?: number;
}

/** Modes where a feature is being edited with the keypad open. */
const isOperation = (m: Mode): m is Extract<Mode, { keypad: KeypadHandle }> => "keypad" in m;

const emptyDoc = (): CadDocument => ({ format: "waffle", version: 1, features: [] });
let doc: CadDocument = emptyDoc();
/** The open project; null until the saved ones are read (or when this browser cannot store them). */
let project: ProjectMeta | null = null;
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
/** The document without its imported files (they only ever get added, so undo leaves them be). */
const snapshot = () => JSON.stringify({ ...doc, files: undefined });
const undoStack: string[] = [snapshot()];
let undoPos = 0;

const vp = new Viewport($("#view"));
vp.perspective = prefs.perspective;
vp.setDisplayMode(prefs.display);
let solver: Solver;

// ---------- Worker ----------

const worker = new Worker(new URL("./cad/worker.ts", import.meta.url), { type: "module" });
let kernelReady = false;
let reqCounter = 0;
let latestBuild = 0;
const pendingFiles = new Map<number, (b: Blob | null, err?: string) => void>();
const pendingRefs = new Map<number, (ref: Omit<MateRef, "part"> | null) => void>();
const pendingClashes = new Map<number, (c: Clash[], err?: string) => void>();
let buildTimer = 0;
/** One build at a time: while one runs, later changes wait and go as a single build after it. */
let buildRunning = false;
let buildSlow = false;
let buildSlowTimer = 0;
let buildAgain = false;
/** Frame the model when the next build arrives (after an import). */
let fitNext = false;
/** Quality of the build waiting behind the running one: fine if any request wanted fine. */
let againDraft = true;

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
    buildRunning = false;
    if (buildAgain) {
      // More changes waited: the indicator stays on through the next build.
      buildAgain = false;
      sendBuild(againDraft);
    } else {
      clearTimeout(buildSlowTimer);
      buildSlowTimer = 0;
      if (buildSlow) {
        buildSlow = false;
        document.body.classList.remove("building");
        renderStatus();
      }
    }
    if (m.reqId !== latestBuild) return;
    const first = lastBuild === null;
    lastBuild = m;
    vp.setModel(m, m.preview);
    if (isOperation(mode)) mode.keypad.setNote(m.preview?.error ?? null);
    if ((first || fitNext) && m.mesh) {
      fitNext = false;
      vp.fit();
    }
    if (mode.kind === "sketch") vp.setModelOpacity(0.45);
    if (mode.kind === "shell") highlightShellFaces(mode.feat);
    if (mode.kind === "fillet") highlightFilletEdges(mode.feat);
    renderTimeline();
    renderPanel();
    renderPartOverlays();
    if (explode > 0) spreadParts(explode);
    syncGizmo();
    if (thumbStale) scheduleThumb();
    if (measuring) showMeasurePicks();
  } else if (m.type === "measured") {
    if (!measuring || m.reqId !== measureReq) return;
    measuring.result = m.result;
    renderPanel();
    renderPartOverlays();
  } else if (m.type === "clash") {
    pendingClashes.get(m.reqId)?.(m.clashes, m.error);
    pendingClashes.delete(m.reqId);
  } else if (m.type === "ref") {
    pendingRefs.get(m.reqId)?.(m.ref);
    pendingRefs.delete(m.reqId);
  } else if (m.type === "file") {
    pendingFiles.get(m.reqId)?.(m.blob, m.error);
    pendingFiles.delete(m.reqId);
  }
};

function sendBuild(draft = false) {
  if (!kernelReady) return;
  if (buildRunning) {
    againDraft = buildAgain ? againDraft && draft : draft;
    buildAgain = true;
    return;
  }
  buildRunning = true;
  // A build that takes a while shows a running bar at the top, and says so in the status line.
  if (!buildSlowTimer && !buildSlow)
    buildSlowTimer = window.setTimeout(() => {
      buildSlowTimer = 0;
      if (!buildRunning) return;
      buildSlow = true;
      document.body.classList.add("building");
      renderStatus();
    }, 250);
  latestBuild = ++reqCounter;
  worker.postMessage({ type: "build", reqId: latestBuild, doc, pickExclude: previewExclude ?? undefined, draft } satisfies WorkerRequest);
}

/**
 * Rebuilds the model. Continuous edits (dragging a handle, typing) are throttled, not debounced:
 * the model keeps up while the finger moves, as fast as the kernel allows. The first change of a
 * burst builds fine; the ones that follow quickly are drafts (coarser mesh, no flat faces), and
 * once the changes stop a fine build follows.
 */
let lastChange = 0;
let settleTimer = 0;
let draftSent = false;
const SETTLE_MS = 300;
function rebuild(now = false) {
  const t = performance.now();
  const burst = t - lastChange < SETTLE_MS;
  lastChange = t;
  clearTimeout(settleTimer);
  settleTimer = 0;
  if (now) {
    clearTimeout(buildTimer);
    buildTimer = 0;
    draftSent = false;
    return sendBuild();
  }
  if (burst) {
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (!draftSent) return;
      draftSent = false;
      sendBuild();
    }, SETTLE_MS);
  }
  if (buildTimer) return;
  buildTimer = window.setTimeout(() => {
    buildTimer = 0;
    // Whether this change came in a burst is decided now, not when it was scheduled.
    const draft = settleTimer !== 0;
    if (draft) draftSent = true;
    sendBuild(draft);
  }, 50);
}

function exportFile(format: ExportFormat) {
  if (!kernelReady) return toast("The geometry kernel is still loading");
  const reqId = ++reqCounter;
  pendingFiles.set(reqId, (blob, err) => {
    if (!blob) return toast(err ? "Export failed: " + err : "Nothing to export");
    download(blob, `${fileName()}.${format}`);
  });
  worker.postMessage({ type: "export", reqId, doc, format, name: project?.name ?? "Model" } satisfies WorkerRequest);
}

// ---------- Document, history, persistence ----------

let saveTimer = 0;
let thumbTimer = 0;
/** The model changed since its picture was taken. */
let thumbStale = false;

/** Saves the open project shortly after a change (changes in a row are written once). */
function save() {
  if (!project) return;
  thumbStale = true;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 400);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!saveTimer || !project) return;
  saveTimer = 0;
  project.updated = Date.now();
  try {
    await putProject({ ...project }, doc);
  } catch {
    toast("Could not save in this browser");
  }
}

/** Takes the project's picture from the view, when the model shows as a part (not a sketch). */
function captureThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = 0;
  if (!project || !thumbStale || mode.kind !== "part" || !lastBuild) return;
  const thumb = lastBuild.mesh ? vp.thumbnail(320, 220) : undefined;
  if (thumb === null) return; // no view to take it from (app in the background): later
  thumbStale = false;
  project.thumb = thumb;
  putProject({ ...project }).catch(() => {});
}
function scheduleThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(captureThumb, 1500);
}

function resetHistory() {
  undoStack.length = 0;
  undoStack.push(snapshot());
  undoPos = 0;
}

/** Leaves sketches and operations, keeping what they did, before another project opens. */
function leaveModes() {
  for (let i = 0; i < 20 && escape(); i++);
  pendingFaceTool = null;
}

/** `from`: the assembly this part is opened from (offered as the way back). */
async function openProject(id: string, from: { id: string; name: string } | null = null) {
  await flushSave();
  captureThumb();
  const p = await getProject(id).catch(() => null);
  if (!p) return toast("This project could not be opened");
  leaveModes();
  project = p.meta;
  doc = asDocument(p.doc) ?? emptyDoc();
  cameFrom = from;
  if (isAssembly()) {
    await loadParts();
    // Assemblies made before mates: the first part holds the others.
    if (doc.instances?.length && !doc.instances.some((i) => i.fixed)) doc.instances[0].fixed = true;
    solveState = null;
  }
  explode = explodeTarget = 0;
  clashes = null;
  vp.setClashes(null);
  prefs.project = id;
  savePrefs();
  selectedFeature = null;
  selectedFace = null;
  lastBuild = null; // the first build of the project frames it
  hiddenBodies = new Set();
  vp.setHiddenBodies(hiddenBodies);
  thumbStale = !p.meta.thumb && (p.doc.features.length > 0 || !!p.doc.instances?.length);
  resetHistory();
  vp.setModel(null);
  rebuild(true);
  renderAll();
}

/** Saves `d` as a new project and opens it. */
async function createProject(name: string, d: CadDocument = emptyDoc()) {
  const now = Date.now();
  const meta: ProjectMeta = { id: newProjectId(), name, created: now, updated: now, kind: d.kind };
  try {
    await putProject(meta, d);
  } catch {
    return toast("Could not save in this browser");
  }
  await openProject(meta.id);
}

async function newProject() {
  const names = (await listProjects().catch(() => [])).map((p) => p.name);
  await createProject(freeName("Model", names));
  closeProjects();
}

/** A new assembly, and the parts to put in it right away. */
async function newAssembly() {
  const names = (await listProjects().catch(() => [])).map((p) => p.name);
  await createProject(freeName("Assembly", names), { ...emptyDoc(), kind: "assembly", instances: [] });
  closeProjects();
  void showPartPicker();
}

/**
 * Opens the project used last. The first time, the one document that earlier versions kept
 * becomes a project; with nothing saved yet, an empty project is made.
 */
async function openInitialProject() {
  try {
    let legacy: CadDocument | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      legacy = raw ? asDocument(JSON.parse(raw)) : null;
    } catch {
      // Unreadable: nothing to move.
    }
    if (legacy?.features.length) {
      const now = Date.now();
      await putProject({ id: newProjectId(), name: "Model 1", created: now, updated: now }, legacy);
    }
    localStorage.removeItem(STORAGE_KEY);
    const list = await listProjects();
    const id = list.find((p) => p.id === prefs.project)?.id ?? list[0]?.id;
    if (id) await openProject(id);
    else await createProject("Model 1");
  } catch {
    toast("This browser cannot keep projects: the model is not saved");
  }
}

function commit() {
  if (clashes) clearClashes();
  const snap = snapshot();
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
  doc = { ...JSON.parse(undoStack[pos]), files: doc.files };
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
  if (document.getElementById("projects")) {
    closeProjects();
    return true;
  }
  if (measuring) {
    endMeasure();
    return true;
  }
  if (isOperation(mode)) {
    mode.keypad.close();
    return true;
  }
  if (pendingFaceTool) {
    pendingFaceTool = null;
    renderAll();
    return true;
  }
  if (mode.kind === "mate") {
    startMate();
    return true;
  }
  if (clashes) {
    clearClashes();
    return true;
  }
  if (explodeTarget) {
    toggleExplode();
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
  const before = { distance: feat.distance, distanceExpr: feat.distanceExpr, symmetric: feat.symmetric, op: feat.op, body: feat.body };
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
      ...bodySegment(feat),
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

// ---------- Assemblies: parts from other projects, placed by hand ----------

const isAssembly = () => doc.kind === "assembly";
/** Documents and names of the parts the open assembly uses (their latest saved versions). */
let partDocs: Record<string, CadDocument> = {};
let partNames: Record<string, string> = {};
/** The assembly the open part was opened from: a button goes back to it. */
let cameFrom: { id: string; name: string } | null = null;
let gizmo: PlaceGizmo | null = null;
let gizmoFor = "";

/** Reads the parts the assembly uses and hands them to the worker. */
async function loadParts() {
  const ids = [...new Set((doc.instances ?? []).map((i) => i.project))];
  const got = await Promise.all(ids.map((id) => getProject(id).catch(() => null)));
  partDocs = {};
  partNames = {};
  got.forEach((p, i) => {
    if (!p) return;
    partDocs[ids[i]] = asDocument(p.doc) ?? emptyDoc();
    partNames[ids[i]] = p.meta.name;
  });
  sendParts();
}

function sendParts() {
  worker.postMessage({ type: "parts", parts: partDocs } satisfies WorkerRequest);
}

const instanceOf = (id: string | null) => doc.instances?.find((i) => i.id === id) ?? null;

/** Picks a project to place in the assembly (parts only, not the assembly itself). */
async function showPartPicker() {
  let list: ProjectMeta[];
  try {
    list = (await listProjects()).filter((p) => p.kind !== "assembly" && p.id !== project?.id);
  } catch {
    return toast("This browser cannot keep projects");
  }
  if (!list.length) return toast("Make a part in a project of its own first (New project)");
  closeProjects();
  const el = document.createElement("div");
  el.id = "projects";
  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) closeProjects();
  });
  el.innerHTML = `<div class="projects-card">
    <header><h2>Insert a part</h2><button class="projects-close" aria-label="Close">${icon("close", 22)}</button></header>
    <div class="projects-grid"></div></div>`;
  el.querySelector<HTMLElement>(".projects-close")!.onclick = closeProjects;
  const grid = el.querySelector(".projects-grid")!;
  for (const p of list) {
    const card = document.createElement("div");
    card.className = "project-card";
    card.innerHTML = `<button class="project-thumb"></button><div class="project-row"><div class="project-info"><div class="project-name"></div><div class="project-date"></div></div></div>`;
    const thumb = card.querySelector<HTMLElement>(".project-thumb")!;
    if (p.thumb) {
      const img = document.createElement("img");
      img.src = p.thumb;
      img.alt = "";
      thumb.appendChild(img);
    } else thumb.innerHTML = icon("part", 40);
    card.querySelector(".project-name")!.textContent = p.name;
    card.querySelector(".project-date")!.textContent = ago(p.updated);
    const pick = () => {
      closeProjects();
      void insertPart(p);
    };
    thumb.onclick = pick;
    card.querySelector<HTMLElement>(".project-info")!.onclick = pick;
    grid.appendChild(card);
  }
  document.body.appendChild(el);
}

/** Places a part beside the others (its exact place is then set by hand). */
async function insertPart(p: ProjectMeta, d?: CadDocument) {
  if (!d) {
    const got = await getProject(p.id).catch(() => null);
    if (!got) return toast("This project could not be read");
    d = asDocument(got.doc) ?? emptyDoc();
  }
  partDocs[p.id] = d;
  partNames[p.id] = p.name;
  sendParts();
  const box = vp.modelBox();
  const inst: PartInstance = {
    id: uid(),
    project: p.id,
    name: freeName(p.name, (doc.instances ?? []).map((i) => i.name)),
    at: box ? [Math.round(box.max.x + 10), 0, 0] : [0, 0, 0],
    rot: [0, 0, 0],
    // The first part holds still: the others are mated to it.
    fixed: !doc.instances?.length || undefined,
  };
  doc.instances = [...(doc.instances ?? []), inst];
  selectedFeature = inst.id;
  fitNext = true;
  commit();
}

function duplicateInstance(inst: PartInstance) {
  const box = vp.bodyBox(inst.id);
  const copy: PartInstance = {
    ...inst,
    id: uid(),
    name: freeName(partNames[inst.project] ?? inst.name.replace(/ \d+$/, ""), (doc.instances ?? []).map((i) => i.name)),
    at: [inst.at[0] + (box ? Math.ceil(box.max.x - box.min.x) + 5 : 20), inst.at[1], inst.at[2]],
    rot: [...inst.rot],
    fixed: undefined,
  };
  doc.instances = [...(doc.instances ?? []), copy];
  selectedFeature = copy.id;
  commit();
}

function removeInstance(inst: PartInstance) {
  doc.instances = (doc.instances ?? []).filter((i) => i !== inst);
  // Its mates go with it.
  doc.mates = doc.mates?.filter((m) => m.a.part !== inst.id && m.b.part !== inst.id);
  if (selectedFeature === inst.id) selectedFeature = null;
  commit();
}

function renameInstance(inst: PartInstance) {
  const name = prompt("Part name", inst.name)?.trim();
  if (!name || name === inst.name) return;
  inst.name = name;
  commit();
}

/** Opens the part's own project to change it; the assembly follows when it is opened again. */
async function openPart(inst: PartInstance) {
  if (!project) return;
  const from = { id: project.id, name: project.name };
  await openProject(inst.project, from);
}

/** Moves a part by `m` (a slide or a turn made with the handles), in place of where it was. */
function applyMove(inst: PartInstance, m: THREE.Matrix4) {
  Object.assign(inst, placementOf(m.clone().multiply(instanceMatrix(inst))));
}

// ---------- Mates ----------

/** The mates' state for the current placements: what is left free, and what cannot hold. */
let solveState: { key: string; dof: number; failing: Set<string> } | null = null;

/** Where each part turns about when the solver moves it: its middle, as drawn. */
function partCenters() {
  const out: Record<string, Vec3> = {};
  for (const i of doc.instances ?? []) {
    const b = vp.bodyBox(i.id);
    if (b) out[i.id] = b.getCenter(new THREE.Vector3()).toArray() as Vec3;
  }
  return out;
}

/** Moves the parts so the mates hold (nothing moves when they cannot all hold). */
function applyMates() {
  const sol = solveMates(doc.instances ?? [], doc.mates ?? [], partCenters());
  for (const [id, p] of sol.placed) Object.assign(instanceOf(id)!, p);
  solveState = { key: mateKey(), dof: sol.dof, failing: new Set(sol.failing) };
}

const mateKey = () => JSON.stringify([doc.instances, doc.mates]);

/** The mates' state, worked out again when the parts or mates changed (undo, opening). */
function mateState() {
  if (!solveState || solveState.key !== mateKey()) {
    const sol = solveMates(doc.instances ?? [], doc.mates ?? [], partCenters());
    solveState = { key: mateKey(), dof: sol.dof, failing: new Set(sol.failing) };
  }
  return solveState;
}

const MATE_KINDS: Record<Mate["kind"], string> = { touch: "Touch", align: "Flush", axis: "Axis", angle: "Angle" };

function mateName(kind: Mate["kind"]) {
  return freeName(MATE_KINDS[kind], (doc.mates ?? []).map((m) => m.name));
}

const mateOf = (id: string | null) => doc.mates?.find((m) => m.id === id) ?? null;

function startMate() {
  if (isOperation(mode)) return;
  if ((doc.instances?.length ?? 0) < 2) return toast("Insert at least two parts first");
  if (mode.kind === "mate") {
    mode = { kind: "part" };
    vp.highlightFaces([]);
    vp.highlightEdges([]);
    return renderAll();
  }
  if (measuring) endMeasure();
  selectedFeature = null;
  mode = { kind: "mate", picks: [] };
  renderAll();
}

/** The plane or axis of a face or edge, from the worker. */
function askRef(pick: { kind: "face" | "edge"; id: number }) {
  const reqId = ++reqCounter;
  return new Promise<Omit<MateRef, "part"> | null>((resolve) => {
    pendingRefs.set(reqId, resolve);
    worker.postMessage({ type: "ref", reqId, doc, pick } satisfies WorkerRequest);
  });
}

/** A tap while choosing a mate: a hole or round edge near the tap, else the face under it. */
async function mateTap(p: Ptr) {
  if (mode.kind !== "mate") return;
  const m = mode;
  const bodies = lastBuild?.bodies ?? [];
  const ei = vp.pickEdge(p.x, p.y, hitRadiusPx(p));
  const face = vp.pickFace(p.x, p.y);
  let pick: MatePick | null = null;
  for (const k of [ei != null ? { kind: "edge" as const, id: vp.edgeId(ei) } : null, face != null ? { kind: "face" as const, id: face } : null]) {
    if (!k) continue;
    const body = bodies.find((b) => (k.kind === "face" ? b.faceIds : b.edgeIds).includes(k.id));
    const inst = instanceOf(body?.id ?? null);
    if (!inst) continue;
    const g = await askRef(k);
    if (mode !== m) return; // left meanwhile
    if (!g) continue;
    pick = { ref: { part: inst.id, kind: g.kind, ...localRef(g.origin, g.dir, instanceMatrix(inst)) }, face: k.kind === "face" ? k.id : undefined, edge: k.kind === "edge" ? (ei ?? undefined) : undefined };
    break;
  }
  if (!pick) return toast("Tap a flat face, a hole or a round edge of a part");
  const first = m.picks[0];
  if (first && first.ref.part === pick.ref.part) return toast("Now tap the other part");
  if (first && first.ref.kind !== pick.ref.kind) return toast(first.ref.kind === "plane" ? "Now tap a flat face of the other part" : "Now tap a hole, a pin or a round edge of the other part");
  m.picks.push(pick);
  showMatePicks(m.picks);
  if (m.picks.length < 2) return renderAll();
  const [a, b] = m.picks.map((x) => x.ref);
  const kind: Mate["kind"] = a.kind === "axis" ? "axis" : "touch";
  const mate: Mate = { id: uid(), name: mateName(kind), kind, a, b, value: 0 };
  mode = { kind: "part" };
  showMatePicks([]);
  doc.mates = [...(doc.mates ?? []), mate];
  if (kind === "axis") {
    applyMates();
    selectedFeature = mate.id;
    if (mateState().failing.has(mate.id)) toast("This mate cannot hold with the others");
    return commit();
  }
  void mateTool(mate, true);
}

function showMatePicks(picks: MatePick[]) {
  vp.highlightFaces(picks.flatMap((k) => (k.face != null ? [k.face] : [])));
  vp.highlightEdges(picks.flatMap((k) => (k.edge != null ? [k.edge] : [])));
}

/** A mate between faces: how (facing, flush or at an angle) and the gap or angle, on the keypad. */
async function mateTool(mate: Mate, isNew = false) {
  if (isOperation(mode) || mate.kind === "axis") return;
  const before = JSON.stringify(mate);
  const places = JSON.stringify(doc.instances);
  const unit = () => (mate.kind === "angle" ? "°" : "mm");
  /** What the keypad types: the exact value, or one of the limits. */
  let field: "value" | "min" | "max" = mate.min !== undefined ? "min" : "value";
  const label = () =>
    field === "min" ? "From" : field === "max" ? "To" : ({ touch: "Gap", align: "Offset", angle: "Angle", axis: "" })[mate.kind];
  const read = () => (field === "value" ? mate.value : mate[field]!);
  const choose = (f: typeof field) => {
    field = f;
    kp.setLabel(label(), unit());
    kp.set(read());
  };
  const limitRow: Segmented = {
    options: [
      { value: "min", label: "From" },
      { value: "max", label: "To" },
    ],
    get: () => field,
    set: (v) => choose(v as typeof field),
  };
  const segments: Segmented[] = [];
  const update = () => {
    applyMates();
    kp.setNote(mateState().failing.has(mate.id) ? "Cannot hold with the other mates" : null);
    renderTimeline();
    rebuild();
  };
  // (The keypad draws these rows as it opens.)
  segments.push(
    {
      options: [
        { value: "touch", label: "Facing" },
        { value: "align", label: "Flush" },
        { value: "angle", label: "Angle" },
      ],
      get: () => mate.kind,
      set: (v) => {
        const kind = v as Mate["kind"];
        if (kind === mate.kind) return;
        // Turning to an angle starts at a right angle; back to faces, at contact.
        mate.value = kind === "angle" ? 90 : 0;
        if (mate.min !== undefined) [mate.min, mate.max] = kind === "angle" ? [0, 90] : [0, 10];
        if (isNew) mate.name = freeName(MATE_KINDS[kind], (doc.mates ?? []).filter((x) => x !== mate).map((x) => x.name));
        mate.kind = kind;
        choose(field);
        update();
      },
    },
    {
      // Exact, or free between two limits (a drawer's travel, a lid's opening).
      options: [
        { value: "exact", label: "Exact" },
        { value: "range", label: "Limits" },
      ],
      get: () => (mate.min !== undefined ? "range" : "exact"),
      set: (v) => {
        if ((v === "range") === (mate.min !== undefined)) return;
        if (v === "range") {
          mate.min = Math.min(mate.value, mate.kind === "angle" ? 0 : mate.value);
          mate.max = mate.value + (mate.kind === "angle" ? 90 : 10);
          segments.push(limitRow);
          choose("min");
        } else {
          delete mate.min;
          delete mate.max;
          segments.splice(segments.indexOf(limitRow), 1);
          choose("value");
        }
        update();
      },
    },
  );
  if (mate.min !== undefined) segments.push(limitRow);
  const kp = openKeypad({
    title: mate.name,
    subtitle: `${partLabel(mate.a.part)} and ${partLabel(mate.b.part)}`,
    label: label(),
    value: read(),
    unit: unit(),
    confirmLabel: "Confirm",
    segments,
    onInput: (v) => {
      if (field === "value") mate.value = v;
      else mate[field] = v;
      update();
    },
  });
  mode = { kind: "mateEdit", feat: mate, keypad: kp };
  selectedFeature = mate.id;
  update();
  renderAll();
  const res = await kp.result;
  mode = { kind: "part" };
  if (!res) {
    doc.instances = JSON.parse(places);
    if (isNew) {
      doc.mates = doc.mates?.filter((x) => x !== mate);
      selectedFeature = null;
    } else {
      // Limits added meanwhile go too.
      delete mate.min;
      delete mate.max;
      Object.assign(mate, JSON.parse(before));
    }
    solveState = null;
    rebuild(true);
    renderAll();
    return;
  }
  if (field === "value") mate.value = res.value;
  else mate[field] = res.value;
  if (mate.min !== undefined && mate.max !== undefined && mate.min > mate.max) [mate.min, mate.max] = [mate.max, mate.min];
  applyMates();
  if (mateState().failing.has(mate.id)) toast("This mate cannot hold with the others");
  commit();
}

function deleteMate(mate: Mate) {
  doc.mates = doc.mates?.filter((m) => m !== mate);
  if (selectedFeature === mate.id) selectedFeature = null;
  applyMates();
  commit();
}

/** Facing ⇄ flush: the second face turned round. */
function flipMate(mate: Mate) {
  mate.kind = mate.kind === "touch" ? "align" : "touch";
  // A name it was given by default follows what it now is.
  if (/^(Touch|Flush) \d+$/.test(mate.name)) mate.name = freeName(MATE_KINDS[mate.kind], (doc.mates ?? []).filter((x) => x !== mate).map((x) => x.name));
  applyMates();
  commit();
}

function toggleFixed(inst: PartInstance) {
  inst.fixed = !inst.fixed || undefined;
  applyMates();
  commit();
}

const partLabel = (id: string) => instanceOf(id)?.name ?? "a removed part";

/** The faces or axes of the selected mate (or of the picks being made), drawn over the model. */
function mateMarks(batch: LineBatch) {
  const refs = mode.kind === "mate" ? mode.picks.map((k) => k.ref) : (() => {
    const m = mateOf(selectedFeature) ?? (mode.kind === "mateEdit" ? mode.feat : null);
    return m ? [m.a, m.b] : [];
  })();
  const acc = rgb("--accent");
  const s = 26 * vp.wpp;
  for (const ref of refs) {
    const inst = instanceOf(ref.part);
    if (!inst) continue;
    const { origin: o, dir: n } = worldRef(ref, instanceMatrix(inst));
    const seg = (a: THREE.Vector3, b: THREE.Vector3) => {
      batch.positions.push(...a.toArray(), ...b.toArray());
      batch.colors.push(...acc, ...acc);
    };
    if (ref.kind === "axis") {
      seg(o.clone().addScaledVector(n, -3 * s), o.clone().addScaledVector(n, 3 * s));
      continue;
    }
    // A square on the face, and its normal.
    const u = new THREE.Vector3().crossVectors(n, Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const c = [u.clone().add(v), u.clone().sub(v), u.clone().negate().sub(v), v.clone().sub(u)].map((d) => o.clone().addScaledVector(d, s));
    for (let i = 0; i < 4; i++) seg(c[i], c[(i + 1) % 4]);
    seg(o, o.clone().addScaledVector(n, 1.5 * s));
  }
}

/** The handles on the selected part, while nothing else is going on. */
function syncGizmo() {
  const inst = isAssembly() && mode.kind === "part" && !measuring && !explodeTarget && !clashes && !dragging ? instanceOf(selectedFeature) : null;
  if (inst?.fixed) {
    gizmo?.dispose();
    gizmo = null;
    gizmoFor = "";
    return;
  }
  const box = inst && !hiddenBodies.has(inst.id) ? vp.bodyBox(inst.id) : null;
  const key = inst && box ? `${inst.id}|${box.min.toArray()}|${box.max.toArray()}` : "";
  if (key === gizmoFor) return;
  gizmoFor = key;
  gizmo?.dispose();
  gizmo = null;
  if (!inst || !box) return;
  // The handles give the whole move since the drag began; the mates follow it step by step.
  let last = new THREE.Matrix4();
  gizmo = new PlaceGizmo(
    vp,
    box.getCenter(new THREE.Vector3()),
    (m) => {
      if (!dragging) {
        beginDrag(inst.id);
        last = new THREE.Matrix4();
      }
      dragBy(m.clone().multiply(last.clone().invert()));
      last = m;
    },
    () => endDrag(true),
  );
}

// ---------- Moving parts live (dragged with a finger or the handles) ----------

/** Placements while a part is dragged, kept out of the document until it is let go. */
let dragging: { insts: PartInstance[]; built: Map<string, THREE.Matrix4>; centers: Record<string, Vec3>; lead: string } | null = null;

function beginDrag(id: string) {
  const insts = structuredClone(doc.instances ?? []);
  dragging = { insts, built: new Map(insts.map((i) => [i.id, instanceMatrix(i)])), centers: partCenters(), lead: id };
}

/**
 * Moves the dragged part by `step` from where it is now, then lets the mates have their way: a
 * hinged lid swings, a drawer slides, a mated part only takes what its mates leave free (and parts
 * mated to it follow). Drawn at once, without rebuilding.
 */
function dragBy(step: THREE.Matrix4) {
  const d = dragging;
  if (!d) return;
  const trial = d.insts.map((i) => ({ ...i }));
  const lead = trial.find((i) => i.id === d.lead)!;
  Object.assign(lead, placementOf(step.clone().multiply(instanceMatrix(lead))));
  // Each part turns about its middle where it is now.
  const centers: Record<string, Vec3> = {};
  for (const i of trial) {
    const c = d.centers[i.id];
    if (c) centers[i.id] = new THREE.Vector3(...c).applyMatrix4(instanceMatrix(i).multiply(d.built.get(i.id)!.clone().invert())).toArray() as Vec3;
  }
  const sol = solveMates(trial, doc.mates ?? [], centers);
  if (sol.failing.length) return; // no way there: it stays where it was
  for (const [id, p] of sol.placed) Object.assign(trial.find((i) => i.id === id)!, p);
  d.insts = trial;
  vp.moveBodies(new Map(trial.map((i) => [i.id, instanceMatrix(i).multiply(d.built.get(i.id)!.clone().invert())])));
}

/** Lets go: the parts stay where the drag left them (or go back, on a cancelled gesture). */
function endDrag(keep: boolean) {
  const d = dragging;
  dragging = null;
  if (!d) return;
  if (!keep) {
    vp.moveBodies(new Map());
    return;
  }
  doc.instances = d.insts;
  applyMates();
  commit();
}

/** A finger on a part (not a fixed one) drags it across the view. */
let fingerDrag: { id: string; plane: THREE.Plane; last: THREE.Vector3; x0: number; y0: number; moved: boolean } | null = null;

function fingerDown(p: Ptr) {
  fingerDrag = null;
  if (!isAssembly() || mode.kind !== "part" || measuring || explode > 0 || clashes) return;
  const hit = vp.pickPoint(p.x, p.y);
  const body = hit?.faceId == null ? null : lastBuild?.bodies?.find((b) => b.faceIds.includes(hit.faceId!));
  const inst = instanceOf(body?.id ?? null);
  if (!hit || !inst || inst.fixed) return;
  const at = new THREE.Vector3(...hit.point);
  const toEye = vp.camera.getWorldDirection(new THREE.Vector3()).negate();
  fingerDrag = { id: inst.id, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(toEye, at), last: at, x0: p.x, y0: p.y, moved: false };
}

function fingerMove(p: Ptr) {
  const f = fingerDrag;
  if (!f) return;
  if (!f.moved) {
    if (Math.hypot(p.x - f.x0, p.y - f.y0) < 8) return;
    f.moved = true;
    selectedFeature = f.id;
    gizmo?.dispose();
    gizmo = null;
    gizmoFor = "";
    beginDrag(f.id);
  }
  const to = vp.ray(p.x, p.y).ray.intersectPlane(f.plane, new THREE.Vector3());
  if (!to) return;
  dragBy(new THREE.Matrix4().makeTranslation(to.clone().sub(f.last)));
  f.last = to;
}

// ---------- Exploded view ----------

/** How far the parts are spread (0: assembled, 1: exploded), and where it is heading. */
let explode = 0;
let explodeTarget = 0;

/** Spreads the parts away from the middle of the assembly, each by its own distance from it. */
function spreadParts(t: number) {
  const bodies = lastBuild?.bodies ?? [];
  const all = vp.modelBox();
  if (!all || bodies.length < 2) return;
  const mid = all.getCenter(new THREE.Vector3());
  const moves = new Map<string, THREE.Matrix4>();
  for (const b of bodies) {
    const box = vp.bodyBox(b.id);
    if (box) moves.set(b.id, new THREE.Matrix4().makeTranslation(box.getCenter(new THREE.Vector3()).sub(mid).multiplyScalar(t)));
  }
  vp.moveBodies(moves);
}

function toggleExplode() {
  if ((doc.instances?.length ?? 0) < 2) return toast("Insert at least two parts first");
  explodeTarget = explodeTarget ? 0 : 1;
  const from = explode;
  const to = explodeTarget;
  const t0 = performance.now();
  const frame = () => {
    if (explodeTarget !== to) return; // turned round meanwhile
    const k = Math.min(1, (performance.now() - t0) / 450);
    explode = from + (to - from) * (1 - (1 - k) ** 3);
    // The spread is measured from the parts as built, so it always starts from there.
    vp.moveBodies(new Map());
    spreadParts(explode);
    if (k < 1) requestAnimationFrame(frame);
    else renderAll();
  };
  requestAnimationFrame(frame);
  renderAll();
}

// ---------- Interference ----------

/** Overlapping parts found by the last check (null: no check shown). */
let clashes: { list: Clash[]; running: boolean; error?: string } | null = null;

function checkInterference() {
  if (!kernelReady) return toast("The geometry kernel is still loading");
  if ((doc.instances?.length ?? 0) < 2) return toast("Insert at least two parts first");
  if (measuring) endMeasure();
  selectedFeature = null;
  const reqId = ++reqCounter;
  const state: NonNullable<typeof clashes> = { list: [], running: true };
  clashes = state;
  vp.setClashes(null);
  pendingClashes.set(reqId, (list, error) => {
    if (clashes !== state) return; // closed meanwhile
    clashes = { list, running: false, error };
    vp.setClashes(list);
    renderAll();
  });
  worker.postMessage({ type: "clash", reqId, doc, skip: [...hiddenBodies] } satisfies WorkerRequest);
  renderAll();
}

function clearClashes() {
  clashes = null;
  vp.setClashes(null);
  renderAll();
}

/** Position and turns of a part, typed on the keypad (one value at a time). */
async function placeTool(inst: PartInstance) {
  if (isOperation(mode)) return;
  const before = { at: [...inst.at] as Vec3, rot: [...inst.rot] as Vec3 };
  const LABELS = ["X", "Y", "Z", "Turn X", "Turn Y", "Turn Z"];
  let field = 0;
  const get = (i: number) => (i < 3 ? inst.at[i] : inst.rot[i - 3]);
  const set = (i: number, v: number) => {
    if (i < 3) inst.at[i] = v;
    else inst.rot[i - 3] = v;
    rebuild();
  };
  const choose = (i: number) => {
    field = i;
    kp.setLabel(LABELS[i], i < 3 ? "mm" : "°");
    kp.set(get(i));
  };
  const row = (from: number): Segmented => ({
    options: [0, 1, 2].map((k) => ({ value: String(from + k), label: LABELS[from + k] })),
    get: () => String(field),
    set: (v) => choose(Number(v)),
  });
  const kp = openKeypad({
    title: inst.name,
    subtitle: "Position of its origin, and turns about it",
    label: LABELS[0],
    value: get(0),
    confirmLabel: "Confirm",
    segments: [row(0), row(3)],
    extras: [
      {
        label: "Negate",
        icon: "flip",
        run: () => {
          set(field, -get(field));
          kp.set(get(field));
        },
      },
    ],
    onInput: (v) => set(field, v),
  });
  mode = { kind: "place", feat: inst, keypad: kp };
  renderAll();
  const res = await kp.result;
  mode = { kind: "part" };
  if (!res) {
    inst.at = before.at;
    inst.rot = before.rot;
    rebuild(true);
    renderAll();
    return;
  }
  set(field, res.value);
  applyMates();
  commit();
}

// ---------- Bodies ----------

/** Bodies hidden from view (for this session only: hiding is a way of looking, not a change). */
let hiddenBodies = new Set<string>();

function setHiddenBodies(ids: Iterable<string>) {
  hiddenBodies = new Set(ids);
  vp.setHiddenBodies(hiddenBodies);
  renderPanel();
  renderViewButtons();
  if (displayMenuOpen) renderDisplayMenu();
}

function toggleBody(id: string) {
  const next = new Set(hiddenBodies);
  if (!next.delete(id)) next.add(id);
  // Hiding every body would leave nothing to look at: hiding the last one shows the others.
  const all = lastBuild?.bodies ?? [];
  if (all.length && all.every((b) => next.has(b.id))) setHiddenBodies(all.filter((b) => b.id !== id).map((b) => b.id));
  else setHiddenBodies(next);
}

/** Shows only that body; again on the same body, shows them all. */
function isolateBody(id: string) {
  const others = (lastBuild?.bodies ?? []).filter((b) => b.id !== id).map((b) => b.id);
  const isolated = !hiddenBodies.has(id) && others.every((o) => hiddenBodies.has(o));
  setHiddenBodies(isolated ? [] : others);
}

function anyBodyHidden() {
  return (lastBuild?.bodies ?? []).some((b) => hiddenBodies.has(b.id));
}

/** The part's bodies started before this step (the ones it can join or cut). */
function bodiesBefore(featId: string) {
  const at = doc.features.findIndex((x) => x.id === featId);
  return (lastBuild?.bodies ?? []).filter((b) => {
    const i = doc.features.findIndex((x) => x.id === b.id);
    return i >= 0 && (at < 0 || i < at);
  });
}

/**
 * The keypad row choosing a step's body: joining makes a New body or joins one; cutting works on
 * All bodies or one. None while there is no body yet (the first solid is the first body).
 */
function bodySegment(feat: { id: string; op: string; body?: string }): Segmented[] {
  const earlier = bodiesBefore(feat.id);
  if (!earlier.length) return [];
  const each = earlier.map((b) => ({ value: b.id, label: b.name }));
  return [
    {
      get options() {
        return feat.op === "add" ? [{ value: "new", label: "New body" }, ...each] : [{ value: "all", label: "All bodies" }, ...each];
      },
      get: () => (feat.op === "add" ? (feat.body ?? earlier[0].id) : feat.body && feat.body !== "new" ? feat.body : "all"),
      set: (v) => {
        feat.body = v === "all" ? undefined : v;
        rebuild();
      },
    },
  ];
}

/** "· New body", "· into Lid", "· all bodies"… for a step's summary, when the part has several bodies. */
function bodyNote(f: { id: string; op: string; body?: string }) {
  const bodies = lastBuild?.bodies ?? [];
  if (bodies.length < 2) return "";
  if (f.op === "add") return f.body === "new" ? ` · ${bodyName(f.id)}` : f.body ? ` · into ${bodyName(f.body)}` : "";
  return f.body && f.body !== "new" ? ` · ${bodyName(f.body)} only` : "";
}

function bodyName(id: string) {
  return lastBuild?.bodies?.find((b) => b.id === id)?.name ?? doc.bodyNames?.[id] ?? "Body";
}

function renameBody(id: string) {
  const name = prompt("Body name", bodyName(id))?.trim();
  if (!name) return;
  doc.bodyNames = { ...doc.bodyNames, [id]: name };
  commit();
  renderAll();
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
          // Soft hyphens: on a narrow panel the words break as Counter-bore / Counter-sink.
          { value: "counterbore", label: "Counter­bore" },
          { value: "countersink", label: "Counter­sink" },
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
      ...bodySegment(f),
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
  // Played once: showing the panel again later must not replay it.
  el.addEventListener("animationend", () => el.classList.remove("enter"), { once: true });
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
  syncGizmo();
}

const SKETCH_TOOLS: { tool: SketchToolName; icon: string; label: string; key: string }[] = [
  { tool: "select", icon: "select", label: "Select", key: "Esc" },
  { tool: "line", icon: "line", label: "Line", key: "L" },
  { tool: "rect", icon: "rect", label: "Rectangle", key: "R" },
  { tool: "polygon", icon: "polygon", label: "Polygon", key: "N" },
  { tool: "slot", icon: "slot", label: "Slot", key: "O" },
  { tool: "circle", icon: "circle", label: "Circle", key: "C" },
  { tool: "ellipse", icon: "ellipse", label: "Ellipse", key: "E" },
  { tool: "arc", icon: "arc", label: "Arc", key: "A" },
  { tool: "spline", icon: "spline", label: "Spline", key: "S" },
  { tool: "point", icon: "point", label: "Point", key: "P" },
  { tool: "trim", icon: "trim", label: "Trim", key: "T" },
  { tool: "fillet", icon: "fillet", label: "Fillet", key: "F" },
  { tool: "project", icon: "project", label: "Use edges", key: "U" },
];

/** `disabled`: why the tool cannot be used now; it stays in place, greyed, and tapping it says why. */
/**
 * `tint`: colour of the icon (the reference planes use their 3D colour); `tag`: a short text
 * under the icon, still readable when the panel is folded to icons.
 */
function toolRow(
  ic: string,
  label: string,
  run: () => void,
  opts: { active?: boolean; on?: boolean; key?: string; disabled?: string; tint?: string; tag?: string } = {},
) {
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
  const tile = b.querySelector<HTMLElement>(".tile")!;
  if (opts.tint) tile.style.color = opts.tint;
  if (opts.tag) {
    const t = document.createElement("span");
    t.className = "tile-tag";
    t.textContent = opts.tag;
    tile.appendChild(t);
  }
  holdForName(b, label);
  b.title = opts.key ? `${label} (${opts.key})` : label;
  b.setAttribute("aria-label", label);
  // Any other tool puts the measure away.
  b.onclick = () => {
    if (measuring && run !== toggleMeasure) endMeasure();
    run();
  };
  return b;
}

/**
 * Holding a tool whose label is hidden (panel folded to icons) shows its name in a bubble, and
 * that press does not run the tool. Fingers cannot hover, so this is the way to read the icons.
 */
function holdForName(b: HTMLElement, name: string) {
  let timer = 0;
  let shown = false;
  const hide = () => {
    clearTimeout(timer);
    document.getElementById("tool-bubble")?.remove();
  };
  b.addEventListener("pointerdown", () => {
    shown = false;
    const label = b.querySelector<HTMLElement>(".label");
    if (label && label.getBoundingClientRect().width > 8) return; // the name is already visible
    timer = window.setTimeout(() => {
      shown = true;
      const r = b.getBoundingClientRect();
      const bubble = document.createElement("div");
      bubble.id = "tool-bubble";
      bubble.textContent = name;
      bubble.style.left = `${r.right + 8}px`;
      bubble.style.top = `${r.top + r.height / 2}px`;
      document.body.appendChild(bubble);
    }, 420);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(ev, hide);
  // A long press only shows the name.
  b.addEventListener(
    "click",
    (e) => {
      if (!shown) return;
      shown = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );
  b.addEventListener("contextmenu", (e) => e.preventDefault());
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
    // The same buttons stay, so the fold animates; only this button's icon changes.
    applyPrefs();
    collapse.innerHTML = icon(prefs.collapsed ? "expand" : "collapse", 20);
    collapse.title = prefs.collapsed ? "Show labels" : "Icons only";
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
    el.appendChild(
      toolRow("offset", "Offset", () => {
        if (!ed.selection.size) return toast("Select the lines, arcs or circles to offset first");
        void ed.offsetSelection();
      }),
    );
    el.appendChild(section("Insert"));
    el.appendChild(toolRow("text", "Text", () => void insertText(), { key: "X" }));
    el.appendChild(toolRow("import", "Import DXF / SVG", () => void importDrawing()));
    el.appendChild(section("Options"));
    el.appendChild(
      toolRow("construction", "Construction", () => {
        ed.construction = !ed.construction;
        renderTools();
      }, { on: ed.construction, key: "G" }),
    );
  } else if (mode.kind === "pickPlane") {
    el.appendChild(section("Sketch plane"));
    for (const p of STD_PLANES)
      el.appendChild(toolRow("plane" + p.label, PLANE_NAMES[p.label], () => createSketchOn(p), { tint: PLANE_COLORS[p.label], tag: p.label }));
    el.appendChild(toolRow("close", "Cancel", () => escape()));
  } else if (isAssembly()) {
    el.appendChild(section("Parts"));
    el.appendChild(toolRow("plus", "Insert part", () => void showPartPicker(), { key: "I" }));
    el.appendChild(toolRow("import", "Import STEP", () => void importStep()));
    if ((doc.instances?.length ?? 0) > 1 || mode.kind === "mate") {
      el.appendChild(section("Mates"));
      el.appendChild(toolRow("mate", "Mate", startMate, { active: mode.kind === "mate", key: "M" }));
    }
    if (doc.instances?.length) {
      el.appendChild(section("Check"));
      el.appendChild(toolRow("measure", "Measure", toggleMeasure, { active: !!measuring, key: "D" }));
      if (doc.instances.length > 1) {
        el.appendChild(toolRow("clash", "Interference", () => (clashes ? clearClashes() : checkInterference()), { active: !!clashes, key: "C" }));
        el.appendChild(toolRow("explode", "Exploded view", toggleExplode, { active: explodeTarget > 0, key: "X" }));
      }
    }
  } else {
    if (cameFrom) {
      const back = cameFrom;
      el.appendChild(section("Assembly"));
      el.appendChild(toolRow("back", `Back to ${back.name}`, () => void openProject(back.id)));
    }
    el.appendChild(section("Sketch"));
    el.appendChild(toolRow("sketch", "New sketch", startNewSketch, { key: "S" }));
    // Tools appear as the document grows: a sketch brings Extrude and Revolve, a solid brings
    // the rest. From then on the layout stays put; a tool unavailable for a moment is greyed.
    const anySketch = doc.features.some((f) => f.kind === "sketch");
    const solid = hasSolid();
    if (!anySketch) {
      const hint = document.createElement("p");
      hint.className = "tools-hint";
      hint.textContent = "Start with a sketch: tap New sketch, then a plane.";
      el.appendChild(hint);
    }
    const needSketch = pickSketchForExtrude() ? undefined : "Draw a closed sketch first";
    if (anySketch) {
      el.appendChild(section("Features"));
      el.appendChild(toolRow("extrude", "Extrude", () => void extrude(), { key: "E", disabled: needSketch }));
      el.appendChild(toolRow("revolve", "Revolve", () => void revolveTool(), { key: "V", disabled: needSketch }));
    }
    if (solid) {
      // A tool waiting for a face is put down by tapping it again.
      const faceToggle = (tool: NonNullable<typeof pendingFaceTool>, start: () => void) => () => {
        if (pendingFaceTool !== tool) return start();
        pendingFaceTool = null;
        renderAll();
      };
      el.appendChild(toolRow("pushpull", "Press Pull", faceToggle("pushpull", () => faceTool("pushpull")), { active: pendingFaceTool === "pushpull", key: "Q" }));
      el.appendChild(toolRow("shell", "Shell", faceToggle("shell", () => faceTool("shell")), { active: pendingFaceTool === "shell", key: "K" }));
      el.appendChild(toolRow("fillet", "Fillet / Chamfer", () => void filletTool(), { key: "R" }));
      el.appendChild(toolRow("hole", "Hole", faceToggle("hole", startHoles), { active: pendingFaceTool === "hole", key: "H" }));
      el.appendChild(section("Repeat"));
      el.appendChild(toolRow("mirror", "Mirror", () => void patternTool("mirror"), { key: "M" }));
      el.appendChild(toolRow("linear", "Linear pattern", () => void patternTool("linear"), { key: "L" }));
      el.appendChild(toolRow("circular", "Circular pattern", () => void patternTool("circular"), { key: "O" }));
    }
    el.appendChild(section("Design"));
    if (solid) el.appendChild(toolRow("measure", "Measure", toggleMeasure, { active: !!measuring, key: "D" }));
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
  animateNewTools(el);
}

/** Tools (and section titles) shown at the last refresh; null before the first one. */
let toolsShown: Set<string> | null = null;

/**
 * Only what was not there before slides in (staggered); tools that stay, stay still.
 * A section whose tools are all new comes in as one card.
 */
function animateNewTools(el: HTMLElement) {
  const keyOf = (e: Element) => (e.classList.contains("tool") ? "tool:" + e.getAttribute("aria-label") : "section:" + e.textContent);
  const items = [...el.querySelectorAll(".tool, .section")];
  const before = toolsShown;
  toolsShown = new Set(items.map(keyOf));
  if (!before) return;
  let n = 0;
  const enter = (e: HTMLElement) => {
    e.style.setProperty("--i", String(n++));
    e.classList.add("pop-in");
    e.addEventListener("animationend", () => e.classList.remove("pop-in"), { once: true });
  };
  for (const child of [...el.children] as HTMLElement[]) {
    if (child.classList.contains("tool-group")) {
      const tools = [...child.children] as HTMLElement[];
      const fresh = tools.filter((t) => !before.has(keyOf(t)));
      if (fresh.length === tools.length) enter(child);
      else fresh.forEach(enter);
    } else if (child.classList.contains("section") && !before.has(keyOf(child))) enter(child);
  }
}

/** Right panel: what can be done with the current selection. */
function renderPanel() {
  const el = $("#panel-content");
  el.replaceChildren();
  // Animate when the kind of panel changes, not when the same kind shows another face or step.
  const what =
    mode.kind === "sketch"
      ? `sketch:${mode.editor.sk.id}`
      : isOperation(mode)
        ? `op:${mode.feat.id}`
        : measuring
          ? "measure"
          : showParams
          ? "params"
          : selectedFace
            ? "face"
            : selectedFeature
              ? "feature"
              : "none";
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
    if (ed.tool === "polygon") {
      const n = ed.polygonSides;
      const sides = (k: number) => () => {
        ed.polygonSides = Math.min(24, Math.max(3, n + k));
        renderPanel();
      };
      acts.unshift(
        { id: "sides-", label: "−", title: `${Math.max(3, n - 1)} sides`, run: sides(-1) },
        { id: "sides+", label: "+", title: `${Math.min(24, n + 1)} sides`, run: sides(1) },
      );
    }
    if (ed.tool === "spline" && ed.pending >= 2)
      acts.unshift({ id: "endspline", label: "⏎", title: "Finish spline", key: "Enter", run: () => ed.escape() });
    if (acts.length) {
      const grid = document.createElement("div");
      grid.className = "p-grid";
      for (const a of acts) grid.appendChild(actionTile(a));
      el.appendChild(grid);
      if (ed.tool === "polygon") {
        const hint = document.createElement("p");
        hint.className = "p-hint";
        hint.textContent = `${ed.polygonSides} sides. Tap the centre, then a corner.`;
        el.appendChild(hint);
      }
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
                : ed.tool === "slot"
                  ? "Tap the two centres, then how wide."
                  : ed.tool === "ellipse"
                    ? "Tap the centre, the end of an axis, then how wide."
          : "Tap or drag to draw. Points snap to existing geometry.";
      el.appendChild(hint);
    }
    actions([["check", "Finish sketch", exitSketch, "primary"]]);
    return;
  }
  if (mode.kind === "mate") {
    const n = mode.picks.length;
    head("New mate", n ? `On ${partLabel(mode.picks[0].ref.part)} · now the other part` : "Tap a face or a hole of a part");
    const hint = document.createElement("p");
    hint.className = "p-hint";
    hint.textContent = n
      ? "Tap the face or hole of the other part that goes onto it."
      : "Two flat faces: they meet, flush or at an angle. Two holes, pins or round edges: they share an axis.";
    el.appendChild(hint);
    actions([["close", "Cancel", () => startMate()]]);
    return;
  }
  if (mode.kind !== "part") return;
  if (measuring) {
    head("Measure", "", false);
    renderMeasurePanel(el);
    actions([["check", "Done", endMeasure, "primary"]]);
    return;
  }
  if (showParams) return renderParamsPanel(el);

  if (isAssembly() && clashes) {
    const c = clashes;
    const n = c.list.length;
    head("Interference", c.running ? "Checking every pair of parts…" : c.error ? "The check failed" : n ? `${n} overlap${n > 1 ? "s" : ""}, in red` : "No parts overlap", !!c.error || n > 0);
    if (c.list.length) {
      const box = document.createElement("div");
      box.className = "p-measure";
      for (const x of c.list) {
        const row = document.createElement("div");
        row.innerHTML = "<span></span><b></b>";
        row.querySelector("span")!.textContent = `${partLabel(x.a)} and ${partLabel(x.b)}`;
        row.querySelector("b")!.textContent = `${fmtNum(x.volume)} mm³`;
        box.appendChild(row);
      }
      el.appendChild(box);
    }
    if (!c.running && hiddenBodies.size) {
      const hint = document.createElement("p");
      hint.className = "p-hint";
      hint.textContent = "Hidden parts were left out.";
      el.appendChild(hint);
    }
    actions([["check", "Done", clearClashes, "primary"]]);
    return;
  }
  if (isAssembly()) {
    const mate = mateOf(selectedFeature);
    if (mate) {
      const failing = mateState().failing.has(mate.id);
      const err = failing ? "Cannot hold with the other mates" : lastBuild?.warnings?.[mate.id];
      const unitOf = mate.kind === "angle" ? "°" : " mm";
      const how =
        mate.kind === "axis"
          ? "same axis"
          : mate.min !== undefined && mate.max !== undefined
            ? `between ${fmtNum(mate.min)} and ${fmtNum(mate.max)}${unitOf}`
            : mate.kind === "angle"
              ? `${fmtNum(mate.value)}°`
              : mate.value
                ? `${fmtNum(mate.value)} mm apart`
                : mate.kind === "touch"
                  ? "in contact"
                  : "flush";
      head(mate.name, err ?? `${partLabel(mate.a.part)} and ${partLabel(mate.b.part)} · ${how}`, !!err, true);
      const items: [string, string, () => void, string?][] = [];
      if (mate.kind !== "axis") items.push(["edit", "Edit", () => void mateTool(mate)]);
      if (mate.kind === "touch" || mate.kind === "align") items.push(["flip", mate.kind === "touch" ? "Make it flush" : "Make them face", () => flipMate(mate)]);
      items.push(["trash", "Delete", () => deleteMate(mate), "danger"]);
      actions(items);
      return;
    }
    const inst = instanceOf(selectedFeature);
    if (!inst) {
      if (doc.instances?.length) {
        const st = mateState();
        head(project?.name ?? "Assembly", st.failing.size ? `${st.failing.size} mate${st.failing.size > 1 ? "s" : ""} cannot hold` : st.dof ? `${st.dof} degree${st.dof > 1 ? "s" : ""} of freedom left` : "Fully placed", st.failing.size > 0);
        const hint = document.createElement("p");
        hint.className = "p-hint";
        hint.textContent = "Tap a part to move it. Mate ties two parts: tap a face or hole on each.";
        el.appendChild(hint);
        return;
      }
      head(project?.name ?? "Assembly", "No parts yet");
      const hint = document.createElement("p");
      hint.className = "p-hint";
      hint.textContent = "Insert parts from your other projects, then drag the arrows and rings to place them.";
      el.appendChild(hint);
      actions([["plus", "Insert part", () => void showPartPicker(), "primary"]]);
      return;
    }
    const err = lastBuild?.errors[inst.id] ?? lastBuild?.warnings?.[inst.id];
    const where = `${inst.at.map(fmtNum).join(", ")} mm${inst.rot.some((r) => r) ? ` · turned ${inst.rot.map((r) => fmtNum(r) + "°").join(", ")}` : ""}`;
    head(inst.name, err ?? `${inst.fixed ? "Fixed · " : ""}${partNames[inst.project] ?? "Missing project"} · ${where}`, !!err, true);
    const hidden = hiddenBodies.has(inst.id);
    const items: [string, string, () => void, string?][] = [
      ["edit", "Position…", () => void placeTool(inst)],
      ["lookAt", inst.fixed ? "Let it move" : "Fix in place", () => toggleFixed(inst)],
      ["copy", "Duplicate", () => duplicateInstance(inst)],
      ["rename", "Rename", () => renameInstance(inst)],
      [hidden ? "eye" : "eyeOff", hidden ? "Show" : "Hide", () => toggleBody(inst.id)],
    ];
    if ((lastBuild?.bodies?.length ?? 0) > 1) {
      const others = lastBuild!.bodies!.filter((b) => b.id !== inst.id);
      const isolated = !hidden && others.every((b) => hiddenBodies.has(b.id));
      items.push(["eye", isolated ? "Show all parts" : "Show only this part", () => isolateBody(inst.id)]);
    }
    if (partDocs[inst.project]) items.push(["folder", "Open the part", () => void openPart(inst)]);
    items.push(["trash", "Remove", () => removeInstance(inst), "danger"]);
    actions(items);
    return;
  }

  if (selectedFace) {
    const plane = selectedFace.plane;
    head("Face", plane ? "Flat face" : "Curved face", false, true);
    const items: [string, string, () => void, string?][] = [];
    if (plane) {
      items.push(["sketch", "Sketch on this face", () => createSketchOn(plane)]);
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
    } else if (f.kind === "extrude") items.push(["edit", "Edit", () => void extrude(f)]);
    else if (f.kind === "pushpull") items.push(["edit", "Edit", () => void pushPull(f)]);
    else if (f.kind === "fillet") items.push(["edit", "Edit", () => void filletTool(f)]);
    else if (f.kind === "hole") items.push(["edit", "Edit", () => void holeTool(f)]);
    else if (f.kind === "pattern") items.push(["edit", "Edit", () => void patternTool(f.type, f)]);
    else if (f.kind === "revolve") items.push(["edit", "Edit", () => void revolveTool(f)]);
    else if (f.kind === "import")
      items.push([
        f.op === "add" ? "cut" : "extrude",
        f.op === "add" ? "Cut it instead" : "Join it instead",
        () => {
          f.op = f.op === "add" ? "cut" : "add";
          commit();
          renderAll();
        },
      ]);
    else items.push(["edit", "Edit", () => void shell(f)]);
    items.push(["rename", "Rename", () => renameFeature(f)]);
    if ((f.kind === "extrude" || f.kind === "revolve" || f.kind === "import") && lastBuild?.bodies?.some((b) => b.id === f.id) && lastBuild.bodies.length > 1) {
      items.push(["rename", "Rename body", () => renameBody(f.id)]);
      items.push([hiddenBodies.has(f.id) ? "eye" : "eyeOff", hiddenBodies.has(f.id) ? "Show body" : "Hide body", () => toggleBody(f.id)]);
      const others = lastBuild.bodies.filter((b) => b.id !== f.id);
      const isolated = !hiddenBodies.has(f.id) && others.every((b) => hiddenBodies.has(b.id));
      items.push(["eye", isolated ? "Show all bodies" : "Show only this body", () => isolateBody(f.id)]);
    }
    if (f.kind === "import" && f.op === "add" && bodiesBefore(f.id).length)
      items.push([
        "extrude",
        f.body === "new" ? "Join it to the part" : "Make it a new body",
        () => {
          f.body = f.body === "new" ? undefined : "new";
          commit();
          renderAll();
        },
      ]);
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
    return `${op} · ${fmtNum(Math.abs(f.angle))}°${f.symmetric ? " symmetric" : ""} around ${sk ? axisName(sk, f.axisLine) : "?"}${bodyNote(f)}`;
  }
  if (f.kind === "hole") {
    const n = f.sketchId ? "at sketch points" : `× ${f.points?.length ?? 0}`;
    const head = f.head === "counterbore" ? " · counterbore" : f.head === "countersink" ? " · countersink" : "";
    return `${f.size} ${n}${head} · ${f.depth > 0 ? `${fmtNum(f.depth)} mm deep` : "through"}`;
  }
  if (f.kind === "import") return `${f.op === "add" ? "Join" : "Cut"} · STEP file${bodyNote(f)}`;
  if (f.kind === "fillet")
    return `${f.mode === "fillet" ? "Radius" : "Chamfer"} ${fmtNum(f.radius)} mm · ${f.edges.length} edge${f.edges.length > 1 ? "s" : ""}`;
  const op = f.op === "add" ? "Join" : f.op === "cut" ? "Cut" : "Intersect";
  return `${op} · ${fmtNum(Math.abs(f.distance))} mm${f.symmetric ? " · symmetric" : ""}${bodyNote(f)}`;
}

function featureIcon(f: Feature) {
  if (f.kind === "sketch") return "rect";
  if (f.kind === "pushpull") return "pushpull";
  if (f.kind === "shell") return "shell";
  if (f.kind === "fillet") return f.mode === "fillet" ? "fillet" : "chamfer";
  if (f.kind === "hole") return "hole";
  if (f.kind === "pattern") return f.type;
  if (f.kind === "revolve") return "revolve";
  if (f.kind === "import") return "import";
  return f.op === "cut" ? "cut" : f.op === "intersect" ? "intersect" : "extrude";
}

/** Steps shown at the last refresh (null before the first one: nothing pops in on load). */
let chipsShown: Set<string> | null = null;

function renderTimeline() {
  const el = $("#chips");
  el.replaceChildren();
  if (isAssembly()) return renderPartList(el);
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

/** An assembly's timeline: its parts, in the order they were inserted. */
function renderPartList(el: HTMLElement) {
  const list = doc.instances ?? [];
  if (!list.length) {
    const e = document.createElement("span");
    e.className = "empty";
    e.textContent = "The parts of the assembly appear here. Insert one from your projects.";
    el.appendChild(e);
  }
  const current = isOperation(mode) ? mode.feat.id : selectedFeature;
  for (const inst of list) {
    const b = document.createElement("button");
    b.className = "chip";
    if (chipsShown && !chipsShown.has(inst.id)) b.classList.add("pop");
    if (inst.id === current) b.classList.add("sel");
    if (lastBuild?.errors[inst.id]) b.classList.add("error");
    else if (lastBuild?.warnings?.[inst.id]) b.classList.add("warn");
    if (hiddenBodies.has(inst.id)) b.classList.add("muted");
    b.innerHTML = icon(hiddenBodies.has(inst.id) ? "eyeOff" : "part", 20) + "<span></span>";
    b.querySelector("span")!.textContent = inst.name;
    b.onclick = () => {
      if (mode.kind !== "part") return toast("Finish the current step first");
      if (measuring) endMeasure();
      selectedFeature = selectedFeature === inst.id ? null : inst.id;
      renderAll();
    };
    el.appendChild(b);
    if (inst.id === current) requestAnimationFrame(() => b.scrollIntoView({ inline: "nearest", block: "nearest" }));
  }
  const mates = doc.mates ?? [];
  if (mates.length) {
    const sep = document.createElement("span");
    sep.className = "chip-sep";
    el.appendChild(sep);
  }
  const failing = mates.length ? mateState().failing : new Set<string>();
  for (const m of mates) {
    const b = document.createElement("button");
    b.className = "chip";
    if (chipsShown && !chipsShown.has(m.id)) b.classList.add("pop");
    if (m.id === current) b.classList.add("sel");
    if (failing.has(m.id)) b.classList.add("error");
    else if (lastBuild?.warnings?.[m.id]) b.classList.add("warn");
    b.innerHTML = icon("mate", 20) + "<span></span>";
    b.querySelector("span")!.textContent = m.kind === "touch" || m.kind === "align" ? (m.value ? `${m.name} · ${fmtNum(m.value)}` : m.name) : m.kind === "angle" ? `${m.name} · ${fmtNum(m.value)}°` : m.name;
    b.onclick = () => {
      if (mode.kind !== "part") return toast("Finish the current step first");
      if (measuring) endMeasure();
      selectedFeature = selectedFeature === m.id ? null : m.id;
      renderAll();
    };
    el.appendChild(b);
  }
  chipsShown = new Set([...list.map((i) => i.id), ...mates.map((m) => m.id)]);
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
  else if (mode.kind === "place") s = `${mode.feat.name} · choose a value and type it`;
  else if (mode.kind === "mate") s = mode.picks.length ? "Mate · now the face or hole on the other part" : "Mate · tap a flat face, a hole or a round edge of a part";
  else if (mode.kind === "mateEdit") s = `${mode.feat.name} · facing, flush or at an angle; type the gap, or limits`;
  else if (isAssembly() && clashes) s = clashes.running ? "Checking for overlaps…" : "Interference · overlaps in red";
  else if (isAssembly() && explodeTarget) s = "Exploded view · tap it again to put the parts back";
  else if (isAssembly() && !s && !measuring && doc.instances?.length)
    s = instanceOf(selectedFeature) ? "Drag an arrow to slide the part, a ring to turn it" : "Tap a part to place it";
  if (buildSlow) s = s ? `Building… · ${s}` : "Building the model…";
  $("#status").textContent = s;
}

// ---------- Display menu: how the solid is drawn, and a section through it ----------

let displayMenuOpen = false;

const DISPLAY_MODES: [DisplayMode, string][] = [
  ["shaded-edges", "Shaded with edges"],
  ["shaded", "Shaded"],
  ["wireframe", "Wireframe"],
  ["xray", "X-ray"],
  ["technical", "Technical lines"],
];

/**
 * The menu is built once when it opens and then updated in place, so its changes can animate:
 * it scales in from the button and fades out, a pill slides to the chosen mode, and the section
 * slider unfolds.
 */
function renderDisplayMenu() {
  let el = document.getElementById("display-menu");
  if (!displayMenuOpen) {
    if (el && !el.classList.contains("closing")) {
      const gone = el;
      gone.classList.add("closing");
      const remove = () => gone.remove();
      gone.addEventListener("animationend", remove, { once: true });
      setTimeout(remove, 250); // no animation (reduced motion): remove anyway
    }
    renderViewButtons();
    return;
  }
  if (!el || el.classList.contains("closing")) {
    el?.remove();
    el = buildDisplayMenu();
  }
  syncDisplayMenu(el);
  renderViewButtons();
}

function buildDisplayMenu() {
  const el = document.createElement("div");
  el.id = "display-menu";
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  const title = (text: string) => {
    const t = document.createElement("div");
    t.className = "dm-title";
    t.textContent = text;
    return t;
  };
  el.appendChild(title("Display"));
  const modes = document.createElement("div");
  modes.className = "dm-modes";
  const pill = document.createElement("div");
  pill.className = "dm-pill";
  modes.appendChild(pill);
  for (const [m, label] of DISPLAY_MODES) {
    const b = document.createElement("button");
    b.className = "dm-mode";
    b.dataset.mode = m;
    b.textContent = label;
    b.onclick = () => {
      vp.setDisplayMode(m);
      prefs.display = m;
      savePrefs();
      if (mode.kind === "sketch") vp.setModelOpacity(0.45);
      renderDisplayMenu();
    };
    modes.appendChild(b);
  }
  el.appendChild(modes);
  el.appendChild(title("Section"));
  const seg = document.createElement("div");
  seg.className = "seg";
  for (const a of ["off", "X", "Y", "Z"] as const) {
    const b = document.createElement("button");
    b.dataset.axis = a;
    b.textContent = a === "off" ? "Off" : a;
    b.onclick = () => {
      const cur = vp.section;
      vp.setSection(a === "off" ? null : { axis: a, at: cur?.at ?? 0.5 });
      renderDisplayMenu();
    };
    seg.appendChild(b);
  }
  el.appendChild(seg);
  // Slide the cutting plane through the model; folded away while there is no section.
  const wrap = document.createElement("div");
  wrap.className = "dm-range-wrap";
  const inner = document.createElement("div");
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = "100";
  range.className = "dm-range";
  range.setAttribute("aria-label", "Section position");
  range.oninput = () => {
    const cur = vp.section;
    if (cur) vp.setSection({ axis: cur.axis, at: Number(range.value) / 100 });
  };
  inner.appendChild(range);
  wrap.appendChild(inner);
  el.appendChild(wrap);
  // The part's bodies, each shown or hidden with a tap (filled in by syncDisplayMenu).
  const bodies = document.createElement("div");
  bodies.className = "dm-bodies";
  el.appendChild(bodies);
  document.body.appendChild(el);
  return el;
}

function syncBodyList(el: HTMLElement) {
  const list = lastBuild?.bodies ?? [];
  el.replaceChildren();
  if (list.length < 2) return;
  const t = document.createElement("div");
  t.className = "dm-title";
  t.textContent = isAssembly() ? "Parts" : "Bodies";
  el.appendChild(t);
  for (const b of list) {
    const btn = document.createElement("button");
    const shown = !hiddenBodies.has(b.id);
    btn.className = "dm-mode dm-body" + (shown ? " on" : "");
    btn.innerHTML = icon(shown ? "eye" : "eyeOff", 20);
    btn.append(b.name);
    btn.title = shown ? "Hide this body" : "Show this body";
    btn.onclick = () => toggleBody(b.id);
    el.appendChild(btn);
  }
}

function syncDisplayMenu(el: HTMLElement) {
  let active: HTMLElement | null = null;
  for (const b of el.querySelectorAll<HTMLElement>(".dm-mode")) {
    const on = b.dataset.mode === vp.displayMode;
    b.classList.toggle("on", on);
    if (on) active = b;
  }
  const pill = el.querySelector<HTMLElement>(".dm-pill")!;
  if (active) {
    pill.style.transform = `translateY(${active.offsetTop}px)`;
    pill.style.height = `${active.offsetHeight}px`;
  }
  const cur = vp.section;
  for (const b of el.querySelectorAll<HTMLElement>(".seg button")) b.classList.toggle("on", b.dataset.axis === "off" ? !cur : cur?.axis === b.dataset.axis);
  el.querySelector(".dm-range-wrap")!.classList.toggle("shown", !!cur);
  const range = el.querySelector<HTMLInputElement>(".dm-range")!;
  if (cur) range.value = String(Math.round(cur.at * 100));
  syncBodyList(el.querySelector(".dm-bodies")!);
}

// A tap elsewhere closes the display menu.
document.addEventListener("pointerdown", (e) => {
  if (!displayMenuOpen) return;
  const t = e.target as HTMLElement;
  if (t.closest("#display-menu") || t.closest("#view-buttons")) return;
  displayMenuOpen = false;
  renderDisplayMenu();
});

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
  add("display", "Display: shading, wireframe, X-ray, section", () => {
    displayMenuOpen = !displayMenuOpen;
    renderDisplayMenu();
  }, displayMenuOpen || vp.displayMode !== "shaded-edges" || !!vp.section || anyBodyHidden());
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
  if (measuring && mode.kind === "part") {
    const acc = rgb("--accent");
    for (const k of measuring.picks)
      if (k.kind === "point") {
        marks.positions.push(...k.p);
        marks.colors.push(...acc);
      }
    const line = measuring.result?.line;
    const main = measuring.result?.rows.find((r) => r.unit === "mm" && /distance/i.test(r.label));
    if (line && main && main.value > 1e-6) {
      batch.positions.push(...line[0], ...line[1]);
      batch.colors.push(...acc, ...acc);
      const tag = document.createElement("div");
      tag.className = "sk-label dim";
      tag.textContent = measureValue(main);
      labels.push({ el: tag, at: new THREE.Vector3((line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2, (line[0][2] + line[1][2]) / 2) });
    }
  }
  if (isAssembly()) mateMarks(batch);
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
    else if (c.type === "spline" || c.type === "bezier" || c.type === "ellipse") {
      const ps = sampleCurve(v, c);
      for (let i = 0; i + 1 < ps.length; i++) seg(ps[i], ps[i + 1]);
    } else arc(v.xy(c.c), v.arcRadius(c), ...v.arcAngles(c));
  }
}

// ---------- Part-mode pointer tool: pick planes and faces ----------

const partTool: PointerTool = {
  down(p) {
    if (mode.kind === "hole") holeDown(mode.feat, p);
    fingerDown(p);
  },
  move(p) {
    if (mode.kind === "hole") holeMove(mode.feat, p);
    fingerMove(p);
  },
  up(p) {
    if (fingerDrag?.moved) {
      fingerDrag = null;
      return endDrag(true);
    }
    fingerDrag = null;
    if (mode.kind === "pickPlane") return pickPlaneAt(p);
    if (mode.kind === "mate") return void mateTap(p);
    const face = vp.pickFace(p.x, p.y);
    if (mode.kind === "shell") {
      if (face != null) toggleShellFace(mode.feat, face);
      return;
    }
    if (mode.kind === "fillet") return toggleFilletEdge(mode.feat, p);
    if (mode.kind === "part" && measuring) return measureTap(p);
    if (mode.kind === "part" && isAssembly()) {
      const id = face == null ? null : (lastBuild?.bodies?.find((b) => b.faceIds.includes(face))?.id ?? null);
      selectedFeature = id;
      return renderAll();
    }
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
    if (fingerDrag?.moved) endDrag(false);
    fingerDrag = null;
  },
  hover(p) {
    if (mode.kind !== "pickPlane" || !p) return;
    vp.highlightFace(vp.pickFace(p.x, p.y));
  },
};

// ---------- Measure ----------

/** Measuring: what was tapped (one or two things) and what the worker found. */
let measuring: { picks: MeasurePick[]; result: MeasureResult | null } | null = null;
let measureReq = 0;

function toggleMeasure() {
  if (measuring) return endMeasure();
  showParams = false;
  pendingFaceTool = null;
  selectedFeature = null;
  selectedFace = null;
  vp.highlightFace(null);
  measuring = { picks: [], result: null };
  renderAll();
}

function endMeasure() {
  measuring = null;
  vp.highlightFaces([]);
  vp.highlightEdges([]);
  renderAll();
}

/** What is under the finger: a corner (the end of an edge, close on screen), else an edge, else a face. */
function measurePickAt(p: Ptr): MeasurePick | null {
  const edge = vp.pickEdge(p.x, p.y, 14);
  if (edge != null) {
    const line = vp.edgePolyline(edge);
    const ends = [line[0], line[line.length - 1]];
    const closed = Math.hypot(ends[0][0] - ends[1][0], ends[0][1] - ends[1][1], ends[0][2] - ends[1][2]) < 1e-6;
    if (!closed)
      for (const end of ends) {
        const [sx, sy] = vp.toScreen(new THREE.Vector3(...end));
        if (Math.hypot(sx - p.x, sy - p.y) < 18) return { kind: "point", p: end };
      }
    return { kind: "edge", id: vp.edgeId(edge) };
  }
  const face = vp.pickFace(p.x, p.y);
  return face == null ? null : { kind: "face", id: face };
}

/** A third tap starts again; a tap on nothing clears. */
function measureTap(p: Ptr) {
  if (!measuring) return;
  const pick = measurePickAt(p);
  measuring.picks = !pick ? [] : measuring.picks.length >= 2 ? [pick] : [...measuring.picks, pick];
  measuring.result = null;
  showMeasurePicks();
  if (measuring.picks.length) {
    measureReq = ++reqCounter;
    worker.postMessage({ type: "measure", reqId: measureReq, doc, picks: measuring.picks } satisfies WorkerRequest);
  }
  renderPanel();
  renderPartOverlays();
}

function showMeasurePicks() {
  const picks = measuring?.picks ?? [];
  vp.highlightFaces(picks.flatMap((k) => (k.kind === "face" ? [k.id] : [])));
  vp.highlightEdges(picks.flatMap((k) => (k.kind === "edge" ? [vp.edgeIndexOf(k.id) ?? -1] : [])));
}

function measureValue(r: MeasureRow) {
  return `${fmtNum(r.value)}${r.unit === "°" ? "°" : " " + r.unit}`;
}

function renderMeasurePanel(el: HTMLElement) {
  if (!measuring) return;
  const n = measuring.picks.length;
  const rows = measuring.result?.rows ?? [];
  const box = document.createElement("div");
  box.className = "p-measure";
  for (const r of rows) {
    const row = document.createElement("div");
    row.innerHTML = "<span></span><b></b>";
    row.querySelector("span")!.textContent = r.label;
    row.querySelector("b")!.textContent = measureValue(r);
    box.appendChild(row);
  }
  if (rows.length) el.appendChild(box);
  const hint = document.createElement("p");
  hint.className = "p-hint";
  hint.textContent =
    measuring.result?.error ??
    (n === 0
      ? "Tap a face, an edge or a corner."
      : n === 1
        ? "Tap a second one to measure between them."
        : "Tap again to start a new measure.");
  if (n && !measuring.result) hint.textContent = "Measuring…";
  el.appendChild(hint);
}

// ---------- Menu, files ----------

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Asks for one file; null when the picker is closed without a choice. */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Brings a DXF or SVG drawing into the open sketch. The keypad sets the scale (millimetres per
 * drawing unit, read from the file when it says), with placement and fixed/free as choices;
 * the drawing is shown as it will land while these change.
 */
async function importDrawing() {
  if (mode.kind !== "sketch") return;
  const ed = mode.editor;
  const file = await pickFile(".dxf,.svg,image/vnd.dxf,application/dxf,image/svg+xml");
  if (!file || mode.kind !== "sketch" || mode.editor !== ed) return;
  const text = await file.text();
  // By extension, else by content (an SVG is XML with an <svg> element).
  const isSvg = /\.svg$/i.test(file.name) || (!/\.dxf$/i.test(file.name) && /<svg[\s>]/i.test(text));
  const kind = isSvg ? "SVG" : "DXF";
  let res: ReturnType<typeof parseDxf>;
  try {
    res = isSvg ? parseSvg(text) : parseDxf(text);
  } catch (e) {
    return toast(`Cannot read this ${kind}: ` + (e instanceof Error ? e.message : String(e)));
  }
  const skipped = Object.entries(res.skipped)
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
  if (!res.shapes.length) return toast(skipped ? `Nothing to import (skipped: ${skipped})` : "Nothing to import in this file");

  const before = { entities: structuredClone(ed.sk.entities), constraints: structuredClone(ed.sk.constraints) };
  const opt: ImportOptions = { scale: res.unitScale, place: "file", fixed: true };
  const show = (frame: boolean) => {
    ed.sk.entities = structuredClone(before.entities);
    ed.sk.constraints = structuredClone(before.constraints);
    insertShapes(ed.sk, res.shapes, opt);
    ed.solve();
    ed.render();
    if (!frame) return;
    // Frame the drawing where it lands.
    const b = bounds(res.shapes)!;
    const k = opt.scale;
    const c = opt.place === "centre" ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] : [0, 0];
    const { origin: o, xDir: xd, normal: n } = ed.sk.plane;
    const yd = [n[1] * xd[2] - n[2] * xd[1], n[2] * xd[0] - n[0] * xd[2], n[0] * xd[1] - n[1] * xd[0]];
    const w = (x: number, y: number) => new THREE.Vector3(...[0, 1, 2].map((i) => o[i] + xd[i] * (x - c[0]) * k + yd[i] * (y - c[1]) * k));
    vp.fit(new THREE.Box3().setFromPoints([w(b.min[0], b.min[1]), w(b.max[0], b.max[1]), w(b.min[0], b.max[1]), w(b.max[0], b.min[1])]));
  };
  show(true);
  const kp = openKeypad({
    title: `Import ${kind}`,
    subtitle: `${file.name} · ${res.shapes.length} curves · ${res.unitName}${skipped ? ` · skipped: ${skipped}` : ""}`,
    label: "Scale (mm per drawing unit)",
    value: opt.scale,
    unit: "×",
    confirmLabel: "Import",
    segments: [
      {
        options: [
          { value: "file", label: "As in the file" },
          { value: "centre", label: "Centred on origin" },
        ],
        get: () => opt.place,
        set: (v) => {
          opt.place = v as ImportOptions["place"];
          show(true);
        },
      },
      {
        options: [
          { value: "fixed", label: "Fixed in place" },
          { value: "free", label: "Free to constrain" },
        ],
        get: () => (opt.fixed ? "fixed" : "free"),
        set: (v) => {
          opt.fixed = v === "fixed";
          show(false);
        },
      },
    ],
    onInput: (v) => {
      if (v > 0) {
        opt.scale = v;
        show(true);
      }
    },
  });
  const r = await kp.result;
  if (r === null || !(r.value > 0)) {
    ed.sk.entities = before.entities;
    ed.sk.constraints = before.constraints;
    ed.solve();
    ed.render();
    renderAll();
    return;
  }
  opt.scale = r.value;
  show(false);
  commit();
  toast(`${res.shapes.length} curves imported`);
  renderAll();
}

/**
 * Text: the letters' outlines go into the sketch as fixed curves, centred where the view looks,
 * and stay selected so they can be slid into place. Typed words, height and font preview live.
 */
async function insertText() {
  if (mode.kind !== "sketch") return;
  const ed = mode.editor;
  const opt = { text: "Text", height: 10, font: "bold" as FontId };
  let font: Font;
  try {
    font = await loadFont(opt.font);
  } catch {
    return toast("The font could not be loaded");
  }
  if (mode.kind !== "sketch" || mode.editor !== ed) return;
  const at = vp.screenToPlane(vp.width / 2, vp.height / 2, ed.sk.plane) ?? [0, 0];
  const before = { entities: structuredClone(ed.sk.entities), constraints: structuredClone(ed.sk.constraints) };
  let added: string[] = [];
  const show = (frame = false) => {
    ed.sk.entities = structuredClone(before.entities);
    ed.sk.constraints = structuredClone(before.constraints);
    const shapes = textShapes(font, opt.text, opt.height);
    const b = bounds(shapes);
    if (b) {
      // Centred on the point the view looks at.
      const dx = at[0] - (b.min[0] + b.max[0]) / 2;
      const dy = at[1] - (b.min[1] + b.max[1]) / 2;
      const moved = shapes.map((s) => shiftShape(s, dx, dy));
      const known = new Set(before.entities.map((e) => e.id));
      insertShapes(ed.sk, moved, { scale: 1, place: "file", fixed: true });
      added = ed.sk.entities.filter((e) => !known.has(e.id)).map((e) => e.id);
      if (frame) {
        // Room around the words, which the panel may partly cover.
        const { origin: o, xDir: xd, normal: n } = ed.sk.plane;
        const yd = [n[1] * xd[2] - n[2] * xd[1], n[2] * xd[0] - n[0] * xd[2], n[0] * xd[1] - n[1] * xd[0]];
        const w = (x: number, y: number) => new THREE.Vector3(...[0, 1, 2].map((i) => o[i] + xd[i] * x + yd[i] * y));
        const pad = opt.height * 2;
        const [x0, y0, x1, y1] = [b.min[0] + dx - pad, b.min[1] + dy - pad, b.max[0] + dx + pad, b.max[1] + dy + pad];
        vp.fit(new THREE.Box3().setFromPoints([w(x0, y0), w(x1, y1), w(x0, y1), w(x1, y0)]));
      }
    } else added = [];
    ed.solve();
    ed.render();
  };
  show(true);
  const kp = openKeypad({
    title: "Text",
    subtitle: "Capital letters this tall",
    label: "Height",
    value: opt.height,
    unit: "mm",
    confirmLabel: "Insert",
    text: {
      value: opt.text,
      placeholder: "Type the text",
      onInput: (v) => {
        opt.text = v;
        show();
      },
    },
    segments: [
      {
        options: FONTS.map((f) => ({ value: f.id, label: f.label })),
        get: () => opt.font,
        set: (v) => {
          opt.font = v as FontId;
          void loadFont(opt.font).then((f) => {
            if (opt.font !== v) return;
            font = f;
            show();
          });
        },
      },
    ],
    onInput: (v) => {
      if (v > 0) {
        opt.height = v;
        show();
      }
    },
  });
  const r = await kp.result;
  if (r === null || !(r.value > 0) || !opt.text.trim()) {
    ed.sk.entities = before.entities;
    ed.sk.constraints = before.constraints;
    ed.solve();
    ed.render();
    renderAll();
    return;
  }
  opt.height = r.value;
  show();
  commit();
  ed.setTool("select");
  ed.selection.clear();
  for (const id of added) ed.selection.add(id);
  ed.render();
  renderAll();
}

function shiftShape(s: ImportShape, dx: number, dy: number): ImportShape {
  const m = (p: [number, number]): [number, number] => [p[0] + dx, p[1] + dy];
  switch (s.kind) {
    case "line":
      return { ...s, a: m(s.a), b: m(s.b) };
    case "bezier":
      return { ...s, a: m(s.a), c1: m(s.c1), c2: m(s.c2), b: m(s.b) };
    case "circle":
      return { ...s, c: m(s.c) };
    case "arc":
      return { ...s, c: m(s.c), s: m(s.s), e: m(s.e) };
    case "spline":
      return { ...s, pts: s.pts.map(m) };
  }
}

/**
 * A STEP file becomes a step of the model: its solid is joined as placed in the file, and can be
 * cut instead, filleted, patterned like any other step.
 */
async function importStep() {
  const file = await pickFile(".step,.stp,model/step");
  if (!file) return;
  const text = await file.text();
  if (!text.slice(0, 400).includes("ISO-10303-21")) return toast("This is not a STEP file");
  leaveModes();
  const fileId = uid();
  const name = file.name.replace(/\.(step|stp)$/i, "") || "Import";
  if (isAssembly()) {
    // In an assembly, the file becomes a part: a project of its own, placed here.
    const part: CadDocument = { ...emptyDoc(), files: { [fileId]: text }, features: [{ id: uid(), kind: "import", name, fileId, op: "add" }] };
    const now = Date.now();
    const names = (await listProjects().catch(() => [])).map((p) => p.name);
    const meta: ProjectMeta = { id: newProjectId(), name: names.includes(name) ? freeName(name, names) : name, created: now, updated: now };
    try {
      await putProject(meta, part);
    } catch {
      return toast("Could not save in this browser");
    }
    return insertPart(meta, part);
  }
  doc.files = { ...doc.files, [fileId]: text };
  // An imported part usually stays apart: it starts a body of its own.
  doc.features.push({ id: uid(), kind: "import", name, fileId, op: "add", body: "new" });
  fitNext = true;
  commit();
  renderAll();
}

/** A file opened from the device becomes a new project, named after the file. */
function openFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.waffle,.tcad,application/json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const d = asDocument(JSON.parse(await f.text()));
      if (!d) throw new Error("not a WaffleCAD file");
      await createProject(f.name.replace(/(\.waffle)?\.(json|waffle|tcad)$/i, "") || "Model", d);
      closeProjects();
    } catch (e) {
      toast("Cannot open this file: " + (e instanceof Error ? e.message : e));
    }
  };
  input.click();
}

/** The project's name, made safe for a file name. */
const fileName = () => (project?.name ?? "model").replace(/[\\/:*?"<>|]+/g, "-").trim() || "model";

// ---------- Project gallery ----------

function closeProjects() {
  document.getElementById("projects")?.remove();
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

async function showProjects() {
  await flushSave();
  captureThumb();
  let list: ProjectMeta[];
  try {
    list = await listProjects();
  } catch {
    return toast("This browser cannot keep projects");
  }
  let el = document.getElementById("projects");
  if (!el) {
    el = document.createElement("div");
    el.id = "projects";
    el.addEventListener("pointerdown", (e) => {
      if (e.target === el) closeProjects();
    });
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="projects-card">
    <header><h2>Projects</h2><button class="projects-open">${icon("folder", 20)}<span>Open file</span></button><button class="projects-asm">${icon("assembly", 20)}<span>New assembly</span></button><button class="primary projects-new">${icon("plus", 20)}<span>New project</span></button><button class="projects-close" aria-label="Close">${icon("close", 22)}</button></header>
    <div class="projects-grid"></div></div>`;
  el.querySelector<HTMLElement>(".projects-new")!.onclick = () => void newProject();
  el.querySelector<HTMLElement>(".projects-asm")!.onclick = () => void newAssembly();
  el.querySelector<HTMLElement>(".projects-open")!.onclick = openFile;
  el.querySelector<HTMLElement>(".projects-close")!.onclick = closeProjects;
  const grid = el.querySelector(".projects-grid")!;
  for (const p of list) grid.appendChild(projectCard(p, list));
}

function projectCard(p: ProjectMeta, list: ProjectMeta[]) {
  const current = p.id === project?.id;
  const card = document.createElement("div");
  card.className = "project-card" + (current ? " current" : "");
  card.innerHTML = `<button class="project-thumb"></button>
    <div class="project-row"><div class="project-info"><div class="project-name"></div><div class="project-date"></div></div>
    <button class="project-more" aria-label="More">${icon("more", 22)}</button></div>
    <div class="project-actions"><div>
      <button data-act="rename">${icon("rename", 20)}<span>Rename</span></button>
      <button data-act="copy">${icon("copy", 20)}<span>Duplicate</span></button>
      <button data-act="delete" class="danger">${icon("trash", 20)}<span>Delete</span></button>
    </div></div>`;
  const thumb = card.querySelector<HTMLElement>(".project-thumb")!;
  if (p.thumb) {
    const img = document.createElement("img");
    img.src = p.thumb;
    img.alt = "";
    thumb.appendChild(img);
  } else thumb.innerHTML = icon(p.kind === "assembly" ? "assembly" : "extrude", 40);
  const name = card.querySelector<HTMLElement>(".project-name")!;
  name.textContent = p.name;
  card.querySelector(".project-date")!.textContent = (p.kind === "assembly" ? "Assembly · " : "") + (current ? "Open now" : ago(p.updated));
  const open = async () => {
    if (p.id !== project?.id) await openProject(p.id);
    closeProjects();
  };
  thumb.onclick = open;
  card.querySelector<HTMLElement>(".project-info")!.onclick = open;
  card.querySelector<HTMLElement>(".project-more")!.onclick = () => card.classList.toggle("acting");
  card.querySelector<HTMLElement>('[data-act="rename"]')!.onclick = () => {
    card.classList.remove("acting");
    const input = document.createElement("input");
    input.className = "project-rename";
    input.value = p.name;
    name.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = async (keep: boolean) => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      if (keep && v && v !== p.name) {
        p.name = v;
        if (project && p.id === project.id) project.name = v;
        await putProject({ ...(project && p.id === project.id ? project : p) }).catch(() => toast("Could not rename"));
      }
      name.textContent = p.name;
      input.replaceWith(name);
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") void finish(true);
      if (e.key === "Escape") void finish(false);
    };
    input.onblur = () => void finish(true);
  };
  card.querySelector<HTMLElement>('[data-act="copy"]')!.onclick = async () => {
    await flushSave();
    const src = await getProject(p.id).catch(() => null);
    if (!src) return toast("Could not duplicate");
    const now = Date.now();
    const base = p.name.replace(/ \d+$/, "");
    const copy: ProjectMeta = { ...src.meta, id: newProjectId(), name: freeName(base, list.map((x) => x.name)), created: now, updated: now };
    await putProject(copy, src.doc).catch(() => toast("Could not duplicate"));
    void showProjects();
  };
  card.querySelector<HTMLElement>('[data-act="delete"]')!.onclick = async () => {
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    await deleteProject(p.id).catch(() => toast("Could not delete"));
    if (p.id === project?.id) {
      project = null; // nothing left to save there
      const rest = await listProjects().catch(() => []);
      if (rest.length) await openProject(rest[0].id);
      else await createProject("Model 1");
    }
    void showProjects();
  };
  return card;
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
    ["Projects", () => void showProjects()],
    ["New project", () => void newProject()],
    ["New assembly", () => void newAssembly()],
    ["Open file…", openFile],
    ["Save file (.json)", () => download(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }), `${fileName()}.waffle.json`)],
    ["Import STEP…", () => void importStep()],
    ["Export", () => {}],
    ["Light / dark theme", () => setTheme(prefs.theme === "light" ? "dark" : "light")],
    ["Help", () => $("#help").classList.add("open")],
  ];
  // Export unfolds its formats in place.
  const formats = document.createElement("div");
  formats.className = "menu-sub";
  const inner = document.createElement("div");
  for (const [format, label] of [
    ["step", "STEP"],
    ["stl", "STL"],
    ["3mf", "3MF"],
  ] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      menu.classList.remove("open");
      formats.classList.remove("open");
      exportFile(format);
    };
    inner.appendChild(b);
  }
  formats.appendChild(inner);
  for (const [label, run] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    if (label === "Export") {
      b.classList.add("menu-fold");
      b.innerHTML = `<span>Export</span>${icon("chevron", 18)}`;
      b.onclick = () => b.classList.toggle("open", formats.classList.toggle("open"));
      menu.append(b, formats);
      continue;
    }
    b.onclick = () => {
      menu.classList.remove("open");
      run();
    };
    menu.appendChild(b);
  }
  const version = document.createElement("div");
  version.className = "menu-version";
  version.textContent = `WaffleCAD ${__APP_VERSION__}`;
  menu.appendChild(version);
  const btn = $("#menu");
  btn.innerHTML = icon("menu", 22);
  btn.onclick = (e) => {
    e.stopPropagation();
    // Opens folded again.
    formats.classList.remove("open");
    menu.querySelector(".menu-fold")?.classList.remove("open");
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
    else if (k.toLowerCase() === "x") return void insertText();
    else return;
    return renderAll();
  }
  if (mode.kind === "part" && isAssembly()) {
    const key = k.toLowerCase();
    const inst = instanceOf(selectedFeature);
    const mate = mateOf(selectedFeature);
    if (key === "i") void showPartPicker();
    else if (key === "m") startMate();
    else if (key === "x") toggleExplode();
    else if (key === "c") void (clashes ? clearClashes() : checkInterference());
    else if (key === "d") toggleMeasure();
    else if (key === "f") vp.fit();
    else if (key === "delete" && inst) removeInstance(inst);
    else if (key === "delete" && mate) deleteMate(mate);
    return;
  }
  if (mode.kind === "mate") {
    if (k.toLowerCase() === "m") startMate();
    return;
  }
  if (mode.kind === "part") {
    const key = k.toLowerCase();
    if (key === "s") startNewSketch();
    else if (key === "e") void extrude();
    else if (key === "q") faceTool("pushpull");
    else if (key === "p") toggleParams();
    else if (key === "d") toggleMeasure();
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

/**
 * Areas that scroll say so (touch screens hide scrollbars): faded edges, a small arrow, a nudge
 * the first time. The timeline also scrolls sideways with a mouse wheel.
 */
function setupScrollAreas() {
  scrollHints($("#tools"), "y", "tools");
  scrollHints($("#panel"), "y", "panel");
  const el = $("#chips");
  scrollHints(el, "x", "timeline");
  el.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );
}

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
  setupScrollAreas();
  $("#help-close").onclick = () => $("#help").classList.remove("open");
  renderAll();
  await openInitialProject();
  // A tablet can close the app any time it is in the background: write what is pending then.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    captureThumb();
    void flushSave();
  });
  solver = await Solver.create(planegcsWasm);
  new InputRouter(vp, $("#view"), {
    is2D: () => mode.kind === "sketch",
    tool: () => (mode.kind === "sketch" ? mode.editor : partTool),
    onUndo: undo,
    onRedo: redo,
  });
  if (!doc.features.length && !isAssembly()) $("#help").classList.add("open");
  if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register(`./sw.js?v=${__APP_VERSION__}`);
}

void boot();
