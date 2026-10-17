// Offset: a copy of lines, arcs and circles at a constant distance (walls, clearances).
// Pure sketch-model code (no DOM), testable under Node.
import type { SkArc, SkCircle, SkCurve, SkLine, SketchFeature } from "../types";
import { SketchView, uid } from "./model";

type P2 = [number, number];
const add = (p: P2, q: P2): P2 => [p[0] + q[0], p[1] + q[1]];
const sub = (p: P2, q: P2): P2 => [p[0] - q[0], p[1] - q[1]];
const mul = (p: P2, k: number): P2 => [p[0] * k, p[1] * k];
const dist = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** One curve of a chain, as travelled: a line from a to b, or an arc around c (ccw: counter-clockwise). */
type Piece = { src: SkLine | SkArc; a: P2; b: P2; c?: P2; r?: number; ccw?: boolean };

/** Offset pieces: the same, moved; their ends are adjusted where neighbours meet. */
type Off = { src: SkLine | SkArc; a: P2; b: P2; c?: P2; r?: number; ccw?: boolean };

/** Where two offset curves (as whole lines and circles) cross, closest to `near`. */
function meet(p: Off, q: Off, near: P2): P2 | null {
  const hits: P2[] = [];
  if (!p.c && !q.c) {
    const d1 = sub(p.b, p.a);
    const d2 = sub(q.b, q.a);
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-12) return null;
    const t = ((q.a[0] - p.a[0]) * d2[1] - (q.a[1] - p.a[1]) * d2[0]) / den;
    hits.push(add(p.a, mul(d1, t)));
  } else if (p.c && q.c) {
    const d = dist(p.c, q.c);
    if (d < 1e-12 || d > p.r! + q.r! || d < Math.abs(p.r! - q.r!)) return null;
    const x = (d * d + p.r! * p.r! - q.r! * q.r!) / (2 * d);
    const h = Math.sqrt(Math.max(0, p.r! * p.r! - x * x));
    const u = mul(sub(q.c, p.c), 1 / d);
    const m = add(p.c, mul(u, x));
    hits.push(add(m, [-u[1] * h, u[0] * h]), add(m, [u[1] * h, -u[0] * h]));
  } else {
    const [l, k] = p.c ? [q, p] : [p, q];
    const d = sub(l.b, l.a);
    const f = sub(l.a, k.c!);
    const A = d[0] * d[0] + d[1] * d[1];
    const B = 2 * (f[0] * d[0] + f[1] * d[1]);
    const C = f[0] * f[0] + f[1] * f[1] - k.r! * k.r!;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    for (const s of [-1, 1]) hits.push(add(l.a, mul(d, (-B + s * Math.sqrt(disc)) / (2 * A))));
  }
  hits.sort((u, w) => dist(u, near) - dist(w, near));
  return hits[0] ?? null;
}

/**
 * Orders the lines and arcs into chains through their shared ends. Each piece is given in the
 * direction it is travelled.
 */
function chains(v: SketchView, curves: (SkLine | SkArc)[]): { pieces: Piece[]; closed: boolean }[] {
  const ends = (c: SkLine | SkArc): [string, string] => (c.type === "line" ? [c.p1, c.p2] : [c.s, c.e]);
  const left = new Set(curves);
  const out: { pieces: Piece[]; closed: boolean }[] = [];
  const piece = (c: SkLine | SkArc, from: string): Piece => {
    const [p, q] = ends(c);
    const fwd = p === from;
    const a = v.xy(fwd ? p : q);
    const b = v.xy(fwd ? q : p);
    if (c.type === "line") return { src: c, a, b };
    const ctr = v.xy(c.c);
    return { src: c, a, b, c: ctr, r: dist(ctr, a), ccw: fwd };
  };
  const users = (id: string) => [...left].filter((c) => ends(c).includes(id));
  while (left.size) {
    // Start at a free end when there is one, so open chains are walked whole.
    let first = [...left][0];
    for (const c of left)
      if (ends(c).some((id) => users(id).length === 1)) {
        first = c;
        break;
      }
    left.delete(first);
    const [s0, e0] = ends(first);
    const start = users(s0).length === 0 ? s0 : users(e0).length === 0 ? e0 : s0;
    const pieces = [piece(first, start)];
    let at = ends(first)[0] === start ? ends(first)[1] : ends(first)[0];
    for (;;) {
      const next = users(at)[0];
      if (!next) break;
      left.delete(next);
      pieces.push(piece(next, at));
      const [p, q] = ends(next);
      at = p === at ? q : p;
    }
    out.push({ pieces, closed: at === start && pieces.length > 1 });
  }
  return out;
}

