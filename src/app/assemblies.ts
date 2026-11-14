// Assemblies: parts from other projects placed in this one, by hand or with the gizmo.
import * as THREE from "three";
import { M, commit, flushSave, kernelReady, openProject, pendingBodies, vp, worker } from "../main";
import { catchUpShared } from "./parameters";
import { closeProjects, newGroup } from "./gallery";
import { S, isOperation } from "./state";
import { ago, asDocument, byName, emptyDoc } from "./util";
import { instanceMatrix, placementOf } from "../cad/mates";
import { freeName, getProject, listProjects, newProjectId, putProject, type ProjectMeta } from "../projects";
import { uid } from "../sketch/model";
import { type CadDocument, type PartInstance, type Vec3, type WorkerRequest } from "../types";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

export const isAssembly = () => S.doc.kind === "assembly";
/** Documents and names of the parts the open assembly uses (their latest saved versions). */
export let partDocs: Record<string, CadDocument> = {};
export let partNames: Record<string, string> = {};

/** Reads the parts the assembly uses and hands them to the worker. */
export async function loadParts() {
  partDocs = {};
  partNames = {};
  await loadLinked(S.doc);
  sendParts();
}

/** The projects a document reads: an assembly's parts; a combining part's assembly and target. */
export function linkedProjects(d: CadDocument): string[] {
  const ids = (d.instances ?? []).map((i) => i.project);
  for (const f of d.features) if (f.kind === "combine") ids.push(f.assembly, f.target.project);
  return [...new Set(ids)];
}

/** Loads every project `d` reads that is not loaded yet, and what those read in turn. */
export async function loadLinked(d: CadDocument) {
  const tried = new Set(Object.keys(partDocs));
  let todo = linkedProjects(d).filter((id) => !tried.has(id));
  while (todo.length) {
    for (const id of todo) tried.add(id);
    const got = await Promise.all(todo.map((id) => getProject(id).catch(() => null)));
    const next: string[] = [];
    got.forEach((p, i) => {
      if (!p) return;
      const pd = asDocument(p.doc) ?? emptyDoc();
      if (catchUpShared(pd)) void putProject(p.meta, pd).catch(() => {});
      partDocs[todo[i]] = pd;
      partNames[todo[i]] = p.meta.name;
      next.push(...linkedProjects(pd));
    });
    todo = [...new Set(next)].filter((id) => !tried.has(id));
  }
}

export function sendParts() {
  worker.postMessage({ type: "parts", parts: partDocs, open: S.project?.id } satisfies WorkerRequest);
}

export const instanceOf = (id: string | null) => S.doc.instances?.find((i) => i.id === id) ?? null;

/** Picks a project to place in the assembly (parts only, not the assembly itself). */
export async function showPartPicker() {
  let list: ProjectMeta[];
  try {
    list = byName((await listProjects()).filter((p) => p.kind !== "assembly" && p.id !== S.project?.id));
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
    const pick = () => void pickPart(el, p);
    thumb.onclick = pick;
    card.querySelector<HTMLElement>(".project-info")!.onclick = pick;
    grid.appendChild(card);
  }
  document.body.appendChild(el);
}

/** The bodies of a part (from the worker). */
export function partBodies(d: CadDocument) {
  if (!kernelReady) return Promise.resolve([]);
  const reqId = ++M.reqCounter;
  return new Promise<{ id: string; name: string }[]>((resolve) => {
    pendingBodies.set(reqId, resolve);
    worker.postMessage({ type: "bodies", reqId, doc: d } satisfies WorkerRequest);
  });
}

/** A part chosen in the picker: one with several bodies asks whether to keep them together. */
export async function pickPart(el: HTMLElement, p: ProjectMeta) {
  const got = await getProject(p.id).catch(() => null);
  if (!got) return toast("This project could not be read");
  const d = asDocument(got.doc) ?? emptyDoc();
  // What it reads (a copy's assembly and parts) must be there to count its bodies.
  if (linkedProjects(d).some((id) => !partDocs[id])) {
    await loadLinked(d);
    sendParts();
  }
  const bodies = await partBodies(d);
  if (bodies.length < 2) {
    closeProjects();
    return insertPart(p, d);
  }
  const card = el.querySelector<HTMLElement>(".projects-card")!;
  card.innerHTML = `<header><h2></h2><button class="projects-close" aria-label="Close">${icon("close", 22)}</button></header>
    <p class="p-hint"></p><div class="p-actions"></div>`;
  card.querySelector("h2")!.textContent = p.name;
  card.querySelector(".p-hint")!.textContent = `This part has ${bodies.length} bodies (${bodies.map((b) => b.name).join(", ")}). Insert them as one part, or each as a part of its own, to move and mate them apart.`;
  card.querySelector<HTMLElement>(".projects-close")!.onclick = closeProjects;
  const box = card.querySelector(".p-actions")!;
  for (const [ic, label, run] of [
    ["part", "As one part", () => insertPart(p, d)],
    ["assembly", `Each body apart (${bodies.length})`, () => insertPart(p, d, bodies)],
  ] as const) {
    const b = document.createElement("button");
    b.innerHTML = icon(ic, 20) + "<span></span>";
    b.querySelector("span")!.textContent = label;
    b.onclick = () => {
      closeProjects();
      void run();
    };
    box.appendChild(b);
  }
}

