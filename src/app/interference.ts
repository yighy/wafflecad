// Interference: the parts of an assembly that overlap, found and shown.
import { M, commit, kernelReady, pendingClashes, rebuild, renderAll, vp, worker } from "../main";
import { applyMates } from "./mates";
import { endMeasure, measuring } from "./measure";
import { S, isOperation } from "./state";
import { type PartInstance, type Vec3, type WorkerRequest } from "../types";
import { icon } from "../ui/icons";
import { openKeypad, type Segmented } from "../ui/keypad";
import { toast } from "../ui/toast";

export function checkInterference() {
  if (!kernelReady) return toast("The geometry kernel is still loading");
  if ((S.doc.instances?.length ?? 0) < 2) return toast("Insert at least two parts first");
  if (measuring) endMeasure();
  S.selectedFeature = null;
  const reqId = ++M.reqCounter;
  const state: NonNullable<typeof M.clashes> = { list: [], running: true };
  M.clashes = state;
  vp.setClashes(null);
  pendingClashes.set(reqId, (list, error) => {
    if (M.clashes !== state) return; // closed meanwhile
    M.clashes = { list, running: false, error };
    vp.setClashes(list);
    renderAll();
  });
  worker.postMessage({ type: "clash", reqId, doc: S.doc, skip: [...M.hiddenBodies] } satisfies WorkerRequest);
  renderAll();
}

export function clearClashes() {
  M.clashes = null;
  vp.setClashes(null);
  renderAll();
}

/** Position and turns of a part, typed on the keypad (one value at a time). */
export async function placeTool(inst: PartInstance) {
  if (isOperation(S.mode)) return;
  const before = { at: [...inst.at] as Vec3, rot: [...inst.rot] as Vec3 };
  const LABELS = ["X", "Y", "Z", "Turn X", "Turn Y", "Turn Z"];
  let field = 0;
  const get = (i: number) => (i < 3 ? inst.at[i] : inst.rot[i - 3]);
  const set = (i: number, v: number) => {
    if (i < 3) inst.at[i] = v;
    else inst.rot[i - 3] = v;
    rebuild();
  };
  const choose = (i: number) => {
    field = i;
    kp.setLabel(LABELS[i], i < 3 ? "mm" : "°");
    kp.set(get(i));
  };
  const row = (from: number): Segmented => ({
    options: [0, 1, 2].map((k) => ({ value: String(from + k), label: LABELS[from + k] })),
    get: () => String(field),
    set: (v) => choose(Number(v)),
  });
  const kp = openKeypad({
    title: inst.name,
    subtitle: "Position of its origin, and turns about it",
    label: LABELS[0],
    value: get(0),
    confirmLabel: "Confirm",
    segments: [row(0), row(3)],
    extras: [
      {
        label: "Negate",
        icon: "flip",
        run: () => {
          set(field, -get(field));
          kp.set(get(field));
        },
      },
    ],
    onInput: (v) => set(field, v),
  });
  S.mode = { kind: "place", feat: inst, keypad: kp };
  renderAll();
  const res = await kp.result;
  S.mode = { kind: "part" };
  if (!res) {
    inst.at = before.at;
    inst.rot = before.rot;
    rebuild(true);
    renderAll();
    return;
  }
  set(field, res.value);
  applyMates();
  commit();
}
