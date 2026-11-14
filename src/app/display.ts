// The display menu (how the solid is drawn, a section through it) and the overlays drawn over the model.
import { $ } from "./util";
import * as THREE from "three";
import { M, vp } from "../main";
import { isAssembly } from "./assemblies";
import { mateMarks } from "./mates";
import { anyBodyHidden, toggleBody } from "./bodies";
import { holeDimLabels, holeSel } from "./holes";
import { measureValue, measuring } from "./measure";
import { prefs, savePrefs } from "./prefs";
import { S, usedSketchIds } from "./state";
import { sketchHolePoints } from "../cad/holes";
import { SketchView, sampleCurve, sketchLineWorld } from "../sketch/model";
import { type SketchFeature } from "../types";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { cssVar, type DisplayMode, type LineBatch } from "../view/viewport";

export let displayMenuOpen = false;

export const DISPLAY_MODES: [DisplayMode, string][] = [
  ["shaded-edges", "Shaded with edges"],
  ["shaded", "Shaded"],
  ["wireframe", "Wireframe"],
  ["xray", "X-ray"],
  ["technical", "Technical lines"],
];

/**
 * The menu is built once when it opens and then updated in place, so its changes can animate:
 * it scales in from the button and fades out, a pill slides to the chosen mode, and the section
 * slider unfolds.
 */
export function renderDisplayMenu() {
  let el = document.getElementById("display-menu");
  if (!displayMenuOpen) {
    if (el && !el.classList.contains("closing")) {
      const gone = el;
      gone.classList.add("closing");
      const remove = () => gone.remove();
      gone.addEventListener("animationend", remove, { once: true });
      setTimeout(remove, 250); // no animation (reduced motion): remove anyway
    }
    renderViewButtons();
    return;
  }
  if (!el || el.classList.contains("closing")) {
    el?.remove();
    el = buildDisplayMenu();
  }
  syncDisplayMenu(el);
  renderViewButtons();
}

export function buildDisplayMenu() {
  const el = document.createElement("div");
  el.id = "display-menu";
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  const title = (text: string) => {
    const t = document.createElement("div");
    t.className = "dm-title";
    t.textContent = text;
    return t;
  };
  el.appendChild(title("Display"));
  const modes = document.createElement("div");
  modes.className = "dm-modes";
  const pill = document.createElement("div");
  pill.className = "dm-pill";
  modes.appendChild(pill);
  for (const [m, label] of DISPLAY_MODES) {
    const b = document.createElement("button");
    b.className = "dm-mode";
    b.dataset.mode = m;
    b.textContent = label;
    b.onclick = () => {
      vp.setDisplayMode(m);
      prefs.display = m;
      savePrefs();
      if (S.mode.kind === "sketch") vp.setModelOpacity(0.45);
      renderDisplayMenu();
    };
    modes.appendChild(b);
  }
  el.appendChild(modes);
  el.appendChild(title("Section"));
  const seg = document.createElement("div");
  seg.className = "seg";
  for (const a of ["off", "X", "Y", "Z"] as const) {
    const b = document.createElement("button");
    b.dataset.axis = a;
    b.textContent = a === "off" ? "Off" : a;
    b.onclick = () => {
      const cur = vp.section;
      vp.setSection(a === "off" ? null : { axis: a, at: cur?.at ?? 0.5 });
      renderDisplayMenu();
    };
    seg.appendChild(b);
  }
  el.appendChild(seg);
  // Slide the cutting plane through the model; folded away while there is no section.
  const wrap = document.createElement("div");
  wrap.className = "dm-range-wrap";
  const inner = document.createElement("div");
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = "100";
  range.className = "dm-range";
  range.setAttribute("aria-label", "Section position");
  range.oninput = () => {
    const cur = vp.section;
    if (cur) vp.setSection({ axis: cur.axis, at: Number(range.value) / 100 });
  };
  inner.appendChild(range);
  wrap.appendChild(inner);
  el.appendChild(wrap);
  // The part's bodies, each shown or hidden with a tap (filled in by syncDisplayMenu).
  const bodies = document.createElement("div");
  bodies.className = "dm-bodies";
  el.appendChild(bodies);
  document.body.appendChild(el);
  return el;
}

export function syncBodyList(el: HTMLElement) {
  const list = S.lastBuild?.bodies ?? [];
  el.replaceChildren();
  if (list.length < 2) return;
  const t = document.createElement("div");
  t.className = "dm-title";
  t.textContent = isAssembly() ? "Parts" : "Bodies";
  el.appendChild(t);
  for (const b of list) {
    const btn = document.createElement("button");
    const shown = !M.hiddenBodies.has(b.id);
    btn.className = "dm-mode dm-body" + (shown ? " on" : "");
    btn.innerHTML = icon(shown ? "eye" : "eyeOff", 20);
    btn.append(b.name);
    btn.title = shown ? "Hide this body" : "Show this body";
    btn.onclick = () => toggleBody(b.id);
    el.appendChild(btn);
  }
}

