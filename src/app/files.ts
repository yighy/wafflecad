// Importing STEP files, drawings (DXF / SVG) and text into the open project.
import * as THREE from "three";
import { M, commit, kernelReady, leaveModes, pendingSplits, renderAll, vp, worker } from "../main";
import { insertPart, isAssembly, partDocs, partNames, sendParts } from "./assemblies";
import { newGroup } from "./gallery";
import { S } from "./state";
import { emptyDoc } from "./util";
import { freeName, listProjects, newProjectId, putProject, type ProjectMeta } from "../projects";
import { parseDxf } from "../sketch/dxf";
import { FONTS, loadFont, type FontId } from "../sketch/fonts";
import { bounds, insertShapes, type ImportOptions, type ImportShape } from "../sketch/importShapes";
import { uid } from "../sketch/model";
import { parseSvg } from "../sketch/svg";
import { textShapes } from "../sketch/text";
import { type CadDocument, type PartInstance, type WorkerRequest } from "../types";
import { openKeypad } from "../ui/keypad";
import { toast } from "../ui/toast";
import { type Font } from "opentype.js";

/** Asks for one file; null when the picker is closed without a choice. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Brings a DXF or SVG drawing into the open sketch. The keypad sets the scale (millimetres per
 * drawing unit, read from the file when it says), with placement and fixed/free as choices;
 * the drawing is shown as it will land while these change.
 */
export async function importDrawing() {
  if (S.mode.kind !== "sketch") return;
  const ed = S.mode.editor;
  const file = await pickFile(".dxf,.svg,image/vnd.dxf,application/dxf,image/svg+xml");
  if (!file || S.mode.kind !== "sketch" || S.mode.editor !== ed) return;
  const text = await file.text();
  // By extension, else by content (an SVG is XML with an <svg> element).
  const isSvg = /\.svg$/i.test(file.name) || (!/\.dxf$/i.test(file.name) && /<svg[\s>]/i.test(text));
  const kind = isSvg ? "SVG" : "DXF";
  let res: ReturnType<typeof parseDxf>;
  try {
    res = isSvg ? parseSvg(text) : parseDxf(text);
  } catch (e) {
    return toast(`Cannot read this ${kind}: ` + (e instanceof Error ? e.message : String(e)));
  }
  const skipped = Object.entries(res.skipped)
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
  if (!res.shapes.length) return toast(skipped ? `Nothing to import (skipped: ${skipped})` : "Nothing to import in this file");

  const before = { entities: structuredClone(ed.sk.entities), constraints: structuredClone(ed.sk.constraints) };
  const opt: ImportOptions = { scale: res.unitScale, place: "file", fixed: true };
  const show = (frame: boolean) => {
    ed.sk.entities = structuredClone(before.entities);
    ed.sk.constraints = structuredClone(before.constraints);
    insertShapes(ed.sk, res.shapes, opt);
    ed.solve();
    ed.render();
    if (!frame) return;
    // Frame the drawing where it lands.
    const b = bounds(res.shapes)!;
    const k = opt.scale;
    const c = opt.place === "centre" ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] : [0, 0];
    const { origin: o, xDir: xd, normal: n } = ed.sk.plane;
    const yd = [n[1] * xd[2] - n[2] * xd[1], n[2] * xd[0] - n[0] * xd[2], n[0] * xd[1] - n[1] * xd[0]];
    const w = (x: number, y: number) => new THREE.Vector3(...[0, 1, 2].map((i) => o[i] + xd[i] * (x - c[0]) * k + yd[i] * (y - c[1]) * k));
    vp.fit(new THREE.Box3().setFromPoints([w(b.min[0], b.min[1]), w(b.max[0], b.max[1]), w(b.min[0], b.max[1]), w(b.max[0], b.min[1])]));
  };
  show(true);
  const kp = openKeypad({
    title: `Import ${kind}`,
    subtitle: `${file.name} · ${res.shapes.length} curves · ${res.unitName}${skipped ? ` · skipped: ${skipped}` : ""}`,
    label: "Scale (mm per drawing unit)",
    value: opt.scale,
    unit: "×",
    confirmLabel: "Import",
    segments: [
      {
        options: [
          { value: "file", label: "As in the file" },
          { value: "centre", label: "Centred on origin" },
        ],
        get: () => opt.place,
        set: (v) => {
          opt.place = v as ImportOptions["place"];
          show(true);
        },
      },
      {
        options: [
          { value: "fixed", label: "Fixed in place" },
          { value: "free", label: "Free to constrain" },
        ],
        get: () => (opt.fixed ? "fixed" : "free"),
        set: (v) => {
          opt.fixed = v === "fixed";
          show(false);
        },
      },
    ],
    onInput: (v) => {
      if (v > 0) {
        opt.scale = v;
        show(true);
      }
    },
  });
  const r = await kp.result;
  if (r === null || !(r.value > 0)) {
    ed.sk.entities = before.entities;
    ed.sk.constraints = before.constraints;
    ed.solve();
    ed.render();
    renderAll();
    return;
  }
  opt.scale = r.value;
  show(false);
  commit();
  toast(`${res.shapes.length} curves imported`);
  renderAll();
}

