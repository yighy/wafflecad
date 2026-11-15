// The file bar (Projects, New, Save, Import, Export), its pop-up menus, and choosing a project or an assembly.
import { M, createProject, exportFile, flushSave, newAssembly, newProject, openProject } from "../main";
import { enterSketch, escape, exitSketch, startNewSketch } from "./modes";
import { instanceOf, isAssembly, partDocs, pickPart } from "./assemblies";
import { importDrawing, importStep, importStl } from "./files";
import { closeProjects, groupOf, openFile, saveFile, saveOpenTab, showProjects, tabName, tabsOf } from "./gallery";
import { endMeasure, measuring } from "./measure";
import { S, isOperation, usedSketchIds } from "./state";
import { ago, byName, emptyDoc, $ } from "./util";
import { freeName, getProject, listProjects, type ProjectMeta } from "../projects";
import { type ExportFormat, type SketchFeature } from "../types";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

export type Workspace = "sketch" | "part" | "assembly";
export const WORKSPACES: [Workspace, string, string][] = [
  ["sketch", "Sketch", "sketch"],
  ["part", "Part", "extrude"],
  ["assembly", "Assembly", "assembly"],
];

export function currentWorkspace(): Workspace {
  return S.mode.kind === "sketch" || S.mode.kind === "pickPlane" ? "sketch" : isAssembly() ? "assembly" : "part";
}

/** The top bar: the file actions, as icons (their names as tips). */
export const EXPORTS: [ExportFormat, string][] = [
  ["step", "STEP"],
  ["stl", "STL"],
  ["3mf", "3MF"],
  ["plate", "3MF plate"],
];

export function renderWorkspace() {
  const el = $("#workspace");
  el.replaceChildren();
  el.setAttribute("aria-label", "File");
  // In the middle of a step, finish it first.
  const busy = isOperation(S.mode) || S.mode.kind === "mate" || S.mode.kind === "align" || S.mode.kind === "combine" || S.mode.kind === "sweep" || S.mode.kind === "loft";
  const items: [string, string, (() => void) | [string, () => void][]][] = [
    ["folder", "Projects", () => void showProjects()],
    [
      "plus",
      "New",
      [
        ["Project", () => void newProject()],
        ["Assembly", () => void newAssembly()],
      ],
    ],
    [
      "save",
      "Save",
      [
        ...(S.project ? [["This project and the ones it uses", () => void saveFile()] as [string, () => void]] : []),
        [`The whole tab "${tabName(S.project ? groupOf(S.project) : "")}"`, () => void saveOpenTab()],
      ],
    ],
    [
      "import",
      "Import",
      [
        ["STEP", () => void importStep()],
        ["STL mesh", () => void importStl()],
        // A drawing goes into the sketch open.
        ...(S.mode.kind === "sketch" ? [["DXF / SVG", () => void importDrawing()] as [string, () => void]] : []),
        ["WaffleCAD file (.json)", openFile],
      ],
    ],
    ["export", "Export", EXPORTS.map(([f, label]): [string, () => void] => [label, () => exportFile(f)])],
  ];
  for (const [ic, label, act] of items) {
    const b = document.createElement("button");
    // A button with choices gets a small corner mark, as the Select tool does: all stay one size.
    b.className = "ws-btn" + (typeof act === "function" ? "" : " has-list");
    b.innerHTML = icon(ic, 20) + "<span></span>";
    b.querySelector("span")!.textContent = label;
    b.title = typeof act === "function" ? label : `${label}…`;
    b.setAttribute("aria-label", label);
    b.disabled = busy;
    b.onclick = () => (typeof act === "function" ? act() : toggleBarMenu(b, act));
    el.appendChild(b);
  }
}

export let barMenuFor: HTMLElement | null = null;

