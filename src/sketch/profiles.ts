// Finds the closed regions of a sketch (what an extrusion fills).
//
// Lines and arcs that share points form a planar graph. Its bounded faces are traced
// with the usual "turn as far right as possible" walk; circles are faces of their own.
// Each span of a spline is an edge between two of its points.
// Faces are then nested even-odd: a face inside another face becomes a hole of it,
// a face inside a hole becomes an island again.
import type { ProfileLoop, ProfileRegion, ProfileSegment, SkArc, SketchFeature } from "../types";
import { SketchView, sampleBezier } from "./model";

type P2 = [number, number];

interface HalfEdge {
  curve: string;
  from: string;
  to: string;
  /** Direction of the curve when leaving `from`. */
  angle: number;
  seg: ProfileSegment;
}

interface Face {
  loop: ProfileLoop;
  poly: P2[];
  area: number;
}

const ARC_SAMPLES = 24;

export function findRegions(sk: SketchFeature): ProfileRegion[] {
  const view = new SketchView(sk);
  const faces: Face[] = [];

  for (const c of view.curves()) {
    if (c.type !== "circle" || c.construction) continue;
    const ctr = view.xy(c.c);
    const poly: P2[] = [];
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      poly.push([ctr[0] + c.r * Math.cos(t), ctr[1] + c.r * Math.sin(t)]);
    }
    faces.push({ loop: { kind: "circle", c: ctr, r: c.r }, poly, area: Math.PI * c.r * c.r });
  }

  // Graph of non-construction lines and arcs.
  const out = new Map<string, HalfEdge[]>();
  const add = (h: HalfEdge) => {
    if (!out.has(h.from)) out.set(h.from, []);
    out.get(h.from)!.push(h);
  };
  for (const c of view.curves()) {
    if (c.construction || c.type === "circle") continue;
    if (c.type === "line") {
      const a = view.xy(c.p1);
      const b = view.xy(c.p2);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      add({ curve: c.id, from: c.p1, to: c.p2, angle: ang, seg: { kind: "line", a, b } });
      add({ curve: c.id, from: c.p2, to: c.p1, angle: ang + Math.PI, seg: { kind: "line", a: b, b: a } });
    } else if (c.type === "spline") {
      // Direction leaving `p` towards its control point (or the far end if they coincide).
      const dir = (p: P2, q: P2, r: P2) =>
        Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-9 ? Math.atan2(q[1] - p[1], q[0] - p[0]) : Math.atan2(r[1] - p[1], r[0] - p[0]);
      view.splineSpans(c).forEach((sp, i) => {
        if (sp.from === sp.to) return;
        const curve = `${c.id}#${i}`;
        add({ curve, from: sp.from, to: sp.to, angle: dir(sp.a, sp.c1, sp.b), seg: { kind: "bezier", a: sp.a, b: sp.b, c1: sp.c1, c2: sp.c2 } });
        add({ curve, from: sp.to, to: sp.from, angle: dir(sp.b, sp.c2, sp.a), seg: { kind: "bezier", a: sp.b, b: sp.a, c1: sp.c2, c2: sp.c1 } });
      });
    } else {
      const [s, e] = view.arcAngles(c);
      const ctr = view.xy(c.c);
      const r = view.arcRadius(c);
      const a = view.xy(c.s);
      const b = view.xy(c.e);
      const mid: P2 = [ctr[0] + r * Math.cos((s + e) / 2), ctr[1] + r * Math.sin((s + e) / 2)];
      // CCW from s: tangent = radius direction + 90°; reversed from e: radius direction − 90°.
      add({ curve: c.id, from: c.s, to: c.e, angle: s + Math.PI / 2, seg: { kind: "arc", a, b, mid } });
      add({ curve: c.id, from: c.e, to: c.s, angle: e - Math.PI / 2, seg: { kind: "arc", a: b, b: a, mid } });
    }
  }

  // Open chains cannot bound anything: prune dangling edges repeatedly.
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const [v, hs] of out) {
      if (hs.length === 1) {
        const h = hs[0];
        out.delete(v);
        const back = out.get(h.to);
        if (back) {
          const i = back.findIndex((x) => x.curve === h.curve && x.to === v);
          if (i >= 0) back.splice(i, 1);
          if (back.length === 0) out.delete(h.to);
        }
        pruned = true;
      } else if (hs.length === 0) out.delete(v);
    }
  }

  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  for (const hs of out.values()) hs.sort((p, q) => norm(p.angle) - norm(q.angle));

  const used = new Set<HalfEdge>();
  for (const hs of out.values()) {
    for (const start of hs) {
      if (used.has(start)) continue;
      const segs: ProfileSegment[] = [];
      let h = start;
      let guard = 0;
      while (!used.has(h) && guard++ < 10000) {
        used.add(h);
        segs.push(h.seg);
        const around = out.get(h.to);
        if (!around) break;
        const twinIdx = around.findIndex((x) => x.curve === h.curve && x.to === h.from);
        // Next edge: the one just clockwise from the way we came in.
        h = around[(twinIdx - 1 + around.length) % around.length];
      }
      if (h !== start) continue;
      const poly = sampleSegments(segs);
      const area = signedArea(poly);
      if (area > 1e-9) faces.push({ loop: { kind: "path", segments: segs }, poly, area });
    }
  }

  return nestEvenOdd(faces);
}

