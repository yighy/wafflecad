// What the side panel shows: the sketch's selection and constraints, a feature, a face, a part, a mate.
import { M, commit, openProject, renderAll, vp } from "../main";
import { clearPartSelection, createSketchOn, enterSketch, exitSketch } from "./modes";
import { featureDetail } from "./timeline";
import { renderAlignPanel } from "./align";
import { duplicateInstance, instanceOf, isAssembly, openPart, partDocs, partNames, removeInstance, renameInstance, showPartPicker } from "./assemblies";
import { bodiesBefore, isolateBody, renameBody, toggleBody } from "./bodies";
import { COMBINE_NAMES, combineRows, renderCombinePanel } from "./combine";
import { extrude } from "./extrude";
import { pushPull, shell } from "./faceTools";
import { filletTool } from "./fillet";
import { holeTool } from "./holes";
import { clearClashes, placeTool } from "./interference";
import { deleteMate, flipMate, mateOf, mateState, mateTool, partLabel, startMate, toggleFixed } from "./mates";
import { endMeasure, measuring, renderMeasurePanel } from "./measure";
import { deleteFeature, renameFeature, renderParamsPanel } from "./parameters";
import { patternTool } from "./patterns";
import { prefs, savePrefs } from "./prefs";
import { revolveTool } from "./revolve";
import { S, isOperation } from "./state";
import { renderSweepLoftPanel, startLoft, startSweep } from "./sweepLoft";
import { fmtNum, $ } from "./util";
import { SketchEditor, type Action } from "../sketch/editor";
import { constraintLabel } from "../sketch/model";
import { DIMENSION_TYPES, type SkEntity } from "../types";
import { playEnter } from "../ui/enter";
import { icon } from "../ui/icons";

