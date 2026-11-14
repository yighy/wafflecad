// Combine: a new part made from an assembly's parts (cut, join, overlap, or copied as they are).
import { M, buttons, commit, flushSave, openProject, renderAll, vp } from "../main";
import { renderPanel } from "./sidePanel";
import { chooseProject } from "./workspace";
import { instanceOf, partDocs, partNames, sendParts } from "./assemblies";
import { partLabel } from "./mates";
import { endAlign } from "./align";
import { clearClashes } from "./interference";
import { newGroup } from "./gallery";
import { endMeasure, measuring } from "./measure";
import { S, isOperation } from "./state";
import { emptyDoc } from "./util";
import { freeName, getProject, listProjects, newProjectId, putProject, type ProjectMeta } from "../projects";
import { uid } from "../sketch/model";
import { type CadDocument, type CombineFeature } from "../types";
import { toast } from "../ui/toast";
import { cssVar } from "../view/viewport";

/** A combine step's name, after its operation. */
export const COMBINE_NAMES: Record<CombineFeature["op"], string> = { cut: "Cut", add: "Join", intersect: "Intersect", keep: "Copy" };

export const COMBINE_OPS: [CombineFeature["op"], string][] = [
  ["cut", "Cut"],
  ["add", "Join"],
  ["intersect", "Intersect"],
];
/** Play offered for a cut (mm): none, or the usual fits of 3D printed parts. */
export const COMBINE_PLAY = [0, 0.1, 0.2, 0.3, 0.5];

/**
 * Combine (cut, join, intersect parts into a new part) or, with `copy`, Copy as part: the parts
 * tapped come into a new part as they are, each a body of its own, where the assembly has them.
 */
export function startCombine(copy = false) {
  if (isOperation(S.mode)) return;
  if (!copy && (S.doc.instances?.length ?? 0) < 2) return toast("Insert at least two parts first");
  if (!S.doc.instances?.length) return toast("Insert a part first");
  if (S.mode.kind === "combine") {
    const was = S.mode.op === "keep";
    endCombine();
    if (was === copy) return;
  }
  if (measuring) endMeasure();
  if (M.clashes) clearClashes();
  if (S.mode.kind === "align") endAlign();
  // The selected part, if any, is the one the new part is made from.
  S.mode = { kind: "combine", target: instanceOf(S.selectedFeature)?.id ?? null, tools: [], op: copy ? "keep" : "cut", clearance: 0, replace: false, existing: null };
  S.selectedFeature = null;
  showCombinePicks();
  renderAll();
  void lookForCombined();
}

/** The part already made by a Combine from this assembly's target, if any: it can be updated. */
export async function lookForCombined() {
  if (S.mode.kind !== "combine" || !S.project) return;
  const m = S.mode;
  const asm = S.project.id;
  const target = m.target;
  let found: ProjectMeta | null = null;
  if (target)
    for (const meta of (await listProjects().catch(() => [])).filter((p) => p.kind !== "assembly")) {
      const got = await getProject(meta.id).catch(() => null);
      if (got?.doc.features.some((f) => f.kind === "combine" && f.assembly === asm && f.target.instance === target)) {
        found = meta;
        break;
      }
    }
  // Only if still combining the same target.
  if (S.mode !== m || m.target !== target) return;
  m.existing = found;
  renderPanel();
}

export function endCombine() {
  S.mode = { kind: "part" };
  vp.highlightFaces([]);
  renderAll();
}

/** The first part tapped is the target; the next ones are tools. Tapping one again lets it go. */
export function toggleCombinePart(id: string) {
  if (S.mode.kind !== "combine") return;
  if (S.mode.target === id) S.mode.target = S.mode.op === "keep" ? (S.mode.tools.shift() ?? null) : null;
  else if (S.mode.tools.includes(id)) S.mode.tools = S.mode.tools.filter((t) => t !== id);
  else if (!S.mode.target) S.mode.target = id;
  else S.mode.tools.push(id);
  showCombinePicks();
  renderAll();
  void lookForCombined();
}

