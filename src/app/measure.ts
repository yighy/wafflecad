// Measure: tap faces, edges or corners (one or two), and the worker says lengths, distances, angles.
import * as THREE from "three";
import type { MeasurePick, MeasureResult, MeasureRow } from "../types";
import type { Ptr } from "../view/input";
import { app } from "./app";
import { fmtNum } from "./util";

/** Measuring: what was tapped (one or two things) and what the worker found. */
export let measuring: { picks: MeasurePick[]; result: MeasureResult | null } | null = null;
export let measureReq = 0;

export function toggleMeasure() {
  if (measuring) return endMeasure();
  app.clearPartFocus();
  measuring = { picks: [], result: null };
  app.renderAll();
}

export function endMeasure() {
  measuring = null;
  app.vp.highlightFaces([]);
  app.vp.highlightEdges([]);
  app.renderAll();
}

/** What is under the finger: a corner (the end of an edge, close on screen), else an edge, else a face. */
function measurePickAt(p: Ptr): MeasurePick | null {
  const edge = app.vp.pickEdge(p.x, p.y, 14);
  if (edge != null) {
    const line = app.vp.edgePolyline(edge);
    const ends = [line[0], line[line.length - 1]];
    const closed = Math.hypot(ends[0][0] - ends[1][0], ends[0][1] - ends[1][1], ends[0][2] - ends[1][2]) < 1e-6;
    if (!closed)
      for (const end of ends) {
        const [sx, sy] = app.vp.toScreen(new THREE.Vector3(...end));
        if (Math.hypot(sx - p.x, sy - p.y) < 18) return { kind: "point", p: end };
      }
    return { kind: "edge", id: app.vp.edgeId(edge) };
  }
  const face = app.vp.pickFace(p.x, p.y);
  return face == null ? null : { kind: "face", id: face };
}

/** A third tap starts again; a tap on nothing clears. */
export function measureTap(p: Ptr) {
  if (!measuring) return;
  const pick = measurePickAt(p);
  measuring.picks = !pick ? [] : measuring.picks.length >= 2 ? [pick] : [...measuring.picks, pick];
  measuring.result = null;
  showMeasurePicks();
  if (measuring.picks.length) {
    measureReq = app.nextReq();
    app.post({ type: "measure", reqId: measureReq, doc: app.doc(), picks: measuring.picks });
  }
  app.renderPanel();
  app.renderPartOverlays();
}

export function showMeasurePicks() {
  const picks = measuring?.picks ?? [];
  app.vp.highlightFaces(picks.flatMap((k) => (k.kind === "face" ? [k.id] : [])));
  app.vp.highlightEdges(picks.flatMap((k) => (k.kind === "edge" ? [app.vp.edgeIndexOf(k.id) ?? -1] : [])));
}

export function measureValue(r: MeasureRow) {
  return `${fmtNum(r.value)}${r.unit === "°" ? "°" : " " + r.unit}`;
}

export function renderMeasurePanel(el: HTMLElement) {
  if (!measuring) return;
  const n = measuring.picks.length;
  const rows = measuring.result?.rows ?? [];
  const box = document.createElement("div");
  box.className = "p-measure";
  for (const r of rows) {
    const row = document.createElement("div");
    row.innerHTML = "<span></span><b></b>";
    row.querySelector("span")!.textContent = r.label;
    row.querySelector("b")!.textContent = measureValue(r);
    box.appendChild(row);
  }
  if (rows.length) el.appendChild(box);
  const hint = document.createElement("p");
  hint.className = "p-hint";
  hint.textContent =
    measuring.result?.error ??
    (n === 0
      ? "Tap a face, an edge or a corner."
      : n === 1
        ? "Tap a second one to measure between them."
        : "Tap again to start a new measure.");
  if (n && !measuring.result) hint.textContent = "Measuring…";
  el.appendChild(hint);
}
