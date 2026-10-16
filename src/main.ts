import "./style.css";
import planegcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import type { BuildResult, CadDocument, ExtrudeFeature, ExtrudeOp, Feature, PlaneDef, SketchFeature, WorkerRequest, WorkerResponse } from "./types";
import { Viewport, type LineBatch } from "./view/viewport";
import { InputRouter, type PointerTool, type Ptr } from "./view/input";
import { Solver } from "./sketch/solver";
import { SketchEditor, type SketchToolName } from "./sketch/editor";
import { SketchView, newSketch, uid } from "./sketch/model";
import { keypad } from "./ui/keypad";

const STORAGE_KEY = "touch-cad.document";
const STD_PLANES: PlaneDef[] = [
  { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1], label: "XY" },
  { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0], label: "XZ" },
  { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0], label: "YZ" },
];
const PLANE_COLORS: Record<string, string> = { XY: "#5588ee", XZ: "#55c46a", YZ: "#e05555" };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------- State ----------

type Mode = { kind: "part" } | { kind: "pickPlane" } | { kind: "sketch"; editor: SketchEditor };

let doc: CadDocument = loadDoc();
let mode: Mode = { kind: "part" };
let selectedFeature: string | null = null;
let lastBuild: BuildResult | null = null;
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
    setStatus("");
    rebuild(true);
  } else if (m.type === "fatal") {
    setStatus("Geometry kernel failed to load: " + m.message);
  } else if (m.type === "built") {
    if (m.reqId !== latestBuild) return;
    const first = lastBuild === null;
    lastBuild = m;
    vp.setModel(m);
    if (first && m.mesh) vp.fit();
    if (mode.kind === "sketch") vp.setModelOpacity(0.45);
    renderTree();
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
  renderTree();
  renderPartOverlays();
  updateHistoryButtons();
}

function restore(pos: number) {
  undoPos = pos;
  doc = JSON.parse(undoStack[pos]);
  save();
  if (mode.kind === "sketch") {
    const id = mode.editor.sk.id;
    const sk = doc.features.find((f): f is SketchFeature => f.id === id && f.kind === "sketch");
    if (sk) mode.editor.load(sk);
    else exitSketch();
  }
  rebuild();
  renderTree();
  renderPartOverlays();
  renderToolbar();
  updateHistoryButtons();
}

function undo() {
  if (undoPos > 0) restore(undoPos - 1);
  else toast("Nothing to undo");
}
function redo() {
  if (undoPos < undoStack.length - 1) restore(undoPos + 1);
}

function updateHistoryButtons() {
  $<HTMLButtonElement>("#undo").disabled = undoPos === 0;
  $<HTMLButtonElement>("#redo").disabled = undoPos >= undoStack.length - 1;
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
  vp.showPlanes(STD_PLANES.map((def) => ({ def, color: PLANE_COLORS[def.label] })));
  renderToolbar();
  renderPartOverlays();
  setStatus("Tap a plane or a flat face");
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
  const sk = newSketch(nextName("Sketch"), plane);
  doc.features.push(sk);
  commit();
  enterSketch(sk);
}

function enterSketch(sk: SketchFeature) {
  if (mode.kind === "sketch") mode.editor.dispose();
  vp.showPlanes(null);
  const editor = new SketchEditor(vp, solver, sk, {
    commit,
    changed: () => {
      renderContext();
      renderSketchStatus();
    },
    toast,
  });
  mode = { kind: "sketch", editor };
  selectedFeature = sk.id;
  vp.setGridPlane(sk.plane);
  vp.viewNormalTo(sk.plane);
  vp.setModelOpacity(0.45);
  renderToolbar();
  renderTree();
  renderPartOverlays();
  renderSketchStatus();
}

function exitSketch() {
  if (mode.kind !== "sketch") return;
  const sk = mode.editor.sk;
  mode.editor.dispose();
  mode = { kind: "part" };
  vp.setGridPlane(null);
  vp.setModelOpacity(1);
  setStatus("");
  commit();
  renderToolbar();
  renderTree();
  renderPartOverlays();
  const used = doc.features.some((f) => f.kind === "extrude" && f.sketchId === sk.id);
  if (!used && new SketchView(sk).curves().some((c) => !c.construction && !("axis" in c && c.axis)))
    toast("Tip: tap Extrude to turn this sketch into a solid");
}