/**
 * Text: the letters' outlines go into the sketch as fixed curves, centred where the view looks,
 * and stay selected so they can be slid into place. Typed words, height and font preview live.
 */
export async function insertText() {
  if (S.mode.kind !== "sketch") return;
  const ed = S.mode.editor;
  const opt = { text: "Text", height: 10, font: "bold" as FontId };
  let font: Font;
  try {
    font = await loadFont(opt.font);
  } catch {
    return toast("The font could not be loaded");
  }
  if (S.mode.kind !== "sketch" || S.mode.editor !== ed) return;
  const at = vp.screenToPlane(vp.width / 2, vp.height / 2, ed.sk.plane) ?? [0, 0];
  const before = { entities: structuredClone(ed.sk.entities), constraints: structuredClone(ed.sk.constraints) };
  let added: string[] = [];
  const show = (frame = false) => {
    ed.sk.entities = structuredClone(before.entities);
    ed.sk.constraints = structuredClone(before.constraints);
    const shapes = textShapes(font, opt.text, opt.height);
    const b = bounds(shapes);
    if (b) {
      // Centred on the point the view looks at.
      const dx = at[0] - (b.min[0] + b.max[0]) / 2;
      const dy = at[1] - (b.min[1] + b.max[1]) / 2;
      const moved = shapes.map((s) => shiftShape(s, dx, dy));
      const known = new Set(before.entities.map((e) => e.id));
      insertShapes(ed.sk, moved, { scale: 1, place: "file", fixed: true });
      added = ed.sk.entities.filter((e) => !known.has(e.id)).map((e) => e.id);
      if (frame) {
        // Room around the words, which the panel may partly cover.
        const { origin: o, xDir: xd, normal: n } = ed.sk.plane;
        const yd = [n[1] * xd[2] - n[2] * xd[1], n[2] * xd[0] - n[0] * xd[2], n[0] * xd[1] - n[1] * xd[0]];
        const w = (x: number, y: number) => new THREE.Vector3(...[0, 1, 2].map((i) => o[i] + xd[i] * x + yd[i] * y));
        const pad = opt.height * 2;
        const [x0, y0, x1, y1] = [b.min[0] + dx - pad, b.min[1] + dy - pad, b.max[0] + dx + pad, b.max[1] + dy + pad];
        vp.fit(new THREE.Box3().setFromPoints([w(x0, y0), w(x1, y1), w(x0, y1), w(x1, y0)]));
      }
    } else added = [];
    ed.solve();
    ed.render();
  };
  show(true);
  const kp = openKeypad({
    title: "Text",
    subtitle: "Capital letters this tall",
    label: "Height",
    value: opt.height,
    unit: "mm",
    confirmLabel: "Insert",
    text: {
      value: opt.text,
      placeholder: "Type the text",
      onInput: (v) => {
        opt.text = v;
        show();
      },
    },
    segments: [
      {
        options: FONTS.map((f) => ({ value: f.id, label: f.label })),
        get: () => opt.font,
        set: (v) => {
          opt.font = v as FontId;
          void loadFont(opt.font).then((f) => {
            if (opt.font !== v) return;
            font = f;
            show();
          });
        },
      },
    ],
    onInput: (v) => {
      if (v > 0) {
        opt.height = v;
        show();
      }
    },
  });
  const r = await kp.result;
  if (r === null || !(r.value > 0) || !opt.text.trim()) {
    ed.sk.entities = before.entities;
    ed.sk.constraints = before.constraints;
    ed.solve();
    ed.render();
    renderAll();
    return;
  }
  opt.height = r.value;
  show();
  commit();
  ed.setTool("select");
  ed.selection.clear();
  for (const id of added) ed.selection.add(id);
  ed.render();
  renderAll();
}

