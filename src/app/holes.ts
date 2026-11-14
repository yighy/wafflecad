// Holes: metric screw holes placed on a face or at a sketch's points.
import * as THREE from "three";
import { commit, nextName, paramScope, rebuild, renderAll, renderPartOverlays, renderStatus, rgb, vp } from "../main";
import { faceTool } from "./faceTools";
import { S } from "./state";
import { fmtNum } from "./util";
import { atDistance, edgesInPlane, faceFrame, holeDims, snapHole, to2D, to3D, type EdgeDim } from "../cad/holePlace";
import { HOLE_SIZES, sketchHolePoints } from "../cad/holes";
import { uid } from "../sketch/model";
import { type HoleFeature, type SketchFeature, type Vec3 } from "../types";
import { icon } from "../ui/icons";
import { openKeypad } from "../ui/keypad";
import { toast } from "../ui/toast";
import { type Ptr } from "../view/input";
import { type LineBatch } from "../view/viewport";

/** Starts the hole tool: from the selected sketch's free points, the selected face, or the next face tapped. */
export function startHoles() {
  if (S.mode.kind !== "part") return;
  const sel = S.doc.features.find((f) => f.id === S.selectedFeature);
  if (sel?.kind === "sketch") {
    if (!sketchHolePoints(sel).length) return toast("This sketch has no free points: add points where the holes go");
    return void holeTool(undefined, { sketch: sel });
  }
  faceTool("hole");
}