export function syncDisplayMenu(el: HTMLElement) {
  let active: HTMLElement | null = null;
  for (const b of el.querySelectorAll<HTMLElement>(".dm-mode")) {
    const on = b.dataset.mode === vp.displayMode;
    b.classList.toggle("on", on);
    if (on) active = b;
  }
  const pill = el.querySelector<HTMLElement>(".dm-pill")!;
  if (active) {
    pill.style.transform = `translateY(${active.offsetTop}px)`;
    pill.style.height = `${active.offsetHeight}px`;
  }
  const cur = vp.section;
  for (const b of el.querySelectorAll<HTMLElement>(".seg button")) b.classList.toggle("on", b.dataset.axis === "off" ? !cur : cur?.axis === b.dataset.axis);
  el.querySelector(".dm-range-wrap")!.classList.toggle("shown", !!cur);
  const range = el.querySelector<HTMLInputElement>(".dm-range")!;
  if (cur) range.value = String(Math.round(cur.at * 100));
  syncBodyList(el.querySelector(".dm-bodies")!);
}

// A tap elsewhere closes the display menu.
document.addEventListener("pointerdown", (e) => {
  if (!displayMenuOpen) return;
  const t = e.target as HTMLElement;
  if (t.closest("#display-menu") || t.closest("#view-buttons")) return;
  displayMenuOpen = false;
  renderDisplayMenu();
});

export function renderViewButtons() {
  const el = $("#view-buttons");
  el.replaceChildren();
  const add = (ic: string, title: string, run: () => void, on = false) => {
    const b = document.createElement("button");
    b.innerHTML = icon(ic, 22);
    b.title = title;
    b.setAttribute("aria-label", title);
    if (on) b.classList.add("on");
    b.onclick = run;
    el.appendChild(b);
  };
  add("fit", "Fit (F)", () => vp.fit());
  // Sketches are always shown without perspective, so the toggle is only offered outside them.
  if (S.mode.kind !== "sketch")
    add("perspective", vp.perspective ? "Perspective (tap for orthographic)" : "Orthographic (tap for perspective)", () => {
      vp.perspective = prefs.perspective = !vp.perspective;
      savePrefs();
      renderViewButtons();
    }, vp.perspective);
  add("display", "Display: shading, wireframe, X-ray, section", () => {
    displayMenuOpen = !displayMenuOpen;
    renderDisplayMenu();
  }, displayMenuOpen || vp.displayMode !== "shaded-edges" || !!vp.section || anyBodyHidden());
  add("grid", "Grid", () => {
    vp.setGridVisible(!vp.isGridVisible);
    renderViewButtons();
  }, vp.isGridVisible);
  if (S.mode.kind === "sketch") {
    const ed = S.mode.editor;
    const plane = ed.sk.plane;
    add("lookAt", "Look at sketch", () => vp.viewNormalTo(plane));
    // Constraint symbols: all, those of the selection, or none (a crowded sketch stays readable).
    const next = { all: "selection", selection: "none", none: "all" } as const;
    const said = { all: "all constraint symbols", selection: "the selection's constraint symbols", none: "no constraint symbols" };
    add("glyphs", `Showing ${said[ed.glyphs]} (tap: ${said[next[ed.glyphs]]})`, () => {
      ed.glyphs = prefs.glyphs = next[ed.glyphs];
      savePrefs();
      ed.render();
      renderViewButtons();
      toast(`Showing ${said[ed.glyphs]}`);
    }, ed.glyphs !== "all");
  }
}