/** Right panel: what can be done with the current selection. */
export function renderPanel() {
  const el = $("#panel-content");
  el.replaceChildren();
  // Animate when the kind of panel changes, not when the same kind shows another face or step.
  const what =
    S.mode.kind === "sketch"
      ? `sketch:${S.mode.editor.sk.id}`
      : isOperation(S.mode) || S.mode.kind === "sweep" || S.mode.kind === "loft"
        ? `op:${S.mode.feat.id}`
        : measuring
          ? "measure"
          : S.showParams
          ? "params"
          : S.selectedFace
            ? "face"
            : S.selectedFeature
              ? "feature"
              : "none";
  playEnter("panel", what, el);
  const head = (title: string, sub = "", err = false, closable = false) => {
    const h = document.createElement("div");
    h.className = "p-head";
    h.innerHTML = `<div><div class="p-title"></div><div class="p-sub"></div></div>`;
    h.querySelector(".p-title")!.textContent = title;
    const s = h.querySelector(".p-sub")!;
    s.textContent = sub;
    s.classList.toggle("err", err);
    if (closable) {
      const x = document.createElement("button");
      x.className = "p-close";
      x.innerHTML = icon("close", 20);
      x.setAttribute("aria-label", "Close");
      x.onclick = clearPartSelection;
      h.appendChild(x);
    }
    el.appendChild(h);
  };
  const actions = (items: [string, string, () => void, string?][]) => {
    const box = document.createElement("div");
    box.className = "p-actions";
    for (const [ic, label, run, cls] of items) {
      const b = document.createElement("button");
      b.innerHTML = icon(ic, 20) + "<span></span>";
      b.querySelector("span")!.textContent = label;
      if (cls) b.className = cls;
      b.onclick = run;
      box.appendChild(b);
    }
    el.appendChild(box);
  };

  if (S.mode.kind === "sketch") {
    if (S.showParams) return renderParamsPanel(el);
    const ed = S.mode.editor;
    head(ed.sk.name, dofText(ed.dof));
    const acts = ed.actions();
    if (ed.tool === "line")
      acts.unshift({ id: "endline", label: "⏎", title: "End line", key: "Enter", run: () => ed.escape() });
    if (ed.tool === "polygon") {
      const n = ed.polygonSides;
      const sides = (k: number) => () => {
        ed.polygonSides = Math.min(24, Math.max(3, n + k));
        renderPanel();
      };
      acts.unshift(
        { id: "sides-", label: "−", title: `${Math.max(3, n - 1)} sides`, run: sides(-1) },
        { id: "sides+", label: "+", title: `${Math.min(24, n + 1)} sides`, run: sides(1) },
      );
    }
    if (ed.tool === "spline" && ed.pending >= 2)
      acts.unshift({ id: "endspline", label: "⏎", title: "Finish spline", key: "Enter", run: () => ed.escape() });
    if (acts.length) {
      const grid = document.createElement("div");
      grid.className = "p-grid";
      for (const a of acts) grid.appendChild(actionTile(a));
      el.appendChild(grid);
      const sole = ed.tool === "select" ? ed.soleSelected() : null;
      if (sole) renderConstraintList(el, ed, sole);
      if (ed.tool === "polygon") {
        const hint = document.createElement("p");
        hint.className = "p-hint";
        hint.textContent = `${ed.polygonSides} sides. Tap the centre, then a corner.`;
        el.appendChild(hint);
      }
    } else {
      const hint = document.createElement("p");
      hint.className = "p-hint";
      hint.textContent =
        ed.tool === "select"
          ? "Tap lines, circles or points to constrain them. Drag a point to move it."
          : ed.tool === "trim"
            ? "Press a piece of a curve: it turns red, and goes when you lift, up to the nearest crossings."
            : ed.tool === "fillet"
              ? "Tap the corner point between two lines, then type the radius."
              : ed.tool === "project"
                ? "Tap edges of the model: each one is added to the sketch, flattened onto its plane and fixed."
                : ed.tool === "slot"
                  ? "Tap the two centres, then how wide."
                  : ed.tool === "ellipse"
                    ? "Tap the centre, the end of an axis, then how wide."
          : "Tap or drag to draw. Points snap to existing geometry.";
      el.appendChild(hint);
    }
    actions([["check", "Finish sketch", exitSketch, "primary"]]);
    return;
  }
  if (S.mode.kind === "align") return renderAlignPanel(el, head, actions);
  if (S.mode.kind === "combine") return renderCombinePanel(el, head, actions);
  if (S.mode.kind === "sweep" || S.mode.kind === "loft") return renderSweepLoftPanel(el, head, actions);
  if (S.mode.kind === "mate") {
    const n = S.mode.picks.length;
    head("New mate", n ? `On ${partLabel(S.mode.picks[0].ref.part)} · now the other part` : "Tap a face or a hole of a part");
    const hint = document.createElement("p");
    hint.className = "p-hint";
    hint.textContent = n
      ? "Tap the face or hole of the other part that goes onto it."
      : "Two flat faces: they meet, flush or at an angle. Two holes, pins or round edges: they share an axis.";
    el.appendChild(hint);
    actions([["close", "Cancel", () => startMate()]]);
    return;
  }
  if (S.mode.kind !== "part") return;
  if (measuring) {
    head("Measure", "", false);
    renderMeasurePanel(el);
    actions([["check", "Done", endMeasure, "primary"]]);
    return;
  }
  if (S.showParams) return renderParamsPanel(el);

  if (isAssembly() && M.clashes) {
    const c = M.clashes;
    const n = c.list.length;
    head("Interference", c.running ? "Checking every pair of parts…" : c.error ? "The check failed" : n ? `${n} overlap${n > 1 ? "s" : ""}, in red` : "No parts overlap", !!c.error || n > 0);
    if (c.list.length) {
      const box = document.createElement("div");
      box.className = "p-measure";
      for (const x of c.list) {
        const row = document.createElement("div");
        row.innerHTML = "<span></span><b></b>";
        row.querySelector("span")!.textContent = `${partLabel(x.a)} and ${partLabel(x.b)}`;
        row.querySelector("b")!.textContent = `${fmtNum(x.volume)} mm³`;
        box.appendChild(row);
      }
      el.appendChild(box);
    }
    if (!c.running && M.hiddenBodies.size) {
      const hint = document.createElement("p");
      hint.className = "p-hint";
      hint.textContent = "Hidden parts were left out.";
      el.appendChild(hint);
    }
    actions([["check", "Done", clearClashes, "primary"]]);
    return;
  }
  if (isAssembly()) {
    const mate = mateOf(S.selectedFeature);
    if (mate) {
      const failing = mateState().failing.has(mate.id);
      const err = failing ? "Cannot hold with the other mates" : S.lastBuild?.warnings?.[mate.id];
      const unitOf = mate.kind === "angle" ? "°" : " mm";
      const how =
        mate.kind === "axis"
          ? "same axis"
          : mate.min !== undefined && mate.max !== undefined
            ? `between ${fmtNum(mate.min)} and ${fmtNum(mate.max)}${unitOf}`
            : mate.kind === "angle"
              ? `${fmtNum(mate.value)}°`
              : mate.value
                ? `${fmtNum(mate.value)} mm apart`
                : mate.kind === "touch"
                  ? "in contact"
                  : "flush";
      head(mate.name, err ?? `${partLabel(mate.a.part)} and ${partLabel(mate.b.part)} · ${how}`, !!err, true);
      const items: [string, string, () => void, string?][] = [];
      if (mate.kind !== "axis") items.push(["edit", "Edit", () => void mateTool(mate)]);
      if (mate.kind === "touch" || mate.kind === "align") items.push(["flip", mate.kind === "touch" ? "Make it flush" : "Make them face", () => flipMate(mate)]);
      items.push(["trash", "Delete", () => deleteMate(mate), "danger"]);
      actions(items);
      return;
    }
    const inst = instanceOf(S.selectedFeature);
    if (!inst) {
      if (S.doc.instances?.length) {
        const st = mateState();
        head(S.project?.name ?? "Assembly", st.failing.size ? `${st.failing.size} mate${st.failing.size > 1 ? "s" : ""} cannot hold` : st.dof ? `${st.dof} degree${st.dof > 1 ? "s" : ""} of freedom left` : "Fully placed", st.failing.size > 0);
        const hint = document.createElement("p");
        hint.className = "p-hint";
        hint.textContent = "Tap a part to move it. Mate ties two parts: tap a face or hole on each.";
        el.appendChild(hint);
        return;
      }
      head(S.project?.name ?? "Assembly", "No parts yet");
      const hint = document.createElement("p");
      hint.className = "p-hint";
      hint.textContent = "Insert parts from your other projects, then drag the arrows and rings to place them.";
      el.appendChild(hint);
      actions([["plus", "Insert part", () => void showPartPicker(), "primary"]]);
      return;
    }
    const err = S.lastBuild?.errors[inst.id] ?? S.lastBuild?.warnings?.[inst.id];
    const where = `${inst.at.map(fmtNum).join(", ")} mm${inst.rot.some((r) => r) ? ` · turned ${inst.rot.map((r) => fmtNum(r) + "°").join(", ")}` : ""}`;
    head(inst.name, err ?? `${inst.fixed ? "Fixed · " : ""}${partNames[inst.project] ?? "Missing project"}${inst.body ? " (one body)" : ""} · ${where}`, !!err, true);
    const hidden = M.hiddenBodies.has(inst.id);
    const items: [string, string, () => void, string?][] = [
      ["edit", "Position…", () => void placeTool(inst)],
      ["lookAt", inst.fixed ? "Let it move" : "Fix in place", () => toggleFixed(inst)],
      ["copy", "Duplicate", () => duplicateInstance(inst)],
      ["rename", "Rename", () => renameInstance(inst)],
      [hidden ? "eye" : "eyeOff", hidden ? "Show" : "Hide", () => toggleBody(inst.id)],
    ];
    if ((S.lastBuild?.bodies?.length ?? 0) > 1) {
      const others = S.lastBuild!.bodies!.filter((b) => b.id !== inst.id);
      const isolated = !hidden && others.every((b) => M.hiddenBodies.has(b.id));
      items.push(["eye", isolated ? "Show all parts" : "Show only this part", () => isolateBody(inst.id)]);
    }
    if (partDocs[inst.project]) items.push(["folder", "Open the part", () => void openPart(inst)]);
    items.push(["trash", "Remove", () => removeInstance(inst), "danger"]);
    actions(items);
    return;
  }

  if (S.selectedFace) {
    const plane = S.selectedFace.plane;
    head("Face", plane ? "Flat face" : "Curved face", false, true);
    const items: [string, string, () => void, string?][] = [];
    if (plane) {
      const anchor = S.selectedFace.center ?? undefined;
      items.push(["sketch", "Sketch on this face", () => createSketchOn(plane, anchor && { center: anchor, normal: plane.normal })]);
      items.push(["lookAt", "Look at", () => vp.viewNormalTo(plane)]);
    }
    actions(items);
    return;
  }
  const f = S.doc.features.find((x) => x.id === S.selectedFeature);
  if (f) {
    const err = S.lastBuild?.errors[f.id] ?? S.lastBuild?.warnings?.[f.id];
    head(f.name, err ?? featureDetail(f), !!err, true);
    const items: [string, string, () => void, string?][] = [];
    if (f.kind === "combine") {
      // Changing what it does is a tap: no keypad to open.
      combineRows(el, f, () => {
        if (f.op !== "cut") delete f.clearance;
        else if (!f.clearance) delete f.clearance;
        // A name the user gave stays; the default one follows the operation.
        if (Object.values(COMBINE_NAMES).includes(f.name)) f.name = COMBINE_NAMES[f.op];
        commit();
        renderAll();
      });
      if (partDocs[f.assembly]) items.push(["assembly", `Open ${partNames[f.assembly]}`, () => void openProject(f.assembly)]);
    }
    if (f.kind === "sketch") {
      items.push(["edit", "Edit sketch", () => enterSketch(f)]);
    } else if (f.kind === "extrude") items.push(["edit", "Edit", () => void extrude(f)]);
    else if (f.kind === "pushpull") items.push(["edit", "Edit", () => void pushPull(f)]);
    else if (f.kind === "fillet") items.push(["edit", "Edit", () => void filletTool(f)]);
    else if (f.kind === "hole") items.push(["edit", "Edit", () => void holeTool(f)]);
    else if (f.kind === "pattern") items.push(["edit", "Edit", () => void patternTool(f.type, f)]);
    else if (f.kind === "revolve") items.push(["edit", "Edit", () => void revolveTool(f)]);
    else if (f.kind === "sweep") items.push(["edit", "Edit", () => startSweep(f)]);
    else if (f.kind === "loft") items.push(["edit", "Edit", () => startLoft(f)]);
    else if (f.kind === "import")
      items.push([
        f.op === "add" ? "cut" : "extrude",
        f.op === "add" ? "Cut it instead" : "Join it instead",
        () => {
          f.op = f.op === "add" ? "cut" : "add";
          commit();
          renderAll();
        },
      ]);
    else if (f.kind === "shell") items.push(["edit", "Edit", () => void shell(f)]);
    items.push(["rename", "Rename", () => renameFeature(f)]);
    if ((f.kind === "extrude" || f.kind === "revolve" || f.kind === "sweep" || f.kind === "loft" || f.kind === "import") && S.lastBuild?.bodies?.some((b) => b.id === f.id) && S.lastBuild.bodies.length > 1) {
      items.push(["rename", "Rename body", () => renameBody(f.id)]);
      items.push([M.hiddenBodies.has(f.id) ? "eye" : "eyeOff", M.hiddenBodies.has(f.id) ? "Show body" : "Hide body", () => toggleBody(f.id)]);
      const others = S.lastBuild.bodies.filter((b) => b.id !== f.id);
      const isolated = !M.hiddenBodies.has(f.id) && others.every((b) => M.hiddenBodies.has(b.id));
      items.push(["eye", isolated ? "Show all bodies" : "Show only this body", () => isolateBody(f.id)]);
    }
    if (f.kind === "import" && f.op === "add" && bodiesBefore(f.id).length)
      items.push([
        "extrude",
        f.body === "new" ? "Join it to the part" : "Make it a new body",
        () => {
          f.body = f.body === "new" ? undefined : "new";
          commit();
          renderAll();
        },
      ]);
    items.push(["trash", "Delete", () => deleteFeature(f), "danger"]);
    actions(items);
  }
}

