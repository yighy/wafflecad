// Modes: starting and leaving a sketch, picking a sketch plane, and Escape (what it ends, in order).
import { M, PLANE_COLORS, STD_PLANES, commit, nextName, renderAll, solver, vp } from "../main";
import { renderTools } from "./tools";
import { renderPanel } from "./sidePanel";
import { renderStatus } from "./status";
import { endAlign } from "./align";
import { endCombine } from "./combine";
import { explodeTarget, toggleExplode } from "./explode";
import { closeProjects } from "./gallery";
import { clearClashes } from "./interference";
import { startMate } from "./mates";
import { endMeasure, measuring } from "./measure";
import { paramScope, toggleParams } from "./parameters";
import { prefs } from "./prefs";
import { S, isOperation } from "./state";
import { endSweepLoft } from "./sweepLoft";
import { SketchEditor } from "../sketch/editor";
import { newSketch } from "../sketch/model";
import { findRegions } from "../sketch/profiles";
import { type FaceRef, type PlaneDef, type SketchFeature, type Vec3 } from "../types";
import { icon } from "../ui/icons";
import { openKeypad, type KeypadHandle } from "../ui/keypad";
import { toast } from "../ui/toast";
import { type Ptr } from "../view/input";

export function startNewSketch() {
  S.mode = { kind: "pickPlane", offset: 0, tiltX: 0, tiltY: 0 };
  S.selectedFeature = null;
  S.selectedFace = null;
  vp.highlightFace(null);
  showPickPlanes();
  renderAll();
}

/** The three planes, where the sketch would land with the offset and tilt set. */
export function showPickPlanes() {
  if (S.mode.kind !== "pickPlane") return;
  const m = S.mode;
  vp.showPlanes(STD_PLANES.map((def) => ({ def: placedPlane(def, m), color: PLANE_COLORS[def.label] })));
}

/**
 * The picked plane moved along its normal, then turned around its own X axis, then around the Y
 * axis of the plane so turned (tilt forward, then to the side).
 */
