import "@fontsource-variable/dm-sans/wght.css";
import "./style.css";
import * as THREE from "three";
import planegcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import type { Axis, BuildResult, BundledProject, CadDocument, Clash, CombineFeature, Mate, MateRef, PartInstance, ExtrudeFeature, RevolveFeature, SweepFeature, LoftFeature, ExtrudeOp, FaceRef, Feature, FilletFeature, HoleFeature, Parameter, PatternFeature, PlaneDef, PushPullFeature, ShellFeature, SketchFeature, SkEntity, EdgeGroup, Vec3, WorkerRequest, WorkerResponse } from "./types";
import { DIMENSION_TYPES } from "./types";
import { NAME_RE, applyParameters, dropSharedCopies, expressionSlots, hasNames, identifiers, partParameters, renameInExpr, resolveParameters, sharedUsed, usedNames } from "./params";
import { Viewport, cssVar, type DisplayMode, type LineBatch } from "./view/viewport";
import { InputRouter, type PointerTool, type Ptr } from "./view/input";
import { Solver } from "./sketch/solver";
import { SketchEditor, type Action, type SketchToolName } from "./sketch/editor";
import { updateProjections } from "./sketch/ops";
import type { SelectMode } from "./sketch/selectModes";
import { SketchView, constraintLabel, newSketch, sampleCurve, sketchLineWorld, uid } from "./sketch/model";
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
import { $, ago, asDocument, byName, download, emptyDoc, fmtNum } from "./app/util";
import { toast } from "./ui/toast";
import { playEnter } from "./ui/enter";
import { applyPrefs, prefs, savePrefs, type Prefs } from "./app/prefs";
import { narrow, placePanel, setupPanelDrag } from "./app/panel";
import { explode, explodeTarget, resetExplode, spreadParts, toggleExplode } from "./app/explode";
import { endMeasure, measureReq, measureTap, measureValue, measuring, renderMeasurePanel, showMeasurePicks, toggleMeasure } from "./app/measure";
import { registerApp } from "./app/app";
// Keyboard shortcuts: the module only listens, nothing is imported from it.
import "./app/keyboard";
import { escape, exitSketch } from "./app/modes";
import { renderWorkspace, toggleBarMenu } from "./app/workspace";
import { renderTools } from "./app/tools";
import { renderPanel } from "./app/sidePanel";
import { renderTimeline } from "./app/timeline";
import { renderStatus } from "./app/status";
import { duplicateInstance, instanceOf, isAssembly, loadParts, newPartHere, openPart, partDocs, partNames, pickPart, removeInstance, renameInstance, showPartPicker } from "./app/assemblies";
import { deleteMate, flipMate, mateOf, mateState, mateTool, partLabel, startMate, syncGizmo, toggleFixed } from "./app/mates";
import { alignReference, alignShift, endAlign, renderAlignPanel, showAlignPicks, startAlign, toggleAlignPart } from "./app/align";
import { COMBINE_NAMES, combineNames, combineRows, endCombine, renderCombinePanel, showCombinePicks, startCombine, toggleCombinePart } from "./app/combine";
import { checkInterference, clearClashes, placeTool } from "./app/interference";
import { bodiesBefore, bodyNote, isolateBody, renameBody, toggleBody } from "./app/bodies";
import { catchUpShared, deleteFeature, hasSolid, paramScope, pickSketchForExtrude, renameFeature, renderParamsPanel, toggleParams } from "./app/parameters";
import { renderPartOverlays, renderViewButtons } from "./app/display";
import { partTool } from "./app/partTool";
import { importDrawing, importStep, insertText } from "./app/files";
import { setupMenu } from "./app/menu";
import { extrude } from "./app/extrude";
import { faceTool, pushPull, shell } from "./app/faceTools";
import { hitRadiusPx, holeDimLabels, holeDown, dropHoleDrag, holeMove, holeSel, holeTool, holeUp, startHoles } from "./app/holes";
import { axisName, revolveAxisPicker, revolveTool } from "./app/revolve";
import { allSketches, endSweepLoft, pickSketchLine, renderSweepLoftPanel, startLoft, startSweep } from "./app/sweepLoft";
import { patternSummary, patternTool, togglePatternFeature } from "./app/patterns";
import { filletTool, highlightFilletEdges, highlightShellFaces, toggleFilletEdge, toggleShellFace } from "./app/fillet";
import { S, isOperation, usedSketchIds, type MatePick, type Mode } from "./app/state";
import { closeProjects, fileName, groupOf, initGallery, newGroup, openFile, saveFile, saveOpenTab, showProjects, tabName } from "./app/gallery";

