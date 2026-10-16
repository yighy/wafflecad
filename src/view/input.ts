// Pointer routing. One finger, the stylus and the left mouse button drive the active tool;
// two fingers drive the camera; mouse right/middle buttons and the wheel do the same.
import type { Viewport } from "./viewport";

export interface Ptr {
  x: number;
  y: number;
  kind: "touch" | "pen" | "mouse";
  shift: boolean;
  ctrl: boolean;
}

export interface PointerTool {
  down(p: Ptr): void;
  move(p: Ptr): void;
  up(p: Ptr): void;
  /** The gesture became a camera gesture: forget the pending action. */
  cancel(): void;
  /** Stylus or mouse moving without contact. */
  hover?(p: Ptr | null): void;
}

export interface InputOptions {
  /** In 2D mode a two-finger drag pans instead of orbiting. */
  is2D: () => boolean;
  tool: () => PointerTool | null;
  onUndo: () => void;
  onRedo: () => void;
}

interface Track {
  id: number;
  x: number;
  y: number;
  x0: number;
  y0: number;
}

const TAP_MOVE = 10;
const TAP_TIME = 300;
const CLASSIFY = 12;

export class InputRouter {
  private touches = new Map<number, Track>();
  /** Pointer currently driving the tool (finger, pen or left mouse). */
  private toolPtr: number | null = null;
  private penActive = false;
  private gesture: {
    mode: "undecided" | "pinch" | "drag" | "dead";
    t0: number;
    maxFingers: number;
    moved: boolean;
    dist0: number;
    mid0: [number, number];
    lastDist: number;
    lastMid: [number, number];
  } | null = null;
  private mouseCam: { button: number; x: number; y: number; pan: boolean } | null = null;

