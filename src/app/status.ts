// The status line at the top: what is being done, or what to do next.
import { $ } from "./util";
import { M, buildSlow, kernelBroken, kernelMessage } from "../main";
import { SKETCH_TOOLS } from "./tools";
import { dofText } from "./sidePanel";
import { instanceOf, isAssembly } from "./assemblies";
import { explodeTarget } from "./explode";
import { shell } from "./faceTools";
import { measuring } from "./measure";
import { S } from "./state";

export function renderStatus() {
  let s = kernelMessage;
  if (S.mode.kind === "pickPlane")
    s = S.mode.offset || S.mode.tiltX || S.mode.tiltY ? "New sketch · tap a plane or a face: the sketch lands on it moved as set" : "New sketch · tap a plane or a flat face";
  else if (S.mode.kind === "sketch") {
    const ed = S.mode.editor;
    const tool = SKETCH_TOOLS.find((t) => t.tool === ed.tool)!.label;
    s = `${ed.sk.name} · ${tool} · ${dofText(ed.dof).toLowerCase()}`;
  } else if (S.mode.kind === "extrude") s = "Extrude · drag the handle or type a value";
  else if (S.mode.kind === "pushpull") s = "Press Pull · drag the handle or type a value";
  else if (S.mode.kind === "shell") s = "Shell · tap the faces to open, type the wall thickness";
  else if (S.mode.kind === "revolve") s = "Revolve · tap a line of the sketch to use it as the axis";
  else if (S.mode.kind === "sweep") s = S.mode.feat.helix ? "Sweep · a coil: set its axis, pitch and turns in the panel" : "Sweep · choose the profile and the path in the panel";
  else if (S.mode.kind === "loft") s = "Loft · choose the sketches, in order, in the panel";
  else if (S.mode.kind === "pattern") {
    const f = S.mode.feat;
    s = f.featureIds.length ? `${f.name} · tap timeline steps to add or remove them` : `${f.name} · the whole solid, or tap the steps to repeat in the timeline`;
  } else if (S.mode.kind === "hole") {
    const f = S.mode.feat;
    s = f.sketchId ? `Hole · ${f.size} at the sketch points` : `Hole · ${f.size} × ${f.points?.length ?? 0} · tap to add, drag a hole to move it`;
  } else if (S.mode.kind === "fillet") {
    const n = S.mode.feat.edges.length;
    s = `${S.mode.feat.mode === "fillet" ? "Fillet" : "Chamfer"} · ${n ? `${n} edge${n > 1 ? "s" : ""} chosen` : "tap the edges"}, type the size`;
  }
  else if (S.pendingFaceTool) s = `${{ shell: "Shell", pushpull: "Press Pull", hole: "Hole" }[S.pendingFaceTool]} · tap a flat face`;
  else if (S.mode.kind === "place") s = `${S.mode.feat.name} · choose a value and type it`;
  else if (S.mode.kind === "align") s = S.mode.ids.length < 2 ? "Align · tap the parts to line up" : "Align · choose an axis and where to line them up";
  else if (S.mode.kind === "combine")
    s = S.mode.op === "keep" ? "Copy as part · tap the parts to copy" : !S.mode.target ? "Combine · tap the part to make the new part from" : "Combine · tap the parts to join or cut it with";
  else if (S.mode.kind === "mate") s = S.mode.picks.length ? "Mate · now the face or hole on the other part" : "Mate · tap a flat face, a hole or a round edge of a part";
  else if (S.mode.kind === "mateEdit") s = `${S.mode.feat.name} · facing, flush or at an angle; type the gap, or limits`;
  else if (isAssembly() && M.clashes) s = M.clashes.running ? "Checking for overlaps…" : "Interference · overlaps in red";
  else if (isAssembly() && explodeTarget) s = "Exploded view · tap it again to put the parts back";
  else if (isAssembly() && !s && !measuring && S.doc.instances?.length)
    s = instanceOf(S.selectedFeature)?.fixed
      ? "This part is fixed: tap Let it move to place it"
      : instanceOf(S.selectedFeature)
        ? "Drag an arrow to slide the part, a ring to turn it"
        : "Tap a part to place it";
  if (buildSlow) s = s ? `Building… · ${s}` : "Building the model…";
  $("#status").textContent = s;
  $("#status-pill").classList.toggle("retry", kernelBroken && s === kernelMessage);
}
