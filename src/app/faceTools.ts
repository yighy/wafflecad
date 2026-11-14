// Press Pull and Shell: tools that work on a face of the solid.
import * as THREE from "three";
import { NEED_SOLID, commit, hasSolid, nextName, paramScope, rebuild, renderAll, renderTimeline, vp } from "../main";
import { holeTool } from "./holes";
import { S } from "./state";
import { uid } from "../sketch/model";
import { type FaceRef, type PushPullFeature, type ShellFeature, type Vec3 } from "../types";
import { DistanceHandle } from "../ui/distanceHandle";
import { openKeypad } from "../ui/keypad";
import { toast } from "../ui/toast";

export function faceRefOfSelection(): FaceRef | null {
  if (!S.selectedFace?.plane || !S.selectedFace.center) return null;
  return { center: S.selectedFace.center, normal: S.selectedFace.plane.normal };
}

/** Starts a face tool on the selected face, or waits for a face to be tapped. */
export function faceTool(tool: "pushpull" | "shell" | "hole") {
  if (S.mode.kind !== "part") return;
  if (!hasSolid()) return toast(NEED_SOLID);
  const ref = faceRefOfSelection();
  if (!ref) {
    S.pendingFaceTool = tool;
    S.selectedFeature = null;
    renderAll();
    return;
  }
  S.pendingFaceTool = null;
  if (tool === "pushpull") void pushPull(undefined, ref);
  else if (tool === "shell") void shell(undefined, ref);
  else void holeTool(undefined, { normal: ref.normal, at: (S.selectedFace?.hit ?? ref.center).map((c) => Math.round(c * 100) / 100) as Vec3 });
}

export async function pushPull(existing?: PushPullFeature, ref?: FaceRef) {
  const feat: PushPullFeature = existing ?? { id: uid(), kind: "pushpull", name: nextName("Press Pull"), face: ref!, distance: 5 };
  const before = { distance: feat.distance, distanceExpr: feat.distanceExpr };
  if (!existing) S.doc.features.push(feat);
  S.selectedFeature = feat.id;
  S.selectedFace = null;
  vp.highlightFace(null);

  let handle: DistanceHandle | null = null;
  const setDistance = (d: number, fromKeypad = false) => {
    feat.distance = d;
    if (!fromKeypad) kp.set(d);
    handle?.update();
    renderTimeline();
    rebuild();
  };
  const kp = openKeypad({
    title: feat.name,
    subtitle: "Positive pulls the face out, negative pushes it in",
    label: "Distance",
    value: feat.distance,
    expr: feat.distanceExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: [
          { value: "pull", label: "Pull (add)" },
          { value: "push", label: "Push (cut)" },
        ],
        get: () => (feat.distance >= 0 ? "pull" : "push"),
        set: (v) => {
          if ((v === "push") !== feat.distance < 0) setDistance(-feat.distance);
        },
      },
    ],
    onInput: (v) => {
      if (v !== 0) setDistance(v, true);
    },
  });
  S.mode = { kind: "pushpull", feat, keypad: kp };
  // The arrow starts on the face as it was before this feature.
  handle = new DistanceHandle(
    vp,
    new THREE.Vector3(...feat.face.center),
    new THREE.Vector3(...feat.face.normal),
    () => feat.distance,
    (d) => setDistance(d),
  );
  renderAll();
  rebuild(true);

  const res = await kp.result;
  const value = res?.value ?? null;
  handle.dispose();
  S.mode = { kind: "part" };
  if (value === null || value === 0) {
    if (existing) Object.assign(feat, before);
    else {
      S.doc.features = S.doc.features.filter((x) => x !== feat);
      S.selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.distance = value;
  feat.distanceExpr = res?.expr;
  commit();
}

export async function shell(existing?: ShellFeature, ref?: FaceRef) {
  const feat: ShellFeature = existing ?? { id: uid(), kind: "shell", name: nextName("Shell"), faces: [ref!], thickness: 2 };
  const before = { thickness: feat.thickness, thicknessExpr: feat.thicknessExpr, faces: [...feat.faces] };
  if (!existing) S.doc.features.push(feat);
  S.selectedFeature = feat.id;
  S.selectedFace = null;
  // Faces are chosen on the solid as it is before the shell.
  S.previewExclude = feat.id;
  const kp = openKeypad({
    title: feat.name,
    subtitle: "Tap faces to open or close them",
    label: "Wall thickness",
    value: feat.thickness,
    expr: feat.thicknessExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    onInput: (v) => {
      if (v > 0) feat.thickness = v;
      rebuild();
    },
  });
  S.mode = { kind: "shell", feat, keypad: kp };
  renderAll();
  rebuild(true);

  const res = await kp.result;
  const value = res?.value ?? null;
  S.previewExclude = null;
  S.mode = { kind: "part" };
  vp.highlightFace(null);
  if (value === null || value <= 0 || !feat.faces.length) {
    if (value !== null && !feat.faces.length) toast("A shell needs at least one open face");
    if (existing) Object.assign(feat, before);
    else {
      S.doc.features = S.doc.features.filter((x) => x !== feat);
      S.selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.thickness = value;
  feat.thicknessExpr = res?.expr;
  commit();
}
