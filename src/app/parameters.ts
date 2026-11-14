// Parameters: named values used in dimensions, the part's own and the shared ones.
import { M, commit, flushSave, renderAll, resetHistory, saveShared, solver, solverReady, vp } from "../main";
import { section } from "./tools";
import { toggleBarMenu } from "./workspace";
import { partDocs, sendParts } from "./assemblies";
import { S, usedSketchIds } from "./state";
import { asDocument, byName, fmtNum } from "./util";
import { NAME_RE, applyParameters, dropSharedCopies, expressionSlots, hasNames, identifiers, partParameters, renameInExpr, resolveParameters, sharedUsed, usedNames } from "../params";
import { getProject, listProjects, putProject } from "../projects";
import { uid } from "../sketch/model";
import { type CadDocument, type Feature, type Parameter, type SketchFeature } from "../types";
import { icon } from "../ui/icons";
import { openKeypad } from "../ui/keypad";
import { toast } from "../ui/toast";

export function paramScope() {
  return resolveParameters(partParameters(S.doc, M.shared)).scope;
}

/**
 * Brings a part up to date with the shared parameters it uses: they may have changed while
 * another part was open. Left as it is when they no longer fit it. True when it changed.
 */
export function catchUpShared(d: CadDocument): boolean {
  // Its own copy of a shared parameter (same value), left from before it was shared, goes.
  const dropped = dropSharedCopies(d, M.shared);
  // Before the solver is there (at start), done once it is.
  if (!solverReady || !sharedUsed(d, M.shared).length) return dropped;
  const before = JSON.stringify(d);
  const copy = JSON.parse(before) as CadDocument;
  if (applyParameters(copy, solver, M.shared).length) return dropped;
  if (JSON.stringify(copy) === before) return dropped;
  Object.assign(d, copy);
  return true;
}

/** Re-evaluates the whole document after a parameter change; undoes it if something breaks. */
export function applyParamChange(change: () => void) {
  const backup = JSON.stringify(S.doc);
  const sharedBefore = JSON.stringify(M.shared);
  change();
  const problems = applyParameters(S.doc, solver, M.shared);
  if (problems.length) {
    S.doc = JSON.parse(backup);
    M.shared = JSON.parse(sharedBefore);
    toast(problems[0]);
    reloadSketch();
    renderAll();
    return false;
  }
  if (JSON.stringify(M.shared) !== sharedBefore) saveShared();
  reloadSketch();
  commit();
  return true;
}

export const findParam = (id: string) => S.doc.parameters?.find((x) => x.id === id) ?? M.shared.find((x) => x.id === id);
export const isShared = (p: Parameter) => M.shared.some((x) => x.id === p.id);

/** The sketch being edited takes the document's version of it again (after parameters changed it). */
export function reloadSketch() {
  if (S.mode.kind !== "sketch") return;
  const id = S.mode.editor.sk.id;
  const sk = S.doc.features.find((f): f is SketchFeature => f.id === id && f.kind === "sketch");
  if (sk) S.mode.editor.load(sk);
}

/** `among`: the parameters the name must differ from (the part's own, or the shared ones). */
export function askName(title: string, initial: string, except?: string, among = S.doc.parameters ?? []): string | null {
  const name = prompt(title, initial)?.trim();
  if (!name) return null;
  if (!NAME_RE.test(name)) {
    toast("Use letters, digits and _ (not starting with a digit)");
    return null;
  }
  if (among.some((p) => p.name === name && p.name !== except)) {
    toast(`${name} already exists`);
    return null;
  }
  return name;
}

export async function newParameter() {
  const params = (S.doc.parameters ??= []);
  let n = params.length + 1;
  while (params.some((p) => p.name === `p${n}`)) n++;
  const name = askName("Parameter name (e.g. width, wall, hole_d)", `p${n}`);
  if (!name) return;
  const res = await openKeypad({ title: name, subtitle: "New parameter", label: "Value", value: 10, scope: paramScope(), confirmLabel: "Add" }).result;
  if (!res) return;
  const p: Parameter = { id: uid(), name, expr: res.expr ?? String(res.value) };
  if (applyParamChange(() => (S.doc.parameters ??= []).push(p)) && M.shared.some((x) => x.name === name)) toast(`In this part, ${name} is this value instead of the shared one`);
}

