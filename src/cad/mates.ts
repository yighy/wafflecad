// Assembly mates: the parts are moved, as little as possible, until every mate holds.
// Each moving part has 6 unknowns (a slide and a small turn about its centre); each mate gives a
// few equations. They are solved by damped least squares (Levenberg–Marquardt), which also keeps
// the parts' free movements where they were. No DOM: runs under Node for the tests.
import * as THREE from "three";
import type { Mate, MateRef, PartInstance, Vec3 } from "../types";

/** Direction errors count as this many millimetres (so turns and slides weigh alike). */
const DIR_WEIGHT = 20;
/** A mate holds when its error is below this (mm). */
const TOL = 1e-6;

export interface MateSolution {
  /** New placement of each part that moved. */
  placed: Map<string, { at: Vec3; rot: Vec3 }>;
  /** Movements left free to the parts that are not fixed (0: fully placed). */
  dof: number;
  /** Mates that cannot hold with the others (nothing is moved then). */
  failing: string[];
}

/** The placement of a part, as a matrix (turned about its origin, then moved). */
export function instanceMatrix(inst: Pick<PartInstance, "at" | "rot">) {
  const e = new THREE.Euler(...(inst.rot.map((d) => THREE.MathUtils.degToRad(d)) as Vec3), "XYZ");
  return new THREE.Matrix4().compose(new THREE.Vector3(...inst.at), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(1, 1, 1));
}

/** The placement a matrix stands for, rounded (no −0, no 1e-15 left over). */
export function placementOf(m: THREE.Matrix4): { at: Vec3; rot: Vec3 } {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  m.decompose(p, q, new THREE.Vector3());
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  const clean = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
  return { at: [p.x, p.y, p.z].map(clean) as Vec3, rot: [e.x, e.y, e.z].map((r) => clean(THREE.MathUtils.radToDeg(r))) as Vec3 };
}

/** A part's plane or axis where the part is now (`m`: its placement). */
export function worldRef(ref: Pick<MateRef, "origin" | "dir">, m: THREE.Matrix4) {
  return {
    origin: new THREE.Vector3(...ref.origin).applyMatrix4(m),
    dir: new THREE.Vector3(...ref.dir).transformDirection(m),
  };
}

/** A world plane or axis in a part's own coordinates (to store it in a mate). */
export function localRef(origin: Vec3, dir: Vec3, m: THREE.Matrix4): { origin: Vec3; dir: Vec3 } {
  const inv = m.clone().invert();
  return {
    origin: new THREE.Vector3(...origin).applyMatrix4(inv).toArray() as Vec3,
    dir: new THREE.Vector3(...dir).transformDirection(inv).toArray() as Vec3,
  };
}

/** The errors of a mate, for parts placed at `ma` and `mb` (all zero when it holds). */
function mateErrors(mate: Mate, ma: THREE.Matrix4, mb: THREE.Matrix4): number[] {
  const a = worldRef(mate.a, ma);
  const b = worldRef(mate.b, mb);
  const gap = b.origin.clone().sub(a.origin);
  if (mate.kind === "axis") {
    const par = a.dir.clone().cross(b.dir).multiplyScalar(DIR_WEIGHT);
    const off = gap.cross(a.dir);
    return [par.x, par.y, par.z, off.x, off.y, off.z];
  }
  if (mate.kind === "angle") return [(a.dir.dot(b.dir) - Math.cos(THREE.MathUtils.degToRad(mate.value))) * DIR_WEIGHT];
  // Facing each other (touch) the normals are opposite; flush (align) they are the same.
  const turn = (mate.kind === "touch" ? a.dir.clone().add(b.dir) : a.dir.clone().sub(b.dir)).multiplyScalar(DIR_WEIGHT);
  return [turn.x, turn.y, turn.z, gap.dot(a.dir) - mate.value];
}

/**
 * Moves the parts so that the mates hold, each as little as it can. Fixed parts never move; parts
 * with no mate stay where they are. `centers`: where each part turns about (its middle, world
 * coordinates), so that turning it does not swing it far away.
 */
