// DXF reading: the 2D geometry of a drawing (ENTITIES, with BLOCKS inserted), in millimetres.
// Pure code (no DOM), testable under Node.
import type { ImportShape } from "./importShapes";

type P2 = [number, number];
interface Pair {
  code: number;
  value: string;
}

export interface DxfResult {
  shapes: ImportShape[];
  /** Entity types met but not supported (texts, hatches, dimensions…), with their counts. */
  skipped: Record<string, number>;
  /** Millimetres per drawing unit, from $INSUNITS (1 when the file does not say). */
  unitScale: number;
  unitName: string;
}

const UNITS: Record<number, [number, string]> = {
  0: [1, "unitless (read as mm)"],
  1: [25.4, "inches"],
  2: [304.8, "feet"],
  4: [1, "mm"],
  5: [10, "cm"],
  6: [1000, "m"],
  8: [0.0000254, "microinches"],
  9: [0.0254, "mils"],
  10: [914.4, "yards"],
  14: [100, "decimetres"],
};

function pairsOf(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) throw new Error("This is not a text DXF file (binary DXF is not supported)");
    out.push({ code, value: lines[i + 1].trim() });
  }
  return out;
}

/** An entity: its type and its group codes, in order. */
interface Entity {
  type: string;
  pairs: Pair[];
}

const num = (e: Entity, code: number, fallback = 0) => {
  const p = e.pairs.find((x) => x.code === code);
  return p ? parseFloat(p.value) : fallback;
};
const str = (e: Entity, code: number) => e.pairs.find((x) => x.code === code)?.value ?? "";
const all = (e: Entity, code: number) => e.pairs.filter((x) => x.code === code).map((x) => parseFloat(x.value));

/** Splits a run of pairs into entities (each starts at a code 0). */
function entitiesOf(pairs: Pair[]): Entity[] {
  const out: Entity[] = [];
  for (const p of pairs) {
    if (p.code === 0) out.push({ type: p.value, pairs: [] });
    else out[out.length - 1]?.pairs.push(p);
  }
  return out;
}

function sections(pairs: Pair[]) {
  const out = new Map<string, Pair[]>();
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code !== 0 || pairs[i].value !== "SECTION") continue;
    const name = pairs[i + 1]?.value ?? "";
    const start = i + 2;
    let end = start;
    while (end < pairs.length && !(pairs[end].code === 0 && pairs[end].value === "ENDSEC")) end++;
    out.set(name, pairs.slice(start, end));
    i = end;
  }
  return out;
}

/** A 2D placement: x' = a·x + b·y + e, y' = c·x + d·y + f. */
type Xf = [number, number, number, number, number, number];
const ID: Xf = [1, 0, 0, 1, 0, 0];
const apply = (t: Xf, [x, y]: P2): P2 => [t[0] * x + t[1] * y + t[4], t[2] * x + t[3] * y + t[5]];
const compose = (outer: Xf, inner: Xf): Xf => [
  outer[0] * inner[0] + outer[1] * inner[2],
  outer[0] * inner[1] + outer[1] * inner[3],
  outer[2] * inner[0] + outer[3] * inner[2],
  outer[2] * inner[1] + outer[3] * inner[3],
  outer[0] * inner[4] + outer[1] * inner[5] + outer[4],
  outer[2] * inner[4] + outer[3] * inner[5] + outer[5],
];
const det = (t: Xf) => t[0] * t[3] - t[1] * t[2];
/** Uniform scale of a placement (circles stay circles only when it is uniform). */
const uniformScale = (t: Xf) => {
  const sx = Math.hypot(t[0], t[2]);
  const sy = Math.hypot(t[1], t[3]);
  return Math.abs(sx - sy) < 1e-9 * Math.max(sx, sy) && Math.abs(t[0] * t[1] + t[2] * t[3]) < 1e-9 * sx * sy ? sx : null;
};

const TAU = Math.PI * 2;

function arcPoints(c: P2, r: number, a0: number, a1: number, n = 24): P2[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += TAU;
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) out.push([c[0] + r * Math.cos(a0 + (sweep * i) / n), c[1] + r * Math.sin(a0 + (sweep * i) / n)]);
  return out;
}

