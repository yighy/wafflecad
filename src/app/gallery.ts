// The Projects side of the app: the gallery and its tabs, and project files (save, open,
// bundle). It owns the tabs (localStorage) and talks to the rest of the app through `ctx`,
// given once at boot: the open document and project, and the few calls back into the app.
import type { BundledProject, CadDocument, Parameter } from "../types";
import { deleteProject, freeName, getProject, listProjects, newProjectId, putProject, type ProjectMeta } from "../projects";
import { sharedUsed } from "../params";
import { icon } from "../ui/icons";
import { uid } from "../sketch/model";
import { ago, asDocument, byName, download, emptyDoc, keepName } from "./util";

export interface GalleryCtx {
  doc(): CadDocument;
  project(): ProjectMeta | null;
  setProject(p: ProjectMeta | null): void;
  cameFrom(): { id: string; name: string } | null;
  setCameFrom(v: null): void;
  shared(): Parameter[];
  toast(message: string): void;
  toggleBarMenu(anchor: HTMLElement, choices: [string, () => void, boolean?][]): void;
  renderWorkspace(): void;
  openProject(id: string, from?: { id: string; name: string } | null): Promise<unknown>;
  createProject(name: string, d?: CadDocument, group?: string): Promise<unknown>;
  newProject(): Promise<unknown>;
  newAssembly(): Promise<unknown>;
  flushSave(): Promise<unknown>;
  captureThumb(): void;
  saveShared(): void;
  commit(): void;
  renderAll(): void;
}
let ctx: GalleryCtx;
export function initGallery(c: GalleryCtx) {
  ctx = c;
}

// ---------- Tabs of projects ----------

const GROUPS_KEY = "waffle.groups";
const TAB_KEY = "waffle.tab";
interface Group {
  id: string;
  name: string;
}
/** The tabs projects are sorted into, after "My projects" (which has no id). */
let groups: Group[] = [];
try {
  const raw: unknown = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]");
  if (Array.isArray(raw)) groups = raw as Group[];
} catch {
  // None yet.
}
/** What is typed in the search field of Projects: only the names holding it are shown. */
let projectsQuery = "";
/** The tab Projects shows: "all", "" (My projects) or a tab's id. */
let projectsTab = localStorage.getItem(TAB_KEY) ?? "";
function saveGroups() {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
    localStorage.setItem(TAB_KEY, projectsTab);
  } catch {
    ctx.toast("Could not save the tabs in this browser");
  }
}
/** The tab a project is in: "" for My projects, also when its tab is gone. */
export const groupOf = (p: ProjectMeta) => (p.group && groups.some((g) => g.id === p.group) ? p.group : "");
/** Where a new project goes: the tab Projects shows, or else the open project's. */
export function newGroup(): string | undefined {
  const shown = document.getElementById("projects") && projectsTab !== "all";
  const cur = ctx.project();
  return (shown ? projectsTab : cur ? groupOf(cur) : "") || undefined;
}
export function addGroup(name: string): Group {
  const g = { id: newProjectId(), name: keepName(name, ["All", "My projects", ...groups.map((x) => x.name)]) };
  groups.push(g);
  saveGroups();
  return g;
}

/** The projects a document uses: an assembly's parts, a combined part's assembly and parts. */
function projectsUsed(d: CadDocument): string[] {
  const ids = (d.instances ?? []).map((i) => i.project);
  for (const f of d.features) if (f.kind === "combine") ids.push(f.assembly, f.target.project);
  return [...new Set(ids)];
}

/**
 * Downloads a copy of the project, dated so copies never take each other's name and sort in order.
 * The projects it uses go in it too, and theirs, so it opens whole on another device.
 */
export async function saveFile() {
  const cur = ctx.project();
  if (!cur) return;
  await ctx.flushSave();
  const bundle = await bundleProjects([], [ctx.doc()], new Set([cur.id]));
  const copy: CadDocument = { ...ctx.doc(), ...(bundle.length ? { bundle } : {}), ...sharedCarried([ctx.doc(), ...bundle.map((b) => b.doc)]) };
  download(new Blob([JSON.stringify(copy, null, 1)], { type: "application/json" }), `${fileName()}_${stamp()}.waffle.json`);
}

/**
 * Downloads a tab whole: its projects, and the ones they use from elsewhere, in one file named
 * after it. Opened on another device, it becomes a tab of the same name again.
 */
