// The timeline of steps (or an assembly's parts and mates) along the bottom, and how each step is named.
import { M, PLANE_NAMES, STD_PLANES, buttons, renderAll, undoPos, undoStack, vp } from "../main";
import { alignReference, toggleAlignPart } from "./align";
import { isAssembly } from "./assemblies";
import { bodyNote } from "./bodies";
import { combineNames, toggleCombinePart } from "./combine";
import { mateState } from "./mates";
import { endMeasure, measuring } from "./measure";
import { patternSummary, togglePatternFeature } from "./patterns";
import { axisName } from "./revolve";
import { S, isOperation } from "./state";
import { fmtNum, $ } from "./util";
import { type Feature, type SketchFeature } from "../types";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

export function featureDetail(f: Feature) {
  if (f.kind === "sketch") {
    const std = STD_PLANES.find((p) => p.label === f.plane.label);
    const off = std ? (f.plane.origin[0] - std.origin[0]) * std.normal[0] + (f.plane.origin[1] - std.origin[1]) * std.normal[1] + (f.plane.origin[2] - std.origin[2]) * std.normal[2] : 0;
    const tilted = std ? f.plane.normal[0] * std.normal[0] + f.plane.normal[1] * std.normal[1] + f.plane.normal[2] * std.normal[2] < 1 - 1e-9 : false;
    const t = f.plane.tilt;
    const said = t ? [t[0] ? `${fmtNum(t[0])}° X` : "", t[1] ? `${fmtNum(t[1])}° Y` : ""].filter(Boolean).join(", ") : "";
    const extra = `${Math.abs(off) > 1e-9 ? ` · ${fmtNum(off)} mm` : ""}${tilted ? (said ? ` · tilted ${said}` : " · tilted") : ""}`;
    return f.plane.label === "Face" ? "Sketch on a face" : `Sketch on ${PLANE_NAMES[f.plane.label]}${extra}`;
  }
  if (f.kind === "pushpull") return `${f.distance >= 0 ? "Pull" : "Push"} · ${fmtNum(Math.abs(f.distance))} mm`;
  if (f.kind === "shell") return `${fmtNum(f.thickness)} mm walls · ${f.faces.length} open face${f.faces.length > 1 ? "s" : ""}`;
  if (f.kind === "pattern") return patternSummary(f);
  if (f.kind === "revolve") {
    const sk = S.doc.features.find((x): x is SketchFeature => x.id === f.sketchId && x.kind === "sketch");
    const op = f.op === "add" ? "Join" : f.op === "cut" ? "Cut" : "Intersect";
    return `${op} · ${fmtNum(Math.abs(f.angle))}°${f.symmetric ? " symmetric" : ""} around ${sk ? axisName(sk, f.axisLine) : "?"}${bodyNote(f)}`;
  }
  if (f.kind === "hole") {
    const n = f.sketchId ? "at sketch points" : `× ${f.points?.length ?? 0}`;
    const head = f.head === "counterbore" ? " · counterbore" : f.head === "countersink" ? " · countersink" : "";
    return `${f.size} ${n}${head} · ${f.depth > 0 ? `${fmtNum(f.depth)} mm deep` : "through"}`;
  }
  if (f.kind === "import") return `${f.op === "add" ? "Join" : "Cut"} · STEP file${bodyNote(f)}`;
  if (f.kind === "combine") {
    const n = combineNames(f);
    const tools = n.tools.join(", ");
    const what = f.op === "add" ? `${n.target} joined with ${tools}` : f.op === "cut" ? `${n.target} minus ${tools}` : `${n.target} overlap with ${tools}`;
    return `${what}${f.op === "cut" && f.clearance ? ` · ${fmtNum(f.clearance)} mm play` : ""} · from ${n.assembly}${bodyNote(f)}`;
  }
  if (f.kind === "fillet")
    return `${f.mode === "fillet" ? "Radius" : "Chamfer"} ${fmtNum(f.radius)} mm · ${f.edges.length} edge${f.edges.length > 1 ? "s" : ""}`;
  const op = f.op === "add" ? "Join" : f.op === "cut" ? "Cut" : "Intersect";
  const skName = (id: string) => S.doc.features.find((x) => x.id === id)?.name ?? "?";
  if (f.kind === "sweep")
    return f.helix
      ? `${op} · ${skName(f.sketchId)} coiled · ${fmtNum(f.helix.turns)} turns, ${fmtNum(Math.abs(f.helix.pitch))} mm pitch${f.helix.leftHand ? ", left hand" : ""}${bodyNote(f)}`
      : `${op} · ${skName(f.sketchId)} along ${skName(f.pathSketchId)}${bodyNote(f)}`;
  if (f.kind === "loft") return `${op} · through ${f.sketchIds.map(skName).join(", ")}${f.ruled ? " · ruled" : ""}${bodyNote(f)}`;
  return `${op} · ${fmtNum(Math.abs(f.distance))} mm${f.symmetric ? " · symmetric" : ""}${bodyNote(f)}`;
}

