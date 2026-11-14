// Extrude: a sketch's regions pushed into a solid, with a handle to drag the distance.
import { PLANE_NAMES, bodySegment, commit, exitSketch, nextName, paramScope, pickSketchForExtrude, rebuild, renderAll, renderTimeline, vp } from "../main";
import { S, isOperation } from "./state";
import { uid } from "../sketch/model";
import { type ExtrudeFeature, type ExtrudeOp, type SketchFeature } from "../types";
import { DistanceHandle, sketchArrow } from "../ui/distanceHandle";
import { icon } from "../ui/icons";
import { openKeypad } from "../ui/keypad";
import { toast } from "../ui/toast";

export async function extrude(existing?: ExtrudeFeature) {
  if (isOperation(S.mode)) return;
  let f = existing;
  if (!f) {
    const sk = pickSketchForExtrude();
    if (!sk) return toast("Draw a closed sketch first");
    if (S.mode.kind === "sketch") exitSketch();
    const onFace = sk.plane.label === "Face";
    f = { id: uid(), kind: "extrude", name: nextName("Extrude"), sketchId: sk.id, distance: onFace ? 5 : 10, symmetric: false, op: "add" };
    S.doc.features.push(f);
  }
  const feat = f;
  const sk = S.doc.features.find((x): x is SketchFeature => x.id === feat.sketchId && x.kind === "sketch");
  if (!sk) return toast("This extrusion's sketch is missing");
  const onFace = sk.plane.label === "Face";
  const before = { distance: feat.distance, distanceExpr: feat.distanceExpr, symmetric: feat.symmetric, op: feat.op, body: feat.body };
  S.selectedFeature = feat.id;
  S.selectedFace = null;
  vp.highlightFace(null);

  let handle: DistanceHandle | null = null;
  const setDistance = (d: number, fromKeypad = false) => {
    feat.distance = d;
    if (!fromKeypad) kp.set(Math.abs(d));
    handle?.update();
    renderTimeline();
    rebuild();
  };
  const kp = openKeypad({
    title: feat.name,
    subtitle: `${sk.name} · ${sk.plane.label === "Face" ? "on a face" : PLANE_NAMES[sk.plane.label] ?? sk.plane.label}`,
    label: "Distance",
    value: Math.abs(feat.distance),
    expr: feat.distanceExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: [
          { value: "one", label: "One side" },
          { value: "sym", label: "Symmetric" },
        ],
        get: () => (feat.symmetric ? "sym" : "one"),
        set: (v) => {
          feat.symmetric = v === "sym";
          rebuild();
        },
      },
      {
        options: [
          { value: "add", label: "Join" },
          { value: "cut", label: "Cut" },
          { value: "intersect", label: "Intersect" },
        ],
        get: () => feat.op,
        set: (v) => {
          const op = v as ExtrudeOp;
          // A face normal points out of the solid: cutting goes the other way by default.
          if (onFace && (op === "cut") !== (feat.op === "cut")) feat.distance = -feat.distance;
          feat.op = op;
          handle?.update();
          rebuild();
        },
      },
      ...bodySegment(feat),
    ],
    extras: [{ label: "Flip direction", icon: "flip", run: () => setDistance(-feat.distance) }],
    onInput: (v) => {
      if (v > 0) setDistance(Math.sign(feat.distance || 1) * v, true);
    },
  });
  S.mode = { kind: "extrude", feat, keypad: kp };
  const arrow = sketchArrow(sk);
  handle = new DistanceHandle(vp, arrow.base, arrow.normal, () => feat.distance, (d) => setDistance(d));
  renderAll();
  rebuild(true);

  const res = await kp.result;
  const value = res?.value ?? null;
  handle.dispose();
  S.mode = { kind: "part" };
  if (value === null || value <= 0) {
    if (value !== null) toast("The distance must be positive");
    if (existing) Object.assign(feat, before);
    else {
      S.doc.features = S.doc.features.filter((x) => x !== feat);
      S.selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  feat.distance = Math.sign(feat.distance || 1) * value;
  feat.distanceExpr = res?.expr;
  commit();
}