async function saveTab(name: string, ids: string[]) {
  if (!ids.length) return;
  await ctx.flushSave();
  const bundle = await bundleProjects(ids, [], new Set());
  const copy: CadDocument = { ...emptyDoc(), tab: name, bundle, ...sharedCarried(bundle.map((b) => b.doc)) };
  download(new Blob([JSON.stringify(copy, null, 1)], { type: "application/json" }), `${safeName(name)}_${stamp()}.waffle.json`);
}

/** The name of a tab by id ("" is My projects). */
export const tabName = (id: string) => groups.find((g) => g.id === id)?.name ?? "My projects";

/** Saves the tab the open project is in (none open: My projects). */
export async function saveOpenTab() {
  const cur = ctx.project();
  const id = cur ? groupOf(cur) : "";
  const inside = (await listProjects().catch(() => [])).filter((p) => groupOf(p) === id);
  if (!inside.length) return ctx.toast("Nothing in this tab yet");
  await saveTab(tabName(id), inside.map((p) => p.id));
}

/** The projects given, then the ones used by them or by `docs`, and theirs in turn: none twice, none in `seen`. */
async function bundleProjects(ids: string[], docs: CadDocument[], seen: Set<string>): Promise<BundledProject[]> {
  const bundle: BundledProject[] = [];
  const todo = [...ids, ...docs.flatMap(projectsUsed)];
  while (todo.length) {
    const id = todo.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const got = await getProject(id).catch(() => null);
    if (!got) continue;
    bundle.push({ id, name: got.meta.name, kind: got.meta.kind, doc: got.doc });
    todo.push(...projectsUsed(got.doc));
  }
  return bundle;
}

/** The shared parameters these documents use, to go in a saved file with them. */
function sharedCarried(docs: CadDocument[]): { shared?: Parameter[] } {
  const carried = new Map<string, Parameter>();
  for (const d of docs) for (const p of sharedUsed(d, ctx.shared())) carried.set(p.name, p);
  return carried.size ? { shared: [...carried.values()] } : {};
}