export function featureIcon(f: Feature) {
  if (f.kind === "sketch") return "rect";
  if (f.kind === "pushpull") return "pushpull";
  if (f.kind === "shell") return "shell";
  if (f.kind === "fillet") return f.mode === "fillet" ? "fillet" : "chamfer";
  if (f.kind === "hole") return "hole";
  if (f.kind === "pattern") return f.type;
  if (f.kind === "revolve") return "revolve";
  if (f.kind === "sweep") return "sweep";
  if (f.kind === "loft") return "loft";
  if (f.kind === "import") return "import";
  if (f.kind === "combine") return "combine";
  return f.op === "cut" ? "cut" : f.op === "intersect" ? "intersect" : "extrude";
}

/** Steps shown at the last refresh (null before the first one: nothing pops in on load). */
export let chipsShown: Set<string> | null = null;

export function renderTimeline() {
  const el = $("#chips");
  el.replaceChildren();
  if (isAssembly()) return renderPartList(el);
  if (!S.doc.features.length) {
    const e = document.createElement("span");
    e.className = "empty";
    e.textContent = "Your feature history appears here. Start with New sketch.";
    el.appendChild(e);
  }
  const current = S.mode.kind === "sketch" ? S.mode.editor.sk.id : isOperation(S.mode) ? S.mode.feat.id : S.selectedFeature;
  S.doc.features.forEach((f, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "chip-sep";
      sep.innerHTML = icon("chevron", 16);
      el.appendChild(sep);
    }
    const b = document.createElement("button");
    b.className = "chip";
    // A step that was not there at the last refresh pops in.
    if (chipsShown && !chipsShown.has(f.id)) b.classList.add("pop");
    if (f.id === current) b.classList.add("sel");
    if (S.mode.kind === "pattern" && S.mode.feat.featureIds.includes(f.id)) b.classList.add("picked");
    if (S.lastBuild?.errors[f.id]) b.classList.add("error");
    else if (S.lastBuild?.warnings?.[f.id]) b.classList.add("warn");
    b.innerHTML = icon(featureIcon(f), 20) + "<span></span>";
    b.querySelector("span")!.textContent = f.kind === "extrude" ? `${f.name} · ${fmtNum(Math.abs(f.distance))}` : f.name;
    b.onclick = () => {
      if (S.mode.kind === "pattern") return togglePatternFeature(S.mode.feat, f);
      if (S.mode.kind !== "part") return toast("Finish the current step first");
      S.selectedFace = null;
      vp.highlightFace(null);
      S.selectedFeature = S.selectedFeature === f.id ? null : f.id;
      S.showParams = false;
      renderAll();
    };
    el.appendChild(b);
    if (f.id === current) requestAnimationFrame(() => b.scrollIntoView({ inline: "nearest", block: "nearest" }));
  });
  chipsShown = new Set(S.doc.features.map((f) => f.id));
  for (const b of buttons(".undo-btn")) b.disabled = undoPos === 0;
  for (const b of buttons(".redo-btn")) b.disabled = undoPos >= undoStack.length - 1;
}

