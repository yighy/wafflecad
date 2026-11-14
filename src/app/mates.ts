// Mates: how an assembly's parts are tied together, and solving them.
import * as THREE from "three";
import { M, commit, pendingRefs, rebuild, renderAll, vp, worker } from "../main";
import { renderTimeline } from "./timeline";
import { instanceOf, isAssembly } from "./assemblies";
import { beginDrag, dragBy, dragging, endDrag } from "./partDrag";
import { rgb } from "./display";
import { explodeTarget } from "./explode";
import { hitRadiusPx } from "./holes";
import { endMeasure, measuring } from "./measure";
import { S, isOperation, type MatePick } from "./state";
import { instanceMatrix, localRef, solveMates, worldRef } from "../cad/mates";
import { freeName } from "../projects";
import { uid } from "../sketch/model";
import { type Mate, type MateRef, type PartInstance, type Vec3, type WorkerRequest } from "../types";
import { openKeypad, type Segmented } from "../ui/keypad";
import { PlaceGizmo } from "../ui/placeGizmo";
import { toast } from "../ui/toast";
import { type Ptr } from "../view/input";
import { type LineBatch } from "../view/viewport";

/** Where each part turns about when the solver moves it (its middle, as drawn), and its size. */
export function partFrames() {
  const centers: Record<string, Vec3> = {};
  const radii: Record<string, number> = {};
  for (const i of S.doc.instances ?? []) {
    const b = vp.bodyBox(i.id);
    if (!b) continue;
    centers[i.id] = b.getCenter(new THREE.Vector3()).toArray() as Vec3;
    radii[i.id] = b.getSize(new THREE.Vector3()).length() / 2;
  }
  return { centers, radii };
}

/** Moves the parts so the mates hold (nothing moves when they cannot all hold). */
export function applyMates() {
  const f = partFrames();
  const sol = solveMates(S.doc.instances ?? [], S.doc.mates ?? [], f.centers, f.radii);
  for (const [id, p] of sol.placed) Object.assign(instanceOf(id)!, p);
  M.solveState = { key: mateKey(), dof: sol.dof, failing: new Set(sol.failing) };
}

export const mateKey = () => JSON.stringify([S.doc.instances, S.doc.mates]);

/** The mates' state, worked out again when the parts or mates changed (undo, opening). */
export function mateState() {
  if (!M.solveState || M.solveState.key !== mateKey()) {
    const f = partFrames();
    const sol = solveMates(S.doc.instances ?? [], S.doc.mates ?? [], f.centers, f.radii);
    M.solveState = { key: mateKey(), dof: sol.dof, failing: new Set(sol.failing) };
  }
  return M.solveState;
}

export const MATE_KINDS: Record<Mate["kind"], string> = { touch: "Touch", align: "Flush", axis: "Axis", angle: "Angle" };

export function mateName(kind: Mate["kind"]) {
  return freeName(MATE_KINDS[kind], (S.doc.mates ?? []).map((m) => m.name));
}

export const mateOf = (id: string | null) => S.doc.mates?.find((m) => m.id === id) ?? null;

export function startMate() {
  if (isOperation(S.mode)) return;
  if ((S.doc.instances?.length ?? 0) < 2) return toast("Insert at least two parts first");
  if (S.mode.kind === "mate") {
    S.mode = { kind: "part" };
    vp.highlightFaces([]);
    vp.highlightEdges([]);
    return renderAll();
  }
  if (measuring) endMeasure();
  S.selectedFeature = null;
  S.mode = { kind: "mate", picks: [] };
  renderAll();
}

/** The plane or axis of a face or edge, from the worker. */
export function askRef(pick: { kind: "face" | "edge"; id: number }) {
  const reqId = ++M.reqCounter;
  return new Promise<Omit<MateRef, "part"> | null>((resolve) => {
    pendingRefs.set(reqId, resolve);
    worker.postMessage({ type: "ref", reqId, doc: S.doc, pick } satisfies WorkerRequest);
  });
}