/** Sketches not consumed by a feature stay visible in the part view. */
export function renderPartOverlays() {
  if (S.mode.kind === "sketch") return;
  const used = new Set(S.doc.features.flatMap(usedSketchIds));
  const sel = S.doc.features.find((f) => f.id === S.selectedFeature);
  const highlight = new Set(sel?.kind === "sketch" ? [sel.id] : sel ? usedSketchIds(sel) : []);
  const batch: LineBatch = { positions: [], colors: [], width: 2, overlay: true };
  const hi = rgb("--sk-selected");
  const normal = rgb("--sk-line");
  for (const f of S.doc.features) {
    if (f.kind !== "sketch") continue;
    if (used.has(f.id) && !highlight.has(f.id)) continue;
    appendSketchLines(batch, f, highlight.has(f.id) ? hi : normal);
  }
  if (S.mode.kind === "revolve") {
    const f = S.mode.feat;
    const sk = S.doc.features.find((x): x is SketchFeature => x.id === f.sketchId && x.kind === "sketch");
    if (sk) {
      const muted = rgb("--sk-construction");
      for (const e of sk.entities) {
        if (e.type !== "line" || !e.construction || e.axis) continue;
        const [a, b] = sketchLineWorld(sk, e.id);
        batch.positions.push(...a, ...b);
        batch.colors.push(...muted, ...muted);
      }
      try {
        // The axis, drawn long in the accent colour.
        const [a, b] = sketchLineWorld(sk, f.axisLine);
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const len = Math.hypot(d[0], d[1], d[2]) || 1;
        const L = vp.viewHeight * 2;
        const acc = rgb("--accent");
        batch.positions.push(...[0, 1, 2].map((i) => a[i] - (d[i] / len) * L), ...[0, 1, 2].map((i) => a[i] + (d[i] / len) * L));
        batch.colors.push(...acc, ...acc);
      } catch {
        // Missing axis line: the build reports it.
      }
    }
  }
  const marks = { positions: [] as number[], colors: [] as number[], size: 14 };
  let labels: { el: HTMLElement; at: THREE.Vector3; dx?: number; dy?: number }[] = [];
  if (S.mode.kind === "hole") {
    const f = S.mode.feat;
    const sk = f.sketchId ? S.doc.features.find((x): x is SketchFeature => x.id === f.sketchId && x.kind === "sketch") : undefined;
    const acc = rgb("--accent");
    const sel = rgb("--sk-selected");
    (sk ? sketchHolePoints(sk) : f.points ?? []).forEach((q, i) => {
      marks.positions.push(...q);
      marks.colors.push(...(!sk && i === holeSel ? sel : acc));
    });
    labels = holeDimLabels(f, batch);
  }
  if (measuring && S.mode.kind === "part") {
    const acc = rgb("--accent");
    for (const k of measuring.picks)
      if (k.kind === "point") {
        marks.positions.push(...k.p);
        marks.colors.push(...acc);
      }
    const line = measuring.result?.line;
    const main = measuring.result?.rows.find((r) => r.unit === "mm" && /distance/i.test(r.label));
    if (line && main && main.value > 1e-6) {
      batch.positions.push(...line[0], ...line[1]);
      batch.colors.push(...acc, ...acc);
      const tag = document.createElement("div");
      tag.className = "sk-label dim";
      tag.textContent = measureValue(main);
      labels.push({ el: tag, at: new THREE.Vector3((line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2, (line[0][2] + line[1][2]) / 2) });
    }
  }
  if (isAssembly()) mateMarks(batch);
  vp.setSketchLayer([batch], [marks]);
  vp.setLabels(labels);
}

export function rgb(name: string) {
  const c = new THREE.Color(cssVar(name, "#888888"));
  return [c.r, c.g, c.b];
}

export function appendSketchLines(b: LineBatch, sk: SketchFeature, col: number[]) {
  const v = new SketchView(sk);
  const { origin, xDir, normal } = sk.plane;
  const yDir = [normal[1] * xDir[2] - normal[2] * xDir[1], normal[2] * xDir[0] - normal[0] * xDir[2], normal[0] * xDir[1] - normal[1] * xDir[0]];
  const w = ([x, y]: [number, number]) => [0, 1, 2].map((i) => origin[i] + xDir[i] * x + yDir[i] * y);
  const seg = (p: [number, number], q: [number, number]) => {
    b.positions.push(...w(p), ...w(q));
    b.colors.push(...col, ...col);
  };
  const arc = (c: [number, number], r: number, a0: number, a1: number) => {
    const n = Math.max(12, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 72));
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      seg([c[0] + r * Math.cos(t0), c[1] + r * Math.sin(t0)], [c[0] + r * Math.cos(t1), c[1] + r * Math.sin(t1)]);
    }
  };
  for (const c of v.curves()) {
    if (c.construction) continue;
    if (c.type === "line") seg(v.xy(c.p1), v.xy(c.p2));
    else if (c.type === "circle") arc(v.xy(c.c), c.r, 0, 2 * Math.PI);
    else if (c.type === "spline" || c.type === "bezier" || c.type === "ellipse") {
      const ps = sampleCurve(v, c);
      for (let i = 0; i + 1 < ps.length; i++) seg(ps[i], ps[i + 1]);
    } else arc(v.xy(c.c), v.arcRadius(c), ...v.arcAngles(c));
  }
}