/** An assembly's timeline: its parts, in the order they were inserted. */
export function renderPartList(el: HTMLElement) {
  const list = S.doc.instances ?? [];
  if (!list.length) {
    const e = document.createElement("span");
    e.className = "empty";
    e.textContent = "The parts of the assembly appear here. Insert one from your projects.";
    el.appendChild(e);
  }
  const current = isOperation(S.mode) ? S.mode.feat.id : S.selectedFeature;
  for (const inst of list) {
    const b = document.createElement("button");
    b.className = "chip";
    if (chipsShown && !chipsShown.has(inst.id)) b.classList.add("pop");
    if (S.mode.kind === "align") {
      if (inst.id === alignReference(S.mode.ids)) b.classList.add("sel");
      else if (S.mode.ids.includes(inst.id)) b.classList.add("picked");
    } else if (S.mode.kind === "combine") {
      if (inst.id === S.mode.target) b.classList.add("sel");
      else if (S.mode.tools.includes(inst.id)) b.classList.add("picked");
    } else if (inst.id === current) b.classList.add("sel");
    if (S.lastBuild?.errors[inst.id]) b.classList.add("error");
    else if (S.lastBuild?.warnings?.[inst.id]) b.classList.add("warn");
    if (M.hiddenBodies.has(inst.id)) b.classList.add("muted");
    b.innerHTML = icon(M.hiddenBodies.has(inst.id) ? "eyeOff" : "part", 20) + "<span></span>";
    b.querySelector("span")!.textContent = inst.name;
    b.onclick = () => {
      if (S.mode.kind === "align") return toggleAlignPart(inst.id);
      if (S.mode.kind === "combine") return toggleCombinePart(inst.id);
      if (S.mode.kind !== "part") return toast("Finish the current step first");
      if (measuring) endMeasure();
      S.selectedFeature = S.selectedFeature === inst.id ? null : inst.id;
      renderAll();
    };
    el.appendChild(b);
    if (inst.id === current) requestAnimationFrame(() => b.scrollIntoView({ inline: "nearest", block: "nearest" }));
  }
  const mates = S.doc.mates ?? [];
  if (mates.length) {
    const sep = document.createElement("span");
    sep.className = "chip-sep";
    el.appendChild(sep);
  }
  const failing = mates.length ? mateState().failing : new Set<string>();
  for (const m of mates) {
    const b = document.createElement("button");
    b.className = "chip";
    if (chipsShown && !chipsShown.has(m.id)) b.classList.add("pop");
    if (m.id === current) b.classList.add("sel");
    if (failing.has(m.id)) b.classList.add("error");
    else if (S.lastBuild?.warnings?.[m.id]) b.classList.add("warn");
    b.innerHTML = icon("mate", 20) + "<span></span>";
    b.querySelector("span")!.textContent = m.kind === "touch" || m.kind === "align" ? (m.value ? `${m.name} · ${fmtNum(m.value)}` : m.name) : m.kind === "angle" ? `${m.name} · ${fmtNum(m.value)}°` : m.name;
    b.onclick = () => {
      if (S.mode.kind !== "part") return toast("Finish the current step first");
      if (measuring) endMeasure();
      S.selectedFeature = S.selectedFeature === m.id ? null : m.id;
      renderAll();
    };
    el.appendChild(b);
  }
  chipsShown = new Set([...list.map((i) => i.id), ...mates.map((m) => m.id)]);
  for (const b of buttons(".undo-btn")) b.disabled = undoPos === 0;
  for (const b of buttons(".redo-btn")) b.disabled = undoPos >= undoStack.length - 1;
}