/** What holds the selected element: tap one to see what it ties it to, ✕ to remove it. */
export function renderConstraintList(el: HTMLElement, ed: SketchEditor, e: SkEntity) {
  const list = ed.constraintsOn(e);
  if (!list.length) {
    const none = document.createElement("div");
    none.className = "con-title";
    none.textContent = "No constraints: it moves freely";
    el.appendChild(none);
    return;
  }
  // The heading folds the list away (remembered), leaving room for the actions.
  const folded = prefs.constraintsFolded;
  const title = document.createElement("button");
  title.className = "con-title con-fold" + (folded ? "" : " open");
  title.innerHTML = `${icon("chevron", 14)}<span></span>`;
  title.querySelector("span")!.textContent = `Constraints (${list.length})`;
  title.setAttribute("aria-expanded", String(!folded));
  title.title = folded ? "Show the constraints" : "Hide the constraints";
  title.onclick = () => {
    prefs.constraintsFolded = !folded;
    savePrefs();
    if (prefs.constraintsFolded) ed.focus = null;
    ed.render();
    renderPanel();
  };
  el.appendChild(title);
  if (folded) return;
  for (const { c, name, detail } of list) {
    const row = document.createElement("div");
    row.className = "con-row" + (ed.focus === c.id ? " on" : "");
    row.innerHTML = `<button class="con-main"><span class="con-glyph"></span><span class="con-text"><span class="con-name"></span><span class="con-detail"></span></span></button><button class="con-del" aria-label="Remove">${icon("close", 18)}</button>`;
    row.querySelector(".con-glyph")!.textContent = DIMENSION_TYPES.includes(c.type) ? (c.type === "angle" ? "∠" : c.type === "radius" ? "R" : c.type === "diameter" ? "⌀" : "↔") : constraintLabel(c);
    row.querySelector(".con-name")!.textContent = name;
    row.querySelector(".con-detail")!.textContent = detail;
    const main = row.querySelector<HTMLElement>(".con-main")!;
    main.title = DIMENSION_TYPES.includes(c.type) ? "Show it; tap again to change the value" : "Show what it ties";
    main.onclick = () => {
      // A dimension already shown opens its value.
      if (ed.focus === c.id && DIMENSION_TYPES.includes(c.type)) return void ed.editDimension(c);
      ed.focus = ed.focus === c.id ? null : c.id;
      ed.render();
      renderPanel();
    };
    const del = row.querySelector<HTMLElement>(".con-del")!;
    del.title = `Remove ${name}`;
    del.onclick = () => {
      ed.removeConstraint(c.id);
      renderPanel();
    };
    el.appendChild(row);
  }
}

export function actionTile(a: Action) {
  const b = document.createElement("button");
  if (a.id === "del") b.classList.add("danger");
  const glyph = a.id === "del" ? icon("trash", 20) : a.id === "constr" ? icon("construction", 20) : "";
  b.innerHTML = `<span class="glyph">${glyph}</span><span class="cap"></span>`;
  if (!glyph) b.querySelector(".glyph")!.textContent = a.label;
  b.querySelector(".cap")!.textContent = a.title;
  b.title = a.key ? `${a.title} (${a.key})` : a.title;
  b.onclick = () => {
    a.run();
    renderPanel();
  };
  return b;
}

export function dofText(dof: number) {
  return dof === 0 ? "Fully constrained" : dof < 0 ? "Over-constrained" : `${dof} degree${dof > 1 ? "s" : ""} of freedom left`;
}
