// Sketch mode: drawing tools, snapping, dragging with the solver, selection and constraints.
// Every action works with one finger or a stylus; keyboard shortcuts are optional extras.
import * as THREE from "three";
import type { ConstraintType, SkArc, SkConstraint, SkCurve, SkEntity, SkLine, SkPoint, SketchFeature } from "../types";
import { DIMENSION_TYPES } from "../types";
import type { PointerTool, Ptr } from "../view/input";
import { V, gridStep, type LineBatch, type PointBatch, type Viewport } from "../view/viewport";
import { ORIGIN, SketchView, constraintLabel, deleteEntities, fmt, isHiddenPoint, isReference, mergePoints, uid } from "./model";
import { arcMid, findRegions, sampleSegments } from "./profiles";
import type { Drag, SolveResult, Solver } from "./solver";
import { keypad } from "../ui/keypad";

export type SketchToolName = "select" | "line" | "rect" | "circle" | "arc" | "point";

type P2 = [number, number];

/** What the pointer is on: an existing point, a curve (with the projected position), or nothing. */
type Snap =
  | { kind: "point"; id: string; at: P2 }
  | { kind: "curve"; id: string; at: P2 }
  | { kind: "free"; at: P2 };

export interface EditorHooks {
  /** A finished edit: record an undo step. */
  commit(label: string): void;
  /** Selection or available actions changed. */
  changed(): void;
  toast(msg: string): void;
}

export interface Action {
  id: string;
  label: string;
  title: string;
  key?: string;
  run: () => void;
}

const COLORS = {
  normal: [0.91, 0.94, 0.97],
  constrained: [0.55, 0.88, 0.55],
  construction: [0.85, 0.6, 0.3],
  selected: [0.3, 0.76, 1.0],
  hover: [1.0, 0.85, 0.45],
  preview: [1.0, 0.71, 0.28],
  axisX: [0.88, 0.33, 0.33],
  axisY: [0.33, 0.77, 0.42],
};
const TAP = 8;
const AUTO_HV_DEG = 4;
/** Magnifier under the finger while drawing. Off for now: the target is tablets, with room to see. */
const LOUPE = false;

const hitRadius = (k: Ptr["kind"]) => (k === "touch" ? 26 : k === "pen" ? 16 : 10);

export class SketchEditor implements PointerTool {
  tool: SketchToolName = "select";
  construction = false;
  autoConstrain = true;
  readonly selection = new Set<string>();
  dof = 0;

  private hoverId: string | null = null;
  private cursor: Snap | null = null;
  private hvHint: "horizontal" | "vertical" | null = null;
  /** First clicks of a multi-click tool (line start, rectangle corner, circle centre…). */
  private anchors: Snap[] = [];
  /** For arcs: accumulated sweep while choosing the end point, to know the direction. */
  private arcSweep = 0;
  private lastArcAngle = 0;
  /** Line tool: the chain continues from this point. */
  private chainFrom: string | null = null;
  private press: { p: Ptr; snap: Snap; hit: string | null; moved: boolean } | null = null;
  private dragState: { ids: string[]; starts: Map<string, P2>; from: P2; radius?: string } | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private boxEl: HTMLDivElement;

  constructor(
    private vp: Viewport,
    private solver: Solver,
    public sk: SketchFeature,
    private hooks: EditorHooks,
  ) {
    this.boxEl = document.createElement("div");
    this.boxEl.className = "selbox";
    vp.container.appendChild(this.boxEl);
    this.solve();
    this.render();
  }

  dispose() {
    this.boxEl.remove();
    this.vp.setSketchLayer([], []);
    this.vp.setFills(null, [], "");
    this.vp.setLabels([]);
    this.vp.loupe = null;
  }

  /** Replaces the working sketch (after undo/redo). */
  load(sk: SketchFeature) {
    this.sk = sk;
    const v = new SketchView(sk);
    for (const id of [...this.selection]) if (!v.get(id) && !sk.constraints.some((c) => c.id === id)) this.selection.delete(id);
    this.resetTool();
    this.solve();
    this.render();
  }

  get view() {
    return new SketchView(this.sk);
  }

  setTool(t: SketchToolName) {
    this.tool = t;
    this.resetTool();
    if (t !== "select") this.selection.clear();
    this.render();
    this.hooks.changed();
  }

  /** Esc: drop what is in progress, then the selection. Returns false when nothing was left to cancel. */
  escape(): boolean {
    if (this.anchors.length || this.chainFrom || this.press) {
      this.resetTool();
      this.render();
      return true;
    }
    if (this.tool !== "select") {
      this.setTool("select");
      return true;
    }
    if (this.selection.size) {
      this.selection.clear();
      this.render();
      this.hooks.changed();
      return true;
    }
    return false;
  }

  private resetTool() {
    this.anchors = [];
    this.chainFrom = null;
    this.press = null;
    this.dragState = null;
    this.cursor = null;
    this.hvHint = null;
    this.box = null;
    this.boxEl.style.display = "none";
    this.vp.loupe = null;
  }

  // ---------- Coordinates and snapping ----------

  private toSketch(p: Ptr): P2 {
    return this.vp.screenToPlane(p.x, p.y, this.sk.plane) ?? [0, 0];
  }