/** Where versions before projects kept their one document (moved into a project at start). */
const STORAGE_KEY = "waffle.document";

// The app was called "Touch CAD" first: move what that version saved in this browser.
try {
  for (const [from, to] of [
    ["touch-cad.document", STORAGE_KEY],
  ]) {
    const v = localStorage.getItem(from);
    if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v);
    localStorage.removeItem(from);
  }
} catch {
  // Private mode: nothing saved anyway.
}

/** Documents saved by the first versions say "touch-cad"; read them as WaffleCAD documents. */
export const STD_PLANES: PlaneDef[] = [
  { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1], label: "XY" },
  { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0], label: "XZ" },
  { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0], label: "YZ" },
];
export const PLANE_NAMES: Record<string, string> = { XY: "Top (XY)", XZ: "Front (XZ)", YZ: "Right (YZ)" };
export const PLANE_COLORS: Record<string, string> = { XY: "#4c6ef5", XZ: "#2f9e44", YZ: "#e03131" };

export const buttons = (sel: string) => [...document.querySelectorAll<HTMLButtonElement>(sel)];

/**
 * State the modules split out of this file and this file both change (each `let` that would
 * otherwise be written from another module). Read and written as M.x everywhere.
 */
export const M = {
  /** The assembly the open part was opened from: a button goes back to it. */
  cameFrom: null as { id: string; name: string } | null,
  /** Overlapping parts found by the last check (null: no check shown). */
  clashes: null as { list: Clash[]; running: boolean; error?: string } | null,
  fingerDrag: null as { id: string; plane: THREE.Plane; flat: boolean; last: THREE.Vector3; x0: number; y0: number; moved: boolean } | null,
  /** Frame the model when the next build arrives (after an import). */
  fitNext: false,
  gizmo: null as PlaceGizmo | null,
  gizmoFor: "",
  /** Bodies hidden from view (for this session only: hiding is a way of looking, not a change). */
  hiddenBodies: new Set<string>(),
  reqCounter: 0,
  /** Parameters every part sees, kept in this browser beside the projects. */
  shared: [] as Parameter[],
  /** The mates' state for the current placements: what is left free, and what cannot hold. */
  solveState: null as { key: string; dof: number; failing: Set<string> } | null,
};

// ---------- Shared parameters ----------

const SHARED_KEY = "waffle.shared";
try {
  const raw: unknown = JSON.parse(localStorage.getItem(SHARED_KEY) ?? "[]");
  if (Array.isArray(raw)) M.shared = raw as Parameter[];
} catch {
  // None yet.
}
export function saveShared() {
  try {
    localStorage.setItem(SHARED_KEY, JSON.stringify(M.shared));
  } catch {
    toast("Could not save the shared parameters in this browser");
  }
}

// ---------- State ----------

export let kernelMessage = "Loading geometry kernel…";
/** The kernel could not load: the status line offers to try again. */
export let kernelBroken = false;
/** When the kernel last showed signs of life while loading (download progress). */
let kernelAlive = performance.now();
/** The document without its imported files (they only ever get added, so undo leaves them be). */
const snapshot = () => JSON.stringify({ ...S.doc, files: undefined, sharedNow: M.shared });
export const undoStack: string[] = [snapshot()];
export let undoPos = 0;

export const vp = new Viewport($("#view"));
vp.perspective = prefs.perspective;
vp.setDisplayMode(prefs.display);
export let solver: Solver;

// ---------- Loading screen ----------

/**
 * Shown from the first paint until the app can be used: the project open, the sketch solver ready
 * and the model drawn. It never holds the app back for long: past a few seconds of geometry
 * kernel loading it goes, and the status line keeps telling.
 */
const splash = document.getElementById("splash");
let splashGone = false;
export let solverReady = false;
let modelShown = false;

function splashStep(text: string, error = false) {
  if (splashGone || !splash) return;
  const el = splash.querySelector(".splash-step")!;
  el.textContent = text;
  el.classList.toggle("err", error);
  splash.classList.toggle("failed", error);
}

function hideSplash() {
  if (splashGone || !splash) return;
  splashGone = true;
  splash.classList.add("gone");
  setTimeout(() => splash.remove(), 400);
}