export async function editParameter(p: Parameter) {
  const scope = paramScope();
  delete scope[p.name];
  const res = await openKeypad({
    title: p.name,
    subtitle: isShared(p) ? "Shared: every part using it updates" : "Every dimension using it updates",
    label: "Value",
    value: paramScope()[p.name] ?? 0,
    expr: hasNames(p.expr) ? p.expr : undefined,
    scope,
    confirmLabel: "Apply",
  }).result;
  if (!res) return;
  const expr = res.expr ?? String(res.value);
  applyParamChange(() => {
    const live = findParam(p.id);
    if (live) live.expr = expr;
  });
}

export function renameParameter(p: Parameter) {
  if (isShared(p)) return void renameShared(p);
  const name = askName("New name", p.name, p.name);
  if (!name || name === p.name) return;
  for (const slot of expressionSlots(S.doc)) slot.set(renameInExpr(slot.get(), p.name, name));
  const live = S.doc.parameters?.find((x) => x.id === p.id);
  if (live) live.name = name;
  reloadSketch();
  commit();
}

export function deleteParameter(p: Parameter) {
  if (isShared(p)) return void deleteShared(p);
  // It was replacing a shared one here: the part goes back to that one.
  if (M.shared.some((x) => x.name === p.name)) {
    if (applyParamChange(() => (S.doc.parameters = (S.doc.parameters ?? []).filter((x) => x.id !== p.id)))) toast(`${p.name} is the shared value again here`);
    return;
  }
  const used = usedNames(S.doc, p.name).has(p.name);
  if (used && !confirm(`${p.name} is used. Replace it by its current value everywhere?`)) return;
  const value = paramScope()[p.name];
  applyParamChange(() => {
    S.doc.parameters = (S.doc.parameters ?? []).filter((x) => x.id !== p.id);
    for (const slot of expressionSlots(S.doc)) {
      const e = renameInExpr(slot.get(), p.name, value === undefined ? "0" : `(${value})`);
      slot.set(e);
    }
    // Feature values that no longer use any parameter become plain numbers.
    for (const f of S.doc.features) {
      if (f.kind === "sketch") for (const c of f.constraints) if (c.expr && !hasNames(c.expr)) c.expr = undefined;
      if ((f.kind === "extrude" || f.kind === "pushpull") && f.distanceExpr && !hasNames(f.distanceExpr)) f.distanceExpr = undefined;
      if (f.kind === "shell" && f.thicknessExpr && !hasNames(f.thicknessExpr)) f.thicknessExpr = undefined;
    }
  });
}

/** A part's parameter becomes shared: every part can use it. */
export async function shareParameter(p: Parameter) {
  if (M.shared.some((x) => x.name === p.name)) return toast(`A shared ${p.name} exists already`);
  const own = new Set((S.doc.parameters ?? []).map((x) => x.name));
  const local = identifiers(p.expr).find((n) => own.has(n) && n !== p.name);
  if (local) return toast(`${p.name} uses ${local}, which is only in this part: share ${local} first`);
  if (
    !applyParamChange(() => {
      S.doc.parameters = (S.doc.parameters ?? []).filter((x) => x.id !== p.id);
      M.shared.push({ ...p });
    })
  )
    return;
  // Other parts with the same value of their own follow the shared one from now on.
  await flushSave();
  const n = await changeOtherParts((d) => dropSharedCopies(d, M.shared));
  // Other parts changed with it: undoing it here alone would leave them apart.
  if (n) resetHistory();
  toast(`${p.name} is shared: every part can use it${n ? ` · ${n} other part${n > 1 ? "s" : ""} dropped the same value of their own` : ""}`);
}

/**
 * Runs `change` on every other saved part (and on the ones loaded here), saving those it changed.
 * Returns how many changed.
 */