/** The target is marked as a selected body; the tools take the colour of what they do to it. */
export function showCombinePicks() {
  if (S.mode.kind !== "combine") return;
  const tools = new Set(S.mode.tools);
  const colour = S.mode.op === "cut" ? cssVar("--danger", "#c92a2a") : S.mode.op === "intersect" ? cssVar("--sk-selected", "#1971c2") : cssVar("--accent", "#dc4c12");
  vp.highlightFaces((S.lastBuild?.bodies ?? []).filter((b) => tools.has(b.id)).flatMap((b) => b.faceIds), colour);
}

export function renderCombinePanel(el: HTMLElement, head: (title: string, sub?: string) => void, actions: (items: [string, string, () => void, string?][]) => void) {
  if (S.mode.kind !== "combine") return;
  const m = S.mode;
  const n = m.tools.length;
  if (m.op === "keep") {
    const count = (m.target ? 1 : 0) + n;
    head("Copy as part", count ? `${count} part${count > 1 ? "s" : ""} to copy` : "Tap the parts to copy");
  } else {
    head(
      "Combine",
      !m.target ? "Tap the part to make the new part from" : `${partLabel(m.target)} · ${n ? `${n} part${n > 1 ? "s" : ""} to ${m.op === "cut" ? "cut away" : m.op === "add" ? "join" : "keep the overlap with"}` : "now tap the other parts"}`,
    );
    combineRows(el, m, () => {
      showCombinePicks();
      renderPanel();
    });
  }
  // The new part can take the target's place here (same place, same mates); not a kept set of
  // parts, already where the assembly has them.
  if (m.op === "keep") m.replace = false;
  const then = document.createElement("div");
  then.className = "align-row combine-row";
  then.innerHTML = `<span>Then</span><div class="seg"><button>Keep both</button><button>Replace it</button></div>`;
  then.querySelectorAll("button").forEach((b, i) => {
    b.classList.toggle("on", m.replace === (i === 1));
    b.onclick = () => {
      m.replace = i === 1;
      renderPanel();
    };
  });
  if (m.op !== "keep") el.appendChild(then);
  const hint = document.createElement("p");
  hint.className = "p-hint";
  hint.textContent =
    m.op === "cut"
      ? "The other parts are cut out of it where the assembly places them, grown by the play for a fit. The result is a new part, kept up to date with the assembly."
      : m.op === "keep"
        ? "The parts tapped come into a new part as they are, each a body of its own, where the assembly places it. It is kept up to date with the assembly: add fillets or holes, or export them as one part."
        : m.op === "add"
        ? "The parts become one solid, as the assembly places them. The result is a new part, kept up to date with the assembly."
        : "Only what it shares with the other parts is kept. The result is a new part, kept up to date with the assembly.";
  el.appendChild(hint);
  if (m.existing) {
    // Made before from this part: update that one rather than add another.
    const again = document.createElement("p");
    again.className = "p-hint";
    again.textContent = `${m.existing.name} was made from this part already: update it, or make a new one.`;
    el.appendChild(again);
    const existing = m.existing;
    actions([
      ["close", "Cancel", endCombine],
      ["plus", "Make a new one", () => void createCombined()],
      ["check", `Update ${existing.name}`, () => void updateCombined(existing), "primary"],
    ]);
    return;
  }
  actions([
    ["close", "Cancel", endCombine],
    ["check", "Create the part", () => void createCombined(), "primary"],
  ]);
}

/** Puts the parts and operation chosen into the part a Combine made before from the same target. */
export async function updateCombined(meta: ProjectMeta) {
  if (S.mode.kind !== "combine" || !S.project) return;
  const m = S.mode;
  const asm = S.project.id;
  const target = instanceOf(m.target);
  if (!target) return;
  const got = await getProject(meta.id).catch(() => null);
  const feat = got?.doc.features.find((f): f is CombineFeature => f.kind === "combine" && f.assembly === asm && f.target.instance === target.id);
  if (!got || !feat) return toast(`${meta.name} could not be read`);
  Object.assign(feat, {
    name: COMBINE_NAMES[m.op],
    tools: [...m.tools],
    op: m.op,
    clearance: m.op === "cut" && m.clearance ? m.clearance : undefined,
  });
  try {
    await putProject({ ...got.meta, updated: Date.now() }, got.doc);
  } catch {
    return toast("Could not save in this browser");
  }
  if (partDocs[meta.id]) partDocs[meta.id] = got.doc;
  const replace = m.replace && target.project !== meta.id;
  endCombine();
  if (replace) {
    partDocs[meta.id] = got.doc;
    partNames[meta.id] = meta.name;
    target.project = meta.id;
    delete target.body;
    commit();
    S.selectedFeature = target.id;
  }
  sendParts();
  renderAll();
  toast(`${meta.name} updated`);
}

