// Sketch editing operations that rebuild geometry: corner fillet, mirror, projected edges.
// Pure sketch-model code (no DOM), testable under Node.
import type { SkConstraint, SkCurve, SkEntity, SkLine, SketchFeature } from "../types";
import { SketchView, isReference, uid } from "./model";

type P2 = [number, number];
const sub = (p: P2, q: P2): P2 => [p[0] - q[0], p[1] - q[1]];
const len = (v: P2) => Math.hypot(v[0], v[1]);
const unit = (v: P2): P2 => {
  const l = len(v);
  return [v[0] / l, v[1] / l];
};

/** The two lines meeting at a point, if exactly two lines end there. */
export function cornerLines(sk: SketchFeature, pointId: string): [SkLine, SkLine] | null {
  const lines = sk.entities.filter((e): e is SkLine => e.type === "line" && !e.axis && (e.p1 === pointId || e.p2 === pointId));
  return lines.length === 2 ? [lines[0], lines[1]] : null;
}

/**
 * Rounds the corner between the two lines ending at `pointId` with an arc of radius r,
 * tangent to both. Returns an error message, or null when done.
 */
export function filletCorner(sk: SketchFeature, pointId: string, r: number): string | null {
  const pair = cornerLines(sk, pointId);
  if (!pair) return "Tap a corner where exactly two lines meet";
  if (!(r > 0)) return "The radius must be positive";
  const v = new SketchView(sk);
  const P = v.xy(pointId);
  const far = (l: SkLine) => (l.p1 === pointId ? l.p2 : l.p1);
  const [q1, q2] = pair.map((l) => v.xy(far(l)));
  const d1 = sub(q1, P);
  const d2 = sub(q2, P);
  const u1 = unit(d1);
  const u2 = unit(d2);
  const angle = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
  if (angle < 1e-3 || angle > Math.PI - 1e-3) return "These lines are in line: there is no corner to round";
  const t = r / Math.tan(angle / 2);
  if (t >= len(d1) - 1e-9 || t >= len(d2) - 1e-9) return "The radius is too large for these lines";
  const bis = unit([u1[0] + u2[0], u1[1] + u2[1]]);
  const h = r / Math.sin(angle / 2);
  const C: P2 = [P[0] + bis[0] * h, P[1] + bis[1] * h];
  const T1: P2 = [P[0] + u1[0] * t, P[1] + u1[1] * t];
  const T2: P2 = [P[0] + u2[0] * t, P[1] + u2[1] * t];

  const [l1, l2] = pair;
  // Their lengths, midpoints and equalities referred to the sharp corner: they no longer hold.
  sk.constraints = sk.constraints.filter(
    (c) => !(c.refs.includes(l1.id) || c.refs.includes(l2.id)) || !((c.type === "distance" && c.refs.length === 1) || c.type === "midpoint" || c.type === "equal"),
  );
  const [c, t1, t2] = [uid(), uid(), uid()];
  sk.entities.push({ id: c, type: "point", x: C[0], y: C[1] }, { id: t1, type: "point", x: T1[0], y: T1[1] }, { id: t2, type: "point", x: T2[0], y: T2[1] });
  for (const [l, tp] of [[l1, t1], [l2, t2]] as const) {
    if (l.p1 === pointId) l.p1 = tp;
    else l.p2 = tp;
  }
  // Arcs run counter-clockwise from s to e.
  const ccw = (T1[0] - C[0]) * (T2[1] - C[1]) - (T1[1] - C[1]) * (T2[0] - C[0]) > 0;
  const arc = { id: uid(), type: "arc" as const, c, s: ccw ? t1 : t2, e: ccw ? t2 : t1, construction: l1.construction && l2.construction ? true : undefined };
  sk.entities.push(arc);
  // The corner stays as a "virtual sharp" on both lines: its own constraints (fixed, dimensions
  // to it) keep holding the lines where they were.
  const corner = sk.entities.find((e) => e.id === pointId);
  if (corner?.type === "point" && !corner.fixed) corner.sharp = true;
  sk.constraints.push(
    { id: uid(), type: "pointOn", refs: [pointId, l1.id] },
    { id: uid(), type: "pointOn", refs: [pointId, l2.id] },
    { id: uid(), type: "tangent", refs: [l1.id, arc.id] },
    { id: uid(), type: "tangent", refs: [l2.id, arc.id] },
    { id: uid(), type: "radius", refs: [arc.id], value: r },
  );
  return null;
}