/** A small list of choices under a button (New, Export, a parameter's ⋯). A third `true`: it destroys. */
export function toggleBarMenu(anchor: HTMLElement, choices: [string, () => void, boolean?][]) {
  const open = document.getElementById("bar-menu");
  open?.remove();
  if (open && barMenuFor === anchor) return void (barMenuFor = null);
  barMenuFor = anchor;
  const m = document.createElement("div");
  m.id = "bar-menu";
  for (const [label, run, danger] of choices) {
    const c = document.createElement("button");
    c.textContent = label;
    if (danger) c.classList.add("danger");
    c.onclick = () => {
      m.remove();
      run();
    };
    m.appendChild(c);
  }
  const r = anchor.getBoundingClientRect();
  m.style.left = `${r.left}px`;
  m.style.top = `${r.bottom + 8}px`;
  document.body.appendChild(m);
  // Kept on screen: right-aligned near the right edge, above the button near the bottom.
  const b = m.getBoundingClientRect();
  if (b.right > innerWidth - 8) m.style.left = `${Math.max(8, r.right - b.width)}px`;
  if (b.bottom > innerHeight - 8) m.style.top = `${Math.max(8, r.top - 8 - b.height)}px`;
  const away = (e: PointerEvent) => {
    if (m.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
    m.remove();
    document.removeEventListener("pointerdown", away, true);
  };
  document.addEventListener("pointerdown", away, true);
}

/** Sketch · Part · Assembly (set aside while the file bar is tried). */
export function renderWorkspaceTabs() {
  const el = $("#workspace");
  el.replaceChildren();
  const cur = currentWorkspace();
  // In the middle of a step (keypad open, choosing a mate…), finish it first.
  const busy = isOperation(S.mode) || S.mode.kind === "mate" || S.mode.kind === "align" || S.mode.kind === "combine" || S.mode.kind === "sweep" || S.mode.kind === "loft";
  const tips: Record<Workspace, string> = {
    sketch: isAssembly() ? "Open a part in its last sketch" : "Edit the selected sketch, or start one",
    part: S.mode.kind === "sketch" ? "Finish the sketch" : isAssembly() ? "Open a part of this assembly" : "The part",
    assembly: M.cameFrom ? `Back to ${M.cameFrom.name}` : isAssembly() ? "The assembly" : "Assemblies using this part",
  };
  for (const [w, label, ic] of WORKSPACES) {
    const b = document.createElement("button");
    b.className = "ws-btn" + (w === cur ? " on" : "");
    b.innerHTML = icon(ic, 18) + "<span></span>";
    b.querySelector("span")!.textContent = label;
    b.title = tips[w];
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(w === cur));
    b.disabled = busy && w !== cur;
    b.onclick = () => void goWorkspace(w);
    el.appendChild(b);
  }
}

export async function goWorkspace(w: Workspace) {
  if (w === currentWorkspace()) return;
  if (measuring) endMeasure();
  if (w === "sketch") {
    if (isAssembly()) return openPartOfAssembly(true);
    // The selected sketch (or the one an extrusion or revolution uses), else a new one.
    const sel = S.doc.features.find((f) => f.id === S.selectedFeature);
    const id = sel?.kind === "sketch" ? sel.id : sel ? (usedSketchIds(sel)[0] ?? null) : null;
    const sk = S.doc.features.find((f): f is SketchFeature => f.id === id && f.kind === "sketch");
    return sk ? enterSketch(sk) : startNewSketch();
  }
  if (S.mode.kind === "sketch") exitSketch();
  else if (S.mode.kind === "pickPlane") escape();
  if (w === "part") return isAssembly() ? openPartOfAssembly(false) : undefined;
  if (M.cameFrom) {
    // The assembly may have been deleted since.
    if (await getProject(M.cameFrom.id).catch(() => null)) return openProject(M.cameFrom.id);
    M.cameFrom = null;
  }
  return chooseAssembly();
}

/** From an assembly: the selected part's project, or one picked from those it uses. */
export async function openPartOfAssembly(sketch: boolean) {
  const go = async (id: string) => {
    if (!S.project) return;
    await openProject(id, { id: S.project.id, name: S.project.name });
    if (!sketch) return;
    const last = [...S.doc.features].reverse().find((f): f is SketchFeature => f.kind === "sketch");
    if (last) enterSketch(last);
    else startNewSketch();
  };
  const inst = instanceOf(S.selectedFeature);
  if (inst) return partDocs[inst.project] ? go(inst.project) : toast(`${inst.name} is neither in your projects nor in this file`);
  const ids = [...new Set((S.doc.instances ?? []).map((i) => i.project))].filter((id) => partDocs[id]);
  if (!ids.length) return toast("Insert a part first");
  if (ids.length === 1) return go(ids[0]);
  const metas = (await listProjects().catch(() => [])).filter((p) => ids.includes(p.id));
  chooseProject(sketch ? "Sketch in which part?" : "Open which part?", metas, (p) => void go(p.id), { tab: groupOf(S.project!) });
}

/** From a part: the assemblies that use it, or a new one with it. */
export async function chooseAssembly() {
  if (!S.project) return;
  const here = S.project;
  await flushSave();
  const all = await listProjects().catch(() => []);
  const using: ProjectMeta[] = [];
  for (const m of all.filter((p) => p.kind === "assembly")) {
    const got = await getProject(m.id).catch(() => null);
    if (got?.doc.instances?.some((i) => i.project === here.id)) using.push(m);
  }
  chooseProject(using.length ? `Assemblies using ${here.name}` : `No assembly uses ${here.name} yet`, using, (p) => void openProject(p.id), {
    tab: groupOf(here),
    extra: [
      "plus",
      "New assembly with this part",
      async () => {
        const names = all.map((p) => p.name);
        const got = await getProject(here.id).catch(() => null);
        await createProject(freeName("Assembly", names), { ...emptyDoc(), kind: "assembly", instances: [] });
        if (!got) return;
        // The part goes in at once (asking first, if it has several bodies).
        const el = chooseProject(`Insert ${here.name}`, [], () => {});
        void pickPart(el, got.meta);
      },
    ],
  });
}

