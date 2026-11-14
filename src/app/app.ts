// What modules split out of main.ts reach of the app: the viewport, the open document, the last
// build, and a few calls back. Filled once by main.ts, right after the viewport and worker exist;
// modules only use it from code that runs later (taps, renders), never at load.
import type { BuildResult, CadDocument, WorkerRequest } from "../types";
import type { Viewport } from "../view/viewport";

export interface AppCtx {
  vp: Viewport;
  doc(): CadDocument;
  lastBuild(): BuildResult | null;
  renderAll(): void;
  renderPanel(): void;
  renderPartOverlays(): void;
  /** A fresh request id for the worker. */
  nextReq(): number;
  post(msg: WorkerRequest): void;
  /** Nothing selected or pending in the part (a tool that takes over the taps is starting). */
  clearPartFocus(): void;
}

export const app = {} as AppCtx;
export function registerApp(c: AppCtx) {
  Object.assign(app, c);
}