  private toWorld([x, y]: P2) {
    const pl = this.sk.plane;
    const xd = V(pl.xDir);
    const yd = V(pl.normal).cross(xd);
    return V(pl.origin).addScaledVector(xd, x).addScaledVector(yd, y);
  }

  private toScreen(p: P2) {
    return this.vp.toScreen(this.toWorld(p));
  }

  /** Free positions are rounded to a tenth of the grid step: clean numbers without a keyboard. */
  private round(p: P2): P2 {
    const q = gridStep(this.vp.viewHeight) / 10;
    return [Math.round(p[0] / q) * q, Math.round(p[1] / q) * q];
  }

  /** Nearest point, then nearest curve, within the pointer's hit radius. */
  private hitTest(p: Ptr, exclude: Set<string> = new Set()): { id: string; kind: "point" | "curve"; at: P2 } | null {
    const v = this.view;
    const R = hitRadius(p.kind);
    let best: { id: string; kind: "point" | "curve"; at: P2; d: number } | null = null;
    for (const pt of v.points()) {
      if (exclude.has(pt.id)) continue;
      const [sx, sy] = this.toScreen([pt.x, pt.y]);
      const d = Math.hypot(sx - p.x, sy - p.y);
      if (d < R && (!best || d < best.d)) best = { id: pt.id, kind: "point", at: [pt.x, pt.y], d };
    }
    if (best) return best;
    const s = this.toSketch(p);
    for (const c of v.curves()) {
      if (exclude.has(c.id)) continue;
      const proj = this.project(c, s, v);
      if (!proj) continue;
      const [sx, sy] = this.toScreen(proj);
      const d = Math.hypot(sx - p.x, sy - p.y);
      // Curves are a bit easier to miss than points: favour points by a margin.
      if (d < R * 0.8 && (!best || d < best.d)) best = { id: c.id, kind: "curve", at: proj, d };
    }
    return best;
  }

  /** Closest point on a curve (arcs: only within their sweep). */
  private project(c: SkCurve, s: P2, v: SketchView): P2 | null {
    if (c.type === "line") {
      const a = v.xy(c.p1);
      const b = v.xy(c.p2);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy;
      if (L2 < 1e-12) return null;
      let t = ((s[0] - a[0]) * dx + (s[1] - a[1]) * dy) / L2;
      if (!c.axis) t = Math.max(0, Math.min(1, t));
      return [a[0] + t * dx, a[1] + t * dy];
    }
    const ctr = v.xy(c.c);
    const r = c.type === "circle" ? c.r : v.arcRadius(c);
    let ang = Math.atan2(s[1] - ctr[1], s[0] - ctr[0]);
    if (c.type === "arc") {
      const [a0, a1] = v.arcAngles(c);
      while (ang < a0) ang += Math.PI * 2;
      if (ang > a1) {
        const d0 = Math.abs(ang - a1);
        const d1 = Math.abs(a0 + Math.PI * 2 - ang);
        ang = d0 < d1 ? a1 : a0;
      }
    }
    return [ctr[0] + r * Math.cos(ang), ctr[1] + r * Math.sin(ang)];
  }

  private snap(p: Ptr, exclude?: Set<string>): Snap {
    const h = this.hitTest(p, exclude);
    if (h) return h.kind === "point" ? { kind: "point", id: h.id, at: h.at } : { kind: "curve", id: h.id, at: h.at };
    return { kind: "free", at: this.round(this.toSketch(p)) };
  }

  /** Makes a free snap exactly horizontal/vertical from `from` when close enough. */
  private inferHV(from: P2 | null, s: Snap): Snap {
    this.hvHint = null;
    if (!from || s.kind === "point" || !this.autoConstrain) return s;
    const dx = s.at[0] - from[0];
    const dy = s.at[1] - from[1];
    if (Math.hypot(dx, dy) < 1e-9) return s;
    const ang = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
    if (Math.min(ang, 180 - ang) < AUTO_HV_DEG) {
      this.hvHint = "horizontal";
      return s.kind === "free" ? { ...s, at: [s.at[0], from[1]] } : s;
    }
    if (Math.abs(ang - 90) < AUTO_HV_DEG) {
      this.hvHint = "vertical";
      return s.kind === "free" ? { ...s, at: [from[0], s.at[1]] } : s;
    }
    return s;
  }

  private anchorXY(s: Snap): P2 {
    return s.kind === "point" ? this.view.xy(s.id) : s.at;
  }

  /** Turns a snap into a point id, adding the point (and a point-on-curve constraint) if needed. */
  private realize(s: Snap): string {
    if (s.kind === "point") return s.id;
    const id = uid();
    this.sk.entities.push({ id, type: "point", x: s.at[0], y: s.at[1] });
    if (s.kind === "curve" && this.autoConstrain) this.sk.constraints.push({ id: uid(), type: "pointOn", refs: [id, s.id] });
    return id;
  }

  private addCurve(c: SkCurve) {
    if (this.construction) c.construction = true;
    this.sk.entities.push(c);
  }

  // ---------- Pointer handling ----------