/** NURBS curve points by de Boor's algorithm. */
function nurbs(ctrl: P2[], weights: number[], knots: number[], degree: number, samples: number): P2[] {
  const n = ctrl.length;
  const w = weights.length === n ? weights : ctrl.map(() => 1);
  const lo = knots[degree];
  const hi = knots[n];
  const out: P2[] = [];
  for (let s = 0; s <= samples; s++) {
    const t = s === samples ? hi - 1e-12 * (hi - lo) : lo + ((hi - lo) * s) / samples;
    let k = degree;
    while (k < n - 1 && knots[k + 1] <= t) k++;
    const d = Array.from({ length: degree + 1 }, (_, j) => {
      const i = k - degree + j;
      return [ctrl[i][0] * w[i], ctrl[i][1] * w[i], w[i]];
    });
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den === 0 ? 0 : (t - knots[i]) / den;
        for (let m = 0; m < 3; m++) d[j][m] = (1 - a) * d[j - 1][m] + a * d[j][m];
      }
    }
    out.push([d[degree][0] / d[degree][2], d[degree][1] / d[degree][2]]);
  }
  return out;
}

export function parseDxf(text: string): DxfResult {
  const pairs = pairsOf(text);
  const secs = sections(pairs);
  const header = secs.get("HEADER") ?? [];
  const iu = header.findIndex((p) => p.code === 9 && p.value === "$INSUNITS");
  const unitCode = iu >= 0 ? parseInt(header[iu + 1]?.value ?? "0", 10) : 0;
  const [unitScale, unitName] = UNITS[unitCode] ?? UNITS[0];

  // Blocks: name → base point and entities.
  const blocks = new Map<string, { base: P2; entities: Entity[] }>();
  let current: { name: string; base: P2; entities: Entity[] } | null = null;
  for (const e of entitiesOf(secs.get("BLOCKS") ?? [])) {
    if (e.type === "BLOCK") current = { name: str(e, 2), base: [num(e, 10), num(e, 20)], entities: [] };
    else if (e.type === "ENDBLK") {
      if (current) blocks.set(current.name, current);
      current = null;
    } else current?.entities.push(e);
  }

  const shapes: ImportShape[] = [];
  const skipped: Record<string, number> = {};
  const skip = (t: string) => (skipped[t] = (skipped[t] ?? 0) + 1);

  const emit = (list: Entity[], xf: Xf, depth: number) => {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      // Entities drawn with their extrusion along −Z are mirrored in X (arbitrary axis rule).
      const t: Xf = num(e, 230, 1) < 0 ? compose(xf, [-1, 0, 0, 1, 0, 0]) : xf;
      const layer = str(e, 8);
      const P = (x: number, y: number) => apply(t, [x, y]);
      const s = uniformScale(t);
      const flip = det(t) < 0;
      switch (e.type) {
        case "LINE":
          shapes.push({ kind: "line", a: P(num(e, 10), num(e, 20)), b: P(num(e, 11), num(e, 21)), layer });
          break;
        case "CIRCLE":
        case "ARC": {
          const c: P2 = [num(e, 10), num(e, 20)];
          const r = num(e, 40);
          if (e.type === "CIRCLE") {
            if (s !== null) shapes.push({ kind: "circle", c: P(...c), r: r * s, layer });
            else shapes.push({ kind: "spline", pts: arcPoints(c, r, 0, TAU, 32).slice(0, -1).map((q) => P(...q)), closed: true, layer });
            break;
          }
          const a0 = (num(e, 50) * Math.PI) / 180;
          const a1 = (num(e, 51) * Math.PI) / 180;
          if (s !== null) {
            const start = P(c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0));
            const end = P(c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1));
            // A mirror turns the arc the other way round: swap its ends to keep it counter-clockwise.
            shapes.push({ kind: "arc", c: P(...c), r: r * s, s: flip ? end : start, e: flip ? start : end, layer });
          } else shapes.push({ kind: "spline", pts: arcPoints(c, r, a0, a1).map((q) => P(...q)), closed: false, layer });
          break;
        }
        case "LWPOLYLINE": {
          const xs = all(e, 10);
          const ys = all(e, 20);
          // A bulge (42) belongs to the vertex before it.
          const bulges: number[] = xs.map(() => 0);
          let v = -1;
          for (const p of e.pairs) {
            if (p.code === 10) v++;
            else if (p.code === 42 && v >= 0) bulges[v] = parseFloat(p.value);
          }
          const verts = xs.map((x, k): P2 => [x, ys[k]]);
          polyline(verts, bulges, (num(e, 70) & 1) === 1, layer);
          break;
        }
        case "POLYLINE": {
          const flags = num(e, 70);
          if (flags & (16 | 64)) {
            skip("POLYLINE (3D mesh)");
            break;
          }
          const verts: P2[] = [];
          const bulges: number[] = [];
          while (list[i + 1]?.type === "VERTEX") {
            i++;
            verts.push([num(list[i], 10), num(list[i], 20)]);
            bulges.push(num(list[i], 42));
          }
          if (list[i + 1]?.type === "SEQEND") i++;
          polyline(verts, bulges, (flags & 1) === 1, layer);
          break;
        }
        case "SPLINE": {
          const fx = all(e, 11);
          const fy = all(e, 21);
          const closed = (num(e, 70) & 1) === 1;
          let pts: P2[];
          if (fx.length >= 2) pts = fx.map((x, k): P2 => [x, fy[k]]);
          else {
            const cx = all(e, 10);
            const cy = all(e, 20);
            const ctrl = cx.map((x, k): P2 => [x, cy[k]]);
            const degree = num(e, 71, 3);
            const knots = all(e, 40);
            if (ctrl.length <= degree || knots.length !== ctrl.length + degree + 1) {
              skip("SPLINE (unreadable)");
              break;
            }
            pts = nurbs(ctrl, all(e, 41), knots, degree, Math.min(64, Math.max(8, ctrl.length * 3)));
          }
          if (closed && pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
          shapes.push({ kind: "spline", pts: pts.map((q) => P(...q)), closed, layer });
          break;
        }
        case "ELLIPSE": {
          const c: P2 = [num(e, 10), num(e, 20)];
          const major: P2 = [num(e, 11), num(e, 21)];
          const ratio = num(e, 40, 1);
          const u0 = num(e, 41, 0);
          let u1 = num(e, 42, TAU);
          const full = Math.abs(u1 - u0 - TAU) < 1e-6 || Math.abs(u1 - u0) < 1e-9;
          while (u1 <= u0) u1 += TAU;
          const minor: P2 = [-major[1] * ratio, major[0] * ratio];
          const n = full ? 32 : 24;
          const pts: P2[] = [];
          for (let k = 0; k <= n; k++) {
            if (full && k === n) break;
            const u = full ? (TAU * k) / n : u0 + ((u1 - u0) * k) / n;
            pts.push(P(c[0] + major[0] * Math.cos(u) + minor[0] * Math.sin(u), c[1] + major[1] * Math.cos(u) + minor[1] * Math.sin(u)));
          }
          shapes.push({ kind: "spline", pts, closed: full, layer });
          break;
        }
        case "INSERT": {
          const b = blocks.get(str(e, 2));
          if (!b || depth > 6) {
            skip("INSERT");
            break;
          }
          const sx = num(e, 41, 1);
          const sy = num(e, 42, 1);
          const rot = (num(e, 50) * Math.PI) / 180;
          const [cos, sin] = [Math.cos(rot), Math.sin(rot)];
          const at: P2 = [num(e, 10), num(e, 20)];
          // Block coordinates: minus the base point, scaled, rotated, then moved to the insertion point.
          const place: Xf = [cos * sx, -sin * sy, sin * sx, cos * sy, 0, 0];
          const [bx, by] = apply(place, b.base);
          emit(b.entities, compose(t, [place[0], place[1], place[2], place[3], at[0] - bx, at[1] - by]), depth + 1);
          break;
        }
        case "VERTEX":
        case "SEQEND":
        case "ATTRIB":
        case "ATTDEF":
        case "POINT":
          break;
        default:
          skip(e.type);
      }

      function polyline(verts: P2[], bulges: number[], closed: boolean, layer: string) {
        const n = verts.length;
        for (let k = 0; k < (closed ? n : n - 1); k++) {
          const a = verts[k];
          const b = verts[(k + 1) % n];
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-12) continue;
          const bulge = bulges[k] ?? 0;
          if (Math.abs(bulge) < 1e-9) {
            shapes.push({ kind: "line", a: P(...a), b: P(...b), layer });
            continue;
          }
          // Bulge = tan(angle / 4); positive turns counter-clockwise from a to b.
          const theta = 4 * Math.atan(bulge);
          const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const h = chord / (2 * Math.tan(theta / 2));
          const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const nrm: P2 = [-(b[1] - a[1]) / chord, (b[0] - a[0]) / chord];
          const c: P2 = [m[0] + nrm[0] * h, m[1] + nrm[1] * h];
          const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
          const ccw = (theta > 0) !== flip;
          if (s !== null) shapes.push({ kind: "arc", c: P(...c), r: r * s, s: ccw ? P(...a) : P(...b), e: ccw ? P(...b) : P(...a), layer });
          else {
            const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
            const a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
            const pts = theta > 0 ? arcPoints(c, r, a0, a1) : arcPoints(c, r, a1, a0).reverse();
            shapes.push({ kind: "spline", pts: pts.map((q) => P(...q)), closed: false, layer });
          }
        }
      }
    }
  };
  emit(entitiesOf(secs.get("ENTITIES") ?? []), ID, 0);
  return { shapes, skipped, unitScale, unitName };
}
