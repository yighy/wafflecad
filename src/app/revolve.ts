// Revolve: a sketch turned around one of its lines.
import { commit, nextName, rebuild, renderAll, vp } from "../main";
import { exitSketch } from "./modes";
import { bodySegment } from "./bodies";
import { renderPartOverlays } from "./display";
import { paramScope, pickSketchForExtrude } from "./parameters";
import { S, isOperation } from "./state";
import { uid } from "../sketch/model";
import { type ExtrudeOp, type RevolveFeature, type SketchFeature } from "../types";
import { icon } from "../ui/icons";
import { openKeypad } from "../ui/keypad";
import { toast } from "../ui/toast";

export function axisName(sk: SketchFeature, lineId: string) {
  if (lineId === "AX") return "the sketch X axis";
  if (lineId === "AY") return "the sketch Y axis";
  return sk.entities.some((e) => e.id === lineId) ? "a line of the sketch" : "a missing line";
}

export async function revolveTool(existing?: RevolveFeature) {
  if (isOperation(S.mode)) return;
  let feat = existing;
  if (!feat) {
    const sk = pickSketchForExtrude();
    if (!sk) return toast("Draw a closed sketch first (half of the profile, next to the axis)");
    if (S.mode.kind === "sketch") exitSketch();
    // A construction line is the usual way to draw a revolve axis.
    const axis = sk.entities.find((e) => e.type === "line" && e.construction && !e.axis)?.id ?? "AY";
    feat = { id: uid(), kind: "revolve", name: nextName("Revolve"), sketchId: sk.id, axisLine: axis, angle: 360, symmetric: false, op: "add" };
    S.doc.features.push(feat);
  }
  const f = feat;
  const sk = S.doc.features.find((x): x is SketchFeature => x.id === f.sketchId && x.kind === "sketch");
  if (!sk) return toast("This revolve's sketch is missing");
  const before = structuredClone(f);
  S.selectedFeature = f.id;
  S.selectedFace = null;
  S.showParams = false;
  vp.highlightFace(null);
  let drawnLine = f.axisLine !== "AX" && f.axisLine !== "AY" ? f.axisLine : null;
  const subtitle = () => `${sk.name} · around ${axisName(sk, f.axisLine)}`;
  const kp = openKeypad({
    title: f.name,
    subtitle: subtitle(),
    label: "Angle (360 = full turn)",
    unit: "°",
    value: Math.abs(f.angle),
    expr: f.angleExpr,
    scope: paramScope(),
    confirmLabel: "Confirm",
    segments: [
      {
        options: [
          { value: "AX", label: "Sketch X" },
          { value: "AY", label: "Sketch Y" },
          { value: "line", label: "Tapped line" },
        ],
        get: () => (f.axisLine === "AX" || f.axisLine === "AY" ? f.axisLine : "line"),
        set: (v) => {
          if (v === "line") {
            if (!drawnLine) return toast("Tap a line of the sketch to use it as the axis");
            f.axisLine = drawnLine;
          } else f.axisLine = v;
          kp.setSubtitle(subtitle());
          renderPartOverlays();
          rebuild();
        },
      },
      {
        options: [
          { value: "one", label: "One side" },
          { value: "sym", label: "Symmetric" },
        ],
        get: () => (f.symmetric ? "sym" : "one"),
        set: (v) => {
          f.symmetric = v === "sym";
          rebuild();
        },
      },
      {
        options: [
          { value: "add", label: "Join" },
          { value: "cut", label: "Cut" },
          { value: "intersect", label: "Intersect" },
        ],
        get: () => f.op,
        set: (v) => {
          f.op = v as ExtrudeOp;
          rebuild();
        },
      },
      ...bodySegment(f),
    ],
    extras: [
      {
        label: "Flip direction",
        icon: "flip",
        run: () => {
          f.angle = -f.angle;
          rebuild();
        },
      },
    ],
    onInput: (v) => {
      if (v > 0 && v <= 360) {
        f.angle = Math.sign(f.angle || 1) * v;
        rebuild();
      }
    },
  });
  S.mode = { kind: "revolve", feat: f, keypad: kp };
  const pickAxis = (lineId: string) => {
    drawnLine = lineId;
    f.axisLine = lineId;
    kp.setSubtitle(subtitle());
    renderPartOverlays();
    rebuild();
  };
  revolveAxisPicker = pickAxis;
  renderAll();
  rebuild(true);

  const res = await kp.result;
  revolveAxisPicker = null;
  S.mode = { kind: "part" };
  const value = res?.value ?? null;
  if (value === null || value <= 0 || value > 360) {
    if (value !== null) toast("The angle must be between 0 and 360°");
    if (existing) Object.assign(f, before);
    else {
      S.doc.features = S.doc.features.filter((x) => x !== f);
      S.selectedFeature = null;
    }
    rebuild(true);
    renderAll();
    return;
  }
  f.angle = Math.sign(f.angle || 1) * value;
  f.angleExpr = res?.expr;
  commit();
}

/** Set while a revolve is being edited: receives the line tapped as the new axis. */
export let revolveAxisPicker: ((lineId: string) => void) | null = null;
