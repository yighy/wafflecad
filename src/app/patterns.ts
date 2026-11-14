// Mirror and patterns: earlier steps, or the whole solid, repeated.
import { NEED_SOLID, commit, hasSolid, nextName, rebuild, renderAll, renderStatus, renderTimeline, vp } from "../main";
import { S } from "./state";
import { fmtNum } from "./util";
import { uid } from "../sketch/model";
import { type Axis, type Feature, type PatternFeature } from "../types";
import { openKeypad, type Segmented } from "../ui/keypad";
import { toast } from "../ui/toast";

/** Features whose material can be repeated by a pattern. */
export const repeatable = (f: Feature) => (f.kind === "extrude" && f.op !== "intersect") || f.kind === "pushpull" || f.kind === "hole" || f.kind === "pattern";

export type PatternField = "count" | "spacing" | "count2" | "spacing2" | "angle" | "offset";
export const FIELD_LABEL: Record<PatternField, [string, string]> = {
  count: ["Count (original included)", ""],
  spacing: ["Spacing", "mm"],
  count2: ["Count, 2nd direction", ""],
  spacing2: ["Spacing, 2nd direction", "mm"],
  angle: ["Total angle (360 = all around)", "°"],
  offset: ["Plane position", "mm"],
};

export function patternSummary(f: PatternFeature) {
  const n = f.featureIds.length;
  const what = n ? `${n} feature${n > 1 ? "s" : ""}` : "whole solid";
  if (f.type === "mirror") return `${what} · ${{ X: "YZ", Y: "XZ", Z: "XY" }[f.axis]} plane at ${fmtNum(f.offset)} mm`;
  if (f.type === "circular") return `${what} · ${f.count} around ${f.axis} · ${fmtNum(f.angle)}°`;
  const second = f.count2 > 1 ? ` × ${f.count2} along ${f.axis2}` : "";
  return `${what} · ${f.count} along ${f.axis}${second}`;
}

export async function patternTool(type: PatternFeature["type"], existing?: PatternFeature) {
  if (S.mode.kind !== "part") return;
  if (!existing && !hasSolid()) return toast(NEED_SOLID);
  const sel = S.doc.features.find((f) => f.id === S.selectedFeature);
  const prefix = { linear: "Linear pattern", circular: "Circular pattern", mirror: "Mirror" }[type];
  const feat: PatternFeature = existing ?? {
    id: uid(),
    kind: "pattern",
    name: nextName(prefix),
    type,
    featureIds: sel && repeatable(sel) ? [sel.id] : [],
    axis: type === "circular" ? "Z" : "X",
    count: type === "circular" ? 6 : 3,
    spacing: 10,
    axis2: "Y",
    count2: 1,
    spacing2: 10,
    angle: 360,
    offset: 0,
  };
  const before = structuredClone(feat);
  if (!existing) S.doc.features.push(feat);
  S.selectedFeature = feat.id;
  S.selectedFace = null;
  S.showParams = false;
  vp.highlightFace(null);

  let field: PatternField = type === "mirror" ? "offset" : "count";
  const axisSeg = (get: () => Axis, set: (a: Axis) => void, labels: [string, string, string]) => ({
    options: (["X", "Y", "Z"] as Axis[]).map((a, i) => ({ value: a, label: labels[i] })),
    get,
    set: (v: string) => {
      set(v as Axis);
      update();
    },
  });
  const fieldSeg = (fields: PatternField[], labels: string[]) => ({
    options: fields.map((f, i) => ({ value: f, label: labels[i] })),
    get: () => field,
    set: (v: string) => {
      field = v as PatternField;
      kp.set(feat[field]);
      kp.setLabel(...FIELD_LABEL[field]);
    },
  });
  // What is repeated: the steps tapped in the timeline, or the whole solid when none is.
  let picked = [...feat.featureIds];
  const whatSeg = {
    options: [
      { value: "steps", label: "Chosen steps" },
      { value: "whole", label: "Whole solid" },
    ],
    get: () => (feat.featureIds.length ? "steps" : "whole"),
    set: (v: string) => {
      if (v === "whole") {
        if (feat.featureIds.length) picked = [...feat.featureIds];
        feat.featureIds = [];
      } else if (!feat.featureIds.length) {
        if (picked.length) feat.featureIds = [...picked];
        else toast("Tap the features to repeat in the timeline");
      }
      update();
    },
  };
  const segments: Segmented[] = [whatSeg];
  segments.push(
    ...(type === "mirror"
      ? [axisSeg(() => feat.axis, (a) => (feat.axis = a), ["YZ plane", "XZ plane", "XY plane"])]
      : type === "circular"
        ? [fieldSeg(["count", "angle"], ["Count", "Angle"]), axisSeg(() => feat.axis, (a) => (feat.axis = a), ["X axis", "Y axis", "Z axis"])]
        : [
            fieldSeg(["count", "spacing", "count2", "spacing2"], ["Count", "Spacing", "Count 2", "Spacing 2"]),
            axisSeg(() => feat.axis, (a) => (feat.axis = a), ["Along X", "Along Y", "Along Z"]),
            axisSeg(() => feat.axis2, (a) => (feat.axis2 = a), ["2nd X", "2nd Y", "2nd Z"]),
          ]),
  );
  const setField = (v: number) => {
    feat[field] = field === "count" || field === "count2" ? Math.max(1, Math.round(v)) : v;
  };
  const update = () => {
    kp.setSubtitle(patternSummary(feat));
    renderTimeline();
    rebuild();
  };
  const kp = openKeypad({
    title: feat.name,
    subtitle: patternSummary(feat),
    label: FIELD_LABEL[field][0],
    unit: FIELD_LABEL[field][1],
    value: feat[field],
    confirmLabel: "Confirm",
    segments,
    onInput: (v) => {
      setField(v);
      update();
    },
  });
  S.mode = { kind: "pattern", feat, keypad: kp };
  renderAll();
  rebuild(true);

  const res = await kp.result;
  S.mode = { kind: "part" };
  if (res === null) {
    if (existing) Object.assign(feat, before);
    else {
      S.doc.features = S.doc.features.filter((x) => x !== feat);
      S.selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  setField(res.value);
  commit();
}

/** In a pattern, tapping a timeline step adds it to (or removes it from) the repeated features. */
export function togglePatternFeature(feat: PatternFeature, f: Feature) {
  const idx = S.doc.features.indexOf(feat);
  if (S.doc.features.indexOf(f) >= idx) return toast("Only earlier features can be repeated");
  if (!repeatable(f)) return toast(`${f.name} cannot be repeated (only extrusions, Press Pull, holes and patterns)`);
  const i = feat.featureIds.indexOf(f.id);
  if (i >= 0) feat.featureIds.splice(i, 1);
  else feat.featureIds.push(f.id);
  if (S.mode.kind === "pattern") {
    S.mode.keypad.setSubtitle(patternSummary(feat));
    S.mode.keypad.refresh();
  }
  renderTimeline();
  renderStatus();
  rebuild();
}
