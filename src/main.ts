import "./style.css";
import * as THREE from "three";
import planegcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import type { BuildResult, CadDocument, ExtrudeFeature, ExtrudeOp, Feature, PlaneDef, SketchFeature, WorkerRequest, WorkerResponse } from "./types";
import { Viewport, cssVar, type LineBatch } from "./view/viewport";
import { InputRouter, type PointerTool, type Ptr } from "./view/input";
import { Solver } from "./sketch/solver";
import { SketchEditor, type Action, type SketchToolName } from "./sketch/editor";
import { SketchView, newSketch, uid } from "./sketch/model";
import { openKeypad, setKeypadHost, type KeypadHandle } from "./ui/keypad";
import { icon } from "./ui/icons";
import { createAxisGizmo } from "./ui/axisGizmo";
import { ExtrudeHandle } from "./ui/extrudeHandle";
import { findRegions } from "./sketch/profiles";

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
}
const prefs: Prefs = { theme: "light", collapsed: false, panelPos: null };
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
  | { kind: "extrude"; feat: ExtrudeFeature; keypad: KeypadHandle };

let doc: CadDocument = loadDoc();
let mode: Mode = { kind: "part" };
let selectedFeature: string | null = null;
let selectedFace: { faceId: number; plane: PlaneDef | null } | null = null;
let lastBuild: BuildResult | null = null;
let kernelMessage = "Loading geometry kernel…";
const undoStack: string[] = [JSON.stringify(doc)];
let undoPos = 0;

const vp = new Viewport($("#view"));
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
    vp.setModel(m);
    if (first && m.mesh) vp.fit();
    if (mode.kind === "sketch") vp.setModelOpacity(0.45);
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
    worker.postMessage({ type: "build", reqId: latestBuild, doc } satisfies WorkerRequest);
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
  if (mode.kind === "extrude") mode.keypad.close();
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
  if (mode.kind === "extrude") {
    mode.keypad.close();
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
  if (mode.kind === "extrude") return;
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
  const before = { distance: feat.distance, symmetric: feat.symmetric, op: feat.op };
  selectedFeature = feat.id;
  selectedFace = null;
  vp.highlightFace(null);

  let handle: ExtrudeHandle | null = null;
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
  handle = new ExtrudeHandle(vp, sk, () => feat.distance, (d) => setDistance(d));
  renderAll();
  rebuild(true);

  const value = await kp.result;
  handle.dispose();
  mode = { kind: "part" };
  if (value === null || value <= 0) {
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
  commit();
}

/** The selected sketch, or the last sketch not yet used by a feature. */
function pickSketchForExtrude(): SketchFeature | null {
  if (mode.kind === "sketch") return mode.editor.sk;
  const sel = doc.features.find((f) => f.id === selectedFeature);
  if (sel?.kind === "sketch") return sel;
  const used = new Set(doc.features.flatMap((f) => (f.kind === "extrude" ? [f.sketchId] : [])));
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

function renderAll() {
  document.body.dataset.mode = mode.kind;
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
  { tool: "point", icon: "point", label: "Point", key: "P" },
];

function toolRow(ic: string, label: string, run: () => void, opts: { active?: boolean; on?: boolean; key?: string } = {}) {
  const b = document.createElement("button");
  b.className = "tool";
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
    for (const t of SKETCH_TOOLS)
      el.appendChild(
        toolRow(t.icon, t.label, () => {
          ed.setTool(t.tool);
          renderAll();
        }, { active: ed.tool === t.tool, key: t.key }),
      );
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
    el.appendChild(section("Features"));
    el.appendChild(toolRow("extrude", "Extrude", () => void extrude(), { active: mode.kind === "extrude", key: "E" }));
  }
}

/** Right panel: what can be done with the current selection. */
function renderPanel() {
  const el = $("#panel-content");
  el.replaceChildren();
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
          : "Tap or drag to draw. Points snap to existing geometry.";
      el.appendChild(hint);
    }
    actions([["check", "Finish sketch", exitSketch, "primary"]]);
    return;
  }
  if (mode.kind !== "part") return;

  if (selectedFace) {
    const plane = selectedFace.plane;
    head("Face", plane ? "Flat face" : "Curved face", false, true);
    const items: [string, string, () => void, string?][] = [];
    if (plane) items.push(["sketch", "Sketch on this face", () => createSketchOn(plane)]);
    if (plane) items.push(["lookAt", "Look at", () => vp.viewNormalTo(plane)]);
    actions(items);
    return;
  }
  const f = doc.features.find((x) => x.id === selectedFeature);
  if (f) {
    const err = lastBuild?.errors[f.id];
    head(f.name, err ?? featureDetail(f), !!err, true);
    const items: [string, string, () => void, string?][] = [];
    if (f.kind === "sketch") {
      items.push(["edit", "Edit sketch", () => enterSketch(f)]);
      items.push(["extrude", "Extrude", () => void extrude()]);
    } else items.push(["edit", "Edit", () => void extrude(f)]);
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
  const op = f.op === "add" ? "Join" : f.op === "cut" ? "Cut" : "Intersect";
  return `${op} · ${fmtNum(Math.abs(f.distance))} mm${f.symmetric ? " · symmetric" : ""}`;
}

