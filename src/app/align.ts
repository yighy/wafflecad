// Align: line an assembly's parts up, spread them evenly, put them on the plate.
import * as THREE from "three";
import { M, buttons, commit, renderAll, vp } from "../main";
import { applyMove, instanceOf } from "./assemblies";
import { applyMates, partLabel } from "./mates";
import { clearClashes } from "./interference";
import { endMeasure, measuring } from "./measure";
import { S, isOperation } from "./state";
import { toast } from "../ui/toast";

/** Moves made by Align that the next build has not drawn yet (so taps in a row add up). */
export const alignShift = new Map<string, THREE.Vector3>();

export function startAlign() {
  if (isOperation(S.mode)) return;
  if ((S.doc.instances?.length ?? 0) < 2) return toast("Insert at least two parts first");
  if (S.mode.kind === "align") return endAlign();
  if (measuring) endMeasure();
  if (M.clashes) clearClashes();
  // The selected part, if any, is the one the others line up with.
  const first = instanceOf(S.selectedFeature);
  S.mode = { kind: "align", ids: first ? [first.id] : [] };
  S.selectedFeature = null;
  showAlignPicks();
  renderAll();
}

export function endAlign() {
  S.mode = { kind: "part" };
  vp.highlightFaces([]);
  renderAll();
}

export function toggleAlignPart(id: string) {
  if (S.mode.kind !== "align") return;
  const ids = S.mode.ids;
  const i = ids.indexOf(id);
  if (i >= 0) ids.splice(i, 1);
  else ids.push(id);
  showAlignPicks();
  renderAll();
}

export function showAlignPicks() {
  if (S.mode.kind !== "align") return;
  const ids = new Set(S.mode.ids);
  vp.highlightFaces((S.lastBuild?.bodies ?? []).filter((b) => ids.has(b.id)).flatMap((b) => b.faceIds));
}

/** A part's box where it is drawn (moves waiting for a build are already drawn). */
export const alignBox = (id: string) => vp.bodyBox(id);

/** The part the others line up with: a fixed one among those chosen, else the first chosen. */
export function alignReference(ids: string[]) {
  return ids.find((id) => instanceOf(id)?.fixed) ?? ids[0];
}

/**
 * Slides parts by the given amounts (fixed ones stay, unless `rigid`: whole mated pieces moving
 * as one), lets the mates have their say, and saves.
 */
export function shiftParts(moves: Map<string, THREE.Vector3>, rigid = false) {
  let held = 0;
  for (const [id, d] of moves) {
    const inst = instanceOf(id);
    if (!inst || d.lengthSq() < 1e-12) continue;
    if (inst.fixed && !rigid) {
      held++;
      continue;
    }
    applyMove(inst, new THREE.Matrix4().makeTranslation(d));
    alignShift.set(id, (alignShift.get(id) ?? new THREE.Vector3()).add(d));
  }
  if (held) toast(`${held} fixed part${held > 1 ? "s" : ""} stayed put`);
  applyMates();
  vp.moveBodies(new Map([...alignShift].map(([id, d]) => [id, new THREE.Matrix4().makeTranslation(d)])));
  commit();
}

export const AXIS_INDEX = { X: 0, Y: 1, Z: 2 } as const;

/** Lines the chosen parts up with the reference one, on one axis: their min, centre or max. */
export function alignParts(axis: keyof typeof AXIS_INDEX, where: "min" | "mid" | "max") {
  if (S.mode.kind !== "align" || S.mode.ids.length < 2) return toast("Choose at least two parts");
  const k = AXIS_INDEX[axis];
  const at = (b: THREE.Box3) => (where === "min" ? b.min.getComponent(k) : where === "max" ? b.max.getComponent(k) : (b.min.getComponent(k) + b.max.getComponent(k)) / 2);
  const ref = alignReference(S.mode.ids);
  const rb = alignBox(ref);
  if (!rb) return;
  const moves = new Map<string, THREE.Vector3>();
  for (const id of S.mode.ids) {
    const b = alignBox(id);
    if (id === ref || !b) continue;
    moves.set(id, new THREE.Vector3().setComponent(k, at(rb) - at(b)));
  }
  shiftParts(moves);
}

