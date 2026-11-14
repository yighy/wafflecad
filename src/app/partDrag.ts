// Moving an assembly's parts live, dragged with a finger or the gizmo handles.
import * as THREE from "three";
import { M, commit, renderAll, vp } from "../main";
import { instanceOf, isAssembly } from "./assemblies";
import { applyMates, partFrames } from "./mates";
import { explode } from "./explode";
import { measuring } from "./measure";
import { S } from "./state";
import { instanceMatrix, placementOf, solveMates } from "../cad/mates";
import { type PartInstance, type Vec3 } from "../types";
import { type Ptr } from "../view/input";

/** Placements while a part is dragged, kept out of the document until it is let go. */
export let dragging: { insts: PartInstance[]; built: Map<string, THREE.Matrix4>; centers: Record<string, Vec3>; radii: Record<string, number>; lead: string } | null = null;

export function beginDrag(id: string) {
  const insts = structuredClone(S.doc.instances ?? []);
  dragging = { insts, built: new Map(insts.map((i) => [i.id, instanceMatrix(i)])), ...partFrames(), lead: id };
}

/**
 * Moves the dragged part by `step` from where it is now, then lets the mates have their way: a
 * hinged lid swings, a drawer slides, a mated part only takes what its mates leave free (and parts
 * mated to it follow). Drawn at once, without rebuilding.
 */
export function dragBy(step: THREE.Matrix4) {
  const d = dragging;
  if (!d) return;
  const trial = d.insts.map((i) => ({ ...i }));
  const lead = trial.find((i) => i.id === d.lead)!;
  Object.assign(lead, placementOf(step.clone().multiply(instanceMatrix(lead))));
  // Each part turns about its middle where it is now.
  const centers: Record<string, Vec3> = {};
  for (const i of trial) {
    const c = d.centers[i.id];
    if (c) centers[i.id] = new THREE.Vector3(...c).applyMatrix4(instanceMatrix(i).multiply(d.built.get(i.id)!.clone().invert())).toArray() as Vec3;
  }
  const sol = solveMates(trial, S.doc.mates ?? [], centers, d.radii);
  if (sol.failing.length) return; // no way there: it stays where it was
  for (const [id, p] of sol.placed) Object.assign(trial.find((i) => i.id === id)!, p);
  d.insts = trial;
  vp.moveBodies(new Map(trial.map((i) => [i.id, instanceMatrix(i).multiply(d.built.get(i.id)!.clone().invert())])));
}

/** Lets go: the parts stay where the drag left them (or go back, on a cancelled gesture). */
export function endDrag(keep: boolean) {
  const d = dragging;
  dragging = null;
  if (!d) return;
  if (!keep) {
    // A second finger turned the drag into a camera move: the parts go back, the handles too.
    vp.moveBodies(new Map());
    renderAll();
    return;
  }
  S.doc.instances = d.insts;
  applyMates();
  commit();
}

/**
 * A finger on a part (not a fixed one) slides it across the table: it keeps its height (Z), which
 * only the gizmo's Z arrow or the keypad change.
 */

export function fingerDown(p: Ptr) {
  M.fingerDrag = null;
  if (!isAssembly() || S.mode.kind !== "part" || measuring || explode > 0 || M.clashes) return;
  const hit = vp.pickPoint(p.x, p.y);
  const body = hit?.faceId == null ? null : S.lastBuild?.bodies?.find((b) => b.faceIds.includes(hit.faceId!));
  const inst = instanceOf(body?.id ?? null);
  if (!hit || !inst || inst.fixed) return;
  const at = new THREE.Vector3(...hit.point);
  const toEye = vp.camera.getWorldDirection(new THREE.Vector3()).negate();
  // On a level plane through the point touched, so the part follows the finger exactly; seen
  // nearly edge-on that plane would make small moves jump far, so then on an upright plane facing
  // the eye, its height change dropped.
  const flat = Math.abs(toEye.z) > 0.26;
  const normal = flat ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(toEye.x, toEye.y, 0).normalize();
  M.fingerDrag = { id: inst.id, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, at), flat, last: at, x0: p.x, y0: p.y, moved: false };
}

export function fingerMove(p: Ptr) {
  const f = M.fingerDrag;
  if (!f) return;
  if (!f.moved) {
    // A finger waits a little longer: a second one may still come and make it a camera move.
    if (Math.hypot(p.x - f.x0, p.y - f.y0) < (p.kind === "touch" ? 16 : 6)) return;
    f.moved = true;
    S.selectedFeature = f.id;
    M.gizmo?.dispose();
    M.gizmo = null;
    M.gizmoFor = "";
    beginDrag(f.id);
  }
  const to = vp.ray(p.x, p.y).ray.intersectPlane(f.plane, new THREE.Vector3());
  if (!to) return;
  const step = to.clone().sub(f.last);
  if (!f.flat) step.z = 0;
  dragBy(new THREE.Matrix4().makeTranslation(step));
  f.last = to;
}