  down(p: Ptr) {
    const hit = this.tool === "select" ? this.hitTest(p) : null;
    this.press = { p, snap: this.snap(p), hit: hit?.id ?? null, moved: false };
    if (this.tool !== "select") {
      this.cursor = this.toolSnap(p);
      if (LOUPE && p.kind === "touch") this.vp.loupe = { x: p.x, y: p.y };
      this.render();
    }
  }

  move(p: Ptr) {
    const pr = this.press;
    if (!pr) return;
    if (!pr.moved && Math.hypot(p.x - pr.p.x, p.y - pr.p.y) > TAP) {
      pr.moved = true;
      if (this.tool === "select") this.beginDrag(pr);
    }
    if (LOUPE && p.kind === "touch" && (this.tool !== "select" || this.dragState)) this.vp.loupe = { x: p.x, y: p.y };

    if (this.tool === "select") {
      if (this.dragState) this.dragTo(p);
      else if (this.box) {
        this.box.x1 = p.x;
        this.box.y1 = p.y;
        this.showBox();
      }
      return;
    }
    // Dragging from a fresh press (no anchor yet) previews from the press point.
    if (pr.moved && this.anchors.length === 0 && !this.chainFrom) this.anchors = [pr.snap];
    this.cursor = this.toolSnap(p);
    this.render();
  }

  up(p: Ptr) {
    const pr = this.press;
    this.press = null;
    this.vp.loupe = null;
    if (!pr) return;
    if (this.tool === "select") {
      if (this.dragState) {
        this.dragState = null;
        this.hooks.commit("Drag");
      } else if (this.box) {
        this.finishBox(p);
      } else {
        this.tapSelect(pr.hit, p);
      }
      this.render();
      this.hooks.changed();
      return;
    }
    if (pr.moved && this.anchors.length === 0 && !this.chainFrom) this.anchors = [pr.snap];
    this.cursor = this.toolSnap(p);
    this.place(this.cursor);
    this.render();
  }

  cancel() {
    if (this.dragState) {
      this.dragState = null;
      this.hooks.commit("Drag");
    }
    // Keep anchors from previous taps: a second finger only aborts the current press.
    this.press = null;
    this.box = null;
    this.boxEl.style.display = "none";
    this.vp.loupe = null;
    this.render();
  }

  hover(p: Ptr | null) {
    if (!p) {
      this.hoverId = null;
      if (this.tool !== "select") this.cursor = null;
      this.render();
      return;
    }
    if (this.tool === "select") {
      const h = this.hitTest(p)?.id ?? null;
      if (h !== this.hoverId) {
        this.hoverId = h;
        this.render();
      }
    } else {
      this.cursor = this.toolSnap(p);
      this.render();
    }
  }

  /** Snap for drawing tools, with horizontal/vertical inference from the previous point. */
  private toolSnap(p: Ptr): Snap {
    const s = this.snap(p);
    const from = this.chainFrom ? this.view.xy(this.chainFrom) : this.anchors.length ? this.anchorXY(this.anchors[0]) : null;
    if (this.tool === "line") return this.inferHV(from, s);
    if (this.tool === "arc" && this.anchors.length === 2) this.trackArcSweep(s.at);
    this.hvHint = null;
    return s;
  }

  // ---------- Drawing tools ----------

  /** A click (tap, or end of a drag) with a drawing tool. */
  private place(s: Snap) {
    switch (this.tool) {
      case "point": {
        if (s.kind === "point") return;
        this.realize(s);
        this.afterEdit("Point");
        return;
      }
      case "line":
        return this.placeLine(s);
      case "rect":
        if (!this.anchors.length) return void (this.anchors = [s]);
        return this.placeRect(this.anchors[0], s);
      case "circle":
        if (!this.anchors.length) return void (this.anchors = [s]);
        return this.placeCircle(this.anchors[0], s);
      case "arc":
        if (this.anchors.length < 2) {
          this.anchors.push(s);
          if (this.anchors.length === 2) {
            const c = this.anchorXY(this.anchors[0]);
            this.lastArcAngle = Math.atan2(s.at[1] - c[1], s.at[0] - c[0]);
            this.arcSweep = 0;
          }
          return;
        }
        return this.placeArc(this.anchors[0], this.anchors[1], s);
    }
  }

  private placeLine(s: Snap) {
    if (!this.chainFrom && !this.anchors.length) {
      this.anchors = [s];
      return;
    }
    const startSnap = this.chainFrom ? null : this.anchors[0];
    const startXY = this.chainFrom ? this.view.xy(this.chainFrom) : this.anchorXY(startSnap!);
    if (s.kind === "point" && (s.id === this.chainFrom || (startSnap?.kind === "point" && startSnap.id === s.id))) {
      // Tapping the last point again ends the chain.
      this.resetTool();
      return;
    }
    if (Math.hypot(s.at[0] - startXY[0], s.at[1] - startXY[1]) < 1e-9) return;
    const hint = this.hvHint;
    const a = this.chainFrom ?? this.realize(startSnap!);
    const b = this.realize(s);
    const line: SkLine = { id: uid(), type: "line", p1: a, p2: b };
    this.addCurve(line);
    if (hint) this.sk.constraints.push({ id: uid(), type: hint, refs: [line.id] });
    this.anchors = [];
    // Reaching an existing point (closing a loop) ends the chain.
    this.chainFrom = s.kind === "point" ? null : b;
    this.afterEdit("Line");
  }

