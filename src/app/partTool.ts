// Taps and drags on the model in the part view: planes, faces, parts.
import { M, renderAll, vp } from "../main";
import { pickPlaneAt } from "./modes";
import { isAssembly } from "./assemblies";
import { mateTap } from "./mates";
import { endDrag, fingerDown, fingerMove } from "./partDrag";
import { toggleAlignPart } from "./align";
import { toggleCombinePart } from "./combine";
import { faceTool } from "./faceTools";
import { toggleFilletEdge, toggleShellFace } from "./fillet";
import { dropHoleDrag, holeDown, holeMove, holeUp } from "./holes";
import { measureTap, measuring } from "./measure";
import { revolveAxisPicker } from "./revolve";
import { S } from "./state";
import { pickSketchLine } from "./sweepLoft";
import { type RevolveFeature, type SketchFeature } from "../types";
import { toast } from "../ui/toast";
import { type PointerTool } from "../view/input";

export const partTool: PointerTool = {
  down(p) {
    if (S.mode.kind === "hole") holeDown(S.mode.feat, p);
    fingerDown(p);
  },
  move(p) {
    if (S.mode.kind === "hole") holeMove(S.mode.feat, p);
    fingerMove(p);
  },
  up(p) {
    if (M.fingerDrag?.moved) {
      M.fingerDrag = null;
      return endDrag(true);
    }
    M.fingerDrag = null;
    if (S.mode.kind === "pickPlane") return pickPlaneAt(p);
    if (S.mode.kind === "mate") return void mateTap(p);
    const face = vp.pickFace(p.x, p.y);
    if (S.mode.kind === "align" || S.mode.kind === "combine") {
      const body = face == null ? null : S.lastBuild?.bodies?.find((b) => b.faceIds.includes(face));
      if (body) (S.mode.kind === "align" ? toggleAlignPart : toggleCombinePart)(body.id);
      return;
    }
    if (S.mode.kind === "shell") {
      if (face != null) toggleShellFace(S.mode.feat, face);
      return;
    }
    if (S.mode.kind === "fillet") return toggleFilletEdge(S.mode.feat, p);
    if (S.mode.kind === "part" && measuring) return measureTap(p);
    if (S.mode.kind === "part" && isAssembly()) {
      const id = face == null ? null : (S.lastBuild?.bodies?.find((b) => b.faceIds.includes(face))?.id ?? null);
      S.selectedFeature = id;
      return renderAll();
    }
    if (S.mode.kind === "hole") return holeUp(S.mode.feat, p);
    if (S.mode.kind === "revolve") {
      const sk = S.doc.features.find((x): x is SketchFeature => x.id === (S.mode as { feat: RevolveFeature }).feat.sketchId && x.kind === "sketch");
      const line = sk ? pickSketchLine(sk, p) : null;
      if (line) revolveAxisPicker?.(line);
      return;
    }
    if (S.mode.kind !== "part") return;
    vp.highlightFace(face);
    S.selectedFeature = null;
    if (face != null) S.showParams = false;
    const pf = face == null ? undefined : S.lastBuild?.planarFaces.find((f) => f.faceId === face);
    const hit = face == null ? null : vp.pickPoint(p.x, p.y)?.point ?? null;
    S.selectedFace = face == null ? null : { faceId: face, plane: pf?.plane ?? null, center: pf?.center ?? null, hit };
    if (S.pendingFaceTool && face != null) {
      if (!pf) return toast("Only flat faces work here");
      return faceTool(S.pendingFaceTool);
    }
    renderAll();
  },
  cancel() {
    dropHoleDrag();
    if (M.fingerDrag?.moved) endDrag(false);
    M.fingerDrag = null;
  },
  hover(p) {
    if (S.mode.kind !== "pickPlane" || !p) return;
    vp.highlightFace(vp.pickFace(p.x, p.y));
  },
};