export function solveMates(instances: PartInstance[], mates: Mate[], centers: Record<string, Vec3> = {}): MateSolution {
  const byId = new Map(instances.map((i) => [i.id, i]));
  const live = mates.filter((m) => byId.has(m.a.part) && byId.has(m.b.part) && m.a.part !== m.b.part);
  const free = instances.filter((i) => !i.fixed);
  const mated = new Set(live.flatMap((m) => [m.a.part, m.b.part]));
  const moving = free.filter((i) => mated.has(i.id));
  const col = new Map(moving.map((i, k) => [i.id, k * 6]));
  const base = new Map(instances.map((i) => [i.id, instanceMatrix(i)]));
  const center = new Map(instances.map((i) => [i.id, new THREE.Vector3(...(centers[i.id] ?? i.at))]));
  const n = moving.length * 6;

  const poseOf = (id: string, x: Float64Array) => {
    const m0 = base.get(id)!;
    const k = col.get(id);
    if (k === undefined) return m0;
    const c = center.get(id)!;
    const w = new THREE.Vector3(x[k + 3], x[k + 4], x[k + 5]);
    const angle = w.length();
    const turn = angle > 0 ? new THREE.Matrix4().makeRotationAxis(w.clone().divideScalar(angle), angle) : new THREE.Matrix4();
    return new THREE.Matrix4()
      .makeTranslation(c.x + x[k], c.y + x[k + 1], c.z + x[k + 2])
      .multiply(turn)
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
      .multiply(m0);
  };
  const errorsAt = (x: Float64Array) => live.map((m) => mateErrors(m, poseOf(m.a.part, x), poseOf(m.b.part, x)));
  const flat = (e: number[][]) => e.flat();
  const cost = (r: number[]) => r.reduce((s, v) => s + v * v, 0);
  const jacobian = (x: Float64Array, r: number[]) => {
    const h = 1e-7;
    const J: number[][] = r.map(() => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const xp = x.slice();
      xp[j] += h;
      const rp = flat(errorsAt(xp));
      for (let i = 0; i < r.length; i++) J[i][j] = (rp[i] - r[i]) / h;
    }
    return J;
  };

  /** Damped least squares from a start; returns where it ended and its error. */
  const descend = (start: Float64Array) => {
    let x = start;
    let r = flat(errorsAt(x));
    let c = cost(r);
    let mu = 1e-6;
    for (let it = 0; it < 200 && c > TOL * TOL && n > 0; it++) {
      const J = jacobian(x, r);
      const H = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => J.reduce((s, row) => s + row[i] * row[j], 0)));
      const g = Array.from({ length: n }, (_, i) => J.reduce((s, row, k) => s + row[i] * r[k], 0));
      let improved = false;
      while (mu < 1e12) {
        const A = H.map((row, i) => row.map((v, j) => v + (i === j ? mu : 0)));
        const step = solveLinear(A, g.map((v) => -v));
        const xn = x.map((v, i) => v + (step?.[i] ?? 0));
        const rn = flat(errorsAt(xn));
        const cn = cost(rn);
        if (step && cn < c) {
          x = xn;
          r = rn;
          c = cn;
          mu = Math.max(mu * 0.3, 1e-12);
          improved = true;
          break;
        }
        mu *= 10;
      }
      if (!improved) break;
    }
    return { x, c };
  };

  // From where the parts are first. A part turned exactly the wrong way round (flush faces that
  // face each other) sits where no small turn helps: it is then also tried half a turn round.
  let best = descend(new Float64Array(n));
  for (let k = 0; k < moving.length && best.c > TOL * TOL; k++)
    for (const axis of [0, 1, 2]) {
      const start = new Float64Array(n);
      start[k * 6 + 3 + axis] = Math.PI;
      const tryIt = descend(start);
      if (tryIt.c < best.c) best = tryIt;
      if (best.c <= TOL * TOL) break;
    }
  const x = best.x;

  const errs = errorsAt(x);
  const failing = live.filter((_, i) => Math.hypot(...errs[i]) > 1e-4).map((m) => m.id);
  const placed = new Map<string, { at: Vec3; rot: Vec3 }>();
  if (!failing.length) for (const i of moving) placed.set(i.id, placementOf(poseOf(i.id, x)));
  // Movements left: 6 for each free part, less the independent equations of the mates.
  const rank = n ? matrixRank(jacobian(x, flat(errs))) : 0;
  return { placed, dof: free.length * 6 - rank, failing };
}

/** Solves A·x = b (Gaussian elimination with partial pivoting); null when A is singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = c + 1; i < n; i++) {
      const f = M[i][c] / M[c][c];
      if (f) for (let j = c; j <= n; j++) M[i][j] -= f * M[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/** Number of independent rows of a matrix (elimination with full pivoting). */
function matrixRank(J: number[][]): number {
  const M = J.map((r) => r.slice());
  const rows = M.length;
  const cols = rows ? M[0].length : 0;
  const scale = Math.max(1, ...M.flat().map(Math.abs));
  let rank = 0;
  const used = new Array(rows).fill(false);
  for (let c = 0; c < cols; c++) {
    let p = -1;
    for (let i = 0; i < rows; i++) if (!used[i] && (p < 0 || Math.abs(M[i][c]) > Math.abs(M[p][c]))) p = i;
    if (p < 0 || Math.abs(M[p][c]) < 1e-6 * scale) continue;
    used[p] = true;
    rank++;
    for (let i = 0; i < rows; i++) {
      if (i === p) continue;
      const f = M[i][c] / M[p][c];
      if (f) for (let j = c; j < cols; j++) M[i][j] -= f * M[p][j];
    }
  }
  return rank;
}