export async function changeOtherParts(change: (d: CadDocument) => boolean): Promise<number> {
  let n = 0;
  const list = await listProjects().catch(() => []);
  for (const meta of list) {
    if (meta.id === S.project?.id || meta.kind === "assembly") continue;
    const got = await getProject(meta.id).catch(() => null);
    const d = got && asDocument(got.doc);
    if (!d || !change(d)) continue;
    n++;
    await putProject(meta, d).catch(() => {});
    if (partDocs[meta.id]) partDocs[meta.id] = d;
  }
  if (n) sendParts();
  return n;
}

/** True when a part uses the shared parameter `name` (a part's own of that name hides it). */
export const usesShared = (d: CadDocument, name: string) => !(d.parameters ?? []).some((x) => x.name === name) && usedNames(d).has(name);

/** Renames a shared parameter, and where every part uses it. */
export async function renameShared(p: Parameter) {
  const name = askName("New name (in every part using it)", p.name, p.name, M.shared);
  if (!name || name === p.name) return;
  const from = p.name;
  const rename = (d: CadDocument) => {
    if (!usesShared(d, from)) return false;
    for (const slot of expressionSlots(d)) slot.set(renameInExpr(slot.get(), from, name));
    return true;
  };
  await flushSave();
  rename(S.doc);
  for (const x of M.shared) x.expr = renameInExpr(x.expr, from, name);
  const live = findParam(p.id);
  if (live) live.name = name;
  saveShared();
  const n = await changeOtherParts(rename);
  reloadSketch();
  commit();
  // Other parts changed with it: undoing it here alone would leave them apart.
  resetHistory();
  if (n) toast(`Renamed in ${n} other part${n > 1 ? "s" : ""} too`);
}

/** Deletes a shared parameter; the parts using it keep its value as a parameter of their own. */
export async function deleteShared(p: Parameter) {
  if (!confirm(`Delete the shared ${p.name}? Parts using it keep its value as a parameter of their own.`)) return;
  const value = resolveParameters(M.shared).scope[p.name];
  const expr = value === undefined ? "0" : String(+value.toFixed(6));
  const keep = (d: CadDocument) => {
    if (!usesShared(d, p.name)) return false;
    (d.parameters ??= []).push({ id: uid(), name: p.name, expr });
    return true;
  };
  await flushSave();
  if (
    !applyParamChange(() => {
      keep(S.doc);
      M.shared = M.shared.filter((x) => x.id !== p.id);
      for (const x of M.shared) x.expr = renameInExpr(x.expr, p.name, `(${expr})`);
    })
  )
    return;
  const n = await changeOtherParts(keep);
  resetHistory();
  if (n) toast(`${n} other part${n > 1 ? "s" : ""} keep${n > 1 ? "" : "s"} ${p.name} = ${expr}`);
}

export function toggleParams() {
  S.showParams = !S.showParams;
  if (S.showParams) {
    S.selectedFeature = null;
    S.selectedFace = null;
    vp.highlightFace(null);
  }
  renderAll();
}