  private placeRect(a: Snap, b: Snap) {
    const [x0, y0] = this.anchorXY(a);
    const [x1, y1] = this.anchorXY(b);
    if (Math.abs(x1 - x0) < 1e-6 || Math.abs(y1 - y0) < 1e-6) return;
    const p0 = this.realize(a);
    const p2 = this.realize(b);
    const p1 = this.realize({ kind: "free", at: [x1, y0] });
    const p3 = this.realize({ kind: "free", at: [x0, y1] });
    const ids = [p0, p1, p2, p3];
    const lines = ids.map((id, i): SkLine => ({ id: uid(), type: "line", p1: id, p2: ids[(i + 1) % 4] }));
    lines.forEach((l) => this.addCurve(l));
    const t: ConstraintType[] = ["horizontal", "vertical", "horizontal", "vertical"];
    lines.forEach((l, i) => this.sk.constraints.push({ id: uid(), type: t[i], refs: [l.id] }));
    this.anchors = [];
    this.afterEdit("Rectangle");
  }

  private placeCircle(c: Snap, edge: Snap) {
    const ctr = this.anchorXY(c);
    const r = Math.hypot(edge.at[0] - ctr[0], edge.at[1] - ctr[1]);
    if (r < 1e-6) return;
    this.addCurve({ id: uid(), type: "circle", c: this.realize(c), r });
    this.anchors = [];
    this.afterEdit("Circle");
  }

  private trackArcSweep(at: P2) {
    const c = this.anchorXY(this.anchors[0]);
    const ang = Math.atan2(at[1] - c[1], at[0] - c[0]);
    let d = ang - this.lastArcAngle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.arcSweep += d;
    this.lastArcAngle = ang;
  }

  private placeArc(c: Snap, s: Snap, e: Snap) {
    const ctr = this.anchorXY(c);
    const st = this.anchorXY(s);
    const r = Math.hypot(st[0] - ctr[0], st[1] - ctr[1]);
    if (r < 1e-6) return;
    // Put a free end point exactly on the circle.
    let end = e;
    if (e.kind !== "point") {
      const ang = Math.atan2(e.at[1] - ctr[1], e.at[0] - ctr[0]);
      end = { kind: "free", at: [ctr[0] + r * Math.cos(ang), ctr[1] + r * Math.sin(ang)] };
    }
    const ci = this.realize(c);
    const si = this.realize(s);
    const ei = this.realize(end);
    if (si === ei) return;
    // Arcs are stored counter-clockwise: swap the ends when drawn clockwise.
    const ccw = this.arcSweep >= 0;
    this.addCurve({ id: uid(), type: "arc", c: ci, s: ccw ? si : ei, e: ccw ? ei : si });
    this.anchors = [];
    this.afterEdit("Arc");
  }

  private afterEdit(label: string) {
    this.solve();
    this.hooks.commit(label);
    this.render();
    this.hooks.changed();
  }

  // ---------- Select tool: tap, box, drag ----------

  private tapSelect(id: string | null, p: Ptr) {
    if (!id) {
      if (!p.shift && !p.ctrl) this.selection.clear();
      return;
    }
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
  }

  private beginDrag(pr: NonNullable<SketchEditor["press"]>) {
    const v = this.view;
    const e = pr.hit ? v.get(pr.hit) : undefined;
    if (!e) {
      this.box = { x0: pr.p.x, y0: pr.p.y, x1: pr.p.x, y1: pr.p.y };
      this.showBox();
      return;
    }
    if (isReference(e)) return;
    const from = this.toSketch(pr.p);
    if (e.type === "circle") {
      // Grabbing the rim changes the radius.
      this.dragState = { ids: [], starts: new Map(), from, radius: e.id };
      return;
    }
    const ids = e.type === "point" ? [e.id] : v.defPoints(e);
    const starts = new Map(ids.map((id) => [id, v.xy(id)] as [string, P2]));
    this.dragState = { ids, starts, from };
  }

  private dragTo(p: Ptr) {
    const d = this.dragState!;
    const at = this.toSketch(p);
    const drag: Drag = {};
    if (d.radius) {
      const c = this.view.get(d.radius) as SkCurve & { c: string };
      const ctr = this.view.xy(c.c);
      drag.radius = { id: d.radius, r: Math.hypot(at[0] - ctr[0], at[1] - ctr[1]) };
    } else {
      const dx = at[0] - d.from[0];
      const dy = at[1] - d.from[1];
      drag.points = d.ids.map((id) => {
        const s = d.starts.get(id)!;
        return { id, x: s[0] + dx, y: s[1] + dy };
      });
    }
    this.solve(drag);
    this.render();
  }

  private showBox() {
    const b = this.box!;
    Object.assign(this.boxEl.style, {
      display: "block",
      left: `${Math.min(b.x0, b.x1)}px`,
      top: `${Math.min(b.y0, b.y1)}px`,
      width: `${Math.abs(b.x1 - b.x0)}px`,
      height: `${Math.abs(b.y1 - b.y0)}px`,
    });
  }

