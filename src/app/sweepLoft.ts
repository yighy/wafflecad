// Sweep (along a path or a helix) and Loft (through several sketches).
import * as THREE from "three";
import { bodySegment, commit, exitSketch, nextName, paramScope, pickSketchForExtrude, rebuild, renderAll, renderPanel, renderPartOverlays, renderTimeline, toggleBarMenu, vp } from "../main";
import { endMeasure, measuring } from "./measure";
import { S, isOperation, type Mode, usedSketchIds } from "./state";
import { fmtNum } from "./util";
import { sketchLineWorld, uid } from "../sketch/model";
import { findRegions } from "../sketch/profiles";
import { type ExtrudeOp, type LoftFeature, type SketchFeature, type SweepFeature } from "../types";
import { icon } from "../ui/icons";
import { openKeypad } from "../ui/keypad";
import { toast } from "../ui/toast";
import { type Ptr } from "../view/input";

export const allSketches = () => S.doc.features.filter((f): f is SketchFeature => f.kind === "sketch");
/** The feature as it was before editing began (null: it is new, cancelling removes it). */
export let sweepLoftBefore: SweepFeature | LoftFeature | null = null;

/** A profile sketch pushed along a path drawn in another sketch. */
export function startSweep(existing?: SweepFeature) {
  if (isOperation(S.mode) || S.mode.kind === "sweep" || S.mode.kind === "loft") return;
  let f = existing;
  if (!f) {
    const sketches = allSketches();
    if (!sketches.length) return toast("Draw the profile first");
    if (S.mode.kind === "sketch") exitSketch();
    // The profile: the sketch chosen if closed, else the last closed one; the path: the latest other sketch, open if there is one.
    const chosen = pickSketchForExtrude();
    const profile = (chosen && findRegions(chosen).length ? chosen : null) ?? [...sketches].reverse().find((s) => findRegions(s).length) ?? sketches[sketches.length - 1];
    const others = sketches.filter((s) => s.id !== profile.id);
    const path = [...others].reverse().find((s) => !findRegions(s).length);
    // No open path drawn: a coil around the profile's sketch Y axis (a spring standing up when drawn on XZ).
    f = path
      ? { id: uid(), kind: "sweep", name: nextName("Sweep"), sketchId: profile.id, pathSketchId: path.id, op: "add" }
      : { id: uid(), kind: "sweep", name: nextName("Sweep"), sketchId: profile.id, pathSketchId: "", helix: defaultHelix(profile), op: "add" };
    S.doc.features.push(f);
  } else if (S.mode.kind === "sketch") exitSketch();
  sweepLoftBefore = existing ? structuredClone(existing) : null;
  beginSweepLoft({ kind: "sweep", feat: f });
}

/** A coil with room between its turns: the pitch is twice the profile's width. */
export function defaultHelix(profile: SketchFeature): NonNullable<SweepFeature["helix"]> {
  const outer = findRegions(profile)[0]?.outer;
  const width = outer?.kind === "circle" ? 2 * outer.r : outer?.kind === "ellipse" ? 2 * Math.max(outer.ra, outer.rb) : 2;
  return { axisLine: "AY", pitch: Math.max(1, Math.round(width * 2 * 10) / 10), turns: 5, leftHand: false };
}

/** Types a helix's pitch or number of turns. */
export async function helixValue(f: SweepFeature, what: "pitch" | "turns") {
  const h = f.helix;
  if (!h) return;
  const was = { ...h };
  const kp = openKeypad({
    title: f.name,
    subtitle: what === "pitch" ? "Rise per turn" : "How many times it goes round",
    label: what === "pitch" ? "Pitch" : "Turns",
    unit: what === "pitch" ? "mm" : "",
    value: what === "pitch" ? Math.abs(h.pitch) : h.turns,
    scope: paramScope(),
    confirmLabel: "Confirm",
    onInput: (v) => {
      if (!(v > 0)) return;
      if (what === "pitch") h.pitch = Math.sign(h.pitch || 1) * v;
      else h.turns = v;
      rebuild();
    },
  });
  const res = await kp.result;
  if (!res || !(res.value > 0)) Object.assign(h, was);
  else if (what === "pitch") h.pitch = Math.sign(h.pitch || 1) * res.value;
  else h.turns = res.value;
  rebuild();
  renderPanel();
  renderTimeline();
}

/** A solid through two or more sketches, in order. */
export function startLoft(existing?: LoftFeature) {
  if (isOperation(S.mode) || S.mode.kind === "sweep" || S.mode.kind === "loft") return;
  let f = existing;
  if (!f) {
    const sketches = allSketches();
    if (sketches.length < 2) return toast("Draw two sketches on different planes first");
    if (S.mode.kind === "sketch") exitSketch();
    // The last two sketches not used yet, else the last two.
    const used = new Set(S.doc.features.flatMap(usedSketchIds));
    const free = sketches.filter((s) => !used.has(s.id));
    const pick = (free.length >= 2 ? free : sketches).slice(-2);
    f = { id: uid(), kind: "loft", name: nextName("Loft"), sketchIds: pick.map((s) => s.id), ruled: false, op: "add" };
    S.doc.features.push(f);
  } else if (S.mode.kind === "sketch") exitSketch();
  sweepLoftBefore = existing ? structuredClone(existing) : null;
  beginSweepLoft({ kind: "loft", feat: f });
}

