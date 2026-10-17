// SVG reading: the outlines of a drawing (paths, rectangles, circles, ellipses, lines, polygons),
// with their transforms, in millimetres and with Y pointing up as in a sketch.
// Pure code with its own small XML reader (no DOM), testable under Node.
import type { ImportShape } from "./importShapes";

type P2 = [number, number];
/** x' = a·x + c·y + e, y' = b·x + d·y + f (the SVG matrix order). */
type M = [number, number, number, number, number, number];

export interface SvgResult {
  shapes: ImportShape[];
  skipped: Record<string, number>;
  /** Millimetres per user unit (from width/height and viewBox, else 96 px per inch). */
  unitScale: number;
  unitName: string;
}

// ---------- Minimal XML ----------

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}

function parseXml(text: string): Node {
  const root: Node = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const src = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const tagRe = /<\s*(\/?)\s*([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)\s*>/g;
  const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    const [, closing, rawTag, rawAttrs, selfClose] = m;
    const tag = rawTag.replace(/^svg:/, "");
    if (closing) {
      while (stack.length > 1 && stack.pop()!.tag !== tag);
      continue;
    }
    const attrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(rawAttrs))) attrs[a[1]] = (a[3] ?? a[4] ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    const node: Node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

// ---------- Transforms ----------

const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];
const ap = (m: M, [x, y]: P2): P2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const det = (m: M) => m[0] * m[3] - m[1] * m[2];
const uniform = (m: M) => {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  return Math.abs(sx - sy) < 1e-9 * Math.max(sx, sy, 1e-12) && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9 * sx * sy ? sx : null;
};
const ID: M = [1, 0, 0, 1, 0, 0];