/** Gone once the app can be used: an empty project needs no model to be drawn first. */
function maybeHideSplash() {
  if (solverReady && (modelShown || (!S.doc.features.length && !S.doc.instances?.length))) hideSplash();
}

splash?.querySelector("button")?.addEventListener("click", hideSplash);
// Whatever happens while starting, the app is not hidden for long.
setTimeout(hideSplash, 12000);

// ---------- Worker ----------

export const worker = new Worker(new URL("./cad/worker.ts", import.meta.url), { type: "module" });
export let kernelReady = false;

registerApp({
  vp,
  doc: () => S.doc,
  lastBuild: () => S.lastBuild,
  renderAll,
  renderPanel,
  renderPartOverlays,
  nextReq: () => ++M.reqCounter,
  post: (msg) => worker.postMessage(msg),
  clearPartFocus: () => {
    S.showParams = false;
    S.pendingFaceTool = null;
    S.selectedFeature = null;
    S.selectedFace = null;
    vp.highlightFace(null);
  },
});
let latestBuild = 0;
const pendingFiles = new Map<number, (b: Blob | null, err?: string) => void>();
export const pendingRefs = new Map<number, (ref: Omit<MateRef, "part"> | null) => void>();
export const pendingClashes = new Map<number, (c: Clash[], err?: string) => void>();
export const pendingSplits = new Map<number, (parts: string[]) => void>();
export const pendingBodies = new Map<number, (bodies: { id: string; name: string }[]) => void>();
let buildTimer = 0;
/** One build at a time: while one runs, later changes wait and go as a single build after it. */
let buildRunning = false;
export let buildSlow = false;
let buildSlowTimer = 0;
let buildAgain = false;
/** Quality of the build waiting behind the running one: fine if any request wanted fine. */
let againDraft = true;

worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  const m = ev.data;
  if (m.type === "ready") {
    kernelReady = true;
    kernelMessage = "";
    if (solverReady) splashStep("Building the model…");
    renderStatus();
    rebuild(true);
  } else if (m.type === "progress") {
    kernelAlive = performance.now();
    const mb = (b: number) => (b / 1e6).toFixed(b < 1e7 ? 1 : 0);
    const amount = m.total ? `${Math.floor((m.loaded / m.total) * 100)} %` : `${mb(m.loaded)} MB`;
    kernelMessage = `Loading geometry kernel… ${amount}`;
    if (solverReady) splashStep(kernelMessage);
    renderStatus();
  } else if (m.type === "fatal") {
    kernelFailed(m.message);
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
    const first = S.lastBuild === null;
    S.lastBuild = m;
    vp.setModel(m, m.preview);
    if (!modelShown) {
      modelShown = true;
      // One frame to draw it, then the loading screen fades over the model.
      requestAnimationFrame(maybeHideSplash);
    }
    if (isOperation(S.mode)) S.mode.keypad.setNote(m.preview?.error ?? null);
    if ((first || M.fitNext) && m.mesh) {
      M.fitNext = false;
      vp.fit();
    }
    if (S.mode.kind === "sketch") vp.setModelOpacity(0.45);
    if (S.mode.kind === "shell") highlightShellFaces(S.mode.feat);
    if (S.mode.kind === "fillet") highlightFilletEdges(S.mode.feat);
    renderTimeline();
    renderPanel();
    renderPartOverlays();
    alignShift.clear();
    if (S.mode.kind === "align") showAlignPicks();
    if (S.mode.kind === "combine") showCombinePicks();
    if (explode > 0) spreadParts(explode);
    syncGizmo();
    if (thumbStale) scheduleThumb();
    if (measuring) showMeasurePicks();
    if (m.movedSketches) catchUpFaceSketches(m.movedSketches);
    catchUpProjections(m);
  } else if (m.type === "measured") {
    if (!measuring || m.reqId !== measureReq) return;
    measuring.result = m.result;
    renderPanel();
    renderPartOverlays();
  } else if (m.type === "bodies") {
    pendingBodies.get(m.reqId)?.(m.bodies);
    pendingBodies.delete(m.reqId);
  } else if (m.type === "split") {
    pendingSplits.get(m.reqId)?.(m.parts);
    pendingSplits.delete(m.reqId);
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

/** Face sketches moved by the worker to stay on their face: the document takes the new planes. */
function catchUpFaceSketches(movedList: NonNullable<BuildResult["movedSketches"]>) {
  let grid = false;
  for (const [id, mv] of Object.entries(movedList)) {
    const f = S.doc.features.find((x): x is SketchFeature => x.id === id && x.kind === "sketch");
    if (!f) continue;
    f.plane = mv.plane;
    if (f.face) f.face = { ...f.face, center: mv.center };
    if (S.mode.kind === "sketch" && S.mode.editor.sk.id === id) grid = true;
  }
  save();
  if (grid && S.mode.kind === "sketch") {
    vp.setGridPlane(S.mode.editor.sk.plane);
    vp.viewNormalTo(S.mode.editor.sk.plane);
  }
}

/** How many times projections were re-run since the last commit: a change settles in one, this stops a runaway. */
let reprojected = 0;
let saidLostEdge = false;

/** Model edges copied into sketches follow the model: each is found again by its midpoint and the copy is moved. */
function catchUpProjections(m: { edges: Float32Array; edgeGroups: EdgeGroup[] }) {
  if (isOperation(S.mode) || S.mode.kind === "sketch" || S.mode.kind === "sweep" || S.mode.kind === "loft") return;
  const sks = S.doc.features.filter((f): f is SketchFeature => f.kind === "sketch" && !!f.projections?.length);
  if (!sks.length || !m.edgeGroups.length || reprojected >= 3) return;
  const L = m.edges;
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < L.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (L[i + k] < lo[k]) lo[k] = L[i + k];
      if (L[i + k] > hi[k]) hi[k] = L[i + k];
    }
  // How far an edge may have moved and still be the same one: as findFace allows for faces.
  const limit = Math.max(1, 0.3 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
  const polyline = (g: EdgeGroup): [number, number, number][] => {
    const out: [number, number, number][] = [];
    for (let k = g.start; k < g.start + g.count; k += 2) out.push([L[k * 3], L[k * 3 + 1], L[k * 3 + 2]]);
    const e = (g.start + g.count - 1) * 3;
    out.push([L[e], L[e + 1], L[e + 2]]);
    return out;
  };
  const findChain = (mid: Vec3) => {
    let best: { g: EdgeGroup; d: number } | null = null;
    for (const g of m.edgeGroups) {
      const d = Math.hypot(g.mid[0] - mid[0], g.mid[1] - mid[1], g.mid[2] - mid[2]);
      if (!best || d < best.d) best = { g, d };
    }
    return best && best.d <= limit ? polyline(best.g) : null;
  };
  let moved = false;
  let lost = false;
  for (const sk of sks) {
    const r = updateProjections(sk, findChain);
    moved ||= r.moved;
    lost ||= r.lost;
  }
  if (lost && !saidLostEdge) {
    saidLostEdge = true;
    toast("An edge copied into a sketch is no longer in the model: its copy stays where it was");
  }
  if (!moved) return;
  // The fixes already hold the new places; solving settles whatever was drawn against them.
  if (solverReady)
    for (const sk of sks) {
      try {
        solver.solve(sk);
      } catch {
        // The copy is moved either way.
      }
    }
  reprojected++;
  save();
  rebuild();
}

/** Nothing more will come from the kernel: say so, and offer to try again (a reload). */
function kernelFailed(why: string) {
  if (kernelReady || kernelBroken) return;
  kernelBroken = true;
  kernelMessage = `Geometry kernel did not load (${why}) · tap here to try again`;
  splashStep("The geometry kernel could not load. Sketches still work; solids will not.", true);
  renderStatus();
}

// The worker itself failing to start (its script not found, out of memory…) sends no message.
worker.onerror = (e) => kernelFailed(e.message || "the worker stopped");
// A download that stops moving: the network is gone or stuck.
const kernelWatch = window.setInterval(() => {
  if (kernelReady || kernelBroken) return window.clearInterval(kernelWatch);
  if (performance.now() - kernelAlive > 30000) kernelFailed("the download stalled");
}, 5000);

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
  latestBuild = ++M.reqCounter;
  worker.postMessage({ type: "build", reqId: latestBuild, doc: S.doc, pickExclude: S.previewExclude ?? undefined, draft } satisfies WorkerRequest);
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
export function rebuild(now = false) {
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

export function exportFile(format: ExportFormat) {
  if (!kernelReady) return toast("The geometry kernel is still loading");
  const reqId = ++M.reqCounter;
  pendingFiles.set(reqId, (blob, err) => {
    if (!blob) return toast(err ? "Export failed: " + err : "Nothing to export");
    download(blob, format === "plate" ? `${fileName()}-plate.3mf` : `${fileName()}.${format}`);
  });
  worker.postMessage({ type: "export", reqId, doc: S.doc, format, name: S.project?.name ?? "Model" } satisfies WorkerRequest);
}

// ---------- Document, history, persistence ----------

let saveTimer = 0;
let thumbTimer = 0;
/** The model changed since its picture was taken. */
let thumbStale = false;

/** Saves the open project shortly after a change (changes in a row are written once). */
function save() {
  if (!S.project) return;
  thumbStale = true;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 400);
}

export async function flushSave() {
  clearTimeout(saveTimer);
  if (!saveTimer || !S.project) return;
  saveTimer = 0;
  S.project.updated = Date.now();
  try {
    await putProject({ ...S.project }, S.doc);
  } catch {
    toast("Could not save in this browser");
  }
}

/** Takes the project's picture from the view, when the model shows as a part (not a sketch). */
function captureThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = 0;
  if (!S.project || !thumbStale || S.mode.kind !== "part" || !S.lastBuild) return;
  const thumb = S.lastBuild.mesh ? vp.thumbnail(320, 220) : undefined;
  if (thumb === null) return; // no view to take it from (app in the background): later
  thumbStale = false;
  S.project.thumb = thumb;
  putProject({ ...S.project }).catch(() => {});
}
function scheduleThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(captureThumb, 1500);
}