/** A tap while choosing a mate: a hole or round edge near the tap, else the face under it. */
export async function mateTap(p: Ptr) {
  if (S.mode.kind !== "mate") return;
  const m = S.mode;
  const bodies = S.lastBuild?.bodies ?? [];
  const ei = vp.pickEdge(p.x, p.y, hitRadiusPx(p));
  const face = vp.pickFace(p.x, p.y);
  let pick: MatePick | null = null;
  for (const k of [ei != null ? { kind: "edge" as const, id: vp.edgeId(ei) } : null, face != null ? { kind: "face" as const, id: face } : null]) {
    if (!k) continue;
    const body = bodies.find((b) => (k.kind === "face" ? b.faceIds : b.edgeIds).includes(k.id));
    const inst = instanceOf(body?.id ?? null);
    if (!inst) continue;
    const g = await askRef(k);
    if (S.mode !== m) return; // left meanwhile
    if (!g) continue;
    pick = { ref: { part: inst.id, kind: g.kind, ...localRef(g.origin, g.dir, instanceMatrix(inst)) }, face: k.kind === "face" ? k.id : undefined, edge: k.kind === "edge" ? (ei ?? undefined) : undefined };
    break;
  }
  if (!pick) return toast("Tap a flat face, a hole or a round edge of a part");
  const first = m.picks[0];
  if (first && first.ref.part === pick.ref.part) return toast("Now tap the other part");
  if (first && first.ref.kind !== pick.ref.kind) return toast(first.ref.kind === "plane" ? "Now tap a flat face of the other part" : "Now tap a hole, a pin or a round edge of the other part");
  m.picks.push(pick);
  showMatePicks(m.picks);
  if (m.picks.length < 2) return renderAll();
  const [a, b] = m.picks.map((x) => x.ref);
  const kind: Mate["kind"] = a.kind === "axis" ? "axis" : "touch";
  const mate: Mate = { id: uid(), name: mateName(kind), kind, a, b, value: 0 };
  S.mode = { kind: "part" };
  showMatePicks([]);
  S.doc.mates = [...(S.doc.mates ?? []), mate];
  if (kind === "axis") {
    applyMates();
    S.selectedFeature = mate.id;
    if (mateState().failing.has(mate.id)) toast("This mate cannot hold with the others");
    return commit();
  }
  void mateTool(mate, true);
}

export function showMatePicks(picks: MatePick[]) {
  vp.highlightFaces(picks.flatMap((k) => (k.face != null ? [k.face] : [])));
  vp.highlightEdges(picks.flatMap((k) => (k.edge != null ? [k.edge] : [])));
}

/** A mate between faces: how (facing, flush or at an angle) and the gap or angle, on the keypad. */
export async function mateTool(mate: Mate, isNew = false) {
  if (isOperation(S.mode) || mate.kind === "axis") return;
  const before = JSON.stringify(mate);
  const places = JSON.stringify(S.doc.instances);
  const unit = () => (mate.kind === "angle" ? "°" : "mm");
  /** What the keypad types: the exact value, or one of the limits. */
  let field: "value" | "min" | "max" = mate.min !== undefined ? "min" : "value";
  const label = () =>
    field === "min" ? "From" : field === "max" ? "To" : ({ touch: "Gap", align: "Offset", angle: "Angle", axis: "" })[mate.kind];
  const read = () => (field === "value" ? mate.value : mate[field]!);
  const choose = (f: typeof field) => {
    field = f;
    kp.setLabel(label(), unit());
    kp.set(read());
  };
  const limitRow: Segmented = {
    options: [
      { value: "min", label: "From" },
      { value: "max", label: "To" },
    ],
    get: () => field,
    set: (v) => choose(v as typeof field),
  };
  const segments: Segmented[] = [];
  const update = () => {
    applyMates();
    kp.setNote(mateState().failing.has(mate.id) ? "Cannot hold with the other mates" : null);
    renderTimeline();
    rebuild();
  };
  // (The keypad draws these rows as it opens.)
  segments.push(
    {
      options: [
        { value: "touch", label: "Facing" },
        { value: "align", label: "Flush" },
        { value: "angle", label: "Angle" },
      ],
      get: () => mate.kind,
      set: (v) => {
        const kind = v as Mate["kind"];
        if (kind === mate.kind) return;
        // Turning to an angle starts at a right angle; back to faces, at contact.
        mate.value = kind === "angle" ? 90 : 0;
        if (mate.min !== undefined) [mate.min, mate.max] = kind === "angle" ? [0, 90] : [0, 10];
        if (isNew) mate.name = freeName(MATE_KINDS[kind], (S.doc.mates ?? []).filter((x) => x !== mate).map((x) => x.name));
        mate.kind = kind;
        choose(field);
        update();
      },
    },
    {
      // Exact, or free between two limits (a drawer's travel, a lid's opening).
      options: [
        { value: "exact", label: "Exact" },
        { value: "range", label: "Limits" },
      ],
      get: () => (mate.min !== undefined ? "range" : "exact"),
      set: (v) => {
        if ((v === "range") === (mate.min !== undefined)) return;
        if (v === "range") {
          mate.min = Math.min(mate.value, mate.kind === "angle" ? 0 : mate.value);
          mate.max = mate.value + (mate.kind === "angle" ? 90 : 10);
          segments.push(limitRow);
          choose("min");
        } else {
          delete mate.min;
          delete mate.max;
          segments.splice(segments.indexOf(limitRow), 1);
          choose("value");
        }
        update();
      },
    },
  );
  if (mate.min !== undefined) segments.push(limitRow);
  const kp = openKeypad({
    title: mate.name,
    subtitle: `${partLabel(mate.a.part)} and ${partLabel(mate.b.part)}`,
    label: label(),
    value: read(),
    unit: unit(),
    confirmLabel: "Confirm",
    segments,
    onInput: (v) => {
      if (field === "value") mate.value = v;
      else mate[field] = v;
      update();
    },
  });
  S.mode = { kind: "mateEdit", feat: mate, keypad: kp };
  S.selectedFeature = mate.id;
  update();
  renderAll();
  const res = await kp.result;
  S.mode = { kind: "part" };
  if (!res) {
    S.doc.instances = JSON.parse(places);
    if (isNew) {
      S.doc.mates = S.doc.mates?.filter((x) => x !== mate);
      S.selectedFeature = null;
    } else {
      // Limits added meanwhile go too.
      delete mate.min;
      delete mate.max;
      Object.assign(mate, JSON.parse(before));
    }
    M.solveState = null;
    rebuild(true);
    renderAll();
    return;
  }
  if (field === "value") mate.value = res.value;
  else mate[field] = res.value;
  if (mate.min !== undefined && mate.max !== undefined && mate.min > mate.max) [mate.min, mate.max] = [mate.max, mate.min];
  applyMates();
  if (mateState().failing.has(mate.id)) toast("This mate cannot hold with the others");
  commit();
}

