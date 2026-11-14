// The tool column on the left: sketch tools, part tools, assembly tools, as the mode needs.
import { M, PLANE_COLORS, PLANE_NAMES, STD_PLANES, renderAll } from "../main";
import { createSketchOn, escape, pickPlaneValue, placedPlane, startNewSketch } from "./modes";
import { renderStatus } from "./status";
import { startAlign } from "./align";
import { isAssembly, newPartHere, showPartPicker } from "./assemblies";
import { startCombine } from "./combine";
import { explodeTarget, toggleExplode } from "./explode";
import { extrude } from "./extrude";
import { faceTool } from "./faceTools";
import { importDrawing, importStep, insertText } from "./files";
import { filletTool } from "./fillet";
import { startHoles } from "./holes";
import { checkInterference, clearClashes } from "./interference";
import { startMate } from "./mates";
import { endMeasure, measuring, toggleMeasure } from "./measure";
import { hasSolid, pickSketchForExtrude, toggleParams } from "./parameters";
import { patternTool } from "./patterns";
import { applyPrefs, prefs, savePrefs } from "./prefs";
import { revolveTool } from "./revolve";
import { S, isOperation } from "./state";
import { allSketches, startLoft, startSweep } from "./sweepLoft";
import { fmtNum, $ } from "./util";
import { SketchEditor, type SketchToolName } from "../sketch/editor";
import { type SelectMode } from "../sketch/selectModes";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

export const SKETCH_TOOLS: { tool: SketchToolName; icon: string; label: string; key: string }[] = [
  { tool: "select", icon: "select", label: "Select", key: "Esc" },
  { tool: "line", icon: "line", label: "Line", key: "L" },
  { tool: "rect", icon: "rect", label: "Rectangle", key: "R" },
  { tool: "polygon", icon: "polygon", label: "Polygon", key: "N" },
  { tool: "slot", icon: "slot", label: "Slot", key: "O" },
  { tool: "circle", icon: "circle", label: "Circle", key: "C" },
  { tool: "ellipse", icon: "ellipse", label: "Ellipse", key: "E" },
  { tool: "arc", icon: "arc", label: "Arc", key: "A" },
  { tool: "spline", icon: "spline", label: "Spline", key: "S" },
  { tool: "point", icon: "point", label: "Point", key: "P" },
  { tool: "trim", icon: "trim", label: "Trim", key: "T" },
  { tool: "fillet", icon: "fillet", label: "Fillet", key: "F" },
  { tool: "project", icon: "project", label: "Use edges", key: "U" },
];

/** The Select tool's ways of picking: [mode, icon, name, how to use it]. */
export const SELECT_MODES: [SelectMode, string, string, string][] = [
  ["box", "selBox", "Box", "Drag a box: what lies wholly inside is selected"],
  ["crossing", "selCrossing", "Crossing box", "Drag a box: all it touches is selected"],
  ["lasso", "selLasso", "Lasso", "Draw around what to select"],
  ["contour", "selContour", "Contour", "Tap a line: the whole contour it belongs to is selected"],
  ["region", "selRegion", "Region", "Tap inside a closed shape: it is selected with all it holds"],
];