  private finishBox(p: Ptr) {
    const b = this.box!;
    this.box = null;
    this.boxEl.style.display = "none";
    const [xa, xb] = [Math.min(b.x0, p.x), Math.max(b.x0, p.x)];
    const [ya, yb] = [Math.min(b.y0, p.y), Math.max(b.y0, p.y)];
    const inside = (xy: P2) => {
      const [x, y] = this.toScreen(xy);
      return x >= xa && x <= xb && y >= ya && y <= yb;
    };
    const v = this.view;
    if (!p.shift && !p.ctrl) this.selection.clear();
    for (const e of this.sk.entities) {
      if (isReference(e) || (e.type === "point" && isHiddenPoint(e.id))) continue;
      let pts: P2[];
      if (e.type === "circle") {
        const c = v.xy(e.c);
        pts = [[c[0] - e.r, c[1]], [c[0] + e.r, c[1]], [c[0], c[1] - e.r], [c[0], c[1] + e.r]];
      } else pts = v.defPoints(e).map((id) => v.xy(id));
      if (pts.every(inside)) this.selection.add(e.id);
    }
  }

  // ---------- Solving ----------

  solve(drag?: Drag): SolveResult {
    const r = this.solver.solve(this.sk, drag);
    if (!drag) this.dof = r.dof;
    return r;
  }

  /** Adds a constraint; rejects it (with a message) if it conflicts or is redundant. */
  private addConstraint(c: SkConstraint): boolean {
    const backup = structuredClone(this.sk);
    this.sk.constraints.push(c);
    const r = this.solve();
    if (!r.ok || r.conflicting.length || r.redundant.includes(c.id)) {
      this.sk.entities = backup.entities;
      this.sk.constraints = backup.constraints;
      this.solve();
      this.hooks.toast(r.redundant.includes(c.id) ? "Redundant constraint" : "Over-constrained: conflicts with existing constraints");
      return false;
    }
    return true;
  }

  // ---------- Contextual actions ----------

  actions(): Action[] {
    const v = this.view;
    const sel = [...this.selection];
    const ents = sel.map((id) => v.get(id)).filter((e): e is SkEntity => !!e);
    const cons = sel.filter((id) => this.sk.constraints.some((c) => c.id === id));
    const P = ents.filter((e): e is SkPoint => e.type === "point");
    const L = ents.filter((e): e is SkLine => e.type === "line");
    const R = ents.filter((e): e is SkCurve => e.type === "circle" || e.type === "arc");
    const n = ents.length;
    const out: Action[] = [];
    const con = (id: string, label: string, title: string, type: ConstraintType, refs: string[], key?: string) =>
      out.push({ id, label, title, key, run: () => this.constrain(type, refs) });
    const dim = (label: string, title: string, type: ConstraintType, refs: string[], key = "D") =>
      out.push({ id: "dim-" + type, label, title, key, run: () => void this.dimension(type, refs) });

    if (n === 1 && L.length === 1 && !L[0].axis) {
      con("h", "H", "Horizontal", "horizontal", [L[0].id], "H");
      con("v", "V", "Vertical", "vertical", [L[0].id], "V");
      dim("↔", "Length", "distance", [L[0].id]);
    }
    if (n === 2 && L.length === 2) {
      con("par", "∥", "Parallel", "parallel", [L[0].id, L[1].id]);
      con("perp", "⊥", "Perpendicular", "perpendicular", [L[0].id, L[1].id]);
      if (!L[0].axis && !L[1].axis) con("eq", "=", "Equal length", "equal", [L[0].id, L[1].id], "E");
      dim("∠", "Angle", "angle", [L[0].id, L[1].id]);
    }
    if (n === 2 && P.length === 2) {
      out.push({ id: "coin", label: "⊙", title: "Coincident", key: "C", run: () => this.coincident(P[0].id, P[1].id) });
      con("h", "H", "Horizontal", "horizontal", [P[0].id, P[1].id], "H");
      con("v", "V", "Vertical", "vertical", [P[0].id, P[1].id], "V");
      dim("↔", "Distance", "distance", [P[0].id, P[1].id]);
      dim("↔x", "Horizontal distance", "distanceX", [P[0].id, P[1].id], "X");
      dim("↕y", "Vertical distance", "distanceY", [P[0].id, P[1].id], "Y");
    }
    if (n === 2 && P.length === 1 && L.length === 1) {
      con("on", "•—", "Point on line", "pointOn", [P[0].id, L[0].id], "O");
      if (!L[0].axis) con("mid", "M", "Midpoint", "midpoint", [P[0].id, L[0].id], "M");
      dim("↔", "Distance to line", "distance", [P[0].id, L[0].id]);
    }
    if (n === 2 && P.length === 1 && R.length === 1) con("on", "•◯", "Point on curve", "pointOn", [P[0].id, R[0].id], "O");
    if (n === 1 && R.length === 1) {
      dim("R", "Radius", "radius", [R[0].id], "R");
      dim("⌀", "Diameter", "diameter", [R[0].id], "D");
    }
    if (n === 2 && R.length === 2) {
      con("eq", "=", "Equal radius", "equal", [R[0].id, R[1].id], "E");
      con("tan", "T", "Tangent", "tangent", [R[0].id, R[1].id], "T");
      const [c0, c1] = R.map((r) => (r as { c: string }).c);
      out.push({ id: "conc", label: "◎", title: "Concentric", run: () => this.coincident(c0, c1) });
    }
    if (n === 2 && L.length === 1 && R.length === 1) con("tan", "T", "Tangent", "tangent", [L[0].id, R[0].id], "T");
    if (n === 3 && P.length === 2 && L.length === 1) con("sym", "⇹", "Symmetric about line", "symmetric", [P[0].id, P[1].id, L[0].id], "S");
    if (n === 3 && P.length === 3) con("sym", "⇹", "Symmetric about point", "symmetric", [P[0].id, P[1].id, P[2].id], "S");
    if (n === 1 && P.length === 1 && !P[0].fixed) {
      const fixed = this.sk.constraints.find((c) => c.type === "fix" && c.refs[0] === P[0].id);
      if (!fixed) out.push({ id: "fix", label: "⚓", title: "Fix in place", key: "F", run: () => this.fix(P[0]) });
    }
    if (cons.length === 1 && n === 0) {
      const c = this.sk.constraints.find((k) => k.id === cons[0])!;
      if (DIMENSION_TYPES.includes(c.type)) out.push({ id: "edit", label: "✎", title: "Edit value", run: () => void this.editDimension(c) });
    }
    const editable = ents.filter((e) => !isReference(e));
    if (editable.some((e) => e.type !== "point"))
      out.push({ id: "constr", label: "┄", title: "Toggle construction", key: "G", run: () => this.toggleConstruction() });
    if (editable.length || cons.length) out.push({ id: "del", label: "🗑", title: "Delete", key: "Delete", run: () => this.deleteSelection() });
    return out;
  }

