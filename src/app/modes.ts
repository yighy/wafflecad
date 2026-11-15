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
import { askRef, startMate } from "./mates";
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
import { cssVar } from "../view/viewport";
import { fmtNum } from "./util";

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
  m.hinge = false;
  vp.highlightEdges([]);
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
  if (S.mode.kind === "pickPlane" && S.mode.hinge) return void hingeAt(p);
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
  if (faceId != null && faceId < 0 && !plane) return void sketchOnMesh(p, faceId);
  if (!plane && label) plane = STD_PLANES.find((s) => s.label === label);
  if (!plane) {
    if (faceId != null) toast("Only flat faces can hold a sketch");
    return;
  }
  // Set off a face, the sketch still follows it: the face is kept, the plane moves with it.
  if (S.mode.kind === "pickPlane" && (S.mode.offset || S.mode.tiltX || S.mode.tiltY)) plane = placedPlane(plane, S.mode);
  createSketchOn(plane, face);
}

/**
 * A sketch on a flat face of a mesh body (STL): its plane, found by the worker around the spot
 * tapped. It stays where the face was (a mesh has no face to follow when the part changes).
 */
async function sketchOnMesh(p: Ptr, faceId: number) {
  const mode = S.mode;
  const tri = vp.pickTriangle(p.x, p.y);
  const body = S.lastBuild?.bodies?.find((b) => b.faceIds.includes(faceId));
  if (!tri || !body) return;
  const g = await askRef({ kind: "mesh", body: body.id, p: tri.point });
  if (S.mode !== mode) return; // left meanwhile
  if (!g || g.kind !== "plane") return toast("Only flat faces can hold a sketch: this part of the mesh is curved");
  let plane = facePlane(g.dir, g.origin);
  if (S.mode.kind === "pickPlane" && (S.mode.offset || S.mode.tiltX || S.mode.tiltY)) plane = placedPlane(plane, S.mode);
  createSketchOn(plane);
}

/**
 * A face's plane as the B-rep faces get theirs: the world origin's projection as origin (so
 * dimensions read naturally), X along world X on a lying face, Y up on a standing one.
 */
function facePlane(normal: Vec3, center: Vec3): PlaneDef {
  const origin = mulV(normal, dot3(center, normal));
  const xDir =
    Math.abs(normal[2]) > 0.9
      ? addV([1, 0, 0], mulV(normal, -normal[0]))
      : crossV(addV([0, 0, 1], mulV(normal, -normal[2])), normal);
  return { origin, xDir: mulV(xDir, 1 / Math.hypot(...xDir)), normal, label: "Face" };
}

/** Around an edge: the next tap picks a straight edge of the model, then the angle is typed. */
export function startHinge() {
  if (S.mode.kind !== "pickPlane") return;
  const m = S.mode;
  if (m.hinge) {
    m.hinge = false;
    vp.highlightEdges([]);
    showPickPlanes();
  } else {
    if (!S.lastBuild?.planarFaces.length) return toast("Make a solid first: the plane turns around one of its edges");
    Object.assign(m, { hinge: true, offset: 0, tiltX: 0, tiltY: 0 });
    vp.showPlanes(null);
  }
  renderTools();
  renderStatus();
}

/** The edge a tap would pick for the plane to turn around (shown on hover). */
export const hingeEdgeAt = (p: Ptr) => vp.pickEdge(p.x, p.y, p.kind === "touch" ? 24 : p.kind === "pen" ? 14 : 9);

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mulV = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const addV = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * The plane of a face turned by `deg` around one of its straight edges (a to b): at 0 it is the
 * face, positive lifts it out of the material, negative turns it into it. Its X axis runs along
 * the edge and its Y axis away from the edge, so the sketch grid starts at the hinge.
 */
export function hingePlane(a: Vec3, b: Vec3, face: { normal: Vec3; center: Vec3 }, deg: number): PlaneDef {
  const len = Math.hypot(...sub3(b, a));
  const u = mulV(sub3(b, a), 1 / len);
  const n = face.normal;
  // In the face, at right angles to the edge, towards the face's inside.
  let w = crossV(n, u);
  if (dot3(sub3(face.center, a), w) < 0) w = mulV(w, -1);
  const r = (deg * Math.PI) / 180;
  const w2 = addV(mulV(w, Math.cos(r)), mulV(n, Math.sin(r)));
  const n2 = sub3(mulV(n, Math.cos(r)), mulV(w, Math.sin(r)));
  const xDir = dot3(crossV(n2, u), w2) >= 0 ? u : mulV(u, -1);
  const origin = dot3(a, xDir) <= dot3(b, xDir) ? a : b;
  return { origin, xDir, normal: n2, label: "Face", hinge: deg };
}

