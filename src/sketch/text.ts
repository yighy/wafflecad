// Text as sketch geometry: the outlines of the letters, from a font, as lines and Béziers.
// Pure code (the font is passed in, already parsed), testable under Node.
import type { Font } from "opentype.js";
import type { ImportShape } from "./importShapes";

type P2 = [number, number];

/**
 * Outlines of `text` with capital letters `height` tall, the baseline on y = 0 and the text
 * starting at x = 0 (y up, as in sketches). Lines of a multi-line text go down, 1.5 heights apart.
 * Quadratic curves (TrueType) become exact cubic Béziers.
 */
export function textShapes(font: Font, text: string, height: number): ImportShape[] {
  const capUnits = font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7;
  const size = (height * font.unitsPerEm) / capUnits;
  const out: ImportShape[] = [];
  text.split("\n").forEach((line, row) => {
    // opentype draws y down: flip it.
    const path = font.getPath(line, 0, 0, size);
    const dy = -row * height * 1.5;
    const P = (x: number, y: number): P2 => [x, -y + dy];
    let start: P2 | null = null;
    let at: P2 | null = null;
    const same = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;
    const lineTo = (b: P2) => {
      if (at && !same(at, b)) out.push({ kind: "line", a: at, b });
      at = b;
    };
    for (const c of path.commands) {
      if (c.type === "M") start = at = P(c.x, c.y);
      else if (c.type === "L") lineTo(P(c.x, c.y));
      else if (c.type === "Q" && at) {
        const q = P(c.x1, c.y1);
        const b = P(c.x, c.y);
        const a: P2 = at;
        if (!same(a, b))
          out.push({
            kind: "bezier",
            a,
            c1: [a[0] + (2 / 3) * (q[0] - a[0]), a[1] + (2 / 3) * (q[1] - a[1])],
            c2: [b[0] + (2 / 3) * (q[0] - b[0]), b[1] + (2 / 3) * (q[1] - b[1])],
            b,
          });
        at = b;
      } else if (c.type === "C" && at) {
        const b = P(c.x, c.y);
        if (!same(at, b)) out.push({ kind: "bezier", a: at, c1: P(c.x1, c.y1), c2: P(c.x2, c.y2), b });
        at = b;
      } else if (c.type === "Z" && start) {
        lineTo(start);
        start = at = null;
      }
    }
  });
  return out;
}