function featureIcon(f: Feature) {
  if (f.kind === "sketch") return "rect";
  return f.op === "cut" ? "cut" : f.op === "intersect" ? "intersect" : "extrude";
}

function renderTimeline() {
  const el = $("#chips");
  el.replaceChildren();
  if (!doc.features.length) {
    const e = document.createElement("span");
    e.className = "empty";
    e.textContent = "Your feature history appears here. Start with New sketch.";
    el.appendChild(e);
  }
  const current = mode.kind === "sketch" ? mode.editor.sk.id : mode.kind === "extrude" ? mode.feat.id : selectedFeature;
  doc.features.forEach((f, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "chip-sep";
      sep.innerHTML = icon("chevron", 16);
      el.appendChild(sep);
    }
    const b = document.createElement("button");
    b.className = "chip";
    if (f.id === current) b.classList.add("sel");
    if (lastBuild?.errors[f.id]) b.classList.add("error");
    b.innerHTML = icon(featureIcon(f), 20) + "<span></span>";
    b.querySelector("span")!.textContent = f.kind === "extrude" ? `${f.name} · ${fmtNum(Math.abs(f.distance))}` : f.name;
    b.onclick = () => {
      if (mode.kind !== "part") return toast("Finish the current step first");
      selectedFace = null;
      vp.highlightFace(null);
      selectedFeature = selectedFeature === f.id ? null : f.id;
      renderAll();
    };
    el.appendChild(b);
    if (f.id === current) requestAnimationFrame(() => b.scrollIntoView({ inline: "nearest", block: "nearest" }));
  });
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
  add("iso", "Isometric view", () => vp.setStandardView("iso"));
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
  const used = new Set(doc.features.flatMap((f) => (f.kind === "extrude" ? [f.sketchId] : [])));
  const sel = doc.features.find((f) => f.id === selectedFeature);
  const highlight = sel?.kind === "sketch" ? sel.id : sel?.kind === "extrude" ? sel.sketchId : null;
  const batch: LineBatch = { positions: [], colors: [], width: 2, overlay: true };
  const hi = rgb("--sk-selected");
  const normal = rgb("--sk-line");
  for (const f of doc.features) {
    if (f.kind !== "sketch") continue;
    if (used.has(f.id) && f.id !== highlight) continue;
    appendSketchLines(batch, f, f.id === highlight ? hi : normal);
  }
  vp.setSketchLayer([batch], []);
  vp.setLabels([]);
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
    else arc(v.xy(c.c), v.arcRadius(c), ...v.arcAngles(c));
  }
}

// ---------- Part-mode pointer tool: pick planes and faces ----------

const partTool: PointerTool = {
  down() {},
  move() {},
  up(p) {
    if (mode.kind === "pickPlane") return pickPlaneAt(p);
    if (mode.kind !== "part") return;
    const face = vp.pickFace(p.x, p.y);
    vp.highlightFace(face);
    selectedFeature = null;
    selectedFace = face == null ? null : { faceId: face, plane: lastBuild?.planarFaces.find((f) => f.faceId === face)?.plane ?? null };
    renderAll();
  },
  cancel() {},
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
