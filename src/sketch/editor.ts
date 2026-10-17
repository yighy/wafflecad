// Sketch mode: drawing tools, snapping, dragging with the solver, selection and constraints.
// Every action works with one finger or a stylus; keyboard shortcuts are optional extras.
import * as THREE from "three";
import type { ConstraintType, SkArc, SkConstraint, SkCurve, SkEntity, SkLine, SkPoint, SketchFeature } from "../types";
import { DIMENSION_TYPES } from "../types";
import type { PointerTool, Ptr } from "../view/input";
import { V, cssVar, gridStep, type LineBatch, type PointBatch, type Viewport } from "../view/viewport";
import { ORIGIN, SketchView, constraintLabel, deleteEntities, fmt, isHiddenPoint, isReference, mergePoints, sampleBezier, sampleCurve, sampleSpline, splineSpans, uid } from "./model";
import { arcMid, findRegions, sampleSegments } from "./profiles";
import { trimPlan, type TrimPlan } from "./trim";
import { cornerLines, filletCorner, groupCentre, groupPoints, mirrorEntities, projectEdge, transformGroup, type GroupTransform } from "./ops";
import type { Drag, SolveResult, Solver } from "./solver";
import { keypad, openKeypad } from "../ui/keypad";

export type SketchToolName = "select" | "line" | "rect" | "circle" | "arc" | "spline" | "point" | "trim" | "fillet" | "project";

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
  /** Current parameter values, offered in the keypad. */
  scope(): Record<string, number>;
}

export interface Action {
  id: string;
  label: string;
  title: string;
  key?: string;
  run: () => void;
}