export function placedPlane(base: PlaneDef, o: { offset: number; tiltX: number; tiltY: number }): PlaneDef {
  if (!o.offset && !o.tiltX && !o.tiltY) return base;
  const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
  const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // Rodrigues: v cosθ + (axis × v) sinθ + axis (axis · v)(1 − cosθ)
  const rot = (v: Vec3, axis: Vec3, deg: number): Vec3 => {
    const rad = (deg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
    return add3(add3(mul3(v, c), mul3(cross3(axis, v), s)), mul3(axis, d * (1 - c)));
  };
  const origin = add3(base.origin, mul3(base.normal, o.offset));
  if (!o.tiltX && !o.tiltY) return { ...base, origin };
  let xDir = base.xDir;
  let normal = base.normal;
  if (o.tiltX) normal = rot(normal, xDir, o.tiltX);
  if (o.tiltY) {
    const yDir = cross3(normal, xDir);
    xDir = rot(xDir, yDir, o.tiltY);
    normal = rot(normal, yDir, o.tiltY);
  }
  return { origin, xDir, normal, label: base.label, tilt: [o.tiltX, o.tiltY] };
}

/** Set while the offset or tilt keypad is open: a tap on a plane then waits for Confirm. */
export let planeKeypad: KeypadHandle | null = null;

/** Types the offset (mm along the normal) or a tilt (degrees around the plane's X, then its Y axis). */
export async function pickPlaneValue(what: "offset" | "tiltX" | "tiltY") {
  if (S.mode.kind !== "pickPlane" || planeKeypad) return;
  const m = S.mode;
  const was = { offset: m.offset, tiltX: m.tiltX, tiltY: m.tiltY };
  const kp = openKeypad({
    title: "Sketch plane",
    subtitle: what === "offset" ? "Moved along its normal" : what === "tiltX" ? "Tilted around its X axis (forward or back)" : "Then tilted around its Y axis (to the side)",
    label: what === "offset" ? "Offset" : what === "tiltX" ? "Tilt X" : "Tilt Y",
    unit: what === "offset" ? "mm" : "°",
    value: Math.abs(m[what]),
    scope: paramScope(),
    confirmLabel: "Confirm",
    extras: [
      {
        label: "Flip",
        icon: "flip",
        run: () => {
          m[what] = -m[what];
          showPickPlanes();
        },
      },
    ],
    onInput: (v) => {
      m[what] = Math.sign(m[what] || 1) * v;
      showPickPlanes();
    },
  });
  planeKeypad = kp;
  const res = await kp.result;
  planeKeypad = null;
  if (res === null) Object.assign(m, was);
  else m[what] = Math.sign(m[what] || 1) * res.value;
  showPickPlanes();
  renderTools();
  renderStatus();
}

export function pickPlaneAt(p: Ptr) {
  if (planeKeypad) return; // the offset or tilt is being typed
  const label = vp.pickPlane(p.x, p.y);
  const faceId = vp.pickFace(p.x, p.y);
  let plane: PlaneDef | undefined;
  let face: FaceRef | undefined;
  if (faceId != null) {
    const pf = S.lastBuild?.planarFaces.find((f) => f.faceId === faceId);
    if (pf) {
      plane = pf.plane;
      face = { center: pf.center, normal: pf.plane.normal };
    }
  }
  if (!plane && label) plane = STD_PLANES.find((s) => s.label === label);
  if (!plane) {
    if (faceId != null) toast("Only flat faces can hold a sketch");
    return;
  }
  if (S.mode.kind === "pickPlane" && (S.mode.offset || S.mode.tiltX || S.mode.tiltY)) {
    plane = placedPlane(plane, S.mode);
    face = undefined; // off the face, the sketch no longer follows it
  }
  createSketchOn(plane, face);
}

/** `face`: the model face the plane comes from, so the sketch follows it when the model changes. */
export function createSketchOn(plane: PlaneDef, face?: FaceRef) {
  vp.showPlanes(null);
  vp.highlightFace(null);
  S.selectedFace = null;
  const sk = newSketch(nextName("Sketch"), plane);
  if (face) sk.face = face;
  S.doc.features.push(sk);
  commit();
  enterSketch(sk);
}

export function enterSketch(sk: SketchFeature) {
  if (S.mode.kind === "sketch") S.mode.editor.dispose();
  vp.showPlanes(null);
  vp.highlightFace(null);
  S.selectedFace = null;
  const editor = new SketchEditor(vp, solver, sk, {
    commit,
    changed: () => {
      renderPanel();
      renderStatus();
    },
    toast,
    scope: paramScope,
  });
  editor.selectMode = prefs.selectMode;
  editor.glyphs = prefs.glyphs;
  S.mode = { kind: "sketch", editor };
  S.selectedFeature = sk.id;
  vp.setGridPlane(sk.plane);
  vp.viewNormalTo(sk.plane);
  vp.setModelOpacity(0.45);
  renderAll();
}

export function exitSketch() {
  if (S.mode.kind !== "sketch") return;
  const sk = S.mode.editor.sk;
  S.mode.editor.dispose();
  S.mode = { kind: "part" };
  vp.setGridPlane(null);
  vp.setModelOpacity(1);
  commit();
  renderAll();
  const used = S.doc.features.some((f) => f.kind === "extrude" && f.sketchId === sk.id);
  if (!used && findRegions(sk).length)
    toast("Next: Extrude turns this sketch into a solid");
}

export function escape(): boolean {
  if (document.getElementById("projects")) {
    closeProjects();
    return true;
  }
  if (measuring) {
    endMeasure();
    return true;
  }
  if (isOperation(S.mode)) {
    S.mode.keypad.close();
    return true;
  }
  if (S.pendingFaceTool) {
    S.pendingFaceTool = null;
    renderAll();
    return true;
  }
  if (S.mode.kind === "mate") {
    startMate();
    return true;
  }
  if (S.mode.kind === "sweep" || S.mode.kind === "loft") {
    endSweepLoft(false);
    return true;
  }
  if (S.mode.kind === "align") {
    endAlign();
    return true;
  }
  if (S.mode.kind === "combine") {
    endCombine();
    return true;
  }
  if (M.clashes) {
    clearClashes();
    return true;
  }
  if (explodeTarget) {
    toggleExplode();
    return true;
  }
  if (S.showParams) {
    toggleParams();
    return true;
  }
  if (S.mode.kind === "sketch") {
    if (!S.mode.editor.escape()) exitSketch();
    renderAll();
    return true;
  }
  if (S.mode.kind === "pickPlane") {
    S.mode = { kind: "part" };
    vp.showPlanes(null);
    vp.highlightFace(null);
    renderAll();
    return true;
  }
  if (S.selectedFeature || S.selectedFace) {
    clearPartSelection();
    return true;
  }
  return false;
}

export function clearPartSelection() {
  S.selectedFeature = null;
  S.selectedFace = null;
  vp.highlightFace(null);
  renderAll();
}