export function resetHistory() {
  undoStack.length = 0;
  undoStack.push(snapshot());
  undoPos = 0;
}

/** Leaves sketches and operations, keeping what they did, before another project opens. */
export function leaveModes() {
  for (let i = 0; i < 20 && escape(); i++);
  S.pendingFaceTool = null;
}

/** `from`: the assembly this part is opened from (offered as the way back). */
export async function openProject(id: string, from: { id: string; name: string } | null = null) {
  await flushSave();
  captureThumb();
  const p = await getProject(id).catch(() => null);
  if (!p) return toast("This project could not be opened");
  leaveModes();
  S.project = p.meta;
  S.doc = asDocument(p.doc) ?? emptyDoc();
  const caughtUp = catchUpShared(S.doc);
  M.cameFrom = from;
  await loadParts();
  if (isAssembly()) {
    // Assemblies made before mates: the first part holds the others.
    if (S.doc.instances?.length && !S.doc.instances.some((i) => i.fixed)) S.doc.instances[0].fixed = true;
    M.solveState = null;
  }
  resetExplode();
  M.clashes = null;
  vp.setClashes(null);
  prefs.project = id;
  savePrefs();
  S.selectedFeature = null;
  S.selectedFace = null;
  S.lastBuild = null; // the first build of the project frames it
  M.hiddenBodies = new Set();
  vp.setHiddenBodies(M.hiddenBodies);
  thumbStale = !p.meta.thumb && (p.doc.features.length > 0 || !!p.doc.instances?.length);
  resetHistory();
  if (caughtUp) save();
  vp.setModel(null);
  rebuild(true);
  renderAll();
}

/** Saves `d` as a new project and opens it. */
export async function createProject(name: string, d: CadDocument = emptyDoc(), group = newGroup()) {
  const now = Date.now();
  const meta: ProjectMeta = { id: newProjectId(), name, created: now, updated: now, kind: d.kind, group };
  try {
    await putProject(meta, d);
  } catch {
    return toast("Could not save in this browser");
  }
  await openProject(meta.id);
}

export async function newProject() {
  const names = (await listProjects().catch(() => [])).map((p) => p.name);
  await createProject(freeName("Model", names));
  closeProjects();
}