function parseTransform(t: string | undefined): M {
  let m = ID;
  if (!t) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(t))) {
    const v = (x[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    let n: M = ID;
    switch (x[1]) {
      case "matrix":
        if (v.length === 6) n = v as M;
        break;
      case "translate":
        n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case "scale":
        n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const [c, s] = [Math.cos(a), Math.sin(a)];
        const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
        n = mul(mul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX":
        n = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        n = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, n);
  }
  return m;
}

// ---------- Lengths and units ----------

const MM_PER: Record<string, number> = { px: 25.4 / 96, "": 25.4 / 96, mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, q: 0.25 };

function lengthMm(v: string | undefined): number | null {
  const m = v?.trim().match(/^(-?[\d.]+(?:e[-+]?\d+)?)\s*(px|mm|cm|in|pt|pc|q)?$/i);
  return m ? parseFloat(m[1]) * MM_PER[(m[2] ?? "").toLowerCase()] : null;
}

const numAttr = (n: Node, k: string, d = 0) => {
  const v = parseFloat(n.attrs[k] ?? "");
  return Number.isFinite(v) ? v : d;
};

// ---------- Reader ----------

export function parseSvg(text: string): SvgResult {
  const root = parseXml(text);
  const svg = findFirst(root, "svg");
  if (!svg) throw new Error("No <svg> element in this file");

  // User units → mm: width/height against the viewBox, else CSS pixels.
  const vb = (svg.attrs.viewBox ?? svg.attrs.viewbox ?? "").split(/[\s,]+/).map(Number);
  const w = lengthMm(svg.attrs.width);
  let unitScale = 25.4 / 96;
  let unitName = "px (96 per inch)";
  if (vb.length === 4 && vb[2] > 0 && w !== null) {
    unitScale = w / vb[2];
    unitName = `${svg.attrs.width} for ${vb[2]} units`;
  } else if (vb.length !== 4 && w !== null) unitName = "px (96 per inch)";
  const vbShift: M = vb.length === 4 ? [1, 0, 0, 1, -vb[0], -vb[1]] : ID;

  const shapes: ImportShape[] = [];
  const skipped: Record<string, number> = {};
  const skip = (t: string) => (skipped[t] = (skipped[t] ?? 0) + 1);

  /** The flip that makes Y point up: SVG draws downwards. */
  const FLIP: M = [1, 0, 0, -1, 0, 0];

  const visit = (n: Node, m: M) => {
    const style = (n.attrs.style ?? "") + ";display:" + (n.attrs.display ?? "");
    if (/display\s*:\s*none/.test(style) || n.attrs.visibility === "hidden") return;
    const mm = mul(m, parseTransform(n.attrs.transform));
    switch (n.tag) {
      case "svg":
      case "g":
      case "a":
      case "switch":
        for (const c of n.children) visit(c, n === svg ? mul(m, vbShift) : mm);
        return;
      case "defs":
      case "title":
      case "desc":
      case "metadata":
      case "style":
      case "clipPath":
      case "mask":
      case "pattern":
      case "linearGradient":
      case "radialGradient":
      case "marker":
      case "symbol":
        return;
      case "path":
        pathShapes(n.attrs.d ?? "", mm, shapes);
        return;
      case "line":
        shapes.push({ kind: "line", a: ap(mm, [numAttr(n, "x1"), numAttr(n, "y1")]), b: ap(mm, [numAttr(n, "x2"), numAttr(n, "y2")]) });
        return;
      case "polyline":
      case "polygon": {
        const v = (n.attrs.points ?? "").match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
        const pts: P2[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
        for (let i = 0; i + 1 < pts.length; i++) shapes.push({ kind: "line", a: ap(mm, pts[i]), b: ap(mm, pts[i + 1]) });
        if (n.tag === "polygon" && pts.length > 2) shapes.push({ kind: "line", a: ap(mm, pts[pts.length - 1]), b: ap(mm, pts[0]) });
        return;
      }
      case "rect": {
        const [x, y, W, H] = ["x", "y", "width", "height"].map((k) => numAttr(n, k));
        if (W <= 0 || H <= 0) return;
        let rx = numAttr(n, "rx", NaN);
        let ry = numAttr(n, "ry", NaN);
        if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
        if (Number.isNaN(ry)) ry = rx;
        rx = Math.min(rx, W / 2);
        ry = Math.min(ry, H / 2);
        if (rx <= 0 || ry <= 0) {
          pathShapes(`M${x},${y}h${W}v${H}h${-W}z`, mm, shapes);
          return;
        }
        pathShapes(
          `M${x + rx},${y}H${x + W - rx}A${rx},${ry} 0 0 1 ${x + W},${y + ry}V${y + H - ry}A${rx},${ry} 0 0 1 ${x + W - rx},${y + H}` +
            `H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + H - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}z`,
          mm,
          shapes,
        );
        return;
      }
      case "circle":
      case "ellipse": {
        const cx = numAttr(n, "cx");
        const cy = numAttr(n, "cy");
        const rx = n.tag === "circle" ? numAttr(n, "r") : numAttr(n, "rx");
        const ry = n.tag === "circle" ? rx : numAttr(n, "ry");
        if (rx <= 0 || ry <= 0) return;
        const s = uniform(mm);
        if (Math.abs(rx - ry) < 1e-12 && s !== null) shapes.push({ kind: "circle", c: ap(mm, [cx, cy]), r: rx * s });
        else pathShapes(`M${cx + rx},${cy}A${rx},${ry} 0 0 1 ${cx},${cy + ry}A${rx},${ry} 0 0 1 ${cx - rx},${cy}A${rx},${ry} 0 0 1 ${cx},${cy - ry}A${rx},${ry} 0 0 1 ${cx + rx},${cy}z`, mm, shapes);
        return;
      }
      case "text":
      case "tspan":
        skip("text (convert it to paths first)");
        return;
      case "image":
        skip("image");
        return;
      case "use":
        skip("use");
        return;
      default:
        skip(n.tag);
    }
  };
  visit(svg, FLIP);
  return { shapes, skipped, unitScale, unitName };
}

function findFirst(n: Node, tag: string): Node | null {
  if (n.tag === tag) return n;
  for (const c of n.children) {
    const f = findFirst(c, tag);
    if (f) return f;
  }
  return null;
}

// ---------- Path data ----------

function pathShapes(d: string, m: M, out: ImportShape[]) {
  const toks = d.match(/[a-df-zA-DF-Z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = "";
  let cur: P2 = [0, 0];
  let start: P2 = [0, 0];
  /** Last control point, for the smooth commands S and T. */
  let lastC: P2 | null = null;
  let lastQ: P2 | null = null;
  const isCmd = (t: string | undefined) => !!t && /^[a-zA-Z]$/.test(t);
  const n = () => parseFloat(toks[i++]);
  // Arc flags may be written without separators ("a5 5 0 016 0").
  const flag = () => {
    const t = toks[i];
    if (t.length > 1 && (t[0] === "0" || t[0] === "1") && !t.includes(".")) {
      toks[i] = t.slice(1);
      return t[0] === "1";
    }
    i++;
    return t === "1";
  };
  const line = (a: P2, b: P2) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-12) out.push({ kind: "line", a: ap(m, a), b: ap(m, b) });
  };
  const cubic = (a: P2, c1: P2, c2: P2, b: P2) => out.push({ kind: "bezier", a: ap(m, a), c1: ap(m, c1), c2: ap(m, c2), b: ap(m, b) });

  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++];
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const R = (x: number, y: number): P2 => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const C = cmd.toUpperCase();
    if (C === "Z") {
      line(cur, start);
      cur = start;
      lastC = lastQ = null;
      continue;
    }
    if (isCmd(toks[i]) || i >= toks.length) continue;
    switch (C) {
      case "M": {
        cur = start = R(n(), n());
        // Further pairs after a move are lines.
        cmd = rel ? "l" : "L";
        lastC = lastQ = null;
        break;
      }
      case "L": {
        const p = R(n(), n());
        line(cur, p);
        cur = p;
        lastC = lastQ = null;
        break;
      }
      case "H": {
        const x = n();
        const p: P2 = [rel ? cur[0] + x : x, cur[1]];
        line(cur, p);
        cur = p;
        lastC = lastQ = null;
        break;
      }
      case "V": {
        const y = n();
        const p: P2 = [cur[0], rel ? cur[1] + y : y];
        line(cur, p);
        cur = p;
        lastC = lastQ = null;
        break;
      }
      case "C": {
        const c1 = R(n(), n());
        const c2 = R(n(), n());
        const p = R(n(), n());
        cubic(cur, c1, c2, p);
        lastC = c2;
        lastQ = null;
        cur = p;
        break;
      }
      case "S": {
        const c1: P2 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur;
        const c2 = R(n(), n());
        const p = R(n(), n());
        cubic(cur, c1, c2, p);
        lastC = c2;
        lastQ = null;
        cur = p;
        break;
      }
      case "Q":
      case "T": {
        const q: P2 = C === "Q" ? R(n(), n()) : lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const p = R(n(), n());
        // A quadratic is a cubic with its controls two thirds of the way to the quadratic one.
        cubic(cur, [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p);
        lastQ = q;
        lastC = null;
        cur = p;
        break;
      }
      case "A": {
        const rx = Math.abs(n());
        const ry = Math.abs(n());
        const rot = n();
        const large = flag();
        const sweep = flag();
        const p = R(n(), n());
        arc(cur, p, rx, ry, rot, large, sweep, m, out);
        cur = p;
        lastC = lastQ = null;
        break;
      }
      default:
        i++;
    }
  }
}

/** An SVG elliptical arc: an exact circular arc when it can be, else cubic Béziers. */
function arc(p1: P2, p2: P2, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, m: M, out: ImportShape[]) {
  if (Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) < 1e-12) return;
  if (rx < 1e-12 || ry < 1e-12) {
    out.push({ kind: "line", a: ap(m, p1), b: ap(m, p2) });
    return;
  }
  // Endpoint to centre parameterisation (SVG spec, appendix F.6).
  const phi = (rotDeg * Math.PI) / 180;
  const [cp, sp] = [Math.cos(phi), Math.sin(phi)];
  const dx = (p1[0] - p2[0]) / 2;
  const dy = (p1[1] - p2[1]) / 2;
  const x1 = cp * dx + sp * dy;
  const y1 = -sp * dx + cp * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cx1 = (k * rx * y1) / ry;
  const cy1 = (-k * ry * x1) / rx;
  const c: P2 = [cp * cx1 - sp * cy1 + (p1[0] + p2[0]) / 2, sp * cx1 + cp * cy1 + (p1[1] + p2[1]) / 2];
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;

  const s = uniform(m);
  if (Math.abs(rx - ry) < 1e-9 * Math.max(rx, ry) && s !== null) {
    // Circular, and the placement keeps circles round: an exact arc. Counter-clockwise in the
    // final coordinates means turning the SVG's way when the placement does not mirror.
    const ccw = dt > 0 !== det(m) < 0;
    const [a, b] = [ap(m, p1), ap(m, p2)];
    out.push({ kind: "arc", c: ap(m, c), r: rx * s, s: ccw ? a : b, e: ccw ? b : a });
    return;
  }
  // Otherwise: Béziers, at most a quarter turn each.
  const parts = Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9);
  const step = dt / parts;
  const kk = (4 / 3) * Math.tan(step / 4);
  const pt = (t: number): P2 => [c[0] + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, c[1] + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp];
  const dpt = (t: number): P2 => [-rx * Math.sin(t) * cp - ry * Math.cos(t) * sp, -rx * Math.sin(t) * sp + ry * Math.cos(t) * cp];
  for (let j = 0; j < parts; j++) {
    const ta = t1 + step * j;
    const tb = ta + step;
    const a = j === 0 ? p1 : pt(ta);
    const b = j === parts - 1 ? p2 : pt(tb);
    const da = dpt(ta);
    const db = dpt(tb);
    out.push({
      kind: "bezier",
      a: ap(m, a),
      c1: ap(m, [a[0] + kk * da[0], a[1] + kk * da[1]]),
      c2: ap(m, [b[0] - kk * db[0], b[1] - kk * db[1]]),
      b: ap(m, b),
    });
  }
}