/** The date and time, for a saved file's name: copies never take each other's name and sort in order. */
function stamp() {
  const t = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}_${two(t.getHours())}${two(t.getMinutes())}`;
}

/**
 * A copy brought back: the projects it carries are added under new ids (never over a project
 * already here), and every link to them follows. Returns the document to open and how many came with it.
 */
async function unbundle(d: CadDocument, group?: string): Promise<{ doc: CadDocument; added: number }> {
  const carried = d.bundle ?? [];
  const main: CadDocument = { ...d };
  delete main.bundle;
  delete main.shared;
  takeShared(d.shared ?? []);
  if (!carried.length) return { doc: main, added: 0 };
  const ids = new Map(carried.map((b) => [b.id, newProjectId()]));
  const relink = (x: CadDocument): CadDocument => {
    const to = (id: string) => ids.get(id) ?? id;
    return {
      ...x,
      instances: x.instances?.map((i) => ({ ...i, project: to(i.project) })),
      features: x.features.map((f) => (f.kind === "combine" ? { ...f, assembly: to(f.assembly), target: { ...f.target, project: to(f.target.project) } } : f)),
    };
  };
  const names = (await listProjects().catch(() => [])).map((p) => p.name);
  const now = Date.now();
  for (const b of carried) {
    const name = keepName(b.name, names);
    names.push(name);
    await putProject({ id: ids.get(b.id)!, name, created: now, updated: now, kind: b.kind, group }, relink(b.doc));
  }
  return { doc: relink(main), added: carried.length };
}


/** Shared parameters a file brings: the missing ones are added, the ones here keep their value. */
function takeShared(brought: Parameter[]) {
  const shared = ctx.shared();
  const here = new Map(shared.map((p) => [p.name, p]));
  const added = brought.filter((p) => !here.has(p.name));
  const kept = brought.filter((p) => here.has(p.name) && here.get(p.name)!.expr !== p.expr);
  if (added.length) {
    shared.push(...added.map((p) => ({ ...p, id: uid() })));
    ctx.saveShared();
  }
  const say: string[] = [];
  if (added.length) say.push(`${added.length} shared parameter${added.length > 1 ? "s" : ""} added`);
  if (kept.length) say.push(`${kept.map((p) => p.name).join(", ")} kept the value set here`);
  if (say.length) window.setTimeout(() => ctx.toast(say.join(" · ")), 1500);
}


/** A file opened from the device becomes a new project, named after the file. */
export function openFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.waffle,.tcad,application/json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const d = asDocument(JSON.parse(await f.text()));
      if (!d) throw new Error("not a WaffleCAD file");
      // A copy's date ("Model 1_2026-10-25_1842") is not part of the project's name.
      const name = f.name.replace(/(\.waffle)?\.(json|waffle|tcad)$/i, "").replace(/[ _]\d{4}-\d{2}-\d{2}[ _]\d{4}$/, "");
      // What a file brings goes in a tab of its own, named after it.
      const tab = addGroup(name || "Imported");
      const { doc: main, added } = await unbundle(d, tab.id);
      projectsTab = tab.id;
      saveGroups();
      if (d.tab !== undefined) {
        // A saved tab: its projects are all in the bundle, and the tab is what opens.
        ctx.toast(`${added} project${added > 1 ? "s" : ""} imported in the tab "${tab.name}"`);
        return void showProjects();
      }
      await ctx.createProject(keepName(name || "Model", (await listProjects().catch(() => [])).map((p) => p.name)), main, tab.id);
      if (added) ctx.toast(`${added} linked project${added > 1 ? "s" : ""} imported with it`);
      closeProjects();
    } catch (e) {
      ctx.toast("Cannot open this file: " + (e instanceof Error ? e.message : e));
    }
  };
  input.click();
}

/** The project's name, made safe for a file name. */
export const fileName = () => safeName(ctx.project()?.name ?? "model");
const safeName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "model";


// ---------- Project gallery ----------

export function closeProjects() {
  document.getElementById("projects")?.remove();
}


export async function showProjects() {
  await ctx.flushSave();
  ctx.captureThumb();
  let list: ProjectMeta[];
  try {
    list = await listProjects();
  } catch {
    return ctx.toast("This browser cannot keep projects");
  }
  list = byName(list);
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
    <header><h2>Projects</h2><button class="projects-open">${icon("folder", 20)}<span>Open file</span></button><div class="projects-new-wrap"><button class="primary projects-new">${icon("plus", 20)}<span>New</span>${icon("chevron", 16)}</button><div class="projects-new-menu"><button data-new="project">${icon("extrude", 20)}<span>Project</span></button><button data-new="assembly">${icon("assembly", 20)}<span>Assembly</span></button></div></div><button class="projects-close" aria-label="Close">${icon("close", 22)}</button></header>
    <div class="projects-tabs"></div><div class="projects-grid"></div></div>`;
  // New: a project or an assembly, chosen in a small list under the button.
  const wrap = el.querySelector<HTMLElement>(".projects-new-wrap")!;
  wrap.querySelector<HTMLElement>(".projects-new")!.onclick = () => wrap.classList.toggle("open");
  for (const b of wrap.querySelectorAll<HTMLElement>("[data-new]")) b.onclick = () => void (b.dataset.new === "assembly" ? ctx.newAssembly() : ctx.newProject());
  el.querySelector(".projects-card")!.addEventListener("pointerdown", (e) => {
    if (!wrap.contains(e.target as Node)) wrap.classList.remove("open");
  });
  el.querySelector<HTMLElement>(".projects-open")!.onclick = openFile;
  el.querySelector<HTMLElement>(".projects-close")!.onclick = closeProjects;
  const grid = el.querySelector(".projects-grid")!;
  // Which parts each assembly uses (and so which assemblies use each part), and which assembly
  // each combined part is made from.
  const uses = new Map<string, string[]>();
  const usedBy = new Map<string, string[]>();
  const from = new Map<string, string[]>();
  for (const m of list) {
    const got = await getProject(m.id).catch(() => null);
    if (m.kind !== "assembly") {
      const asms = [...new Set((got?.doc.features ?? []).flatMap((f) => (f.kind === "combine" ? [f.assembly] : [])))];
      if (asms.length) from.set(m.id, asms);
      continue;
    }
    const ids = [...new Set((got?.doc.instances ?? []).map((i) => i.project))];
    uses.set(m.id, ids);
    for (const id of ids) usedBy.set(id, [...(usedBy.get(id) ?? []), m.id]);
  }
  if (projectsTab !== "all" && projectsTab && !groups.some((g) => g.id === projectsTab)) projectsTab = "";
  const tabsRow = el.querySelector<HTMLElement>(".projects-tabs")!;
  // A search field once there are enough projects to lose one; it narrows the tab shown by name.
  const search = document.createElement("input");
  if (list.length >= 6) {
    search.type = "search";
    search.className = "projects-search";
    search.placeholder = "Search";
    search.setAttribute("aria-label", "Search projects");
    search.value = projectsQuery;
    tabsRow.appendChild(search);
  } else projectsQuery = "";
  renderProjectTabs(tabsRow, list);
  // A part only one assembly needs (in it, or made from it): moved and deleted with that assembly.
  const members = new Map<string, ProjectMeta[]>();
  for (const p of list) {
    if (p.kind === "assembly") continue;
    const owners = new Set([...(from.get(p.id) ?? []), ...(usedBy.get(p.id) ?? [])]);
    const [a] = owners;
    const owner = list.find((x) => x.id === a && x.kind === "assembly");
    if (owners.size !== 1 || !owner || groupOf(owner) !== groupOf(p)) continue;
    members.set(a, [...(members.get(a) ?? []), p]);
  }
  const linksOf = (p: ProjectMeta): [string, string[]][] =>
    p.kind === "assembly" ? [["", uses.get(p.id) ?? []]] : [["from ", from.get(p.id) ?? []], ["in ", usedBy.get(p.id) ?? []]];
  for (const p of list) {
    if (projectsTab !== "all" && groupOf(p) !== projectsTab) continue;
    grid.appendChild(projectCard(p, list, linksOf(p), from.has(p.id), members.get(p.id)));
  }
  const filter = () => {
    projectsQuery = search.value.trim();
    const q = projectsQuery.toLowerCase();
    let shown = 0;
    for (const c of grid.querySelectorAll<HTMLElement>(".project-card")) {
      const hit = !q || (c.dataset.name ?? "").toLowerCase().includes(q);
      c.classList.toggle("off", !hit);
      if (hit) shown++;
    }
    grid.querySelector(".projects-empty")?.remove();
    if (!shown) {
      const e = document.createElement("p");
      e.className = "projects-empty";
      e.textContent = q ? `No project named "${projectsQuery}" in this tab` : "No projects in this tab yet";
      grid.appendChild(e);
    }
  };
  search.oninput = filter;
  filter();
}