  constructor(
    private vp: Viewport,
    private el: HTMLElement,
    private opt: InputOptions,
  ) {
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => this.down(e));
    el.addEventListener("pointermove", (e) => this.move(e));
    el.addEventListener("pointerup", (e) => this.up(e, false));
    el.addEventListener("pointercancel", (e) => this.up(e, true));
    el.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "touch" && this.toolPtr === null) this.opt.tool()?.hover?.(null);
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const k = e.deltaMode === 1 ? 0.05 : 0.0015;
        this.vp.zoomAt(Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
  }

  private ptr(e: PointerEvent): Ptr {
    const r = this.el.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      kind: e.pointerType === "pen" ? "pen" : e.pointerType === "touch" ? "touch" : "mouse",
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
    };
  }

  private down(e: PointerEvent) {
    const p = this.ptr(e);
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointers cannot be captured; routing still works.
    }

    if (p.kind === "mouse") {
      if (e.button === 0 && !(e.altKey || this.mouseCam)) {
        this.toolPtr = e.pointerId;
        this.opt.tool()?.down(p);
      } else {
        // Right = orbit (pan in 2D), middle or shift+right = pan.
        const pan = e.button === 1 || e.shiftKey || this.opt.is2D();
        this.mouseCam = { button: e.button, x: p.x, y: p.y, pan };
      }
      return;
    }

    if (p.kind === "pen") {
      this.penActive = true;
      // A palm already on the screen must not keep a gesture going.
      this.touches.clear();
      this.gesture = null;
      this.toolPtr = e.pointerId;
      this.opt.tool()?.down(p);
      return;
    }

    // Touch. Ignored while the stylus is in contact (palm rejection).
    if (this.penActive) return;
    this.touches.set(e.pointerId, { id: e.pointerId, x: p.x, y: p.y, x0: p.x, y0: p.y });
    const n = this.touches.size;
    if (n === 1) {
      this.toolPtr = e.pointerId;
      this.opt.tool()?.down(p);
      return;
    }
    // Second (or third) finger: the tool action becomes a camera gesture.
    if (this.toolPtr !== null) {
      this.opt.tool()?.cancel();
      this.toolPtr = null;
    }
    if (!this.gesture) {
      const [a, b] = [...this.touches.values()];
      const mid = midpoint(a, b);
      const dist = distance(a, b);
      this.gesture = { mode: "undecided", t0: performance.now(), maxFingers: n, moved: false, dist0: dist, mid0: mid, lastDist: dist, lastMid: mid };
    } else {
      this.gesture.maxFingers = Math.max(this.gesture.maxFingers, n);
      if (n > 2) this.gesture.mode = "dead";
    }
  }

  private move(e: PointerEvent) {
    const p = this.ptr(e);

    if (p.kind === "mouse" && this.mouseCam) {
      const dx = p.x - this.mouseCam.x;
      const dy = p.y - this.mouseCam.y;
      this.mouseCam.x = p.x;
      this.mouseCam.y = p.y;
      if (this.mouseCam.pan) this.vp.pan(dx, dy);
      else this.vp.orbit(dx, dy);
      return;
    }

    if (p.kind !== "touch") {
      if (this.toolPtr === e.pointerId) this.opt.tool()?.move(p);
      else if (e.buttons === 0) this.opt.tool()?.hover?.(p);
      return;
    }

    const t = this.touches.get(e.pointerId);
    if (!t) return;
    t.x = p.x;
    t.y = p.y;
    if (Math.hypot(t.x - t.x0, t.y - t.y0) > TAP_MOVE && this.gesture) this.gesture.moved = true;

    if (this.toolPtr === e.pointerId) {
      this.opt.tool()?.move(p);
      return;
    }
    const g = this.gesture;
    if (!g || this.touches.size < 2 || g.mode === "dead") return;
    const [a, b] = [...this.touches.values()];
    const mid = midpoint(a, b);
    const dist = distance(a, b);

    if (g.mode === "undecided") {
      const dd = Math.abs(dist - g.dist0);
      const dm = Math.hypot(mid[0] - g.mid0[0], mid[1] - g.mid0[1]);
      if (dd < CLASSIFY && dm < CLASSIFY) return;
      // In 2D everything is pan + zoom. In 3D, fingers moving together orbit,
      // fingers spreading or closing zoom (and pan with their midpoint).
      g.mode = this.opt.is2D() || dd >= dm ? "pinch" : "drag";
      g.lastDist = dist;
      g.lastMid = mid;
      return;
    }
    if (g.mode === "pinch") {
      this.vp.pan(mid[0] - g.lastMid[0], mid[1] - g.lastMid[1]);
      if (g.lastDist > 0 && dist > 0) this.vp.zoomAt(dist / g.lastDist, mid[0], mid[1]);
    } else {
      this.vp.orbit(mid[0] - g.lastMid[0], mid[1] - g.lastMid[1]);
    }
    g.lastDist = dist;
    g.lastMid = mid;
  }

  private up(e: PointerEvent, cancelled: boolean) {
    const p = this.ptr(e);
    if (p.kind === "mouse" && this.mouseCam) {
      this.mouseCam = null;
      return;
    }
    if (p.kind === "pen") this.penActive = false;

    if (this.toolPtr === e.pointerId) {
      this.toolPtr = null;
      if (cancelled) this.opt.tool()?.cancel();
      else this.opt.tool()?.up(p);
    }
    if (p.kind !== "touch") return;

    this.touches.delete(e.pointerId);
    const g = this.gesture;
    if (g && this.touches.size === 0) {
      this.gesture = null;
      const quick = performance.now() - g.t0 < TAP_TIME && !g.moved && !cancelled;
      if (quick && g.maxFingers === 2) this.opt.onUndo();
      if (quick && g.maxFingers === 3) this.opt.onRedo();
    }
  }
}

const midpoint = (a: Track, b: Track): [number, number] => [(a.x + b.x) / 2, (a.y + b.y) / 2];
const distance = (a: Track, b: Track) => Math.hypot(a.x - b.x, a.y - b.y);