/** A new, empty part, placed at the assembly's origin and opened to be drawn. */
export async function newPartHere() {
  if (!S.project || !isAssembly() || isOperation(S.mode)) return;
  const here = { id: S.project.id, name: S.project.name };
  const names = (await listProjects().catch(() => [])).map((p) => p.name);
  const now = Date.now();
  const meta: ProjectMeta = { id: newProjectId(), name: freeName("Part", names), created: now, updated: now, group: newGroup() };
  const d = emptyDoc();
  try {
    await putProject(meta, d);
  } catch {
    return toast("Could not save in this browser");
  }
  partDocs[meta.id] = d;
  partNames[meta.id] = meta.name;
  sendParts();
  const inst: PartInstance = { id: uid(), project: meta.id, name: meta.name, at: [0, 0, 0], rot: [0, 0, 0], fixed: !S.doc.instances?.length || undefined };
  S.doc.instances = [...(S.doc.instances ?? []), inst];
  commit();
  await flushSave();
  await openProject(meta.id, here);
  toast(`${meta.name} is in ${here.name}: draw it, then come back from Projects`);
}

/**
 * Places a part beside the others (its exact place is then set by hand). With `bodies`, each body
 * becomes a part of its own, all where the part has them.
 */
export async function insertPart(p: ProjectMeta, d?: CadDocument, bodies?: { id: string; name: string }[]) {
  if (!d) {
    const got = await getProject(p.id).catch(() => null);
    if (!got) return toast("This project could not be read");
    d = asDocument(got.doc) ?? emptyDoc();
  }
  if (bodies?.length) {
    partDocs[p.id] = d;
    partNames[p.id] = p.name;
    await loadLinked(d);
    sendParts();
    const box = vp.modelBox();
    const at: Vec3 = box ? [Math.round(box.max.x + 10), 0, 0] : [0, 0, 0];
    const first = !S.doc.instances?.length;
    const taken = (S.doc.instances ?? []).map((i) => i.name);
    const made = bodies.map((b, k): PartInstance => {
      // Bodies the part named keep their name; "Body 2" says which part it comes from.
      const base = /^Body \d+$/.test(b.name) ? `${p.name} ${b.name.toLowerCase()}` : b.name;
      const name = taken.includes(base) ? freeName(base, taken) : base;
      taken.push(name);
      return { id: uid(), project: p.id, name, at: [...at] as Vec3, rot: [0, 0, 0], body: b.id, fixed: (first && k === 0) || undefined };
    });
    S.doc.instances = [...(S.doc.instances ?? []), ...made];
    S.selectedFeature = made[0].id;
    M.fitNext = true;
    return commit();
  }
  partDocs[p.id] = d;
  partNames[p.id] = p.name;
  await loadLinked(d);
  sendParts();
  const box = vp.modelBox();
  const inst: PartInstance = {
    id: uid(),
    project: p.id,
    name: freeName(p.name, (S.doc.instances ?? []).map((i) => i.name)),
    at: box ? [Math.round(box.max.x + 10), 0, 0] : [0, 0, 0],
    rot: [0, 0, 0],
    // The first part holds still: the others are mated to it.
    fixed: !S.doc.instances?.length || undefined,
  };
  S.doc.instances = [...(S.doc.instances ?? []), inst];
  S.selectedFeature = inst.id;
  M.fitNext = true;
  commit();
}

export function duplicateInstance(inst: PartInstance) {
  const box = vp.bodyBox(inst.id);
  const copy: PartInstance = {
    ...inst,
    id: uid(),
    name: freeName(partNames[inst.project] ?? inst.name.replace(/ \d+$/, ""), (S.doc.instances ?? []).map((i) => i.name)),
    at: [inst.at[0] + (box ? Math.ceil(box.max.x - box.min.x) + 5 : 20), inst.at[1], inst.at[2]],
    rot: [...inst.rot],
    fixed: undefined,
  };
  S.doc.instances = [...(S.doc.instances ?? []), copy];
  S.selectedFeature = copy.id;
  commit();
}

export function removeInstance(inst: PartInstance) {
  S.doc.instances = (S.doc.instances ?? []).filter((i) => i !== inst);
  // Its mates go with it.
  S.doc.mates = S.doc.mates?.filter((m) => m.a.part !== inst.id && m.b.part !== inst.id);
  if (S.selectedFeature === inst.id) S.selectedFeature = null;
  commit();
}

export function renameInstance(inst: PartInstance) {
  const name = prompt("Part name", inst.name)?.trim();
  if (!name || name === inst.name) return;
  inst.name = name;
  commit();
}

/** Opens the part's own project to change it; the assembly follows when it is opened again. */
export async function openPart(inst: PartInstance) {
  if (!S.project) return;
  const from = { id: S.project.id, name: S.project.name };
  await openProject(inst.project, from);
}

/** Moves a part by `m` (a slide or a turn made with the handles), in place of where it was. */
export function applyMove(inst: PartInstance, m: THREE.Matrix4) {
  Object.assign(inst, placementOf(m.clone().multiply(instanceMatrix(inst))));
}