/** Line to mirror about: a selected reference axis, else a construction line, else the last line picked. */
export function mirrorAxis(sk: SketchFeature, ids: string[]): string | null {
  const v = new SketchView(sk);
  const lines = ids.map((id) => v.get(id)).filter((e): e is SkLine => e?.type === "line");
  if (!lines.length || ids.length < 2) return null;
  return (lines.find((l) => l.axis) ?? lines.find((l) => l.construction) ?? lines[lines.length - 1]).id;
}

/**
 * Adds the mirror image of the chosen entities about a line. Each new point is tied to its
 * original by a symmetry constraint, so the copy follows later edits; points on the axis are shared.
 */
export function mirrorEntities(sk: SketchFeature, ids: string[], axisId: string): number {
  const v = new SketchView(sk);
  const axis = v.get(axisId) as SkLine;
  const a = v.xy(axis.p1);
  const d = unit(sub(v.xy(axis.p2), a));
  const reflect = ([x, y]: P2): P2 => {
    const w = sub([x, y], a);
    const k = w[0] * d[0] + w[1] * d[1];
    return [a[0] + 2 * k * d[0] - w[0], a[1] + 2 * k * d[1] - w[1]];
  };
  const ents = ids.filter((id) => id !== axisId).map((id) => v.get(id)).filter((e): e is SkEntity => !!e && !(isReference(e) && e.type !== "point"));
  const map = new Map<string, string>();
  const added: SkEntity[] = [];
  const cons: SkConstraint[] = [];
  const mp = (id: string) => {
    if (map.has(id)) return map.get(id)!;
    const p = v.xy(id);
    const q = reflect(p);
    // A point on the axis is its own image.
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-7) {
      map.set(id, id);
      return id;
    }
    const nid = uid();
    added.push({ id: nid, type: "point", x: q[0], y: q[1] });
    cons.push({ id: uid(), type: "symmetric", refs: [id, nid, axisId] });
    map.set(id, nid);
    return nid;
  };
  let count = 0;
  for (const e of ents) {
    if (e.type === "point") {
      if (!e.fixed) mp(e.id);
      continue;
    }
    count++;
    const copy: SkCurve = (() => {
      switch (e.type) {
        case "line":
          return { ...e, id: uid(), p1: mp(e.p1), p2: mp(e.p2) };
        case "circle": {
          const c = { ...e, id: uid(), c: mp(e.c) };
          cons.push({ id: uid(), type: "equal", refs: [e.id, c.id] });
          return c;
        }
        case "arc":
          // A mirror reverses the turning direction: swap the ends.
          return { ...e, id: uid(), c: mp(e.c), s: mp(e.e), e: mp(e.s) };
        case "spline":
          return { ...e, id: uid(), pts: e.pts.map(mp) };
        case "bezier":
          return { ...e, id: uid(), p0: mp(e.p0), c1: mp(e.c1), c2: mp(e.c2), p3: mp(e.p3) };
      }
    })();
    added.push(copy);
  }
  // Points first, so the curves find them.
  sk.entities.push(...added.filter((e) => e.type === "point"), ...added.filter((e) => e.type !== "point"));
  sk.constraints.push(...cons);
  return count || added.length;
}

/**
 * Adds a model edge (a 3D polyline) to the sketch, projected onto its plane: as a line, a
 * circle or an arc when it is one, else a spline through points along it. The new points are
 * fixed where they are; a point already at the same place is reused, so edges stay joined.
 * Returns an error message, or null when done.
 */