  private constrain(type: ConstraintType, refs: string[]) {
    if (this.addConstraint({ id: uid(), type, refs })) {
      this.selection.clear();
      this.hooks.commit(type);
    }
    this.render();
    this.hooks.changed();
  }

  private coincident(a: string, b: string) {
    const backup = structuredClone(this.sk);
    mergePoints(this.sk, a, b);
    const r = this.solve();
    if (!r.ok || r.conflicting.length) {
      this.sk.entities = backup.entities;
      this.sk.constraints = backup.constraints;
      this.solve();
      this.hooks.toast("Over-constrained: cannot make these points coincident");
    } else {
      this.selection.clear();
      this.hooks.commit("Coincident");
    }
    this.render();
    this.hooks.changed();
  }

  private fix(p: SkPoint) {
    this.constrainWith({ id: uid(), type: "fix", refs: [p.id], at: [p.x, p.y] }, "Fix");
  }

  private constrainWith(c: SkConstraint, label: string) {
    if (this.addConstraint(c)) {
      this.selection.clear();
      this.hooks.commit(label);
    }
    this.render();
    this.hooks.changed();
  }

  /** Current measured value for a new dimension. */
  private measure(type: ConstraintType, refs: string[]): number {
    const v = this.view;
    const [a, b] = refs.map((r) => v.get(r)!);
    const d = (p: P2, q: P2) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    switch (type) {
      case "distance":
        if (a.type === "line" && !b) return d(v.xy(a.p1), v.xy(a.p2));
        if (a.type === "point" && b?.type === "line") {
          const proj = this.project({ ...b, axis: true }, v.xy(a.id), v)!;
          return d(v.xy(a.id), proj);
        }
        return d(v.xy(a.id), v.xy(b.id));
      case "distanceX":
        return v.xy(b.id)[0] - v.xy(a.id)[0];
      case "distanceY":
        return v.xy(b.id)[1] - v.xy(a.id)[1];
      case "radius":
        return a.type === "circle" ? a.r : v.arcRadius(a as SkArc);
      case "diameter":
        return 2 * (a.type === "circle" ? a.r : v.arcRadius(a as SkArc));
      case "angle": {
        const dir = (l: SkLine) => {
          const p = v.xy(l.p1);
          const q = v.xy(l.p2);
          return [q[0] - p[0], q[1] - p[1]];
        };
        const [u, w] = [dir(a as SkLine), dir(b as SkLine)];
        return (Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1]) * 180) / Math.PI;
      }
    }
    return 0;
  }

  async dimension(type: ConstraintType, refs: string[]) {
    let r = refs;
    let current = this.measure(type, r);
    // Signed horizontal/vertical distances: order the points so the value is positive.
    if ((type === "distanceX" || type === "distanceY") && current < 0) {
      r = [refs[1], refs[0]];
      current = -current;
    }
    const titles: Partial<Record<ConstraintType, string>> = {
      distance: "Distance",
      distanceX: "Horizontal distance",
      distanceY: "Vertical distance",
      radius: "Radius",
      diameter: "Diameter",
      angle: "Angle",
    };
    const value = await keypad({ title: titles[type] ?? "Value", value: Math.abs(current), unit: type === "angle" ? "°" : "mm" });
    if (value === null) return;
    if (type !== "angle" && value <= 0) return this.hooks.toast("The value must be positive");
    const signed = type === "angle" && current < 0 ? -value : value;
    this.constrainWith({ id: uid(), type, refs: r, value: signed }, titles[type] ?? "Dimension");
  }

  async editDimension(c: SkConstraint) {
    const old = c.value ?? 0;
    const value = await keypad({ title: "Edit dimension", value: Math.abs(old), unit: c.type === "angle" ? "°" : "mm" });
    if (value === null || value === Math.abs(old)) return;
    if (c.type !== "angle" && value <= 0) return this.hooks.toast("The value must be positive");
    c.value = old < 0 ? -value : value;
    const r = this.solve();
    if (!r.ok || r.conflicting.length) {
      c.value = old;
      this.solve();
      this.hooks.toast("This value cannot be solved");
    } else this.hooks.commit("Edit dimension");
    this.render();
    this.hooks.changed();
  }

  toggleConstruction() {
    const v = this.view;
    const curves = [...this.selection].map((id) => v.get(id)).filter((e): e is SkCurve => !!e && e.type !== "point" && !isReference(e));
    const on = !curves.every((c) => c.construction);
    for (const c of curves) c.construction = on;
    this.hooks.commit("Construction");
    this.render();
    this.hooks.changed();
  }

  deleteSelection() {
    const ids = [...this.selection];
    this.sk.constraints = this.sk.constraints.filter((c) => !this.selection.has(c.id));
    deleteEntities(this.sk, ids);
    this.selection.clear();
    this.solve();
    this.hooks.commit("Delete");
    this.render();
    this.hooks.changed();
  }

  /** Keyboard shortcuts for the contextual actions. */
  runShortcut(key: string): boolean {
    const a = this.actions().find((x) => x.key?.toLowerCase() === key.toLowerCase());
    if (!a) return false;
    a.run();
    return true;
  }

  // ---------- Rendering ----------

  render() {
    const v = this.view;
    const lines: LineBatch = { positions: [], colors: [], width: 2.5, overlay: true };
    const constr: LineBatch = { positions: [], colors: [], width: 1.5, overlay: true, dashed: true };
    const preview: LineBatch = { positions: [], colors: [], width: 2, overlay: true, dashed: true };
    const axes: LineBatch = { positions: [], colors: [], width: 1, overlay: false };
    const pts: PointBatch = { positions: [], colors: [], size: 9 };
    const big: PointBatch = { positions: [], colors: [], size: 16 };
    const base = this.dof === 0 ? COLORS.constrained : COLORS.normal;
    const colorOf = (id: string, fallback: number[]) =>
      this.selection.has(id) ? COLORS.selected : this.hoverId === id ? COLORS.hover : fallback;

    const seg = (b: LineBatch, p: P2, q: P2, c: number[]) => {
      b.positions.push(...this.toWorld(p).toArray(), ...this.toWorld(q).toArray());
      b.colors.push(...c, ...c);
    };
    const poly = (b: LineBatch, ps: P2[], c: number[]) => {
      for (let i = 0; i + 1 < ps.length; i++) seg(b, ps[i], ps[i + 1], c);
    };
    const circlePts = (c: P2, r: number, a0 = 0, a1 = Math.PI * 2) => {
      const n = Math.max(16, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 96));
      const out: P2[] = [];
      for (let i = 0; i <= n; i++) {
        const t = a0 + ((a1 - a0) * i) / n;
        out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
      }
      return out;
    };

    for (const c of v.curves()) {
      if (c.type === "line" && c.axis) {
        const big = 1e4;
        const d = v.xy(c.p2);
        const col = this.selection.has(c.id) ? COLORS.selected : c.id === "AX" ? COLORS.axisX : COLORS.axisY;
        seg(axes, [-d[0] * big, -d[1] * big], [d[0] * big, d[1] * big], col);
        continue;
      }
      const b = c.construction ? constr : lines;
      const col = colorOf(c.id, c.construction ? COLORS.construction : base);
      if (c.type === "line") seg(b, v.xy(c.p1), v.xy(c.p2), col);
      else if (c.type === "circle") poly(b, circlePts(v.xy(c.c), c.r), col);
      else {
        const [a0, a1] = v.arcAngles(c);
        poly(b, circlePts(v.xy(c.c), v.arcRadius(c), a0, a1), col);
      }
    }
    for (const p of v.points()) {
      const col = p.id === ORIGIN && !this.selection.has(p.id) ? [0.95, 0.95, 0.4] : colorOf(p.id, base);
      pts.positions.push(...this.toWorld([p.x, p.y]).toArray());
      pts.colors.push(...col);
    }

    // Tool preview: rubber band from the anchor to the cursor.
    const cur = this.cursor;
    if (cur && this.tool !== "select") {
      big.positions.push(...this.toWorld(cur.at).toArray());
      big.colors.push(...(cur.kind === "free" ? COLORS.preview : COLORS.hover));
      const from = this.chainFrom ? v.xy(this.chainFrom) : this.anchors.length ? this.anchorXY(this.anchors[0]) : null;
      const col = COLORS.preview;
      if (from) {
        if (this.tool === "line") seg(preview, from, cur.at, col);
        if (this.tool === "rect") {
          const [x0, y0] = from;
          const [x1, y1] = cur.at;
          poly(preview, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], col);
        }
        if (this.tool === "circle") poly(preview, circlePts(from, Math.hypot(cur.at[0] - from[0], cur.at[1] - from[1])), col);
        if (this.tool === "arc") {
          if (this.anchors.length === 1) seg(preview, from, cur.at, col);
          else {
            const st = this.anchorXY(this.anchors[1]);
            const r = Math.hypot(st[0] - from[0], st[1] - from[1]);
            const a0 = Math.atan2(st[1] - from[1], st[0] - from[0]);
            const sweep = this.arcSweep;
            poly(preview, circlePts(from, r, Math.min(a0, a0 + sweep), Math.max(a0, a0 + sweep)), col);
          }
        }
      }
      for (const a of this.anchors) {
        big.positions.push(...this.toWorld(this.anchorXY(a)).toArray());
        big.colors.push(...COLORS.preview);
      }
    }

    this.vp.setSketchLayer([axes, constr, lines, preview], [pts, big]);

    // Closed regions, filled faintly: what an extrusion will use.
    const regions = findRegions(this.sk).map((r) => ({
      outer: loopPoly(r.outer),
      holes: r.holes.map(loopPoly),
    }));
    this.vp.setFills(this.sk.plane, regions, "#4cc3ff");
    this.renderLabels(v);
  }

  private renderLabels(v: SketchView) {
    const items: { el: HTMLElement; at: THREE.Vector3; dx?: number; dy?: number }[] = [];
    const perEntity = new Map<string, number>();
    const mid = (p: P2, q: P2, t = 0.5): P2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const anchorOf = (id: string): P2 | null => {
      const e = v.get(id);
      if (!e) return null;
      if (e.type === "point") return [e.x, e.y];
      if (e.type === "line") return e.axis ? [v.xy(e.p2)[0] * 20, v.xy(e.p2)[1] * 20] : mid(v.xy(e.p1), v.xy(e.p2), 0.3);
      if (e.type === "circle") {
        const c = v.xy(e.c);
        return [c[0] - e.r * 0.7071, c[1] + e.r * 0.7071];
      }
      return arcMid(v, e);
    };
    for (const c of this.sk.constraints) {
      const isDim = DIMENSION_TYPES.includes(c.type);
      let at: P2 | null = null;
      if (isDim) {
        const [a, b] = c.refs.map((r) => v.get(r));
        if (c.type === "distance" && a?.type === "line" && !b) at = mid(v.xy(a.p1), v.xy(a.p2));
        else if (c.type === "angle" && a?.type === "line" && b?.type === "line")
          at = mid(mid(v.xy(a.p1), v.xy(a.p2)), mid(v.xy(b.p1), v.xy(b.p2)));
        else if ((c.type === "radius" || c.type === "diameter") && a && a.type !== "point" && a.type !== "line") {
          if (a.type === "circle") {
            const ctr = v.xy(a.c);
            at = [ctr[0] + a.r * 0.7071, ctr[1] + a.r * 0.7071];
          } else at = arcMid(v, a);
        } else if (a?.type === "point" && b?.type === "line") {
          const proj = this.project({ ...b, axis: true }, v.xy(a.id), v);
          if (proj) at = mid(v.xy(a.id), proj);
        } else if (a?.type === "point" && b?.type === "point") at = mid(v.xy(a.id), v.xy(b.id));
      } else {
        at = anchorOf(c.refs[0]);
      }
      if (!at) continue;
      const el = document.createElement("button");
      el.className = "sk-label " + (isDim ? "dim" : "glyph");
      if (this.selection.has(c.id)) el.classList.add("sel");
      el.textContent = isDim ? (c.type === "angle" ? fmt(Math.abs(c.value ?? 0)) + "°" : constraintLabel(c)) : constraintLabel(c);
      el.title = c.type;
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isDim && !this.selection.size) return void this.editDimension(c);
        if (this.selection.has(c.id)) this.selection.delete(c.id);
        else this.selection.add(c.id);
        this.render();
        this.hooks.changed();
      });
      let dx = 0;
      let dy = 0;
      if (!isDim) {
        const k = (perEntity.get(c.refs[0]) ?? 0) + 1;
        perEntity.set(c.refs[0], k);
        dx = 14 + (k - 1) * 22;
        dy = -14;
      }
      items.push({ el, at: this.toWorld(at), dx, dy });
    }
    if (this.hvHint && this.cursor) {
      const el = document.createElement("div");
      el.className = "sk-label hint";
      el.textContent = this.hvHint === "horizontal" ? "H" : "V";
      items.push({ el, at: this.toWorld(this.cursor.at), dx: 22, dy: -22 });
    }
    this.vp.setLabels(items);
  }
}

function loopPoly(l: import("../types").ProfileLoop): P2[] {
  if (l.kind === "circle") {
    const out: P2[] = [];
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      out.push([l.c[0] + l.r * Math.cos(t), l.c[1] + l.r * Math.sin(t)]);
    }
    return out;
  }
  return sampleSegments(l.segments);
}