function escape(): boolean {
  if (mode.kind === "sketch") {
    if (mode.editor.escape()) {
      renderToolbar();
      return true;
    }
    exitSketch();
    return true;
  }
  if (mode.kind === "pickPlane") {
    mode = { kind: "part" };
    vp.showPlanes(null);
    vp.highlightFace(null);
    setStatus("");
    renderToolbar();
    return true;
  }
  if (selectedFeature) {
    selectedFeature = null;
    renderTree();
    renderPartOverlays();
    return true;
  }
  return false;
}

// ---------- Extrude ----------

async function extrude(existing?: ExtrudeFeature) {
  let f = existing;
  if (!f) {
    const sk = pickSketchForExtrude();
    if (!sk) return toast("Draw a closed sketch first");
    if (mode.kind === "sketch") exitSketch();
    const hasSolid = doc.features.some((x) => x.kind === "extrude");
    f = { id: uid(), kind: "extrude", name: nextName("Extrude"), sketchId: sk.id, distance: 10, symmetric: false, op: "add" };
    if (hasSolid && sk.plane.label === "Face") f.distance = 5;
    doc.features.push(f);
  }
  const feat = f;
  const onFace = doc.features.some((x) => x.id === feat.sketchId && x.kind === "sketch" && x.plane.label === "Face");
  const before = { distance: feat.distance, symmetric: feat.symmetric, op: feat.op };
  selectedFeature = feat.id;
  renderTree();
  rebuild(true);
  const opBtn = (op: ExtrudeOp, label: string) => ({
    label,
    active: () => feat.op === op,
    toggle: () => {
      // A face normal points out of the solid: cutting goes the other way by default.
      if (onFace && (op === "cut") !== (feat.op === "cut")) feat.distance = -feat.distance;
      feat.op = op;
      rebuild();
    },
  });
  const value = await keypad({
    title: feat.name,
    value: Math.abs(feat.distance),
    extras: [
      opBtn("add", "Add"),
      opBtn("cut", "Cut"),
      opBtn("intersect", "Intersect"),
      {
        label: "⇅ Flip",
        active: () => feat.distance < 0,
        toggle: () => {
          feat.distance = -feat.distance;
          rebuild();
        },
      },
      {
        label: "Symmetric",
        active: () => feat.symmetric,
        toggle: () => {
          feat.symmetric = !feat.symmetric;
          rebuild();
        },
      },
    ],
    onInput: (v) => {
      if (v > 0) {
        feat.distance = Math.sign(feat.distance || 1) * v;
        rebuild();
      }
    },
  });
  if (value === null || value <= 0) {
    if (existing) Object.assign(feat, before);
    else doc.features = doc.features.filter((x) => x !== feat);
    rebuild(true);
    renderTree();
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

// ---------- Feature tree ----------

function renderTree() {
  const list = $("#tree-list");
  list.replaceChildren();
  if (!doc.features.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No features yet. Start with a sketch.";
    list.appendChild(empty);
  }
  for (const f of doc.features) {
    const row = document.createElement("div");
    row.className = "feature";
    if (f.id === selectedFeature) row.classList.add("sel");
    const err = lastBuild?.errors[f.id];
    if (err) row.classList.add("error");
    const icon = f.kind === "sketch" ? "✎" : f.op === "cut" ? "⬇" : f.op === "intersect" ? "⋂" : "⬆";
    const detail = f.kind === "sketch" ? f.plane.label : `${fmtNum(f.distance)} mm${f.symmetric ? " ⇹" : ""}`;
    row.innerHTML = `<span class="ico"></span><span class="name"></span><span class="detail"></span>`;
    row.querySelector(".ico")!.textContent = icon;
    row.querySelector(".name")!.textContent = f.name;
    row.querySelector(".detail")!.textContent = err ? "⚠ " + err : detail;
    row.onclick = () => {
      selectedFeature = selectedFeature === f.id ? null : f.id;
      renderTree();
      renderPartOverlays();
    };
    if (f.id === selectedFeature && mode.kind !== "sketch") {
      const acts = document.createElement("div");
      acts.className = "feature-actions";
      const btn = (label: string, run: () => void, cls = "") => {
        const b = document.createElement("button");
        b.textContent = label;
        b.className = cls;
        b.onclick = (e) => {
          e.stopPropagation();
          run();
        };
        acts.appendChild(b);
      };
      if (f.kind === "sketch") {
        btn("Edit", () => {
          closeDrawer();
          enterSketch(f);
        });
        btn("Extrude", () => {
          closeDrawer();
          void extrude();
        });
      } else
        btn("Edit", () => {
          closeDrawer();
          void extrude(f);
        });
      btn("Rename", () => renameFeature(f));
      btn("Delete", () => deleteFeature(f), "danger");
      row.appendChild(acts);
    }
    list.appendChild(row);
  }
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

function closeDrawer() {
  document.body.classList.remove("drawer-open");
}

// ---------- Part mode overlays: visible sketches ----------

function renderPartOverlays() {
  if (mode.kind === "sketch") return;
  const used = new Set(doc.features.flatMap((f) => (f.kind === "extrude" ? [f.sketchId] : [])));
  const sel = doc.features.find((f) => f.id === selectedFeature);
  const highlight = sel?.kind === "sketch" ? sel.id : sel?.kind === "extrude" ? sel.sketchId : null;
  const batch: LineBatch = { positions: [], colors: [], width: 2, overlay: true };
  for (const f of doc.features) {
    if (f.kind !== "sketch") continue;
    if (used.has(f.id) && f.id !== highlight) continue;
    const col = f.id === highlight ? [0.3, 0.76, 1] : [0.75, 0.8, 0.86];
    appendSketchLines(batch, f, col);
  }
  vp.setSketchLayer([batch], []);
  vp.setLabels([]);
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

// ---------- Toolbars ----------

const SKETCH_TOOLS: { tool: SketchToolName; label: string; title: string; key: string }[] = [
  { tool: "select", label: "↖", title: "Select / move", key: "Esc" },
  { tool: "line", label: "╱", title: "Line", key: "L" },
  { tool: "rect", label: "▭", title: "Rect", key: "R" },
  { tool: "circle", label: "◯", title: "Circle", key: "C" },
  { tool: "arc", label: "◠", title: "Arc (centre, start, end)", key: "A" },
  { tool: "point", label: "•", title: "Point", key: "P" },
];

function toolButton(label: string, title: string, run: () => void, opts: { active?: boolean; cls?: string; key?: string } = {}) {
  const b = document.createElement("button");
  b.innerHTML = `<span class="glyph"></span><span class="cap"></span>`;
  b.querySelector(".glyph")!.textContent = label;
  b.querySelector(".cap")!.textContent = title;
  b.title = opts.key ? `${title} (${opts.key})` : title;
  if (opts.active) b.classList.add("active");
  if (opts.cls) b.classList.add(opts.cls);
  b.onclick = run;
  return b;
}

function renderToolbar() {
  const bar = $("#toolbar");
  bar.replaceChildren();
  document.body.dataset.mode = mode.kind;
  if (mode.kind === "sketch") {
    const ed = mode.editor;
    for (const t of SKETCH_TOOLS) {
      bar.appendChild(
        toolButton(t.label, t.title.split(" ")[0], () => {
          ed.setTool(t.tool);
          renderToolbar();
        }, { active: ed.tool === t.tool, key: t.key }),
      );
    }
    bar.appendChild(
      toolButton("┄", "Constr.", () => {
        ed.construction = !ed.construction;
        renderToolbar();
      }, { active: ed.construction, key: "G" }),
    );
  } else if (mode.kind === "pickPlane") {
    for (const p of STD_PLANES) bar.appendChild(toolButton("▱", p.label, () => createSketchOn(p)));
    bar.appendChild(toolButton("✕", "Cancel", () => escape()));
  } else {
    bar.appendChild(toolButton("☰", "Features", () => document.body.classList.toggle("drawer-open")));
    bar.appendChild(toolButton("✎", "Sketch", startNewSketch, { key: "S" }));
    bar.appendChild(toolButton("⬆", "Extrude", () => void extrude(), { key: "E" }));
    bar.appendChild(toolButton("⤢", "Fit", () => vp.fit(), { key: "F" }));
    bar.appendChild(toolButton("◰", "View", cycleView, { key: "V" }));
  }
  renderContext();
}

let viewIdx = 0;
const VIEWS = ["iso", "top", "front", "right"] as const;
function cycleView() {
  viewIdx = (viewIdx + 1) % VIEWS.length;
  vp.setStandardView(VIEWS[viewIdx]);
  toast(VIEWS[viewIdx][0].toUpperCase() + VIEWS[viewIdx].slice(1) + " view");
}

/** Constraint buttons for the current sketch selection. */
function renderContext() {
  const bar = $("#context");
  bar.replaceChildren();
  if (mode.kind !== "sketch") return;
  const ed = mode.editor;
  for (const a of ed.actions()) {
    const b = toolButton(a.label, a.title, () => {
      a.run();
      renderContext();
    }, { key: a.key, cls: a.id === "del" ? "danger" : "" });
    bar.appendChild(b);
  }
  if (ed.tool === "line") bar.appendChild(toolButton("⏎", "End line", () => (ed.escape(), renderContext()), { key: "Enter" }));
}

function renderSketchStatus() {
  if (mode.kind !== "sketch") return;
  const ed = mode.editor;
  const dof = ed.dof;
  setStatus(`${ed.sk.name} · ${dof === 0 ? "fully constrained" : dof < 0 ? "over-constrained" : dof + " DOF free"}`);
}

// ---------- Part-mode pointer tool: pick faces / features ----------

const partTool: PointerTool = {
  down() {},
  move() {},
  up(p) {
    if (mode.kind === "pickPlane") return pickPlaneAt(p);
    const face = vp.pickFace(p.x, p.y);
    vp.highlightFace(face);
    if (face != null) {
      const plane = lastBuild?.planarFaces.find((f) => f.faceId === face)?.plane;
      showFaceMenu(plane ?? null, face);
    } else hideFaceMenu();
  },
  cancel() {},
  hover(p) {
    if (mode.kind !== "pickPlane" || !p) return;
    vp.highlightFace(vp.pickFace(p.x, p.y));
  },
};

function showFaceMenu(plane: PlaneDef | null, _face: number) {
  const bar = $("#context");
  bar.replaceChildren();
  if (plane) bar.appendChild(toolButton("✎", "Sketch on face", () => {
    hideFaceMenu();
    createSketchOn(plane);
  }));
  bar.appendChild(toolButton("⤢", "Look at", () => plane && vp.viewNormalTo(plane)));
  bar.appendChild(toolButton("✕", "Close", hideFaceMenu));
}

function hideFaceMenu() {
  vp.highlightFace(null);
  $("#context").replaceChildren();
}

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

function setupMenu() {
  const menu = $("#menu-panel");
  const items: [string, () => void][] = [
    ["New document", newDocument],
    ["Open…", openFile],
    ["Save (.json)", () => download(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }), "model.tcad.json")],
    ["Export STEP", () => exportFile("step")],
    ["Export STL", () => exportFile("stl")],
    ["Help", showHelp],
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
  $("#menu").onclick = (e) => {
    e.stopPropagation();
    menu.classList.toggle("open");
  };
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target as Node) && e.target !== $("#menu")) menu.classList.remove("open");
  });
}