/**
 * All · My projects · one tab per imported file, and those made here. Tapping the tab shown again
 * offers to rename or delete it.
 */
function renderProjectTabs(row: HTMLElement, list: ProjectMeta[]) {
  const tabs: [string, string][] = [["all", "All"], ["", "My projects"], ...byName(groups).map((g): [string, string] => [g.id, g.name])];
  for (const [id, name] of tabs) {
    const b = document.createElement("button");
    const n = id === "all" ? list.length : list.filter((p) => groupOf(p) === id).length;
    const on = id === projectsTab;
    b.className = on ? "on" : "";
    b.innerHTML = `<span></span><small>${n}</small>${on && id !== "all" ? icon("more", 16) : ""}`;
    b.querySelector("span")!.textContent = name;
    b.onclick = () => {
      if (!on) {
        projectsTab = id;
        saveGroups();
        return void showProjects();
      }
      const inside = list.filter((p) => groupOf(p) === id);
      const g = groups.find((x) => x.id === id);
      if (g) tabMenu(b, g, inside);
      else if (id === "" && inside.length) {
        ctx.toggleBarMenu(b, [
          [saveTabLabel(inside), () => void saveTab("My projects", inside.map((p) => p.id))],
          // My projects stays the tab projects land in by default, so it is not renamed: its projects move out instead.
          [`Move its ${inside.length} project${inside.length > 1 ? "s" : ""} to a new tab…`, async () => {
            const name = prompt("Name of the new tab")?.trim();
            if (!name) return;
            if (["All", "My projects", ...groups.map((x) => x.name)].includes(name)) return ctx.toast(`${name} already exists`);
            const g = addGroup(name);
            await moveProjects(inside.map((p) => p.id), g.id);
            projectsTab = g.id;
            saveGroups();
            void showProjects();
          }],
        ]);
      }
    };
    row.appendChild(b);
    if (on) requestAnimationFrame(() => b.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
}

function tabMenu(anchor: HTMLElement, g: Group, inside: ProjectMeta[]) {
  const n = `${inside.length} project${inside.length > 1 ? "s" : ""}`;
  const drop = () => {
    groups = groups.filter((x) => x !== g);
    projectsTab = "";
    saveGroups();
  };
  const choices: [string, () => void, boolean?][] = [
    ...(inside.length ? [[saveTabLabel(inside), () => void saveTab(g.name, inside.map((p) => p.id))] as [string, () => void]] : []),
    ["Rename", () => {
      const name = prompt("Tab name", g.name)?.trim();
      if (!name || name === g.name) return;
      if (["All", "My projects", ...groups.map((x) => x.name)].includes(name)) return ctx.toast(`${name} already exists`);
      g.name = name;
      saveGroups();
      ctx.renderWorkspace(); // Save names the open project's tab
      void showProjects();
    }],
  ];
  if (inside.length) {
    choices.push(
      ["Move its projects to My projects", async () => {
        await moveProjects(inside.map((p) => p.id), undefined);
        drop();
        void showProjects();
      }],
      [`Delete with its ${n}`, () => {
        if (!confirm(`Delete the tab "${g.name}" and its ${n}? This cannot be undone.`)) return;
        drop();
        void removeProjects(inside.map((p) => p.id));
      }, true],
    );
  } else {
    choices.push(["Delete the tab", () => {
      drop();
      void showProjects();
    }, true]);
  }
  ctx.toggleBarMenu(anchor, choices);
}

const saveTabLabel = (inside: ProjectMeta[]) => `Save the tab as a file (${inside.length} project${inside.length === 1 ? "" : "s"})`;

/** Projects put in another tab (none: My projects). */
async function moveProjects(ids: string[], group: string | undefined) {
  for (const id of ids) {
    const cur = ctx.project();
    if (cur?.id === id) cur.group = group;
    const got = await getProject(id).catch(() => null);
    if (got) await putProject({ ...got.meta, group }).catch(() => ctx.toast("Could not move"));
  }
  ctx.renderWorkspace(); // Save names the open project's tab
}

/** Projects deleted: what was open, or what Back led to, goes with them. */
async function removeProjects(ids: string[]) {
  for (const id of ids) await deleteProject(id).catch(() => ctx.toast("Could not delete"));
  const from = ctx.cameFrom();
  if (from && ids.includes(from.id)) {
    ctx.setCameFrom(null); // no way back to it any more
    ctx.renderWorkspace();
  }
  const cur = ctx.project();
  if (cur && ids.includes(cur.id)) {
    ctx.setProject(null); // nothing left to save there
    const rest = await listProjects().catch(() => []);
    if (rest.length) await ctx.openProject(rest[0].id);
    else await ctx.createProject("Model 1");
  }
  void showProjects();
}

/**
 * A part renamed: the parts of assemblies still called by its old name take the new one (a part
 * renamed in its assembly keeps its own name).
 */
async function renameInAssemblies(id: string, old: string, name: string, list: ProjectMeta[]) {
  for (const m of list.filter((x) => x.kind === "assembly")) {
    const open = ctx.project()?.id === m.id;
    const got = open ? null : await getProject(m.id).catch(() => null);
    const d = open ? ctx.doc() : got?.doc;
    const hits = (d?.instances ?? []).filter((i) => i.project === id && i.name === old);
    if (!d || !hits.length) continue;
    for (const i of hits) i.name = name;
    if (open) {
      ctx.commit();
      ctx.renderAll();
    } else await putProject(got!.meta, d).catch(() => ctx.toast(`Could not update ${m.name}`));
  }
}

/**
 * A project's card. `links`: lines of linked projects, each after its word ("", "from ", "in "):
 * the parts an assembly uses, the assembly a combined part comes from, the assemblies a part is in.
 */
function projectCard(p: ProjectMeta, list: ProjectMeta[], links: [string, string[]][] = [], combined = false, family: ProjectMeta[] = []) {
  const current = p.id === ctx.project()?.id;
  const card = document.createElement("div");
  card.className = "project-card" + (current ? " current" : "");
  card.dataset.name = p.name;
  card.innerHTML = `<button class="project-thumb"></button>
    <div class="project-row"><div class="project-info"><div class="project-name"></div><div class="project-date"></div></div>
    <button class="project-more" aria-label="More">${icon("more", 22)}</button></div>
    <div class="project-actions"><div>
      <button data-act="rename">${icon("rename", 20)}<span>Rename</span></button>
      <button data-act="copy">${icon("copy", 20)}<span>Duplicate</span></button>
      <button data-act="move">${icon("folder", 20)}<span>Move</span></button>
      <button data-act="delete" class="danger">${icon("trash", 20)}<span>Delete</span></button>
    </div></div>`;
  const thumb = card.querySelector<HTMLElement>(".project-thumb")!;
  if (p.thumb) {
    const img = document.createElement("img");
    img.src = p.thumb;
    img.alt = "";
    thumb.appendChild(img);
  } else thumb.innerHTML = icon(p.kind === "assembly" ? "assembly" : "extrude", 40);
  // What kind of project it is, on its picture.
  const kind = document.createElement("span");
  kind.className = "project-kind";
  const [kindIcon, kindName] = p.kind === "assembly" ? ["assembly", "Assembly"] : combined ? ["combine", "Combined"] : ["part", "Part"];
  kind.innerHTML = icon(kindIcon, 14) + `<span>${kindName}</span>`;
  thumb.appendChild(kind);
  const name = card.querySelector<HTMLElement>(".project-name")!;
  name.textContent = p.name;
  card.querySelector(".project-date")!.textContent = current ? "Open now" : ago(p.updated);
  let after: Element = card.querySelector(".project-row")!;
  for (const [word, ids] of links) {
    const others = byName(ids.map((id) => list.find((x) => x.id === id)).filter((x): x is ProjectMeta => !!x));
    if (!others.length) continue;
    // Each name opens that project.
    const line = document.createElement("div");
    line.className = "project-links";
    line.innerHTML = icon(word === "from " ? "combine" : "assembly", 14) + "<span></span>";
    line.querySelector("span")!.textContent = word;
    others.forEach((o, i) => {
      // Inline text rather than a button, so a long name wraps with the line.
      const a = document.createElement("span");
      a.role = "button";
      a.tabIndex = 0;
      a.textContent = o.name;
      a.title = `Open ${o.name}`;
      a.onclick = async () => {
        if (o.id !== ctx.project()?.id) await ctx.openProject(o.id);
        closeProjects();
      };
      a.onkeydown = (e) => {
        if (e.key === "Enter") a.click();
      };
      if (i) line.append(" · ");
      line.appendChild(a);
    });
    after.after(line);
    after = line;
  }
  const open = async () => {
    if (p.id !== ctx.project()?.id) await ctx.openProject(p.id);
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
        const old = p.name;
        p.name = v;
        const cur = ctx.project();
        if (cur && p.id === cur.id) cur.name = v;
        await putProject({ ...(cur && p.id === cur.id ? cur : p) }).catch(() => ctx.toast("Could not rename"));
        await renameInAssemblies(p.id, old, v, list);
        return void showProjects();
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
    await ctx.flushSave();
    const src = await getProject(p.id).catch(() => null);
    if (!src) return ctx.toast("Could not duplicate");
    const now = Date.now();
    const base = p.name.replace(/ \d+$/, "");
    const copy: ProjectMeta = { ...src.meta, id: newProjectId(), name: freeName(base, list.map((x) => x.name)), created: now, updated: now };
    await putProject(copy, src.doc).catch(() => ctx.toast("Could not duplicate"));
    void showProjects();
  };
  // To another tab, with its own parts.
  const move = card.querySelector<HTMLElement>('[data-act="move"]')!;
  move.onclick = () => {
    const ids = [p.id, ...family.map((m) => m.id)];
    const go = async (group: string | undefined) => {
      await moveProjects(ids, group);
      void showProjects();
    };
    const here = groupOf(p);
    const tabs: [string, string][] = [["", "My projects"], ...byName(groups).map((g): [string, string] => [g.id, g.name])];
    ctx.toggleBarMenu(move, [
      ...tabs.filter(([id]) => id !== here).map(([id, name]): [string, () => void] => [name, () => void go(id || undefined)]),
      ["New tab…", () => {
        const name = prompt("Tab name", p.name)?.trim();
        if (name) void go(addGroup(name).id);
      }],
    ]);
  };
  const del = card.querySelector<HTMLElement>('[data-act="delete"]')!;
  del.onclick = () => {
    const only = () => {
      if (confirm(`Delete "${p.name}"? This cannot be undone.`)) void removeProjects([p.id]);
    };
    if (!family.length) return only();
    // An assembly's own parts can go with it: no other project needs them.
    const n = `${family.length} part${family.length > 1 ? "s" : ""}`;
    ctx.toggleBarMenu(del, [
      [`Delete with its ${n}`, () => {
        if (confirm(`Delete "${p.name}" and its ${n} (${family.map((m) => m.name).join(", ")})? This cannot be undone.`)) void removeProjects([p.id, ...family.map((m) => m.id)]);
      }, true],
      ["Delete only the assembly", only],
    ]);
  };
  return card;
}