export function projectEdge(sk: SketchFeature, chain: [number, number, number][]): string | null {
  const { origin: o, xDir: xd, normal: n } = sk.plane;
  const yd = [n[1] * xd[2] - n[2] * xd[1], n[2] * xd[0] - n[0] * xd[2], n[0] * xd[1] - n[1] * xd[0]];
  const to2 = (p: number[]): P2 => {
    const w = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    return [w[0] * xd[0] + w[1] * xd[1] + w[2] * xd[2], w[0] * yd[0] + w[1] * yd[1] + w[2] * yd[2]];
  };
  const pts: P2[] = [];
  for (const p of chain.map(to2)) if (!pts.length || len(sub(p, pts[pts.length - 1])) > 1e-6) pts.push(p);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (pts.length < 2 || size < 1e-6) return "This edge is seen end-on from the sketch plane";
  const tol = Math.max(size * 1e-4, 1e-6);
  const closed = pts.length > 2 && len(sub(pts[0], pts[pts.length - 1])) < tol;
  if (closed) pts.pop();

  const view = new SketchView(sk);
  const pointAt = (p: P2) => {
    const found = view.points().find((q) => Math.hypot(q.x - p[0], q.y - p[1]) < tol * 10);
    if (found) return found.id;
    const id = uid();
    sk.entities.push({ id, type: "point", x: p[0], y: p[1] });
    sk.constraints.push({ id: uid(), type: "fix", refs: [id], at: [p[0], p[1]] });
    view.byId.set(id, sk.entities[sk.entities.length - 1]);
    return id;
  };
  const distToChord = (p: P2, a: P2, b: P2) => {
    const d = sub(b, a);
    return Math.abs(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / Math.max(len(d), 1e-12);
  };

  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!closed && pts.every((p) => distToChord(p, first, last) < tol)) {
    sk.entities.push({ id: uid(), type: "line", p1: pointAt(first), p2: pointAt(last) });
    return null;
  }
  const circle = fitCircle(pts, tol);
  if (circle) {
    const [c, r] = circle;
    if (closed) {
      const id = uid();
      const cid = pointAt(c);
      sk.entities.push({ id, type: "circle", c: cid, r });
      sk.constraints.push({ id: uid(), type: "radius", refs: [id], value: r });
      return null;
    }
    // Which way the edge turns decides the arc's ends (arcs run counter-clockwise).
    let sweep = 0;
    for (let i = 1; i < pts.length; i++) {
      const a0 = Math.atan2(pts[i - 1][1] - c[1], pts[i - 1][0] - c[0]);
      let d = Math.atan2(pts[i][1] - c[1], pts[i][0] - c[0]) - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      sweep += d;
    }
    const [s, e] = sweep > 0 ? [first, last] : [last, first];
    sk.entities.push({ id: uid(), type: "arc", c: pointAt(c), s: pointAt(s), e: pointAt(e) });
    return null;
  }
  // Any other curve: a spline through up to 12 points along it.
  const count = Math.min(pts.length, 12);
  const picks: P2[] = [];
  for (let i = 0; i < count; i++) picks.push(pts[Math.round((i * (pts.length - (closed ? 0 : 1))) / (count - (closed ? 0 : 1))) % pts.length]);
  const ids = picks.map(pointAt).filter((id, i, a) => i === 0 || id !== a[i - 1]);
  if (ids.length < (closed ? 3 : 2)) return "This edge is too small to use";
  sk.entities.push({ id: uid(), type: "spline", pts: ids, closed: closed || undefined });
  return null;
}

/** Circle through all the points (within tol), from three of them spread along the list. */
function fitCircle(pts: P2[], tol: number): [P2, number] | null {
  if (pts.length < 3) return null;
  const [a, b, c] = [pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]];
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const ctr: P2 = [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
  const r = len(sub(a, ctr));
  // The mesh is within 0.01 mm of the true edge: allow that much on top of the tolerance.
  return pts.every((p) => Math.abs(len(sub(p, ctr)) - r) < tol + 0.01) ? [ctr, r] : null;
}