export interface ChooseOptions {
  /** An action below the list: icon, label, what it does. */
  extra?: [string, string, () => void];
  /** The tab shown first (a project's tab, "" for My projects), when it holds some of the list. */
  tab?: string;
  /** The picker stays open when one is chosen (`go` then replaces its content or closes it). */
  keepOpen?: boolean;
}

/**
 * Projects in the gallery's look, to choose one. When they lie in several tabs, the tabs are
 * shown above them (with a search field once there are many), as in Projects.
 */
export function chooseProject(title: string, list: ProjectMeta[], go: (p: ProjectMeta, el: HTMLElement) => void, opts: ChooseOptions = {}) {
  list = byName(list);
  closeProjects();
  const el = document.createElement("div");
  el.id = "projects";
  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) closeProjects();
  });
  el.innerHTML = `<div class="projects-card"><header><h2></h2><button class="projects-close" aria-label="Close">${icon("close", 22)}</button></header>
    <div class="projects-tabs"></div><div class="projects-grid"></div><div class="p-actions"></div></div>`;
  el.querySelector("h2")!.textContent = title;
  el.querySelector<HTMLElement>(".projects-close")!.onclick = closeProjects;
  const grid = el.querySelector(".projects-grid")!;
  const row = el.querySelector<HTMLElement>(".projects-tabs")!;
  const tabs = tabsOf(list);
  // Tabs only when the list spans two of them; it then opens on the given tab, else All.
  let tab = tabs.length > 2 && tabs.some((t) => t.id === opts.tab) ? opts.tab! : "all";
  let query = "";
  const cards: [ProjectMeta, HTMLElement][] = [];
  const show = () => {
    const q = query.toLowerCase();
    let shown = 0;
    for (const [p, card] of cards) {
      const hit = (tab === "all" || groupOf(p) === tab) && p.name.toLowerCase().includes(q);
      card.classList.toggle("off", !hit);
      if (hit) shown++;
    }
    grid.querySelector(".projects-empty")?.remove();
    if (!shown && list.length) {
      const e = document.createElement("p");
      e.className = "projects-empty";
      e.textContent = q ? `Nothing named "${query}" here` : "Nothing in this tab";
      grid.appendChild(e);
    }
    for (const b of row.querySelectorAll<HTMLElement>("button")) b.classList.toggle("on", b.dataset.tab === tab);
  };
  if (list.length >= 6) {
    const search = document.createElement("input");
    search.type = "search";
    search.className = "projects-search";
    search.placeholder = "Search";
    search.setAttribute("aria-label", "Search");
    search.oninput = () => {
      query = search.value.trim();
      show();
    };
    row.appendChild(search);
  }
  if (tabs.length > 2) {
    for (const t of tabs) {
      const b = document.createElement("button");
      b.dataset.tab = t.id;
      b.innerHTML = `<span></span><small>${t.count}</small>`;
      b.querySelector("span")!.textContent = t.name;
      b.onclick = () => {
        tab = t.id;
        show();
      };
      row.appendChild(b);
    }
  }
  if (!row.childElementCount) row.remove();
  for (const p of list) {
    const card = document.createElement("div");
    cards.push([p, card]);
    card.className = "project-card";
    card.innerHTML = `<button class="project-thumb"></button><div class="project-row"><div class="project-info"><div class="project-name"></div><div class="project-date"></div></div></div>`;
    const thumb = card.querySelector<HTMLElement>(".project-thumb")!;
    if (p.thumb) {
      const img = document.createElement("img");
      img.src = p.thumb;
      img.alt = "";
      thumb.appendChild(img);
    } else thumb.innerHTML = icon(p.kind === "assembly" ? "assembly" : "part", 40);
    card.querySelector(".project-name")!.textContent = p.name;
    card.querySelector(".project-date")!.textContent = ago(p.updated);
    card.dataset.name = p.name;
    const pick = () => {
      if (!opts.keepOpen) closeProjects();
      go(p, el);
    };
    thumb.onclick = pick;
    card.querySelector<HTMLElement>(".project-info")!.onclick = pick;
    grid.appendChild(card);
  }
  const extra = opts.extra;
  if (extra) {
    const b = document.createElement("button");
    b.className = "primary";
    b.innerHTML = icon(extra[0], 20) + "<span></span>";
    b.querySelector("span")!.textContent = extra[1];
    b.onclick = () => {
      closeProjects();
      extra[2]();
    };
    el.querySelector(".p-actions")!.appendChild(b);
  }
  show();
  document.body.appendChild(el);
  return el;
}