/** The menu of selection modes, unfolded beside the Select tool. */
export function toggleSelectModes(anchor: HTMLElement, ed: SketchEditor) {
  if (closeSelectModes()) return;
  const el = document.createElement("div");
  el.id = "select-modes";
  el.setAttribute("role", "menu");
  for (const [m, ic, name, how] of SELECT_MODES) {
    const b = document.createElement("button");
    b.className = "fly-item" + (m === ed.selectMode ? " on" : "");
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", String(m === ed.selectMode));
    b.innerHTML = `<span class="tile">${icon(ic)}</span><span class="label"></span>`;
    b.querySelector(".label")!.textContent = name;
    b.title = how;
    b.onclick = () => {
      ed.selectMode = prefs.selectMode = m;
      savePrefs();
      closeSelectModes();
      renderTools();
      toast(how);
    };
    el.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  // Just past the card of Select's section, folded or not (the column itself is wider).
  const card = (anchor.closest(".tool-group") ?? anchor).getBoundingClientRect();
  el.style.left = `${Math.max(r.right, card.right) + 8}px`;
  // Its first row level with the Select tool.
  el.style.top = `${r.top}px`;
  document.body.appendChild(el);
  // Below the screen's edge it opens upwards.
  const h = el.getBoundingClientRect().height;
  if (r.top + h > innerHeight - 8) el.style.top = `${Math.max(8, innerHeight - 8 - h)}px`;
  const away = (e: PointerEvent) => {
    if (el.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
    closeSelectModes();
  };
  setTimeout(() => document.addEventListener("pointerdown", away, true));
  (el as HTMLElement & { off?: () => void }).off = () => document.removeEventListener("pointerdown", away, true);
}

export function closeSelectModes() {
  const el = document.getElementById("select-modes") as (HTMLElement & { off?: () => void }) | null;
  if (!el) return false;
  el.off?.();
  el.remove();
  return true;
}

/** `disabled`: why the tool cannot be used now; it stays in place, greyed, and tapping it says why. */
/**
 * `tint`: colour of the icon (the reference planes use their 3D colour); `tag`: a short text
 * under the icon, still readable when the panel is folded to icons.
 */
export function toolRow(
  ic: string,
  label: string,
  run: () => void,
  opts: { active?: boolean; on?: boolean; key?: string; disabled?: string; tint?: string; tag?: string } = {},
) {
  const b = document.createElement("button");
  b.className = "tool";
  if (opts.disabled) {
    b.classList.add("disabled");
    b.setAttribute("aria-disabled", "true");
    const why = opts.disabled;
    run = () => toast(why);
  }
  if (opts.active) b.classList.add("active");
  if (opts.on) b.classList.add("on");
  b.innerHTML = `<span class="tile">${icon(ic)}</span><span class="label"></span>`;
  b.querySelector(".label")!.textContent = label;
  const tile = b.querySelector<HTMLElement>(".tile")!;
  if (opts.tint) tile.style.color = opts.tint;
  if (opts.tag) {
    const t = document.createElement("span");
    t.className = "tile-tag";
    t.textContent = opts.tag;
    tile.appendChild(t);
  }
  holdForName(b, label);
  b.title = opts.key ? `${label} (${opts.key})` : label;
  b.setAttribute("aria-label", label);
  // Any other tool puts the measure away.
  b.onclick = () => {
    if (measuring && run !== toggleMeasure) endMeasure();
    run();
  };
  return b;
}

/**
 * Holding a tool whose label is hidden (panel folded to icons) shows its name in a bubble, and
 * that press does not run the tool. Fingers cannot hover, so this is the way to read the icons.
 */
export function holdForName(b: HTMLElement, name: string) {
  let timer = 0;
  let shown = false;
  const hide = () => {
    clearTimeout(timer);
    document.getElementById("tool-bubble")?.remove();
  };
  b.addEventListener("pointerdown", () => {
    shown = false;
    const label = b.querySelector<HTMLElement>(".label");
    if (label && label.getBoundingClientRect().width > 8) return; // the name is already visible
    timer = window.setTimeout(() => {
      shown = true;
      const r = b.getBoundingClientRect();
      const bubble = document.createElement("div");
      bubble.id = "tool-bubble";
      bubble.textContent = name;
      bubble.style.left = `${r.right + 8}px`;
      bubble.style.top = `${r.top + r.height / 2}px`;
      document.body.appendChild(bubble);
    }, 420);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(ev, hide);
  // A long press only shows the name.
  b.addEventListener(
    "click",
    (e) => {
      if (!shown) return;
      shown = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );
  b.addEventListener("contextmenu", (e) => e.preventDefault());
}

export function section(title: string) {
  const s = document.createElement("div");
  s.className = "section";
  s.textContent = title;
  return s;
}

export function renderTools() {
  const el = $("#tools");
  el.replaceChildren();
  if (S.mode.kind !== "sketch") closeSelectModes();
  // During an operation everything (confirm, cancel, options) is in the right panel.
  el.hidden = isOperation(S.mode);
  if (el.hidden) return;
  const collapse = document.createElement("button");
  collapse.id = "collapse";
  collapse.innerHTML = icon(prefs.collapsed ? "expand" : "collapse", 20);
  collapse.title = prefs.collapsed ? "Show labels" : "Icons only";
  collapse.onclick = () => {
    prefs.collapsed = !prefs.collapsed;
    savePrefs();
    // The same buttons stay, so the fold animates; only this button's icon changes.
    applyPrefs();
    collapse.innerHTML = icon(prefs.collapsed ? "expand" : "collapse", 20);
    collapse.title = prefs.collapsed ? "Show labels" : "Icons only";
    renderStatus();
  };
  el.appendChild(collapse);

  if (S.mode.kind === "sketch") {
    const ed = S.mode.editor;
    el.appendChild(section("Draw"));
    for (const t of SKETCH_TOOLS) {
      if (t.tool === "trim") el.appendChild(section("Modify"));
      if (t.tool === "select") {
        // Select shows its mode; tapped again, it unfolds the other modes.
        const [, ic, name] = SELECT_MODES.find(([m]) => m === ed.selectMode) ?? SELECT_MODES[0];
        const label = ed.selectMode === "box" ? t.label : `${t.label} · ${name.replace(" box", "")}`;
        const b = toolRow(ic, label, () => {
          if (ed.tool === "select") return toggleSelectModes(b, ed);
          closeSelectModes();
          ed.setTool("select");
          renderAll();
        }, { active: ed.tool === "select", key: t.key });
        b.querySelector(".tile")!.classList.add("has-modes");
        b.title = `${label} (${t.key}) — tap again for other ways to select`;
        el.appendChild(b);
        continue;
      }
      el.appendChild(
        toolRow(t.icon, t.label, () => {
          closeSelectModes();
          // Tapping the active tool again puts it down.
          ed.setTool(ed.tool === t.tool ? "select" : t.tool);
          renderAll();
        }, { active: ed.tool === t.tool, key: t.key }),
      );
    }
    el.appendChild(
      toolRow("offset", "Offset", () => {
        if (!ed.selection.size) return toast("Select the lines, arcs or circles to offset first");
        void ed.offsetSelection();
      }),
    );
    el.appendChild(section("Insert"));
    el.appendChild(toolRow("text", "Text", () => void insertText(), { key: "X" }));
    el.appendChild(toolRow("import", "Import DXF / SVG", () => void importDrawing()));
    el.appendChild(section("Options"));
    el.appendChild(toolRow("variable", "Parameters", toggleParams, { active: S.showParams }));
    el.appendChild(
      toolRow("construction", "Construction", () => {
        ed.construction = !ed.construction;
        renderTools();
      }, { on: ed.construction, key: "G" }),
    );
  } else if (S.mode.kind === "pickPlane") {
    const m = S.mode;
    el.appendChild(section("Sketch plane"));
    for (const p of STD_PLANES)
      el.appendChild(toolRow("plane" + p.label, PLANE_NAMES[p.label], () => createSketchOn(placedPlane(p, m)), { tint: PLANE_COLORS[p.label], tag: p.label }));
    el.appendChild(section("Place it"));
    el.appendChild(toolRow("pushpull", m.offset ? `Offset · ${fmtNum(m.offset)} mm` : "Offset…", () => void pickPlaneValue("offset"), { on: !!m.offset }));
    el.appendChild(toolRow("revolve", m.tiltX ? `Tilt X · ${fmtNum(m.tiltX)}°` : "Tilt X…", () => void pickPlaneValue("tiltX"), { on: !!m.tiltX }));
    el.appendChild(toolRow("revolve", m.tiltY ? `Tilt Y · ${fmtNum(m.tiltY)}°` : "Tilt Y…", () => void pickPlaneValue("tiltY"), { on: !!m.tiltY }));
    el.appendChild(toolRow("close", "Cancel", () => escape()));
  } else if (isAssembly()) {
    el.appendChild(section("Parts"));
    el.appendChild(toolRow("plus", "Insert part", () => void showPartPicker(), { key: "I" }));
    el.appendChild(toolRow("part", "New part", () => void newPartHere()));
    if (S.doc.instances?.length) el.appendChild(toolRow("copy", "Copy as part", () => startCombine(true), { active: S.mode.kind === "combine" && S.mode.op === "keep" }));
    el.appendChild(toolRow("import", "Import STEP", () => void importStep()));
    if ((S.doc.instances?.length ?? 0) > 1 || S.mode.kind === "mate") {
      el.appendChild(toolRow("align", "Align", startAlign, { active: S.mode.kind === "align", key: "A" }));
      el.appendChild(toolRow("combine", "Combine", () => startCombine(), { active: S.mode.kind === "combine" && S.mode.op !== "keep", key: "B" }));
      el.appendChild(section("Mates"));
      el.appendChild(toolRow("mate", "Mate", startMate, { active: S.mode.kind === "mate", key: "M" }));
    }
    if (S.doc.instances?.length) {
      el.appendChild(section("Check"));
      el.appendChild(toolRow("measure", "Measure", toggleMeasure, { active: !!measuring, key: "D" }));
      if (S.doc.instances.length > 1) {
        el.appendChild(toolRow("clash", "Interference", () => (M.clashes ? clearClashes() : checkInterference()), { active: !!M.clashes, key: "C" }));
        el.appendChild(toolRow("explode", "Exploded view", toggleExplode, { active: explodeTarget > 0, key: "X" }));
      }
    }
  } else {
    el.appendChild(section("Sketch"));
    el.appendChild(toolRow("sketch", "New sketch", startNewSketch, { key: "S" }));
    // Tools appear as the document grows: a sketch brings Extrude and Revolve, a solid brings
    // the rest. From then on the layout stays put; a tool unavailable for a moment is greyed.
    const anySketch = S.doc.features.some((f) => f.kind === "sketch");
    const solid = hasSolid();
    if (!anySketch && !solid) {
      const hint = document.createElement("p");
      hint.className = "tools-hint";
      hint.textContent = "Start with a sketch: tap New sketch, then a plane.";
      el.appendChild(hint);
    }
    const needSketch = pickSketchForExtrude() ? undefined : "Draw a closed sketch first";
    if (anySketch) {
      el.appendChild(section("Features"));
      el.appendChild(toolRow("extrude", "Extrude", () => void extrude(), { key: "E", disabled: needSketch }));
      el.appendChild(toolRow("revolve", "Revolve", () => void revolveTool(), { key: "V", disabled: needSketch }));
      const two = allSketches().length >= 2 ? undefined : "Draw a second sketch first";
      el.appendChild(toolRow("sweep", "Sweep", () => startSweep(), { active: S.mode.kind === "sweep", disabled: needSketch }));
      el.appendChild(toolRow("loft", "Loft", () => startLoft(), { active: S.mode.kind === "loft", disabled: two }));
    }
    if (solid) {
      // A tool waiting for a face is put down by tapping it again.
      const faceToggle = (tool: NonNullable<typeof S.pendingFaceTool>, start: () => void) => () => {
        if (S.pendingFaceTool !== tool) return start();
        S.pendingFaceTool = null;
        renderAll();
      };
      el.appendChild(toolRow("pushpull", "Press Pull", faceToggle("pushpull", () => faceTool("pushpull")), { active: S.pendingFaceTool === "pushpull", key: "Q" }));
      el.appendChild(toolRow("shell", "Shell", faceToggle("shell", () => faceTool("shell")), { active: S.pendingFaceTool === "shell", key: "K" }));
      el.appendChild(toolRow("fillet", "Fillet / Chamfer", () => void filletTool(), { key: "R" }));
      el.appendChild(toolRow("hole", "Hole", faceToggle("hole", startHoles), { active: S.pendingFaceTool === "hole", key: "H" }));
      el.appendChild(section("Repeat"));
      el.appendChild(toolRow("mirror", "Mirror", () => void patternTool("mirror"), { key: "M" }));
      el.appendChild(toolRow("linear", "Linear pattern", () => void patternTool("linear"), { key: "L" }));
      el.appendChild(toolRow("circular", "Circular pattern", () => void patternTool("circular"), { key: "O" }));
    }
    el.appendChild(section("Design"));
    if (solid) el.appendChild(toolRow("measure", "Measure", toggleMeasure, { active: !!measuring, key: "D" }));
    el.appendChild(toolRow("variable", "Parameters", toggleParams, { active: S.showParams, key: "P" }));
  }
  // Consecutive tools of a section share one icon column; their labels stay separate cards.
  let group: HTMLElement | null = null;
  for (const child of [...el.children]) {
    if (!child.classList.contains("tool")) {
      group = null;
      continue;
    }
    if (!group) {
      group = document.createElement("div");
      group.className = "tool-group";
      child.before(group);
    }
    group.appendChild(child);
  }
  animateNewTools(el);
}

/** Tools (and section titles) shown at the last refresh; null before the first one. */
export let toolsShown: Set<string> | null = null;

/**
 * Only what was not there before slides in (staggered); tools that stay, stay still.
 * A section whose tools are all new comes in as one card.
 */
export function animateNewTools(el: HTMLElement) {
  const keyOf = (e: Element) => (e.classList.contains("tool") ? "tool:" + e.getAttribute("aria-label") : "section:" + e.textContent);
  const items = [...el.querySelectorAll(".tool, .section")];
  const before = toolsShown;
  toolsShown = new Set(items.map(keyOf));
  if (!before) return;
  let n = 0;
  const enter = (e: HTMLElement) => {
    e.style.setProperty("--i", String(n++));
    e.classList.add("pop-in");
    e.addEventListener("animationend", () => e.classList.remove("pop-in"), { once: true });
  };
  for (const child of [...el.children] as HTMLElement[]) {
    if (child.classList.contains("tool-group")) {
      const tools = [...child.children] as HTMLElement[];
      const fresh = tools.filter((t) => !before.has(keyOf(t)));
      if (fresh.length === tools.length) enter(child);
      else fresh.forEach(enter);
    } else if (child.classList.contains("section") && !before.has(keyOf(child))) enter(child);
  }
}