export function shiftShape(s: ImportShape, dx: number, dy: number): ImportShape {
  const m = (p: [number, number]): [number, number] => [p[0] + dx, p[1] + dy];
  switch (s.kind) {
    case "line":
      return { ...s, a: m(s.a), b: m(s.b) };
    case "bezier":
      return { ...s, a: m(s.a), c1: m(s.c1), c2: m(s.c2), b: m(s.b) };
    case "circle":
      return { ...s, c: m(s.c) };
    case "arc":
      return { ...s, c: m(s.c), s: m(s.s), e: m(s.e) };
    case "spline":
      return { ...s, pts: s.pts.map(m) };
  }
}

/**
 * A STEP file becomes a step of the model: its solid is joined as placed in the file, and can be
 * cut instead, filleted, patterned like any other step.
 */
export async function importStep() {
  const file = await pickFile(".step,.stp,model/step");
  if (!file) return;
  const text = await file.text();
  if (!text.slice(0, 400).includes("ISO-10303-21")) return toast("This is not a STEP file");
  leaveModes();
  const fileId = uid();
  const name = file.name.replace(/\.(step|stp)$/i, "") || "Import";
  if (isAssembly()) {
    // In an assembly, the file becomes parts: one project for each of its solids (or one for
    // the whole file), placed where the file had them.
    if (!kernelReady) return toast("The geometry kernel is still loading");
    const reqId = ++M.reqCounter;
    const solids = await new Promise<string[]>((resolve) => {
      pendingSplits.set(reqId, resolve);
      worker.postMessage({ type: "split", reqId, text } satisfies WorkerRequest);
    });
    const texts = solids.length ? solids : [text];
    const taken = (await listProjects().catch(() => [])).map((p) => p.name);
    const now = Date.now();
    const made: { meta: ProjectMeta; doc: CadDocument }[] = [];
    for (const t of texts) {
      const id = uid();
      const partName = texts.length > 1 ? freeName(name, taken) : taken.includes(name) ? freeName(name, taken) : name;
      taken.push(partName);
      const part: CadDocument = { ...emptyDoc(), files: { [id]: t }, features: [{ id: uid(), kind: "import", name: partName, fileId: id, op: "add" }] };
      const meta: ProjectMeta = { id: newProjectId(), name: partName, created: now, updated: now, group: newGroup() };
      try {
        await putProject(meta, part);
      } catch {
        return toast("Could not save in this browser");
      }
      made.push({ meta, doc: part });
    }
    if (made.length === 1) return insertPart(made[0].meta, made[0].doc);
    for (const p of made) {
      partDocs[p.meta.id] = p.doc;
      partNames[p.meta.id] = p.meta.name;
    }
    sendParts();
    const first = !S.doc.instances?.length;
    S.doc.instances = [
      ...(S.doc.instances ?? []),
      ...made.map((p, i): PartInstance => ({ id: uid(), project: p.meta.id, name: p.meta.name, at: [0, 0, 0], rot: [0, 0, 0], fixed: (first && i === 0) || undefined })),
    ];
    M.fitNext = true;
    toast(`${made.length} parts imported, each in a project of its own`);
    return commit();
  }
  S.doc.files = { ...S.doc.files, [fileId]: text };
  // An imported part usually stays apart: it starts a body of its own.
  S.doc.features.push({ id: uid(), kind: "import", name, fileId, op: "add", body: "new" });
  M.fitNext = true;
  commit();
  renderAll();
}