/** The tapped edge, if straight: the flat faces it bounds, one per direction, the one facing the camera first. */
async function hingeAt(p: Ptr) {
  const i = hingeEdgeAt(p);
  if (i === null) return toast("Tap a straight edge of the model");
  const line = vp.edgePolyline(i);
  const a = line[0];
  const b = line[line.length - 1];
  const len = Math.hypot(...sub3(b, a));
  const u = len > 1e-9 ? mulV(sub3(b, a), 1 / len) : ([0, 0, 0] as Vec3);
  const off = (q: Vec3) => Math.hypot(...crossV(sub3(q, a), u));
  if (len < 1e-6 || line.some((q) => off(q) > Math.max(1e-4, len * 1e-5))) return toast("Only a straight edge can be turned around");
  const tol = Math.max(1e-4, len * 1e-6);
  const mid = mulV(addV(a, b), 0.5);
  const view = vp.lookDir();
  const faces = (S.lastBuild?.planarFaces ?? [])
    .filter((pf) => Math.abs(dot3(pf.plane.normal, u)) < 1e-6 && [a, b].every((q) => Math.abs(dot3(sub3(q, pf.plane.origin), pf.plane.normal)) < tol))
    .sort((x, y) => Math.hypot(...sub3(x.center, mid)) - Math.hypot(...sub3(y.center, mid)))
    // The face seen most squarely first (the top of a box seen from above), then the other.
    .sort((x, y) => dot3(x.plane.normal, view) - dot3(y.plane.normal, view))
    .filter((pf, k, all) => all.findIndex((o) => dot3(o.plane.normal, pf.plane.normal) > 0.999) === k);
  if (!faces.length) return toast("This edge is not on a flat face");
  vp.highlightEdges([i]);
  let which = 0;
  let angle = 45;
  const color = cssVar("--accent", "#1f7a5a");
  const preview = () => vp.showPlanes([{ def: hingePlane(a, b, { normal: faces[which].plane.normal, center: faces[which].center }, angle), color }]);
  preview();
  const kp = openKeypad({
    title: "Sketch plane",
    subtitle: "Turned around the edge, from the face next to it",
    label: "Angle",
    unit: "°",
    value: Math.abs(angle),
    scope: paramScope(),
    confirmLabel: "Confirm",
    extras: [
      { label: "Flip", icon: "flip", run: () => ((angle = -angle), preview()) },
      ...(faces.length > 1 ? [{ label: "Other face", icon: "plane", run: () => ((which = (which + 1) % faces.length), preview()) }] : []),
    ],
    onInput: (v) => {
      angle = Math.sign(angle || 1) * v;
      preview();
    },
  });
  planeKeypad = kp;
  const res = await kp.result;
  planeKeypad = null;
  vp.highlightEdges([]);
  if (res === null || S.mode.kind !== "pickPlane") {
    vp.showPlanes(null);
    return;
  }
  angle = Math.sign(angle || 1) * res.value;
  const f = faces[which];
  // The other face at the edge (if flat): with both, the plane follows the edge wherever it goes.
  const g = faces.find((x) => x !== f && dot3(x.plane.normal, f.plane.normal) < 0.999 && dot3(x.plane.normal, f.plane.normal) > -0.999);
  createSketchOn(hingePlane(a, b, { normal: f.plane.normal, center: f.center }, angle), { center: f.center, normal: f.plane.normal }, g && { center: g.center, normal: g.plane.normal });
}

/** `face`: the model face the plane comes from, so the sketch follows it when the model changes. */
export function createSketchOn(plane: PlaneDef, face?: FaceRef, hingeFace?: FaceRef) {
  vp.showPlanes(null);
  vp.highlightFace(null);
  S.selectedFace = null;
  const sk = newSketch(nextName("Sketch"), plane);
  if (face) sk.face = face;
  if (face && hingeFace) sk.hingeFace = hingeFace;
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