export function renderParamsPanel(el: HTMLElement) {
  const params = S.doc.parameters ?? [];
  const { scope, errors } = resolveParameters(partParameters(S.doc, M.shared));
  // Shared ones show their own value, even where this part has one of the same name.
  const common = resolveParameters(M.shared);
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
  if (!params.length && !M.shared.length) {
    const hint = document.createElement("p");
    hint.className = "p-hint";
    hint.textContent = "Name the values you reuse (width, wall, screw diameter…). Change one, and the whole part follows. Share one to use it in every part.";
    list.appendChild(hint);
  }
  const section = (text: string) => {
    const t = document.createElement("div");
    t.className = "param-section";
    t.textContent = text;
    list.appendChild(t);
  };
  const own = new Set(params.map((p) => p.name));
  const usedIn = new Map<string, HTMLElement>();
  // Shown by name (q_2 before q_10), so families of names stay together; the saved order stays as made.
  const sharedRows = byName(M.shared);
  const ownRows = byName(params);
  const rows: [Parameter, boolean][] = [...sharedRows.map((p): [Parameter, boolean] => [p, true]), ...ownRows.map((p): [Parameter, boolean] => [p, false])];
  for (const [p, isCommon] of rows) {
    if (M.shared.length && p === (isCommon ? sharedRows[0] : ownRows[0])) section(isCommon ? "Shared · every part" : "This part");
    const row = document.createElement("div");
    row.className = "param-row";
    const main = document.createElement("button");
    main.className = "param-main";
    const hidden = isCommon && own.has(p.name);
    if (hidden) main.classList.add("overridden");
    const err = isCommon ? common.errors[p.id] : errors[p.id];
    const val = isCommon ? common.scope[p.name] : scope[p.name];
    main.innerHTML = `<span class="param-name"></span><span class="param-expr"></span><span class="param-val"></span>`;
    main.querySelector(".param-name")!.textContent = p.name;
    main.querySelector(".param-expr")!.textContent = hasNames(p.expr) ? p.expr : "";
    if (hidden) main.title = "This part has its own " + p.name;
    const v = main.querySelector(".param-val")!;
    v.textContent = err ?? (val === undefined ? "?" : fmtNum(val));
    v.classList.toggle("err", !!err);
    main.onclick = () => void editParameter(p);
    // The rarer actions wait behind one button: the value keeps the room.
    const more = document.createElement("button");
    more.className = "param-icon";
    more.innerHTML = icon("more", 20);
    more.title = "Share, rename, delete";
    more.setAttribute("aria-label", `${p.name}: more`);
    more.onclick = () =>
      toggleBarMenu(more, [
        ...(isCommon ? [] : [["Share with every part", () => void shareParameter(p)] as [string, () => void]]),
        ["Rename", () => renameParameter(p)],
        [isCommon ? "Delete (parts keep its value)" : "Delete", () => deleteParameter(p), true],
      ]);
    row.append(main, more);
    list.appendChild(row);
    if (isCommon) {
      // Which parts use it, filled in once they are read.
      const where = document.createElement("div");
      where.className = "param-used";
      where.textContent = "…";
      list.appendChild(where);
      usedIn.set(p.id, where);
    }
  }
  if (usedIn.size) void showSharedUse(usedIn);
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

/** Under each shared parameter, the parts that use it (the open one as it is now, unsaved changes included). */
export async function showSharedUse(rows: Map<string, HTMLElement>) {
  const list = byName(await listProjects().catch(() => []));
  const users = new Map<string, string[]>();
  for (const m of list) {
    const d = m.id === S.project?.id ? S.doc : (await getProject(m.id).catch(() => null))?.doc;
    if (!d) continue;
    for (const p of sharedUsed(d, M.shared)) users.set(p.id, [...(users.get(p.id) ?? []), m.name]);
  }
  for (const [id, el] of rows) {
    if (!el.isConnected) return; // the panel was drawn again meanwhile
    const names = users.get(id) ?? [];
    el.textContent = names.length ? `In ${names.join(", ")}` : "Not used in any part yet";
  }
}

/** The selected sketch, or the last sketch not yet used by a feature. */
export const NEED_SOLID = "Make a solid first (Sketch, then Extrude)";
export const hasSolid = () => S.doc.features.some((f) => f.kind === "extrude" || f.kind === "revolve" || f.kind === "sweep" || f.kind === "loft" || f.kind === "import" || f.kind === "combine");

export function pickSketchForExtrude(): SketchFeature | null {
  if (S.mode.kind === "sketch") return S.mode.editor.sk;
  const sel = S.doc.features.find((f) => f.id === S.selectedFeature);
  if (sel?.kind === "sketch") return sel;
  const used = new Set(S.doc.features.flatMap(usedSketchIds));
  const free = S.doc.features.filter((f): f is SketchFeature => f.kind === "sketch" && !used.has(f.id));
  return free[free.length - 1] ?? null;
}

export function renameFeature(f: Feature) {
  const name = prompt("Name", f.name);
  if (name && name.trim()) {
    f.name = name.trim();
    commit();
  }
}

export function deleteFeature(f: Feature) {
  const dependents = S.doc.features.filter((x) => usedSketchIds(x).includes(f.id));
  S.doc.features = S.doc.features.filter((x) => x !== f && !dependents.includes(x));
  S.selectedFeature = null;
  if (dependents.length) toast(`Also deleted ${dependents.map((d) => d.name).join(", ")}`);
  commit();
}