export function deleteMate(mate: Mate) {
  S.doc.mates = S.doc.mates?.filter((m) => m !== mate);
  if (S.selectedFeature === mate.id) S.selectedFeature = null;
  applyMates();
  commit();
}

/** Facing ⇄ flush: the second face turned round. */
export function flipMate(mate: Mate) {
  mate.kind = mate.kind === "touch" ? "align" : "touch";
  // A name it was given by default follows what it now is.
  if (/^(Touch|Flush) \d+$/.test(mate.name)) mate.name = freeName(MATE_KINDS[mate.kind], (S.doc.mates ?? []).filter((x) => x !== mate).map((x) => x.name));
  applyMates();
  commit();
}

export function toggleFixed(inst: PartInstance) {
  inst.fixed = !inst.fixed || undefined;
  applyMates();
  commit();
}

export const partLabel = (id: string) => instanceOf(id)?.name ?? "a removed part";

/** The faces or axes of the selected mate (or of the picks being made), drawn over the model. */
export function mateMarks(batch: LineBatch) {
  const refs = S.mode.kind === "mate" ? S.mode.picks.map((k) => k.ref) : (() => {
    const m = mateOf(S.selectedFeature) ?? (S.mode.kind === "mateEdit" ? S.mode.feat : null);
    return m ? [m.a, m.b] : [];
  })();
  const acc = rgb("--accent");
  const s = 26 * vp.wpp;
  for (const ref of refs) {
    const inst = instanceOf(ref.part);
    if (!inst) continue;
    const { origin: o, dir: n } = worldRef(ref, instanceMatrix(inst));
    const seg = (a: THREE.Vector3, b: THREE.Vector3) => {
      batch.positions.push(...a.toArray(), ...b.toArray());
      batch.colors.push(...acc, ...acc);
    };
    if (ref.kind === "axis") {
      seg(o.clone().addScaledVector(n, -3 * s), o.clone().addScaledVector(n, 3 * s));
      continue;
    }
    // A square on the face, and its normal.
    const u = new THREE.Vector3().crossVectors(n, Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const c = [u.clone().add(v), u.clone().sub(v), u.clone().negate().sub(v), v.clone().sub(u)].map((d) => o.clone().addScaledVector(d, s));
    for (let i = 0; i < 4; i++) seg(c[i], c[(i + 1) % 4]);
    seg(o, o.clone().addScaledVector(n, 1.5 * s));
  }
}

/** The handles on the selected part, while nothing else is going on. */
export function syncGizmo() {
  const inst = isAssembly() && S.mode.kind === "part" && !measuring && !explodeTarget && !M.clashes && !dragging ? instanceOf(S.selectedFeature) : null;
  if (inst?.fixed) {
    M.gizmo?.dispose();
    M.gizmo = null;
    M.gizmoFor = "";
    return;
  }
  const box = inst && !M.hiddenBodies.has(inst.id) ? vp.bodyBox(inst.id) : null;
  const key = inst && box ? `${inst.id}|${box.min.toArray()}|${box.max.toArray()}` : "";
  if (key === M.gizmoFor) return;
  M.gizmoFor = key;
  M.gizmo?.dispose();
  M.gizmo = null;
  if (!inst || !box) return;
  // The handles give the whole move since the drag began; the mates follow it step by step.
  let last = new THREE.Matrix4();
  M.gizmo = new PlaceGizmo(
    vp,
    box.getCenter(new THREE.Vector3()),
    (m) => {
      if (!dragging) {
        beginDrag(inst.id);
        last = new THREE.Matrix4();
      }
      dragBy(m.clone().multiply(last.clone().invert()));
      last = m;
    },
    () => endDrag(true),
  );
}