/** Sketch colours, read from the CSS theme. */
function palette() {
  const c = (name: string, fallback: string) => {
    const col = new THREE.Color(cssVar(name, fallback));
    return [col.r, col.g, col.b];
  };
  return {
    normal: c("--sk-line", "#e8eef5"),
    constrained: c("--sk-constrained", "#8ce08c"),
    construction: c("--sk-construction", "#d99a4a"),
    selected: c("--sk-selected", "#4cc3ff"),
    hover: c("--sk-hover", "#ffd873"),
    preview: c("--accent", "#ffb648"),
    trim: c("--danger", "#e5484d"),
    origin: c("--sk-origin", "#f2f266"),
    axisX: c("--axis-x", "#e05555"),
    axisY: c("--axis-y", "#55c46a"),
  };
}
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
  /** While Move is open: a drag anywhere slides the selection (sketch-space offset from the press). */
  private slide: { onDrag: (dx: number, dy: number) => void; onEnd: () => void; from: P2 | null } | null = null;
  /** The item tapped last into the selection (a box or Select all leaves none). */
  private lastTapped: string | null = null;
  private dragState: {
    ids: string[];
    starts: Map<string, P2>;
    from: P2;
    radius?: string;
    /** Dragging a multi-selection: the sketch before, and what moves. */
    group?: { base: Pick<SketchFeature, "entities" | "constraints">; ids: string[] };
  } | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Trim tool: the piece that the current press (or hover) would remove. */
  private trimPreview: TrimPlan | null = null;
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

  /** Points placed so far by a multi-tap tool (the spline's points, for instance). */
  get pending() {
    return this.anchors.length;
  }

  /** Esc: drop what is in progress, then the selection. Returns false when nothing was left to cancel. */
  escape(): boolean {
    // A spline being drawn is kept: Esc / Enter / the back gesture end it.
    if (this.tool === "spline" && this.anchors.length >= 2) {
      this.finishSpline(false);
      return true;
    }
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
    this.trimPreview = null;
    this.vp.highlightEdges([]);
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

  /**
   * Bézier control points stay out of the way (not drawn, not picked) unless their curve, or
   * one of its points, is selected.
   */
  private hiddenControls(v: SketchView): Set<string> {
    const out = new Set<string>();
    const shown = (b: { id: string; p0: string; c1: string; c2: string; p3: string }) =>
      [b.id, b.p0, b.c1, b.c2, b.p3].some((id) => this.selection.has(id) || this.hoverId === id);
    for (const c of v.curves()) if (c.type === "bezier" && !shown(c)) out.add(c.c1).add(c.c2);
    // A control point that is also the end of some curve stays visible.
    for (const c of v.curves()) {
      if (c.type === "bezier") {
        out.delete(c.p0);
        out.delete(c.p3);
      } else for (const id of v.defPoints(c)) out.delete(id);
    }
    return out;
  }

  /** Nearest point, then nearest curve, within the pointer's hit radius. */
  private hitTest(p: Ptr, exclude: Set<string> = new Set()): { id: string; kind: "point" | "curve"; at: P2 } | null {
    const v = this.view;
    const R = hitRadius(p.kind);
    let best: { id: string; kind: "point" | "curve"; at: P2; d: number } | null = null;
    const hidden = this.hiddenControls(v);
    for (const pt of v.points()) {
      if (exclude.has(pt.id) || hidden.has(pt.id)) continue;
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
      const raw = Math.hypot(sx - p.x, sy - p.y);
      // Curves are a bit easier to miss than points: favour points by a margin.
      if (raw >= R * 0.8) continue;
      // Drawn geometry wins over a reference axis it lies on (the axis is still picked away from it).
      const d = c.type === "line" && c.axis ? raw + R : raw;
      if (!best || d < best.d) best = { id: c.id, kind: "curve", at: proj, d };
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
    if (c.type === "spline" || c.type === "bezier") return closestOnPolyline(sampleCurve(v, c), s);
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
    if (this.slide) {
      this.slide.from = this.toSketch(p);
      return;
    }
    if (this.tool === "project") {
      this.press = { p, snap: { kind: "free", at: this.toSketch(p) }, hit: null, moved: false };
      this.showEdgeUnder(p);
      return;
    }
    if (this.tool === "trim") {
      this.press = { p, snap: { kind: "free", at: this.toSketch(p) }, hit: null, moved: false };
      this.trimPreview = this.trimAt(p)?.plan ?? null;
      this.render();
      return;
    }
    const hit = this.tool === "select" ? this.hitTest(p) : null;
    this.press = { p, snap: this.snap(p), hit: hit?.id ?? null, moved: false };
    if (this.tool !== "select") {
      this.cursor = this.toolSnap(p);
      if (LOUPE && p.kind === "touch") this.vp.loupe = { x: p.x, y: p.y };
      this.render();
    }
  }

  move(p: Ptr) {
    if (this.slide?.from) {
      const at = this.toSketch(p);
      this.slide.onDrag(at[0] - this.slide.from[0], at[1] - this.slide.from[1]);
      return;
    }
    const pr = this.press;
    if (!pr) return;
    if (this.tool === "project") return this.showEdgeUnder(p);
    if (this.tool === "trim") {
      // Slide the finger along: the piece under it is shown, and removed on release.
      this.trimPreview = this.trimAt(p)?.plan ?? null;
      this.render();
      return;
    }
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
    if (this.slide) {
      if (this.slide.from) this.slide.onEnd();
      this.slide.from = null;
      return;
    }
    const pr = this.press;
    this.press = null;
    this.vp.loupe = null;
    if (!pr) return;
    if (this.tool === "trim") return this.trim(p);
    if (this.tool === "project") return this.useEdge(p);
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
    if (this.tool === "trim") {
      this.trimPreview = this.trimAt(p)?.plan ?? null;
      this.render();
      return;
    }
    if (this.tool === "project") return this.showEdgeUnder(p);
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
      case "spline":
        return this.placeSpline(s);
      case "fillet":
        if (s.kind === "point") void this.filletAt(s.id);
        else this.hooks.toast("Tap the corner point where two lines meet");
        return;
    }
  }

  /** Fillet tool: rounds the corner at a point, asking for the radius. */
  async filletAt(pointId: string) {
    const pair = cornerLines(this.sk, pointId);
    if (!pair) return this.hooks.toast("Tap a corner where exactly two lines meet");
    const v = this.view;
    const lengthOf = (l: SkLine) => Math.hypot(...([0, 1] as const).map((i) => v.xy(l.p2)[i] - v.xy(l.p1)[i]));
    const guess = Math.min(...pair.map(lengthOf)) * 0.25;
    const step = gridStep(this.vp.viewHeight) / 10;
    const res = await keypad({
      title: "Fillet",
      subtitle: this.sk.name,
      label: "Radius",
      value: Math.max(step, Math.round(guess / step) * step),
      unit: "mm",
      scope: this.hooks.scope(),
    });
    if (res === null) return;
    const backup = structuredClone(this.sk);
    const err = filletCorner(this.sk, pointId, res.value);
    if (err) return this.hooks.toast(err);
    const fil = this.sk.constraints[this.sk.constraints.length - 1];
    if (res.expr) fil.expr = res.expr;
    this.checkOrRevert(backup, "Fillet", "This fillet conflicts with the existing constraints");
  }

  /**
   * Puts the sketch back to `base`, then moves/turns/scales the selection and solves. Returns
   * false (with the sketch left at `base`) when the rest of the sketch holds the piece back.
   */
  private applyGroup(base: Pick<SketchFeature, "entities" | "constraints">, ids: string[], t: GroupTransform): { ok: boolean; error?: string; dropped: number } {
    this.sk.entities = structuredClone(base.entities);
    this.sk.constraints = structuredClone(base.constraints);
    const r = transformGroup(this.sk, ids, t);
    if (r.error) {
      this.solve();
      return { ok: false, error: r.error, dropped: 0 };
    }
    const v = this.view;
    const want = [...groupPoints(this.sk, ids)].map((id) => [id, v.xy(id)] as const);
    const res = this.solve();
    const after = this.view;
    const held = !res.ok || res.conflicting.length > 0 || want.some(([id, [x, y]]) => Math.hypot(after.xy(id)[0] - x, after.xy(id)[1] - y) > 1e-6 * Math.max(1, Math.abs(x) + Math.abs(y)));
    return { ok: !held, dropped: r.dropped };
  }

  /** Move, Rotate or Scale the selection with the keypad, shown live; the origin of a turn or scale can be chosen. */
  async transformSelection(kind: GroupTransform["kind"]) {
    const ids = [...this.selection].filter((id) => this.view.get(id));
    if (!ids.length) return this.hooks.toast("Select what to transform first");
    const base = { entities: structuredClone(this.sk.entities), constraints: structuredClone(this.sk.constraints) };
    const centre = groupCentre(this.sk, ids);
    let about: "centre" | "origin" = "centre";
    let field: "dx" | "dy" = "dx";
    const val = { dx: 0, dy: 0, deg: 90, factor: 2 };
    const make = (): GroupTransform => {
      const at: P2 = about === "centre" ? centre : [0, 0];
      if (kind === "move") return { kind, dx: val.dx, dy: val.dy };
      if (kind === "rotate") return { kind, deg: val.deg, about: at };
      return { kind, factor: val.factor, about: at };
    };
    const show = () => {
      const r = this.applyGroup(base, ids, make());
      kp.setNote(r.error ?? (r.ok ? null : "Held by constraints linking it to the rest of the sketch"));
      this.render();
    };
    const aboutSeg = {
      options: [
        { value: "centre", label: "About its centre" },
        { value: "origin", label: "About the origin" },
      ],
      get: () => about,
      set: (v: string) => {
        about = v as typeof about;
        show();
      },
    };
    const titles = { move: "Move", rotate: "Rotate", scale: "Scale" };
    const kp = openKeypad({
      title: titles[kind],
      subtitle: `${ids.length} item${ids.length > 1 ? "s" : ""}${kind === "move" ? " · or slide a finger on the view" : ""}`,
      label: kind === "move" ? "Along X" : kind === "rotate" ? "Angle (counter-clockwise)" : "Factor",
      unit: kind === "move" ? "mm" : kind === "rotate" ? "°" : "×",
      value: kind === "move" ? 0 : kind === "rotate" ? val.deg : val.factor,
      confirmLabel: titles[kind],
      scope: this.hooks.scope(),
      segments:
        kind === "move"
          ? [
              {
                options: [
                  { value: "dx", label: "Along X" },
                  { value: "dy", label: "Along Y" },
                ],
                get: () => field,
                set: (v: string) => {
                  field = v as typeof field;
                  kp.setLabel(field === "dx" ? "Along X" : "Along Y", "mm");
                  kp.set(val[field]);
                },
              },
            ]
          : [aboutSeg],
      onInput: (x) => {
        if (kind === "move") {
          val[field] = x;
          if (this.slide) this.slide.onEnd();
        }
        else if (kind === "rotate") val.deg = x;
        else if (x > 0) val.factor = x;
        show();
      },
    });
    show();
    if (kind === "move") {
      // Sliding a finger anywhere moves the piece too; the keypad shows the offset reached.
      let start = { dx: 0, dy: 0 };
      this.slide = {
        from: null,
        onDrag: (ddx, ddy) => {
          if (!this.slide?.from) return;
          // Clean values, like drawn points: a tenth of the grid step.
          const q = gridStep(this.vp.viewHeight) / 10;
          const snap = (x: number) => Math.round(Math.round(x / q) * q * 1e6) / 1e6;
          val.dx = snap(start.dx + ddx);
          val.dy = snap(start.dy + ddy);
          kp.set(val[field]);
          show();
        },
        // The next slide (or typed value) starts from where this one ended.
        onEnd: () => (start = { dx: val.dx, dy: val.dy }),
      };
    }
    const res = await kp.result;
    this.slide = null;
    if (res !== null) {
      if (kind === "move") val[field] = res.value;
      else if (kind === "rotate") val.deg = res.value;
      else if (res.value > 0) val.factor = res.value;
    }
    const r = res === null ? null : this.applyGroup(base, ids, make());
    if (!r?.ok) {
      this.sk.entities = base.entities;
      this.sk.constraints = base.constraints;
      this.solve();
      if (r) this.hooks.toast(r.error ?? "Cannot move it there: constraints link it to the rest of the sketch");
    } else {
      this.hooks.commit(titles[kind]);
      if (r.dropped) this.hooks.toast(`${r.dropped} horizontal/vertical constraint${r.dropped > 1 ? "s" : ""} dropped by the turn`);
    }
    this.render();
    this.hooks.changed();
  }

  selectAll() {
    this.lastTapped = null;
    for (const e of this.sk.entities) if (!isReference(e) && !(e.type === "point" && isHiddenPoint(e.id))) this.selection.add(e.id);
    this.render();
    this.hooks.changed();
  }

  /** Solves after an edit; keeps it as an undo step, or puts the sketch back with a message. */
  private checkOrRevert(backup: SketchFeature, label: string, failure: string) {
    const r = this.solve();
    if (!r.ok || r.conflicting.length) {
      this.sk.entities = backup.entities;
      this.sk.constraints = backup.constraints;
      this.solve();
      this.hooks.toast(failure);
    } else {
      for (const id of [...this.selection]) if (!this.view.get(id) && !this.sk.constraints.some((c) => c.id === id)) this.selection.delete(id);
      this.hooks.commit(label);
    }
    this.render();
    this.hooks.changed();
  }

  private mirror(ids: string[], axis: string) {
    const backup = structuredClone(this.sk);
    mirrorEntities(this.sk, ids, axis);
    this.selection.clear();
    this.checkOrRevert(backup, "Mirror", "Cannot mirror: the copy conflicts with the existing constraints");
  }

  /** Close enough on screen to count as tapping the same place. */
  private near(a: P2, b: P2) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]) < 20 * this.vp.wpp;
  }

  /** Spline: each tap adds a point; tapping the last point again ends it, tapping the first closes it. */
  private placeSpline(s: Snap) {
    const n = this.anchors.length;
    if (n >= 3 && this.near(this.anchorXY(this.anchors[0]), s.at)) return this.finishSpline(true);
    if (n && this.near(this.anchorXY(this.anchors[n - 1]), s.at)) {
      if (n >= 2) this.finishSpline(false);
      return;
    }
    this.anchors.push(s);
    // The panel offers "Finish spline" from the second point on.
    if (this.anchors.length === 2) this.hooks.changed();
  }

  private finishSpline(closed: boolean) {
    const ids = this.anchors.map((a) => this.realize(a)).filter((id, i, a) => i === 0 || id !== a[i - 1]);
    // Ending on the first point closes the spline too.
    if (ids.length > 3 && ids[0] === ids[ids.length - 1]) {
      ids.pop();
      closed = true;
    }
    this.anchors = [];
    if (ids.length < (closed ? 3 : 2)) {
      this.render();
      return;
    }
    this.addCurve({ id: uid(), type: "spline", pts: ids, closed });
    this.afterEdit("Spline");
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

  /** The curve under the pointer (reference axes excluded) and its trim plan. */
  private trimAt(p: Ptr): { curve: SkCurve; plan: TrimPlan | null } | null {
    const v = this.view;
    const s = this.toSketch(p);
    const R = hitRadius(p.kind);
    let best: { curve: SkCurve; at: P2; d: number } | null = null;
    for (const c of v.curves()) {
      if (c.type === "line" && c.axis) continue;
      const proj = this.project(c, s, v);
      if (!proj) continue;
      const [sx, sy] = this.toScreen(proj);
      const d = Math.hypot(sx - p.x, sy - p.y);
      if (d < R && (!best || d < best.d)) best = { curve: c, at: proj, d };
    }
    return best && { curve: best.curve, plan: trimPlan(this.sk, best.curve.id, best.at) };
  }

  private edgeUnder(p: Ptr) {
    return this.vp.pickEdge(p.x, p.y, p.kind === "touch" ? 24 : p.kind === "pen" ? 14 : 9);
  }

  private showEdgeUnder(p: Ptr) {
    const i = this.edgeUnder(p);
    this.vp.highlightEdges(i === null ? [] : [i]);
  }

  /** "Use edges": adds the tapped model edge to the sketch, projected onto its plane. */
  private useEdge(p: Ptr) {
    const i = this.edgeUnder(p);
    this.vp.highlightEdges([]);
    if (i === null) return this.hooks.toast("Tap an edge of the model");
    const backup = structuredClone(this.sk);
    const err = projectEdge(this.sk, this.vp.edgePolyline(i));
    if (err) return this.hooks.toast(err);
    this.checkOrRevert(backup, "Use edge", "This edge conflicts with the sketch's constraints");
  }

  private trim(p: Ptr) {
    const hit = this.trimAt(p);
    this.trimPreview = null;
    if (!hit) return this.render();
    if (!hit.plan) {
      this.hooks.toast("Splines cannot be trimmed yet: delete their points instead");
      return this.render();
    }
    const backup = structuredClone(this.sk);
    hit.plan.apply(this.sk);
    const r = this.solve();
    if (!r.ok || r.conflicting.length) {
      this.sk.entities = backup.entities;
      this.sk.constraints = backup.constraints;
      this.solve();
      this.hooks.toast("Cannot trim here: the constraints would conflict");
      return this.render();
    }
    for (const id of [...this.selection]) if (!this.view.get(id) && !this.sk.constraints.some((c) => c.id === id)) this.selection.delete(id);
    this.hooks.commit("Trim");
    this.render();
    this.hooks.changed();
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
    else {
      this.selection.add(id);
      this.lastTapped = id;
    }
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
    // Grabbing one of several selected items moves them all, as one piece.
    const chosen = [...this.selection].filter((id) => v.get(id));
    if (chosen.length > 1 && this.selection.has(e.id)) {
      this.dragState = {
        ids: [],
        starts: new Map(),
        from,
        group: { base: { entities: structuredClone(this.sk.entities), constraints: structuredClone(this.sk.constraints) }, ids: chosen },
      };
      return;
    }
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
    if (d.group) {
      const r = this.applyGroup(d.group.base, d.group.ids, { kind: "move", dx: at[0] - d.from[0], dy: at[1] - d.from[1] });
      if (!r.ok) {
        // Held by the rest of the sketch: it stays where it was.
        this.sk.entities = structuredClone(d.group.base.entities);
        this.sk.constraints = structuredClone(d.group.base.constraints);
        this.solve();
      }
      this.render();
      return;
    }
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
    this.lastTapped = null;
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
    // A spline can carry on smoothly from a line or an arc ending where it starts or ends.
    const S = ents.filter((e): e is SkCurve & { type: "spline" } => e.type === "spline");
    if (n === 2 && S.length === 1 && !S[0].closed) {
      const other = ents.find((e) => e !== S[0])!;
      const ends = [S[0].pts[0], S[0].pts[S[0].pts.length - 1]];
      const joined = ends.some((p) => v.directionInto(other, p));
      const already = this.sk.constraints.some((c) => c.type === "tangent" && c.refs.includes(S[0].id) && c.refs.includes(other.id));
      if (joined && !already) con("tan", "T", "Tangent", "tangent", [S[0].id, other.id], "T");
    }
    // The mirror line: a selected axis or construction line, else the line tapped last (a box
    // or Select all picks no line in particular).
    const lineOf = (id: string | null) => (id && this.selection.has(id) && v.get(id)?.type === "line" ? id : null);
    const axis =
      ents.find((e): e is SkLine => e.type === "line" && (!!e.axis || !!e.construction) && ents.length > 1)?.id ?? (ents.length > 1 ? lineOf(this.lastTapped) : null);
    if (axis && ents.some((e) => e.id !== axis && !isReference(e)))
      out.push({ id: "mirror", label: "⇋", title: "Mirror about line", key: "I", run: () => this.mirror(sel, axis) });
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
    if (editable.length) {
      out.push({ id: "move", label: "✥", title: "Move", run: () => void this.transformSelection("move") });
      out.push({ id: "rotate", label: "⟲", title: "Rotate", run: () => void this.transformSelection("rotate") });
      out.push({ id: "scale", label: "⤢", title: "Scale", run: () => void this.transformSelection("scale") });
    }
    const all = this.sk.entities.filter((e) => !isReference(e) && !(e.type === "point" && isHiddenPoint(e.id)));
    if (all.length && all.some((e) => !this.selection.has(e.id))) out.push({ id: "selall", label: "▣", title: "Select all", run: () => this.selectAll() });
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
    const res = await keypad({
      title: titles[type] ?? "Value",
      subtitle: this.sk.name,
      value: Math.abs(current),
      unit: type === "angle" ? "°" : "mm",
      scope: this.hooks.scope(),
    });
    if (res === null) return;
    const value = res.value;
    if (type !== "angle" && value <= 0) return this.hooks.toast("The value must be positive");
    const signed = type === "angle" && current < 0 ? -Math.abs(value) : value;
    this.constrainWith({ id: uid(), type, refs: r, value: signed, expr: res.expr }, titles[type] ?? "Dimension");
  }

  async editDimension(c: SkConstraint) {
    const old = c.value ?? 0;
    const oldExpr = c.expr;
    const res = await keypad({
      title: "Edit dimension",
      subtitle: this.sk.name,
      value: Math.abs(old),
      expr: c.expr,
      unit: c.type === "angle" ? "°" : "mm",
      scope: this.hooks.scope(),
    });
    if (res === null || (res.value === Math.abs(old) && res.expr === oldExpr)) return;
    const value = res.value;
    if (c.type !== "angle" && value <= 0) return this.hooks.toast("The value must be positive");
    c.value = old < 0 ? -Math.abs(value) : value;
    c.expr = res.expr;
    const r = this.solve();
    if (!r.ok || r.conflicting.length) {
      c.value = old;
      c.expr = oldExpr;
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
    const COLORS = palette();
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
      else if (c.type === "spline" || c.type === "bezier") poly(b, sampleCurve(v, c), col);
      else {
        const [a0, a1] = v.arcAngles(c);
        poly(b, circlePts(v.xy(c.c), v.arcRadius(c), a0, a1), col);
      }
    }
    const sharpMarks: LineBatch = { positions: [], colors: [], width: 1.5, overlay: true };
    // A fillet's virtual corner: a small cross where the lines would meet, with their extensions.
    for (const p of v.points()) {
      if (!p.sharp || this.selection.has(p.id) || this.hoverId === p.id) continue;
      const at: P2 = [p.x, p.y];
      const r = this.vp.wpp * 5;
      seg(sharpMarks, [p.x - r, p.y - r], [p.x + r, p.y + r], COLORS.construction);
      seg(sharpMarks, [p.x - r, p.y + r], [p.x + r, p.y - r], COLORS.construction);
      for (const c of this.sk.constraints) {
        if (c.type !== "pointOn" || c.refs[0] !== p.id) continue;
        const l = v.get(c.refs[1]);
        if (l?.type !== "line") continue;
        const [a, b] = [v.xy(l.p1), v.xy(l.p2)];
        const near = Math.hypot(a[0] - at[0], a[1] - at[1]) < Math.hypot(b[0] - at[0], b[1] - at[1]) ? a : b;
        seg(constr, near, at, COLORS.construction);
      }
    }
    const hidden = this.hiddenControls(v);
    for (const c of v.curves()) {
      if (c.type !== "bezier" || hidden.has(c.c1)) continue;
      seg(constr, v.xy(c.p0), v.xy(c.c1), COLORS.construction);
      seg(constr, v.xy(c.p3), v.xy(c.c2), COLORS.construction);
    }
    for (const p of v.points()) {
      // Virtual corners are drawn above; as a dot only when selected or under the pointer.
      if (p.sharp && !this.selection.has(p.id) && this.hoverId !== p.id) continue;
      if (hidden.has(p.id)) continue;
      const col = p.id === ORIGIN && !this.selection.has(p.id) ? COLORS.origin : colorOf(p.id, base);
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
        if (this.tool === "spline") {
          const ps = this.anchors.map((a) => this.anchorXY(a));
          const closing = ps.length >= 3 && this.near(ps[0], cur.at);
          if (!closing && !this.near(ps[ps.length - 1], cur.at)) ps.push(cur.at);
          for (const sp of splineSpans(ps, closing)) poly(preview, sampleBezier(sp, 16), col);
        }
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

    const trim: LineBatch = { positions: [], colors: [], width: 5, overlay: true };
    if (this.trimPreview) poly(trim, this.trimPreview.removed, COLORS.trim);

    this.vp.setSketchLayer([axes, constr, sharpMarks, lines, preview, trim], [pts, big]);

    // Closed regions, filled faintly: what an extrusion will use.
    const regions = findRegions(this.sk).map((r) => ({
      outer: loopPoly(r.outer),
      holes: r.holes.map(loopPoly),
    }));
    this.vp.setFills(this.sk.plane, regions, cssVar("--sk-fill", "#4cc3ff"));
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
      if (e.type === "spline" || e.type === "bezier") {
        const ps = sampleCurve(v, e);
        return ps[Math.floor(ps.length / 2)];
      }
      return arcMid(v, e);
    };
    const isSharp = (id: string) => (v.get(id) as SkPoint | undefined)?.sharp === true;
    for (const c of this.sk.constraints) {
      const isDim = DIMENSION_TYPES.includes(c.type);
      // A fillet's virtual corner stays on both lines by itself: no glyphs unless it is selected.
      if (c.type === "pointOn" && isSharp(c.refs[0]) && !this.selection.has(c.refs[0]) && !this.selection.has(c.id)) continue;
      if (c.quiet && !c.refs.some((r) => this.selection.has(r)) && !this.selection.has(c.id)) continue;
      /** Screen push for a radius label: outwards along the radius, off the curve. */
      let out: [number, number] | null = null;
      let at: P2 | null = null;
      if (isDim) {
        const [a, b] = c.refs.map((r) => v.get(r));
        if (c.type === "distance" && a?.type === "line" && !b) at = mid(v.xy(a.p1), v.xy(a.p2));
        else if (c.type === "angle" && a?.type === "line" && b?.type === "line")
          at = mid(mid(v.xy(a.p1), v.xy(a.p2)), mid(v.xy(b.p1), v.xy(b.p2)));
        else if ((c.type === "radius" || c.type === "diameter") && (a?.type === "circle" || a?.type === "arc")) {
          const ctr = v.xy(a.c);
          at = a.type === "circle" ? [ctr[0] + a.r * 0.7071, ctr[1] + a.r * 0.7071] : arcMid(v, a);
          const [cx, cy] = this.toScreen(ctr);
          const [mx, my] = this.toScreen(at);
          const len = Math.hypot(mx - cx, my - cy);
          out = len > 1e-6 ? [(mx - cx) / len, (my - cy) / len] : [0.7071, -0.7071];
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
      el.textContent = isDim ? dimText(c) : constraintLabel(c);
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
      if (out) {
        // Far enough that even a small fillet stays visible under its label.
        dx = out[0] * 34;
        dy = out[1] * 26;
      } else if (!isDim) {
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

/** A dimension's label: its value, prefixed by its expression when it uses parameters. */
function dimText(c: SkConstraint) {
  const v = c.type === "angle" ? fmt(Math.abs(c.value ?? 0)) + "°" : constraintLabel(c);
  if (!c.expr) return v;
  const e = c.expr.length > 16 ? c.expr.slice(0, 15) + "…" : c.expr;
  return `${e} = ${v}`;
}

function closestOnPolyline(ps: P2[], s: P2): P2 | null {
  let best: P2 | null = null;
  let bestD = Infinity;
  for (let i = 0; i + 1 < ps.length; i++) {
    const [a, b] = [ps[i], ps[i + 1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((s[0] - a[0]) * dx + (s[1] - a[1]) * dy) / L2));
    const p: P2 = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(p[0] - s[0], p[1] - s[1]);
    if (d < bestD) [best, bestD] = [p, d];
  }
  return best;
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

