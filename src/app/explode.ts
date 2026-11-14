// The exploded view of an assembly: parts spread from its middle, animated both ways.
import * as THREE from "three";
import { app } from "./app";
import { toast } from "../ui/toast";

/** How far the parts are spread (0: assembled, 1: exploded), and where it is heading. */
export let explode = 0;
export let explodeTarget = 0;

/** Spreads the parts away from the middle of the assembly, each by its own distance from it. */
export function spreadParts(t: number) {
  const bodies = app.lastBuild()?.bodies ?? [];
  const all = app.vp.modelBox();
  if (!all || bodies.length < 2) return;
  const mid = all.getCenter(new THREE.Vector3());
  const moves = new Map<string, THREE.Matrix4>();
  for (const b of bodies) {
    const box = app.vp.bodyBox(b.id);
    if (box) moves.set(b.id, new THREE.Matrix4().makeTranslation(box.getCenter(new THREE.Vector3()).sub(mid).multiplyScalar(t)));
  }
  app.vp.moveBodies(moves);
}

export function toggleExplode() {
  if ((app.doc().instances?.length ?? 0) < 2) return toast("Insert at least two parts first");
  explodeTarget = explodeTarget ? 0 : 1;
  const from = explode;
  const to = explodeTarget;
  const t0 = performance.now();
  const frame = () => {
    if (explodeTarget !== to) return; // turned round meanwhile
    const k = Math.min(1, (performance.now() - t0) / 450);
    explode = from + (to - from) * (1 - (1 - k) ** 3);
    // The spread is measured from the parts as built, so it always starts from there.
    app.vp.moveBodies(new Map());
    spreadParts(explode);
    if (k < 1) requestAnimationFrame(frame);
    else app.renderAll();
  };
  requestAnimationFrame(frame);
  app.renderAll();
}


/** Back to assembled, at once (another project opened). */
export function resetExplode() {
  explode = explodeTarget = 0;
}