function showHelp() {
  $("#help").classList.add("open");
}

// ---------- Status and toasts ----------

function setStatus(s: string) {
  $("#status").textContent = s;
}

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
  if (k === "Escape") {
    escape();
    renderToolbar();
    return;
  }
  if (mode.kind === "sketch") {
    const ed = mode.editor;
    if (k === "Enter") {
      if (!ed.escape()) exitSketch();
      renderToolbar();
      return;
    }
    if (k === "Delete" || k === "Backspace") return ed.deleteSelection();
    if (ed.selection.size && ed.runShortcut(k)) return renderContext();
    const t = SKETCH_TOOLS.find((x) => x.key.toLowerCase() === k.toLowerCase());
    if (t) {
      ed.setTool(t.tool);
      renderToolbar();
    } else if (k.toLowerCase() === "g") {
      ed.construction = !ed.construction;
      renderToolbar();
    }
    return;
  }
  if (mode.kind === "part") {
    const key = k.toLowerCase();
    if (key === "s") startNewSketch();
    else if (key === "e") void extrude();
    else if (key === "f") vp.fit();
    else if (key === "v") cycleView();
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
  if (escape()) {
    renderToolbar();
    history.pushState({ guard: true }, "");
  }
});

// ---------- Boot ----------

async function boot() {
  setupMenu();
  $("#undo").onclick = undo;
  $("#done").onclick = exitSketch;
  $("#redo").onclick = redo;
  $("#drawer-close").onclick = closeDrawer;
  $("#help-close").onclick = () => $("#help").classList.remove("open");
  setStatus("Loading geometry kernel…");
  solver = await Solver.create(planegcsWasm);
  new InputRouter(vp, $("#view"), {
    is2D: () => mode.kind === "sketch",
    tool: () => (mode.kind === "sketch" ? mode.editor : partTool),
    onUndo: undo,
    onRedo: redo,
  });
  renderToolbar();
  renderTree();
  renderPartOverlays();
  updateHistoryButtons();
  if (!kernelReady) setStatus("Loading geometry kernel…");
  if (!doc.features.length) showHelp();
  if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("./sw.js");
}

void boot();