/** Spreads three or more parts evenly on one axis: the two at the ends stay, the gaps match. */
export function distributeParts(axis: keyof typeof AXIS_INDEX) {
  if (S.mode.kind !== "align" || S.mode.ids.length < 3) return toast("Choose at least three parts");
  const k = AXIS_INDEX[axis];
  const parts = S.mode.ids.flatMap((id) => {
    const b = alignBox(id);
    return b ? [{ id, lo: b.min.getComponent(k), hi: b.max.getComponent(k) }] : [];
  });
  parts.sort((a, b) => a.lo + a.hi - (b.lo + b.hi));
  const span = parts[parts.length - 1].hi - parts[0].lo;
  const gap = (span - parts.reduce((s, p) => s + p.hi - p.lo, 0)) / (parts.length - 1);
  const moves = new Map<string, THREE.Vector3>();
  let x = parts[0].lo;
  for (const p of parts) {
    moves.set(p.id, new THREE.Vector3().setComponent(k, x - p.lo));
    x += p.hi - p.lo + gap;
  }
  shiftParts(moves);
}

/** Puts each chosen part (all of them if none is chosen) on the plate: its bottom at z = 0. */
export function dropParts() {
  if (S.mode.kind !== "align") return;
  const ids = S.mode.ids.length ? S.mode.ids : (S.doc.instances ?? []).map((i) => i.id);
  // Parts held together by mates go down as one piece (a cube under another stays under it,
  // fixed one included): only the lowest of them comes to rest on the plate.
  const moves = new Map<string, THREE.Vector3>();
  for (const group of matedGroups(ids)) {
    const box = new THREE.Box3();
    for (const id of group) {
      const b = alignBox(id);
      if (b) box.union(b);
    }
    if (box.isEmpty()) continue;
    for (const id of group) moves.set(id, new THREE.Vector3(0, 0, -box.min.z));
  }
  shiftParts(moves, true);
}

/** `ids` split into the sets of parts that mates join (directly or through other parts). */
export function matedGroups(ids: string[]): string[][] {
  const all = (S.doc.instances ?? []).map((i) => i.id);
  const root = new Map(all.map((id) => [id, id]));
  const find = (id: string): string => {
    while (root.get(id) !== id) id = root.get(id)!;
    return id;
  };
  for (const m of S.doc.mates ?? []) if (root.has(m.a.part) && root.has(m.b.part)) root.set(find(m.a.part), find(m.b.part));
  // A chosen part brings the whole piece it belongs to.
  const groups = new Map<string, string[]>();
  for (const id of all) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  const chosen = new Set(ids.map(find));
  return [...groups].filter(([r]) => chosen.has(r)).map(([, g]) => g);
}

export function renderAlignPanel(el: HTMLElement, head: (title: string, sub?: string) => void, actions: (items: [string, string, () => void, string?][]) => void) {
  if (S.mode.kind !== "align") return;
  const ids = S.mode.ids;
  const ref = alignReference(ids);
  head("Align", ids.length ? `${ids.length} part${ids.length > 1 ? "s" : ""} · ${partLabel(ref)} stays put` : "Tap the parts to line up");
  const row = (label: string, buttons: [string, () => void, boolean][]) => {
    const r = document.createElement("div");
    r.className = "align-row";
    r.innerHTML = "<span></span>";
    r.querySelector("span")!.textContent = label;
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const [text, run, ok] of buttons) {
      const b = document.createElement("button");
      b.textContent = text;
      b.disabled = !ok;
      b.onclick = run;
      seg.appendChild(b);
    }
    r.appendChild(seg);
    el.appendChild(r);
  };
  const two = ids.length >= 2;
  for (const axis of ["X", "Y", "Z"] as const)
    row(axis, [
      ["Min", () => alignParts(axis, "min"), two],
      ["Centre", () => alignParts(axis, "mid"), two],
      ["Max", () => alignParts(axis, "max"), two],
    ]);
  const three = ids.length >= 3;
  row("↔", [
    ["Spread X", () => distributeParts("X"), three],
    ["Spread Y", () => distributeParts("Y"), three],
    ["Spread Z", () => distributeParts("Z"), three],
  ]);
  const hint = document.createElement("p");
  hint.className = "p-hint";
  hint.textContent = "Tap parts in the view or below to choose them. Spread needs three: the two at the ends stay.";
  el.appendChild(hint);
  actions([
    ["extrude", ids.length ? "Put them on the plate" : "Put all on the plate", dropParts],
    ["check", "Done", endAlign, "primary"],
  ]);
}