/** The operation and, for a cut, the play: segmented rows that change `c` and call `changed`. */
export function combineRows(el: HTMLElement, c: { op: CombineFeature["op"]; clearance?: number }, changed: () => void) {
  const row = (label: string, buttons: [string, boolean, () => void][]) => {
    const r = document.createElement("div");
    r.className = "align-row combine-row";
    r.innerHTML = "<span></span>";
    r.querySelector("span")!.textContent = label;
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const [text, on, run] of buttons) {
      const b = document.createElement("button");
      b.textContent = text;
      b.classList.toggle("on", on);
      b.onclick = () => {
        run();
        changed();
      };
      seg.appendChild(b);
    }
    r.appendChild(seg);
    el.appendChild(r);
  };
  row(
    "Do",
    COMBINE_OPS.map(([op, text]) => [text, c.op === op, () => (c.op = op)]),
  );
  if (c.op === "cut") row("Play", COMBINE_PLAY.map((p) => [p ? `${p}` : "None", (c.clearance ?? 0) === p, () => (c.clearance = p)]));
}

/** Names of a combine step's parts, as the assembly calls them. */
export function combineNames(f: CombineFeature) {
  const asm = partDocs[f.assembly];
  const name = (id: string) => asm?.instances?.find((i) => i.id === id)?.name ?? "?";
  return { target: name(f.target.instance), tools: f.tools.map(name), assembly: partNames[f.assembly] ?? "a deleted assembly" };
}

/** Saves the combination as a new part project, and offers to open it. */
export async function createCombined() {
  if (S.mode.kind !== "combine" || !S.project) return;
  const target = instanceOf(S.mode.target);
  if (!target) return toast(S.mode.op === "keep" ? "Tap the parts to copy" : "Tap the part to make the new part from");
  if (!S.mode.tools.length && S.mode.op !== "keep") return toast("Tap at least one other part");
  const here = { id: S.project.id, name: S.project.name };
  await flushSave();
  const word = { cut: "cut", add: "joined", intersect: "overlap", keep: "copy" }[S.mode.op];
  const names = (await listProjects().catch(() => [])).map((p) => p.name);
  // A copy of several parts is named after the assembly.
  const base = S.mode.op === "keep" && S.mode.tools.length ? here.name : (partNames[target.project] ?? target.name);
  const name = freeName(`${base} (${word})`, names);
  const feat: CombineFeature = {
    id: uid(),
    kind: "combine",
    name: COMBINE_NAMES[S.mode.op],
    assembly: here.id,
    target: { instance: target.id, project: target.project, body: target.body },
    tools: [...S.mode.tools],
    op: S.mode.op,
    clearance: S.mode.op === "cut" && S.mode.clearance ? S.mode.clearance : undefined,
  };
  const now = Date.now();
  const meta: ProjectMeta = { id: newProjectId(), name, created: now, updated: now, group: newGroup() };
  const made: CadDocument = { ...emptyDoc(), features: [feat] };
  try {
    await putProject(meta, made);
  } catch {
    return toast("Could not save in this browser");
  }
  const replace = S.mode.replace;
  endCombine();
  if (replace) {
    // The new part goes where the target was: its origin is the target's, so its place and mates hold.
    partDocs[meta.id] = made;
    partNames[meta.id] = name;
    target.project = meta.id;
    delete target.body;
    sendParts();
    commit();
    S.selectedFeature = target.id;
    renderAll();
  }
  chooseProject(replace ? `${name} took the place of ${target.name}` : `${name} is ready`, [meta], (p) => void openProject(p.id, here));
}
