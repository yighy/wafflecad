// Sketch editing operations that rebuild geometry: corner fillet, mirror, projected edges.
// Pure sketch-model code (no DOM), testable under Node.
import type { SkConstraint, SkCurve, SkEntity, SkLine, SketchFeature } from "../types";
import { SketchView, deleteEntities, isReference, uid } from "./model";

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
  sk.constraints.push(
    { id: uid(), type: "tangent", refs: [l1.id, arc.id] },
    { id: uid(), type: "tangent", refs: [l2.id, arc.id] },
    { id: uid(), type: "radius", refs: [arc.id], value: r },
  );
  // The sharp corner point goes unless something else still uses it.
  const after = new SketchView(sk);
  const used = after.curves().some((k) => after.defPoints(k).includes(pointId));
  if (!used && !(after.get(pointId) as { fixed?: boolean } | undefined)?.fixed) deleteEntities(sk, [pointId]);
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
      }
    })();
    added.push(copy);
  }
  // Points first, so the curves find them.
  sk.entities.push(...added.filter((e) => e.type === "point"), ...added.filter((e) => e.type !== "point"));
  sk.constraints.push(...cons);
  return count || added.length;
}