/** A new assembly, and the parts to put in it right away. */
export async function newAssembly() {
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

export function commit() {
  if (M.clashes) clearClashes();
  reprojected = 0;
  saidLostEdge = false;
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
  if (isOperation(S.mode)) S.mode.keypad.close();
  undoPos = pos;
  const { sharedNow, ...was } = JSON.parse(undoStack[pos]) as CadDocument & { sharedNow?: Parameter[] };
  S.doc = { ...was, files: S.doc.files };
  if (sharedNow && JSON.stringify(sharedNow) !== JSON.stringify(M.shared)) {
    M.shared = sharedNow;
    saveShared();
  }
  save();
  if (S.mode.kind === "sketch") {
    const id = S.mode.editor.sk.id;
    const sk = S.doc.features.find((f): f is SketchFeature => f.id === id && f.kind === "sketch");
    if (sk) S.mode.editor.load(sk);
    else exitSketch();
  }
  if (S.selectedFeature && !S.doc.features.some((f) => f.id === S.selectedFeature)) S.selectedFeature = null;
  rebuild();
  renderAll();
}

export function undo() {
  if (undoPos > 0) restore(undoPos - 1);
  else toast("Nothing to undo");
}
export function redo() {
  if (undoPos < undoStack.length - 1) restore(undoPos + 1);
}

export function nextName(prefix: string) {
  let i = 1;
  while (S.doc.features.some((f) => f.name === `${prefix} ${i}`)) i++;
  return `${prefix} ${i}`;
}

// ---------- Drawing everything ----------

export function renderAll() {
  document.body.dataset.mode = S.mode.kind;
  vp.forceOrtho = S.mode.kind === "sketch";
  document.body.classList.toggle("busy", S.mode.kind !== "part");
  renderTools();
  renderPanel();
  renderTimeline();
  renderStatus();
  renderViewButtons();
  renderPartOverlays();
  renderWorkspace();
  syncGizmo();
  vp.selectBody(selectedBody());
}

/** The body selected, to mark in the view: an assembly's part, or a part's body when it has several. */
function selectedBody(): string | null {
  if (S.mode.kind === "combine") return S.mode.target;
  if (S.mode.kind !== "part" || !S.selectedFeature || M.clashes) return null;
  const bodies = S.lastBuild?.bodies ?? [];
  if (!isAssembly() && bodies.length < 2) return null;
  return bodies.some((b) => b.id === S.selectedFeature) ? S.selectedFeature : null;
}

// ---------- Boot ----------

initGallery({
  doc: () => S.doc,
  project: () => S.project,
  setProject: (p) => (S.project = p),
  cameFrom: () => M.cameFrom,
  setCameFrom: (v) => (M.cameFrom = v),
  shared: () => M.shared,
  toast,
  toggleBarMenu,
  renderWorkspace,
  openProject,
  createProject,
  newProject,
  newAssembly,
  flushSave,
  captureThumb,
  saveShared,
  commit,
  renderAll,
});

/**
 * Areas that scroll say so (touch screens hide scrollbars): faded edges, a small arrow, a nudge
 * the first time. The timeline also scrolls sideways with a mouse wheel.
 */
function setupScrollAreas() {
  // Their bottom edge cuts through a tool, a button or a line, never through a gap.
  scrollHints($("#tools"), "y", "tools", { cutItems: ".tool" });
  scrollHints($("#panel"), "y", "panel", { cutItems: "button, .p-head, .p-hint, .p-measure > div, .kp-display" });
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
  $("#status-pill").onclick = () => {
    if (kernelBroken) location.reload();
  };
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
  $("#about-version").textContent = `Version ${__APP_VERSION__}`;
  $("#about-close").onclick = () => $("#about").classList.remove("open");
  $("#about").addEventListener("pointerdown", (e) => {
    if (e.target === e.currentTarget) $("#about").classList.remove("open");
  });
  renderAll();
  splashStep("Opening your project…");
  await openInitialProject();
  // A tablet can close the app any time it is in the background: write what is pending then.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    captureThumb();
    void flushSave();
  });
  splashStep("Loading the sketch solver…");
  solver = await Solver.create(planegcsWasm);
  solverReady = true;
  // What opened before the solver was there catches up with the shared parameters now.
  if (catchUpShared(S.doc)) {
    resetHistory();
    save();
    rebuild();
  }
  if (Object.keys(partDocs).length) void loadParts().then(() => rebuild());
  splashStep(kernelReady ? "Building the model…" : "Loading the geometry kernel…");
  maybeHideSplash();
  // A slow kernel (first visit, slow tablet) does not keep the app hidden: sketching works without it.
  setTimeout(hideSplash, 5000);
  new InputRouter(vp, $("#view"), {
    is2D: () => S.mode.kind === "sketch",
    tool: () => (S.mode.kind === "sketch" ? S.mode.editor : partTool),
    onUndo: undo,
    onRedo: redo,
  });
  if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register(`./sw.js?v=${__APP_VERSION__}`);
}

void boot();