function nestEvenOdd(faces: Face[]): ProfileRegion[] {
  // Faces of the same connected graph only share boundaries; containment means a strictly
  // smaller face with an interior sample point inside the other polygon.
  const parentOf = new Map<Face, Face | null>();
  const sorted = [...faces].sort((a, b) => a.area - b.area);
  for (const f of sorted) {
    const probe = interiorPoint(f);
    let parent: Face | null = null;
    for (const g of sorted) {
      if (g === f || g.area <= f.area) continue;
      if (pointInPolygon(probe, g.poly) && (!parent || g.area < parent.area)) parent = g;
    }
    parentOf.set(f, parent);
  }
  const depth = (f: Face): number => {
    const p = parentOf.get(f);
    return p ? depth(p) + 1 : 0;
  };
  const regions: ProfileRegion[] = [];
  for (const f of faces) {
    if (depth(f) % 2 !== 0) continue;
    regions.push({ outer: f.loop, holes: faces.filter((h) => parentOf.get(h) === f).map((h) => h.loop) });
  }
  return regions;
}

/** A point slightly inside the face, next to the middle of its first edge. */
function interiorPoint(f: Face): P2 {
  const [a, b] = [f.poly[0], f.poly[1]];
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const eps = Math.min(len * 1e-3, 1e-3);
  // Polygons are CCW: inside is on the left.
  return [mx - ((b[1] - a[1]) / len) * eps, my + ((b[0] - a[0]) / len) * eps];
}

export function sampleSegments(segs: ProfileSegment[]): P2[] {
  const pts: P2[] = [];
  for (const s of segs) {
    if (s.kind === "line") pts.push(s.a);
    else if (s.kind === "bezier") pts.push(...sampleBezier(s, ARC_SAMPLES).slice(0, -1));
    else pts.push(...sampleArc(s.a, s.mid, s.b, ARC_SAMPLES).slice(0, -1));
  }
  return pts;
}

/** Points along the circular arc through a, m, b (from a to b), endpoints included. */
export function sampleArc(a: P2, m: P2, b: P2, n: number): P2[] {
  const c = circumcenter(a, m, b);
  if (!c) return [a, b];
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const ang = (p: P2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(a);
  const ccw = cross(a, m, b) > 0;
  let sweep = ang(b) - a0;
  if (ccw) while (sweep <= 0) sweep += 2 * Math.PI;
  else while (sweep >= 0) sweep -= 2 * Math.PI;
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return out;
}

function cross(a: P2, b: P2, c: P2) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function circumcenter(a: P2, b: P2, c: P2): P2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
}

export function signedArea(poly: P2[]) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function pointInPolygon(p: P2, poly: P2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Arc helper used by the renderer too. */
export function arcMid(view: SketchView, a: SkArc): P2 {
  const [s, e] = view.arcAngles(a);
  const c = view.xy(a.c);
  const r = view.arcRadius(a);
  return [c[0] + r * Math.cos((s + e) / 2), c[1] + r * Math.sin((s + e) / 2)];
}
