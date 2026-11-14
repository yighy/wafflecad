// Fillet and chamfer on edges of the solid.
import { NEED_SOLID, commit, hasSolid, nextName, paramScope, rebuild, renderAll, renderStatus, renderTimeline, vp } from "../main";
import { S } from "./state";
import { uid } from "../sketch/model";
import { type FaceRef, type FilletFeature, type ShellFeature, type Vec3 } from "../types";
import { openKeypad } from "../ui/keypad";
import { toast } from "../ui/toast";
import { type Ptr } from "../view/input";

export async function filletTool(existing?: FilletFeature) {
  if (S.mode.kind !== "part") return;
  if (!existing && !hasSolid()) return toast(NEED_SOLID);
  const feat: FilletFeature = existing ?? { id: uid(), kind: "fillet", name: nextName("Fillet"), mode: "fillet", edges: [], radius: 1 };
  const before = { mode: feat.mode, radius: feat.radius, radiusExpr: feat.radiusExpr, edges: [...feat.edges], name: feat.name };
  if (!existing) S.doc.features.push(feat);
  S.selectedFeature = feat.id;
  S.selectedFace = null;
  S.showParams = false;
  vp.highlightFace(null);
  // Edges are chosen on the solid as it is before the fillet.
  S.previewExclude = feat.id;
  const kp = openKeypad({
    title: feat.name,
    subtitle: "Tap the edges to round or bevel",
    label: "Size",
    value: feat.radius,
    expr: feat.radiusExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: [
          { value: "fillet", label: "Fillet (round)" },
          { value: "chamfer", label: "Chamfer (bevel)" },
        ],
        get: () => feat.mode,
        set: (v) => {
          feat.mode = v as FilletFeature["mode"];
          rebuild();
          // Keep the default names in step with the choice.
          if (!existing && /^(Fillet|Chamfer) \d+$/.test(feat.name)) {
            feat.name = nextName(feat.mode === "fillet" ? "Fillet" : "Chamfer");
            renderTimeline();
          }
        },
      },
    ],
    onInput: (v) => {
      if (v > 0) feat.radius = v;
      rebuild();
    },
  });
  S.mode = { kind: "fillet", feat, keypad: kp };
  renderAll();
  rebuild(true);

  const res = await kp.result;
  const value = res?.value ?? null;
  S.previewExclude = null;
  S.mode = { kind: "part" };
  vp.highlightEdges([]);
  if (value === null || value <= 0 || !feat.edges.length) {
    if (value !== null && !feat.edges.length) toast("Tap at least one edge");
    if (existing) Object.assign(feat, before);
    else {
      S.doc.features = S.doc.features.filter((x) => x !== feat);
      S.selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.radius = value;
  feat.radiusExpr = res?.expr;
  commit();
}

export function highlightFilletEdges(feat: FilletFeature) {
  vp.highlightEdges(feat.edges.map((e) => vp.edgeAt(e.mid)).filter((i): i is number => i !== null));
}

export function toggleFilletEdge(feat: FilletFeature, p: Ptr) {
  const i = vp.pickEdge(p.x, p.y, p.kind === "touch" ? 24 : p.kind === "pen" ? 14 : 9);
  if (i === null) return;
  const mid = vp.edgeMid(i);
  const k = feat.edges.findIndex((e) => Math.hypot(e.mid[0] - mid[0], e.mid[1] - mid[1], e.mid[2] - mid[2]) < 0.05);
  if (k >= 0) feat.edges.splice(k, 1);
  else feat.edges.push({ mid });
  highlightFilletEdges(feat);
  rebuild();
  renderStatus();
}

export const sameFace = (a: FaceRef, center: Vec3, normal: Vec3) =>
  Math.hypot(a.center[0] - center[0], a.center[1] - center[1], a.center[2] - center[2]) < 1e-3 &&
  a.normal[0] * normal[0] + a.normal[1] * normal[1] + a.normal[2] * normal[2] > 0.999;

export function highlightShellFaces(feat: ShellFeature) {
  const ids = (S.lastBuild?.planarFaces ?? [])
    .filter((pf) => feat.faces.some((r) => sameFace(r, pf.center, pf.plane.normal)))
    .map((pf) => pf.faceId);
  vp.highlightFaces(ids);
}

export function toggleShellFace(feat: ShellFeature, faceId: number) {
  const pf = S.lastBuild?.planarFaces.find((f) => f.faceId === faceId);
  if (!pf) return toast("Only flat faces can be opened");
  const i = feat.faces.findIndex((r) => sameFace(r, pf.center, pf.plane.normal));
  if (i >= 0) feat.faces.splice(i, 1);
  else feat.faces.push({ center: pf.center, normal: pf.plane.normal });
  highlightShellFaces(feat);
  rebuild();
}