export function beginSweepLoft(m: Extract<Mode, { kind: "sweep" | "loft" }>) {
  if (measuring) endMeasure();
  S.selectedFeature = m.feat.id;
  S.selectedFace = null;
  S.showParams = false;
  vp.highlightFace(null);
  S.mode = m;
  renderAll();
  rebuild(true);
}

/** Confirm keeps the step as set; Cancel puts it back as it was, or removes it if it is new. */
export function endSweepLoft(keep: boolean) {
  if (S.mode.kind !== "sweep" && S.mode.kind !== "loft") return;
  const f = S.mode.feat;
  if (keep && f.kind === "loft" && f.sketchIds.length < 2) return toast("Choose at least two sketches");
  if (keep && f.kind === "sweep" && !f.helix && (!f.pathSketchId || f.sketchId === f.pathSketchId)) return toast("Choose a path: another sketch than the profile");
  S.mode = { kind: "part" };
  if (keep) return commit();
  if (sweepLoftBefore) Object.assign(f, sweepLoftBefore);
  else {
    S.doc.features = S.doc.features.filter((x) => x !== f);
    S.selectedFeature = null;
  }
  sweepLoftBefore = null;
  rebuild(true);
  renderAll();
}

export function renderSweepLoftPanel(el: HTMLElement, head: (title: string, sub?: string, err?: boolean) => void, actions: (items: [string, string, () => void, string?][]) => void) {
  if (S.mode.kind !== "sweep" && S.mode.kind !== "loft") return;
  const f = S.mode.feat;
  const err = S.lastBuild?.errors[f.id];
  head(f.name, err ?? (f.kind === "sweep" ? (f.helix ? "A profile coiled around an axis" : "A profile pushed along a path") : "A solid through the sketches, in their order"), !!err);
  const sketches = allSketches();
  const nameOf = (id: string) => sketches.find((s) => s.id === id)?.name ?? "Missing sketch";
  const changed = () => {
    rebuild();
    renderPanel();
    renderTimeline();
    renderPartOverlays();
  };
  const row = (label: string, ...items: HTMLElement[]) => {
    const r = document.createElement("div");
    r.className = "align-row sl-row";
    r.innerHTML = "<span></span>";
    r.querySelector("span")!.textContent = label;
    r.append(...items);
    el.appendChild(r);
  };
  // A sketch chosen in a list: the ones taken elsewhere in this step are left out.
  const picker = (current: string | null, taken: string[], pick: (id: string) => void) => {
    const b = document.createElement("button");
    b.className = "pick" + (current ? "" : " empty");
    b.innerHTML = `<span></span>${icon("chevron", 16)}`;
    b.querySelector("span")!.textContent = current ? nameOf(current) : "Choose a sketch…";
    b.onclick = () => {
      const choices = sketches.filter((s) => !taken.includes(s.id) && s.id !== current);
      if (!choices.length) return toast("No other sketch to choose");
      toggleBarMenu(b, choices.map((s): [string, () => void] => [s.name, () => pick(s.id)]));
    };
    return b;
  };
  const segRow = (label: string, options: { value: string; label: string }[], get: () => string, set: (v: string) => void) => {
    const seg = document.createElement("div");
    seg.className = "seg";
    for (const o of options) {
      const b = document.createElement("button");
      b.textContent = o.label;
      b.classList.toggle("on", get() === o.value);
      b.onclick = () => {
        set(o.value);
        changed();
      };
      seg.appendChild(b);
    }
    row(label, seg);
  };
  if (f.kind === "sweep") {
    row("Profile", picker(f.sketchId, f.helix ? [] : [f.pathSketchId], (id) => void ((f.sketchId = id), changed())));
    segRow("Along", [{ value: "path", label: "A drawn path" }, { value: "helix", label: "A helix" }], () => (f.helix ? "helix" : "path"), (v) => {
      if (v === "helix" && !f.helix) {
        const sk = sketches.find((s) => s.id === f.sketchId);
        f.helix = sk ? defaultHelix(sk) : { axisLine: "AY", pitch: 5, turns: 5, leftHand: false };
      } else if (v === "path") {
        delete f.helix;
        if (!f.pathSketchId || f.pathSketchId === f.sketchId) f.pathSketchId = sketches.find((s) => s.id !== f.sketchId && !findRegions(s).length)?.id ?? "";
      }
    });
    const h = f.helix;
    if (!h) row("Path", picker(f.pathSketchId || null, [f.sketchId], (id) => void ((f.pathSketchId = id), changed())));
    else {
      // The axis: one of the profile sketch's axes, or a line drawn in it (as for a revolve).
      const profile = sketches.find((s) => s.id === f.sketchId);
      const lines = (profile?.entities ?? []).filter((e) => e.type === "line" && !e.axis);
      const axisLabel = h.axisLine === "AX" ? "Sketch X" : h.axisLine === "AY" ? "Sketch Y" : "A drawn line";
      const ax = document.createElement("button");
      ax.className = "pick";
      ax.innerHTML = `<span></span>${icon("chevron", 16)}`;
      ax.querySelector("span")!.textContent = axisLabel;
      ax.onclick = () =>
        toggleBarMenu(ax, [
          ["Sketch X", () => void ((h.axisLine = "AX"), changed())],
          ["Sketch Y", () => void ((h.axisLine = "AY"), changed())],
          ...lines.map((l, i): [string, () => void] => [`${l.type === "line" && l.construction ? "Construction line" : "Line"} ${i + 1}`, () => void ((h.axisLine = l.id), changed())]),
        ]);
      row("Axis", ax);
      const value = (text: string, run: () => void) => {
        const b = document.createElement("button");
        b.className = "pick";
        b.innerHTML = `<span></span>${icon("chevron", 16)}`;
        b.querySelector("span")!.textContent = text;
        b.onclick = run;
        return b;
      };
      row("Pitch", value(`${fmtNum(Math.abs(h.pitch))} mm per turn`, () => void helixValue(f, "pitch")));
      row("Turns", value(`${fmtNum(h.turns)} · ${fmtNum(Math.abs(h.pitch) * h.turns)} mm long`, () => void helixValue(f, "turns")));
      segRow("Hand", [{ value: "right", label: "Right" }, { value: "left", label: "Left" }], () => (h.leftHand ? "left" : "right"), (v) => (h.leftHand = v === "left"));
      segRow("Goes", [{ value: "up", label: "Along the axis" }, { value: "down", label: "The other way" }], () => (h.pitch < 0 ? "down" : "up"), (v) => (h.pitch = (v === "down" ? -1 : 1) * Math.abs(h.pitch)));
    }
  } else {
    f.sketchIds.forEach((id, i) => {
      const drop = document.createElement("button");
      drop.className = "drop";
      drop.innerHTML = icon("close", 18);
      drop.setAttribute("aria-label", `Remove ${nameOf(id)}`);
      drop.onclick = () => {
        f.sketchIds.splice(i, 1);
        changed();
      };
      // Two are the least a loft can have: one of them cannot be dropped, only replaced.
      row(String(i + 1), picker(id, f.sketchIds, (next) => void ((f.sketchIds[i] = next), changed())), ...(f.sketchIds.length > 2 ? [drop] : []));
    });
    if (f.sketchIds.length < sketches.length) row("", picker(null, f.sketchIds, (id) => void (f.sketchIds.push(id), changed())));
    segRow("Surface", [{ value: "smooth", label: "Smooth" }, { value: "ruled", label: "Ruled" }], () => (f.ruled ? "ruled" : "smooth"), (v) => (f.ruled = v === "ruled"));
  }
  segRow("Result", [{ value: "add", label: "Join" }, { value: "cut", label: "Cut" }, { value: "intersect", label: "Intersect" }], () => f.op, (v) => (f.op = v as ExtrudeOp));
  for (const s of bodySegment(f)) segRow("Body", s.options, s.get, s.set);
  const hint = document.createElement("p");
  hint.className = "p-hint";
  hint.textContent =
    f.kind === "sweep"
      ? f.helix
        ? "The profile winds around the axis, at the distance it is drawn from it: for a spring, draw a small circle on XZ beside the sketch Y axis. Keep the pitch wider than the profile so the turns do not touch."
        : "Draw the profile across the start of the path, on a plane facing along it. The path is one chain of lines, arcs or curves; a bend tighter than the profile is wide cannot be swept."
      : "Each sketch gives one closed outline; the solid goes from the first to the last. Sketches on offset planes, one above the other, loft best.";
  el.appendChild(hint);
  actions([
    ["close", "Cancel", () => endSweepLoft(false)],
    ["check", "Confirm", () => endSweepLoft(true), "primary"],
  ]);
}

/** A line of the sketch near a screen point (drawn and construction lines). */
export function pickSketchLine(sk: SketchFeature, p: Ptr): string | null {
  const R = p.kind === "touch" ? 24 : p.kind === "pen" ? 14 : 9;
  let best: { id: string; d: number } | null = null;
  for (const e of sk.entities) {
    if (e.type !== "line" || e.axis) continue;
    const [a, b] = sketchLineWorld(sk, e.id).map((q) => vp.toScreen(new THREE.Vector3(...q)));
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L2)) : 0;
    const d = Math.hypot(a[0] + t * dx - p.x, a[1] + t * dy - p.y);
    if (d < R && (!best || d < best.d)) best = { id: e.id, d };
  }
  return best?.id ?? null;
}
