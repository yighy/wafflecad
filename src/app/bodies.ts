// Bodies: a part's separate solids, named, hidden, shown alone.
import { M, commit, rebuild, renderAll, vp } from "../main";
import { renderPanel } from "./sidePanel";
import { displayMenuOpen, renderDisplayMenu, renderViewButtons } from "./display";
import { S } from "./state";
import { type Segmented } from "../ui/keypad";

export function setHiddenBodies(ids: Iterable<string>) {
  M.hiddenBodies = new Set(ids);
  vp.setHiddenBodies(M.hiddenBodies);
  renderPanel();
  renderViewButtons();
  if (displayMenuOpen) renderDisplayMenu();
}

export function toggleBody(id: string) {
  const next = new Set(M.hiddenBodies);
  if (!next.delete(id)) next.add(id);
  // Hiding every body would leave nothing to look at: hiding the last one shows the others.
  const all = S.lastBuild?.bodies ?? [];
  if (all.length && all.every((b) => next.has(b.id))) setHiddenBodies(all.filter((b) => b.id !== id).map((b) => b.id));
  else setHiddenBodies(next);
}

/** Shows only that body; again on the same body, shows them all. */
export function isolateBody(id: string) {
  const others = (S.lastBuild?.bodies ?? []).filter((b) => b.id !== id).map((b) => b.id);
  const isolated = !M.hiddenBodies.has(id) && others.every((o) => M.hiddenBodies.has(o));
  setHiddenBodies(isolated ? [] : others);
}

export function anyBodyHidden() {
  return (S.lastBuild?.bodies ?? []).some((b) => M.hiddenBodies.has(b.id));
}

/** The part's bodies started before this step (the ones it can join or cut). */
export function bodiesBefore(featId: string) {
  const at = S.doc.features.findIndex((x) => x.id === featId);
  return (S.lastBuild?.bodies ?? []).filter((b) => {
    const i = S.doc.features.findIndex((x) => x.id === b.id);
    return i >= 0 && (at < 0 || i < at);
  });
}

/**
 * The keypad row choosing a step's body: joining makes a New body or joins one; cutting works on
 * All bodies or one. None while there is no body yet (the first solid is the first body).
 */
export function bodySegment(feat: { id: string; op: string; body?: string }): Segmented[] {
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
export function bodyNote(f: { id: string; op: string; body?: string }) {
  const bodies = S.lastBuild?.bodies ?? [];
  if (bodies.length < 2) return "";
  // A step that starts a body (the first solid too, which has no body setting) is named after it.
  if (f.op === "add") return f.body === "new" || bodies.some((b) => b.id === f.id) ? ` · ${bodyName(f.id)}` : f.body ? ` · into ${bodyName(f.body)}` : "";
  return f.body && f.body !== "new" ? ` · ${bodyName(f.body)} only` : "";
}

export function bodyName(id: string) {
  return S.lastBuild?.bodies?.find((b) => b.id === id)?.name ?? S.doc.bodyNames?.[id] ?? "Body";
}

export function renameBody(id: string) {
  const name = prompt("Body name", bodyName(id))?.trim();
  if (!name) return;
  S.doc.bodyNames = { ...S.doc.bodyNames, [id]: name };
  commit();
  renderAll();
}