export async function holeTool(existing?: HoleFeature, from?: { sketch: SketchFeature } | { normal: Vec3; at: Vec3 }) {
  if (S.mode.kind !== "part") return;
  const feat: HoleFeature =
    existing ??
    (from && "sketch" in from
      ? { id: uid(), kind: "hole", name: nextName("Hole"), sketchId: from.sketch.id, normal: from.sketch.plane.normal, size: "M3", fit: "clearance", head: "none", depth: 0 }
      : { id: uid(), kind: "hole", name: nextName("Hole"), points: [from!.at], normal: from!.normal, size: "M3", fit: "clearance", head: "none", depth: 0 });
  const before = structuredClone(feat);
  if (!existing) S.doc.features.push(feat);
  S.selectedFeature = feat.id;
  S.selectedFace = null;
  S.showParams = false;
  vp.highlightFace(null);
  // Positions are chosen on the solid as it is before the holes.
  S.previewExclude = feat.id;
  holeField = null;
  holeDrag = null;
  holeSnapLabel = null;
  holeSel = feat.points?.length && !existing ? feat.points.length - 1 : null;
  if (!existing && feat.points?.length) {
    const ctx = holeContext(feat);
    const s = snapHole(to2D(ctx.frame, feat.points[0]), ctx.edges, nearestCenter(ctx, feat.points[0]), 24 * vp.wpp);
    feat.points[0] = to3D(ctx.frame, s.at);
    holeSnapLabel = s.label;
  }
  const kp = openKeypad({
    title: feat.name,
    subtitle: feat.sketchId ? "At the free points of the sketch" : "Tap to add · drag to move · tap a distance to type it",
    label: "Depth (0 = through)",
    value: feat.depth,
    expr: feat.depthExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: HOLE_SIZES.map((s) => ({ value: s, label: s })),
        get: () => feat.size,
        set: (v) => {
          feat.size = v as HoleFeature["size"];
          rebuild();
        },
      },
      {
        options: [
          { value: "none", label: "Plain" },
          // Soft hyphens: on a narrow panel the words break as Counter-bore / Counter-sink.
          { value: "counterbore", label: "Counter­bore" },
          { value: "countersink", label: "Counter­sink" },
        ],
        get: () => feat.head,
        set: (v) => {
          feat.head = v as HoleFeature["head"];
          rebuild();
        },
      },
      {
        options: [
          { value: "clearance", label: "Screw passes" },
          { value: "plastic", label: "Screw into plastic" },
        ],
        get: () => feat.fit,
        set: (v) => {
          feat.fit = v as HoleFeature["fit"];
          rebuild();
        },
      },
    ],
    extras: !feat.sketchId
      ? [{ label: "Remove hole", icon: "trash", run: () => removeSelectedHole(feat) }]
      : [
          {
            label: "Flip direction",
            icon: "flip",
            run: () => {
              feat.flip = !feat.flip;
              rebuild();
              toast(feat.flip ? "Drilling along the sketch normal" : "Drilling against the sketch normal");
            },
          },
        ],
    onInput: (v) => {
      if (v < 0) return;
      if (holeField && holeSel !== null && feat.points?.[holeSel]) {
        // The keypad is editing a distance to an edge: move the hole square to it.
        const ctx = holeContext(feat);
        feat.points[holeSel] = to3D(ctx.frame, atDistance(holeField.dim, v));
        holeSnapLabel = null;
        renderPartOverlays();
      } else feat.depth = v;
      rebuild();
    },
  });
  S.mode = { kind: "hole", feat, keypad: kp };
  renderAll();
  rebuild(true);

  const typed = await kp.result;
  // Confirmed while a distance was being typed: the depth is the one set before.
  const res = typed && holeField ? { value: feat.depth, expr: feat.depthExpr } : typed;
  holeField = null;
  holeSel = null;
  holeDrag = null;
  const value = res?.value ?? null;
  S.previewExclude = null;
  S.mode = { kind: "part" };
  const hasPoints = feat.sketchId ? true : !!feat.points?.length;
  if (value === null || value < 0 || !hasPoints) {
    if (value !== null && !hasPoints) toast("Tap at least one place on the face");
    if (value !== null && value < 0) toast("The depth cannot be negative");
    if (existing) Object.assign(feat, before);
    else {
      S.doc.features = S.doc.features.filter((x) => x !== feat);
      S.selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.depth = value;
  feat.depthExpr = res?.expr;
  commit();
}

// Placing holes on a face: tap to add (snapped), tap a hole to select it, drag it to move it,
// and tap one of its distances to edges to type an exact value.

/** The selected hole (index in its feature's points). */
export let holeSel: number | null = null;
/** Set while the keypad edits a distance to an edge instead of the depth. */
export let holeField: { dim: EdgeDim } | null = null;
export let holeDrag: { index: number; moved: boolean } | null = null;
/** A drag on a hole interrupted (the pointer was lost): it no longer follows the finger. */
export function dropHoleDrag() {
  holeDrag = null;
}
/** What the last placed or moved hole snapped to, shown next to it. */
export let holeSnapLabel: string | null = null;

export const hitRadiusPx = (p: Ptr) => (p.kind === "touch" ? 24 : p.kind === "pen" ? 14 : 9);

export function holeContext(feat: HoleFeature) {
  const frame = faceFrame(feat.normal, feat.points?.[0] ?? [0, 0, 0]);
  const edges = S.lastBuild ? edgesInPlane(frame, S.lastBuild.edges, S.lastBuild.edgeGroups) : { segments: [], circles: [] };
  return { frame, edges };
}

/** Centre of the flat face (in the holes' plane) closest to a point, in the plane's 2D coordinates. */
export function nearestCenter(ctx: ReturnType<typeof holeContext>, at: Vec3): [number, number] | null {
  const n = ctx.frame.normal;
  const off = (w: Vec3) => (w[0] - at[0]) * n[0] + (w[1] - at[1]) * n[1] + (w[2] - at[2]) * n[2];
  const a = to2D(ctx.frame, at);
  let best: [number, number] | null = null;
  for (const pf of S.lastBuild?.planarFaces ?? []) {
    const m = pf.plane.normal;
    if (m[0] * n[0] + m[1] * n[1] + m[2] * n[2] < 0.999 || Math.abs(off(pf.center)) > 1e-3) continue;
    const c = to2D(ctx.frame, pf.center);
    if (!best || Math.hypot(c[0] - a[0], c[1] - a[1]) < Math.hypot(best[0] - a[0], best[1] - a[1])) best = c;
  }
  return best;
}

/** The snapped place under the pointer, on the holes' plane. */
export function holeSnapAt(feat: HoleFeature, p: Ptr) {
  const ctx = holeContext(feat);
  const raw = vp.screenToPlane(p.x, p.y, ctx.frame);
  if (!raw) return null;
  return snapHole(raw, ctx.edges, nearestCenter(ctx, to3D(ctx.frame, raw)), hitRadiusPx(p) * vp.wpp);
}

export function holeUnder(feat: HoleFeature, p: Ptr): number | null {
  let best: number | null = null;
  let bestD = hitRadiusPx(p) + 6;
  (feat.points ?? []).forEach((q, i) => {
    const [x, y] = vp.toScreen(new THREE.Vector3(...q));
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

export function selectHole(feat: HoleFeature, i: number | null) {
  holeSel = i;
  if (holeField && S.mode.kind === "hole") {
    holeField = null;
    S.mode.keypad.setLabel("Depth (0 = through)", "mm");
    S.mode.keypad.set(feat.depth);
  }
  renderPartOverlays();
  renderStatus();
}

export function holeDown(feat: HoleFeature, p: Ptr) {
  if (feat.sketchId) return;
  const i = holeUnder(feat, p);
  holeDrag = i === null ? null : { index: i, moved: false };
}

export function holeMove(feat: HoleFeature, p: Ptr) {
  if (!holeDrag || !feat.points) return;
  const s = holeSnapAt(feat, p);
  if (!s) return;
  if (!holeDrag.moved) selectHole(feat, holeDrag.index);
  holeDrag.moved = true;
  feat.points[holeDrag.index] = to3D(holeContext(feat).frame, s.at);
  holeSnapLabel = s.label;
  renderPartOverlays();
  rebuild();
}

/** A tap: selects the hole under it, or adds one there (snapped). */
export function holeUp(feat: HoleFeature, p: Ptr) {
  if (feat.sketchId) return toast("These holes follow the sketch points: edit the sketch to move them");
  const drag = holeDrag;
  holeDrag = null;
  if (drag?.moved) return;
  if (drag) return selectHole(feat, drag.index);
  const hit = vp.pickPoint(p.x, p.y);
  if (!hit) return selectHole(feat, null);
  const pts = (feat.points ??= []);
  const n = feat.normal;
  const pf = hit.faceId == null ? undefined : S.lastBuild?.planarFaces.find((f) => f.faceId === hit.faceId);
  const sameNormal = pf && pf.plane.normal[0] * n[0] + pf.plane.normal[1] * n[1] + pf.plane.normal[2] * n[2] > 0.999;
  const ref = pts[0] ?? hit.point;
  const offPlane = Math.abs((hit.point[0] - ref[0]) * n[0] + (hit.point[1] - ref[1]) * n[1] + (hit.point[2] - ref[2]) * n[2]);
  if (!sameNormal || offPlane > 1e-3) return toast("All holes of one feature go on the same flat face");
  const s = holeSnapAt(feat, p);
  if (!s) return;
  pts.push(to3D(holeContext(feat).frame, s.at));
  holeSnapLabel = s.label;
  selectHole(feat, pts.length - 1);
  rebuild();
}

export function removeSelectedHole(feat: HoleFeature) {
  const pts = feat.points ?? [];
  if (holeSel === null || !pts[holeSel]) return toast("Tap a hole first to select it");
  if (pts.length === 1) return toast("This is the last hole: Cancel drops the whole feature");
  pts.splice(holeSel, 1);
  selectHole(feat, null);
  rebuild();
}

/** Distances from the selected hole to the face's edges, as tappable labels. */
export function holeDimLabels(feat: HoleFeature, batch: LineBatch) {
  const at = holeSel === null ? undefined : feat.points?.[holeSel];
  if (!at || feat.sketchId) return [];
  const ctx = holeContext(feat);
  const p = to2D(ctx.frame, at);
  const acc = rgb("--accent");
  const items: { el: HTMLElement; at: THREE.Vector3; dx?: number; dy?: number }[] = [];
  for (const dim of holeDims(p, ctx.edges)) {
    const foot = to3D(ctx.frame, dim.foot);
    batch.positions.push(...foot, ...at);
    batch.colors.push(...acc, ...acc);
    const el = document.createElement("button");
    el.className = "sk-label dim";
    if (holeField && Math.hypot(holeField.dim.dir[0] - dim.dir[0], holeField.dim.dir[1] - dim.dir[1]) < 1e-6) el.classList.add("sel");
    el.textContent = fmtNum(Math.round(dim.dist * 100) / 100);
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (S.mode.kind !== "hole") return;
      holeField = { dim };
      S.mode.keypad.setLabel("Distance to this edge", "mm");
      S.mode.keypad.set(Math.round(dim.dist * 100) / 100);
      renderPartOverlays();
    });
    const mid = to3D(ctx.frame, [(dim.foot[0] + p[0]) / 2, (dim.foot[1] + p[1]) / 2]);
    items.push({ el, at: new THREE.Vector3(...mid) });
  }
  if (holeSnapLabel) {
    const el = document.createElement("div");
    el.className = "sk-label hint";
    el.textContent = holeSnapLabel;
    items.push({ el, at: new THREE.Vector3(...at), dx: 0, dy: -28 });
  }
  return items;
}