/** Twice the signed area of a closed chain (positive: counter-clockwise). */
function area(pieces: Piece[]) {
  let s = 0;
  for (const p of pieces) {
    const pts: P2[] = [p.a];
    if (p.c) {
      // A few points along the arc, so a loop of two arcs has an area too.
      const a0 = Math.atan2(p.a[1] - p.c[1], p.a[0] - p.c[0]);
      let a1 = Math.atan2(p.b[1] - p.c[1], p.b[0] - p.c[0]);
      if (p.ccw && a1 <= a0) a1 += 2 * Math.PI;
      if (!p.ccw && a1 >= a0) a1 -= 2 * Math.PI;
      for (let i = 1; i < 8; i++) {
        const t = a0 + ((a1 - a0) * i) / 8;
        pts.push([p.c[0] + p.r! * Math.cos(t), p.c[1] + p.r! * Math.sin(t)]);
      }
    }
    pts.push(p.b);
    for (let i = 0; i + 1 < pts.length; i++) s += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  }
  return s;
}

/**
 * Adds a copy of the selected lines, arcs and circles `d` away. Closed outlines and circles grow
 * outwards for a positive d (shrink for a negative one); open chains go to the right of the way
 * they run. Corners meet again where the offset curves cross; arcs keep their centre point (the
 * copy stays concentric). Returns the new entities' ids, or an error.
 */
export function offsetEntities(sk: SketchFeature, ids: string[], d: number): { added: string[]; error?: string } {
  const v = new SketchView(sk);
  const picked = ids.map((id) => v.get(id)).filter((e): e is SkCurve => !!e && e.type !== "point");
  if (!picked.length) return { added: [], error: "Select lines, arcs or circles to offset" };
  if (picked.some((e) => e.type === "spline" || e.type === "bezier" || e.type === "ellipse" || (e.type === "line" && e.axis)))
    return { added: [], error: "Offset works on lines, arcs and circles" };
  if (!d) return { added: [] };
  const added: string[] = [];
  const point = (p: P2) => {
    const id = uid();
    sk.entities.push({ id, type: "point", x: p[0], y: p[1] });
    added.push(id);
    return id;
  };
  const curve = (c: SkCurve) => {
    sk.entities.push(c);
    added.push(c.id);
  };

  for (const c of picked.filter((e): e is SkCircle => e.type === "circle")) {
    if (c.r + d <= 1e-9) return { added, error: "Too far inside: a circle would vanish" };
    curve({ id: uid(), type: "circle", c: c.c, r: c.r + d, construction: c.construction });
  }

  for (const { pieces, closed } of chains(v, picked.filter((e): e is SkLine | SkArc => e.type === "line" || e.type === "arc"))) {
    // To the right of the way the chain runs: outwards on a counter-clockwise outline.
    const k = closed && area(pieces) < 0 ? -d : d;
    const offs: Off[] = [];
    for (const p of pieces) {
      if (!p.c) {
        const t = sub(p.b, p.a);
        const l = Math.hypot(t[0], t[1]);
        const n: P2 = [t[1] / l, -t[0] / l];
        offs.push({ src: p.src, a: add(p.a, mul(n, k)), b: add(p.b, mul(n, k)) });
      } else {
        // Right of counter-clockwise travel is away from the centre.
        const r = p.r! + (p.ccw ? k : -k);
        if (r <= 1e-9) return { added, error: "Too far inside: an arc would vanish" };
        const at = (q: P2) => add(p.c!, mul(sub(q, p.c!), r / p.r!));
        offs.push({ src: p.src, a: at(p.a), b: at(p.b), c: p.c, r, ccw: p.ccw });
      }
    }
    // Corners: one shared point where neighbours meet (tangent joins already do), else a bridge.
    const n = offs.length;
    /** Corners left open (the offset curves do not cross nearby): a line bridges them. */
    const bridged: boolean[] = [];
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p = offs[i];
      const q = offs[(i + 1) % n];
      if (dist(p.b, q.a) < 1e-9) {
        bridged.push(false);
        continue;
      }
      const x = meet(p, q, pieces[i].b);
      if (x && dist(x, pieces[i].b) < 4 * Math.abs(d) + 1e-6) {
        p.b = x;
        q.a = x;
        bridged.push(false);
      } else bridged.push(true);
    }
    // Points: each offset piece's start and end, shared across joined corners.
    const startId: string[] = [];
    const endId: string[] = [];
    for (let i = 0; i < n; i++) {
      startId[i] = i > 0 && !bridged[i - 1] ? endId[i - 1] : point(offs[i].a);
      endId[i] = closed && i === n - 1 && !bridged[n - 1] ? startId[0] : point(offs[i].b);
    }
    for (let i = 0; i < n; i++) {
      const o = offs[i];
      const construction = o.src.construction;
      if (!o.c) curve({ id: uid(), type: "line", p1: startId[i], p2: endId[i], construction });
      // Arcs are stored counter-clockwise: from the start when travelled that way, else from the end.
      else curve({ id: uid(), type: "arc", c: (o.src as SkArc).c, s: o.ccw ? startId[i] : endId[i], e: o.ccw ? endId[i] : startId[i], construction });
    }
    bridged.forEach((open, i) => {
      if (open) curve({ id: uid(), type: "line", p1: endId[i], p2: startId[(i + 1) % n] });
    });
  }
  return { added };
}
