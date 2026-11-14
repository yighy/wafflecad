// Keyboard shortcuts, for a tablet with a keyboard or a computer.
import { M, redo, renderAll, undo, vp } from "../main";
import { escape, exitSketch, startNewSketch } from "./modes";
import { SKETCH_TOOLS } from "./tools";
import { renderPanel } from "./sidePanel";
import { endAlign, startAlign } from "./align";
import { instanceOf, isAssembly, removeInstance, showPartPicker } from "./assemblies";
import { endCombine } from "./combine";
import { toggleExplode } from "./explode";
import { extrude } from "./extrude";
import { faceTool } from "./faceTools";
import { insertText } from "./files";
import { filletTool } from "./fillet";
import { startHoles } from "./holes";
import { checkInterference, clearClashes } from "./interference";
import { deleteMate, mateOf, startMate } from "./mates";
import { toggleMeasure } from "./measure";
import { deleteFeature, toggleParams } from "./parameters";
import { patternTool } from "./patterns";
import { revolveTool } from "./revolve";
import { S } from "./state";

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest("input, textarea")) return;
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k.toLowerCase() === "z") {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (ctrl && k.toLowerCase() === "y") {
    e.preventDefault();
    return redo();
  }
  if (ctrl || e.altKey) return;
  if (k === "Escape") return void escape();
  if (S.mode.kind === "sketch") {
    const ed = S.mode.editor;
    if (k === "Enter") {
      if (!ed.escape()) exitSketch();
      return renderAll();
    }
    if (k === "Delete" || k === "Backspace") return ed.deleteSelection();
    if (ed.selection.size && ed.runShortcut(k)) return renderPanel();
    const t = SKETCH_TOOLS.find((x) => x.key.toLowerCase() === k.toLowerCase());
    if (t) ed.setTool(t.tool);
    else if (k.toLowerCase() === "g") ed.construction = !ed.construction;
    else if (k.toLowerCase() === "x") return void insertText();
    else return;
    return renderAll();
  }
  if (S.mode.kind === "part" && isAssembly()) {
    const key = k.toLowerCase();
    const inst = instanceOf(S.selectedFeature);
    const mate = mateOf(S.selectedFeature);
    if (key === "i") void showPartPicker();
    else if (key === "m") startMate();
    else if (key === "a") startAlign();
    else if (key === "x") toggleExplode();
    else if (key === "c") void (M.clashes ? clearClashes() : checkInterference());
    else if (key === "d") toggleMeasure();
    else if (key === "f") vp.fit();
    else if (key === "delete" && inst) removeInstance(inst);
    else if (key === "delete" && mate) deleteMate(mate);
    return;
  }
  if (S.mode.kind === "align") {
    if (k.toLowerCase() === "a") endAlign();
    return;
  }
  if (S.mode.kind === "combine") {
    if (k.toLowerCase() === "b") endCombine();
    return;
  }
  if (S.mode.kind === "mate") {
    if (k.toLowerCase() === "m") startMate();
    return;
  }
  if (S.mode.kind === "part") {
    const key = k.toLowerCase();
    if (key === "s") startNewSketch();
    else if (key === "e") void extrude();
    else if (key === "q") faceTool("pushpull");
    else if (key === "p") toggleParams();
    else if (key === "d") toggleMeasure();
    else if (key === "r") void filletTool();
    else if (key === "h") startHoles();
    else if (key === "m") void patternTool("mirror");
    else if (key === "l") void patternTool("linear");
    else if (key === "o") void patternTool("circular");
    else if (key === "v") void revolveTool();
    else if (key === "k") faceTool("shell");
    else if (key === "f") vp.fit();
    else if (key === "delete" && S.selectedFeature) {
      const f = S.doc.features.find((x) => x.id === S.selectedFeature);
      if (f) deleteFeature(f);
    }
  }
});

// Android back gesture = Escape (one history entry is kept in reserve).
history.replaceState({ base: true }, "");
history.pushState({ guard: true }, "");
window.addEventListener("popstate", () => {
  if (escape()) history.pushState({ guard: true }, "");
});
