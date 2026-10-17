// Core tests under Node: solver, profile detection, solid build. Run: npm test
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { Solver } from "../src/sketch/solver";
import { deleteEntities, mergePoints, newSketch, uid } from "../src/sketch/model";
import { findRegions, sampleSegments, signedArea } from "../src/sketch/profiles";
import { trimPlan } from "../src/sketch/trim";
import { parseDxf } from "../src/sketch/dxf";
import { parseSvg } from "../src/sketch/svg";
import { insertShapes } from "../src/sketch/importShapes";
import { atDistance, edgesInPlane, faceFrame, holeDims, snapHole, to2D, to3D } from "../src/cad/holePlace";
import { filletCorner, groupCentre, mirrorEntities, projectEdge, transformGroup } from "../src/sketch/ops";
import { SketchView } from "../src/sketch/model";
import { buildResult, buildShape, exportFile, interferences, layFlat, placeShape, readStep, setPartDocs, splitStep } from "../src/cad/build";
import * as THREE from "three";
import { hasRef, measure, refGeometry } from "../src/cad/measure";
import { instanceMatrix, solveMates, worldRef } from "../src/cad/mates";
import { textShapes } from "../src/sketch/text";
import { offsetEntities } from "../src/sketch/offset";
import { parse as parseFont } from "opentype.js";
import { readFileSync } from "node:fs";
import { applyParameters, evaluate, renameInExpr, resolveParameters } from "../src/params";
import type { CadDocument, Mate, MateRef, PartInstance, PlaneDef, SkEntity, SkLine, SkPoint, SketchFeature } from "../src/types";

setOC(await opencascade());
const solver = await Solver.create();

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1], label: "XY" };
const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0], label: "XZ" };

function rect(sk: SketchFeature, x0: number, y0: number, x1: number, y1: number) {
  const ids = [uid(), uid(), uid(), uid()];
  const pts: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const ents: SkEntity[] = ids.map((id, i) => ({ id, type: "point", x: pts[i][0], y: pts[i][1] }));
  const lines: SkLine[] = ids.map((id, i) => ({ id: uid(), type: "line", p1: id, p2: ids[(i + 1) % 4] }));
  sk.entities.push(...ents, ...lines);
  return { pts: ids, lines: lines.map((l) => l.id) };
}
const ent = <T>(sk: SketchFeature, id: string) => sk.entities.find((e) => e.id === id) as T;

// --- Solver: rectangle with H/V and dimensions, one corner on the origin.
const sk = newSketch("S1", XY);
const r = rect(sk, 1, 2, 18, 9);
sk.constraints.push(
  { id: "h1", type: "horizontal", refs: [r.lines[0]] },
  { id: "h2", type: "horizontal", refs: [r.lines[2]] },
  { id: "v1", type: "vertical", refs: [r.lines[1]] },
  { id: "v2", type: "vertical", refs: [r.lines[3]] },
  { id: "w", type: "distance", refs: [r.lines[0]], value: 20 },
  { id: "hh", type: "distanceY", refs: [r.pts[1], r.pts[2]], value: 10 },
);
sk.entities = sk.entities.filter((e) => e.id !== r.pts[0]);
for (const e of sk.entities) {
  if (e.type !== "line") continue;
  if (e.p1 === r.pts[0]) e.p1 = "O";
  if (e.p2 === r.pts[0]) e.p2 = "O";
}
let res = solver.solve(sk);
const P = (id: string) => ent<SkPoint>(sk, id);
check("solve ok", res.ok);
check("rect width 20", near(P(r.pts[1]).x, 20) && near(P(r.pts[1]).y, 0), JSON.stringify(P(r.pts[1])));
check("rect height via distanceY", near(P(r.pts[2]).y, 10), JSON.stringify(P(r.pts[2])));
check("fully constrained", res.dof === 0, "dof=" + res.dof);

const before = { ...P(r.pts[2]) };
res = solver.solve(sk, { points: [{ id: r.pts[2], x: 40, y: 40 }] });
check("drag of constrained point keeps it", res.ok && near(P(r.pts[2]).x, before.x) && near(P(r.pts[2]).y, before.y));

sk.constraints.push({ id: "bad", type: "distance", refs: [r.lines[2]], value: 5 });
res = solver.solve(sk);
check("conflict reported", res.conflicting.includes("bad") || !res.ok, JSON.stringify(res));
sk.constraints.pop();
solver.solve(sk);

// Free point drag moves it.
const fp = uid();
sk.entities.push({ id: fp, type: "point", x: 3, y: 3 });
res = solver.solve(sk, { points: [{ id: fp, x: 7, y: 8 }] });
check("free point follows drag", near(P(fp).x, 7) && near(P(fp).y, 8), JSON.stringify(P(fp)));
sk.entities.pop();

// --- Profiles.
const cId = uid();
sk.entities.push({ id: cId, type: "point", x: 10, y: 5 }, { id: uid(), type: "circle", c: cId, r: 3 });
let regions = findRegions(sk);
check("rect+circle → 1 region, 1 hole", regions.length === 1 && regions[0].holes.length === 1);

const sk2 = newSketch("S2", XY);
const r2 = rect(sk2, 0, 0, 10, 10);
const m1 = uid();
const m2 = uid();
sk2.entities.push({ id: m1, type: "point", x: 5, y: 0 }, { id: m2, type: "point", x: 5, y: 10 });
const bottom = ent<SkLine>(sk2, r2.lines[0]);
const top = ent<SkLine>(sk2, r2.lines[2]);
sk2.entities.push({ id: uid(), type: "line", p1: m1, p2: bottom.p2 }, { id: uid(), type: "line", p1: m2, p2: top.p2 });
bottom.p2 = m1;
top.p2 = m2;
sk2.entities.push({ id: uid(), type: "line", p1: m1, p2: m2 });
regions = findRegions(sk2);
check("split rectangle → 2 regions", regions.length === 2, String(regions.length));

const sk3 = newSketch("S3", XY);
const [a, b, c, d, c1, c2] = [uid(), uid(), uid(), uid(), uid(), uid()];
sk3.entities.push(
  { id: a, type: "point", x: 0, y: -5 },
  { id: b, type: "point", x: 20, y: -5 },
  { id: c, type: "point", x: 20, y: 5 },
  { id: d, type: "point", x: 0, y: 5 },
  { id: c1, type: "point", x: 20, y: 0 },
  { id: c2, type: "point", x: 0, y: 0 },
  { id: uid(), type: "line", p1: a, p2: b },
  { id: uid(), type: "arc", c: c1, s: b, e: c },
  { id: uid(), type: "line", p1: c, p2: d },
  { id: uid(), type: "arc", c: c2, s: d, e: a },
);
regions = findRegions(sk3);
check("slot → 1 region", regions.length === 1, String(regions.length));

// --- Build.
const doc: CadDocument = {
  format: "waffle",
  version: 1,
  features: [sk, { id: "e1", kind: "extrude", name: "E1", sketchId: sk.id, distance: 5, symmetric: false, op: "add" }],
};
let built = buildShape(doc);
check("extrude ok", !!built.shape && Object.keys(built.errors).length === 0, JSON.stringify(built.errors));
const bb = built.shape!.boundingBox.bounds;
check("extrude bbox", near(bb[0][0], 0) && near(bb[1][0], 20) && near(bb[1][1], 10) && near(bb[1][2], 5), JSON.stringify(bb));

doc.features.push(sk3, { id: "e2", kind: "extrude", name: "E2", sketchId: sk3.id, distance: 3, symmetric: true, op: "cut" });
built = buildShape(doc);
check("slot cut ok", Object.keys(built.errors).length === 0, JSON.stringify(built.errors));

const sk4 = newSketch("S4", XZ);
rect(sk4, 0, 0, 4, 7);
const d4: CadDocument = {
  format: "waffle",
  version: 1,
  features: [sk4, { id: "e4", kind: "extrude", name: "E4", sketchId: sk4.id, distance: 2, symmetric: false, op: "add" }],
};
const b4 = buildShape(d4).shape!.boundingBox.bounds;
check("XZ: sketch y → +Z, extrude towards −Y", near(b4[1][2], 7) && near(b4[0][1], -2), JSON.stringify(b4));

const result = buildResult(doc);
check("mesh + planar faces", !!result.mesh && result.planarFaces.length >= 6, String(result.planarFaces.length));
const top5 = result.planarFaces.find((f) => near(f.plane.normal[2], 1) && near(f.plane.origin[2], 5));
check("top face plane at z=5", !!top5);
const sideUp = result.planarFaces
  .filter((f) => Math.abs(f.plane.normal[2]) < 0.1)
  .map(({ plane: { normal: n, xDir: x } }) => n[0] * x[1] - n[1] * x[0]);
check("side face sketches have Y pointing up", sideUp.length >= 4 && sideUp.every((z) => z > 0.99), JSON.stringify(sideUp));
if (top5 && result.mesh) {
  const g = result.mesh.faceGroups.find((g) => g.faceId === top5.faceId)!;
  const t = result.mesh.triangles[g.start];
  check("faceGroups ids match faces", near(result.mesh.vertices[t * 3 + 2], 5), String(result.mesh.vertices[t * 3 + 2]));
}

const step = exportFile(doc, "step");
const stepText = step ? await step.text() : "";
check("STEP export", stepText.startsWith("ISO-10303-21") && stepText.includes("MANIFOLD_SOLID_BREP"), String(stepText.length));
const stl = exportFile(doc, "stl");
check("STL export", !!stl && stl.size > 84, String(stl?.size));

// --- Press Pull and Shell on a plain 20 × 10 × 5 block.
const blockSk = newSketch("B", XY);
rect(blockSk, 0, 0, 20, 10);
const block = (...more: CadDocument["features"]): CadDocument => ({
  format: "waffle",
  version: 1,
  features: [blockSk, { id: "eb", kind: "extrude", name: "EB", sketchId: blockSk.id, distance: 5, symmetric: false, op: "add" }, ...more],
});
const topRef = { center: [10, 5, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
let pp = buildShape(block({ id: "pp", kind: "pushpull", name: "PP", face: topRef, distance: 3 }));
check("pull top face +3", !pp.errors.pp && !pp.warnings.pp && near(pp.shape!.boundingBox.bounds[1][2], 8), JSON.stringify(pp.errors));
pp = buildShape(block({ id: "pp", kind: "pushpull", name: "PP", face: topRef, distance: -2 }));
check("push top face −2", !pp.errors.pp && near(pp.shape!.boundingBox.bounds[1][2], 3), JSON.stringify(pp.errors));
pp = buildShape(block({ id: "pp", kind: "pushpull", name: "PP", face: { center: [10, 5, 9], normal: [0, 0, 1] }, distance: 1 }));
check("moved face found again, with a warning", !pp.errors.pp && !!pp.warnings.pp && near(pp.shape!.boundingBox.bounds[1][2], 6), JSON.stringify([pp.errors, pp.warnings]));
pp = buildShape(block({ id: "pp", kind: "pushpull", name: "PP", face: { center: [10, 5, 5], normal: [0.6, 0, 0.8] }, distance: 1 }));
check("missing face reported", !!pp.errors.pp, JSON.stringify(pp.errors));
pp = buildShape(block({ id: "pp", kind: "pushpull", name: "PP", face: { center: [10, 5, 80], normal: [0, 0, 1] }, distance: 1 }));
check("face too far away reported", !!pp.errors.pp, JSON.stringify(pp.errors));
const sh = buildShape(block({ id: "sh", kind: "shell", name: "SH", faces: [topRef], thickness: 1 }));
check("shell open top, 1 mm walls", !sh.errors.sh && near(measureVolume(sh.shape!), 1000 - 18 * 8 * 4, 1e-3), `${JSON.stringify(sh.errors)} vol=${sh.shape && measureVolume(sh.shape)}`);
check("shell keeps outer size", near(sh.shape!.boundingBox.bounds[1][0], 20) && near(sh.shape!.boundingBox.bounds[1][2], 5));
// Faces reported by the build can be used as references.
const pfs = buildResult(block()).planarFaces;
const topFace = pfs.find((f) => near(f.plane.normal[2], 1));
const pp2 = buildShape(block({ id: "pp", kind: "pushpull", name: "PP", face: { center: topFace!.center, normal: topFace!.plane.normal }, distance: 2 }));
check("planarFaces centre works as reference", !pp2.errors.pp && near(pp2.shape!.boundingBox.bounds[1][2], 7), JSON.stringify(pp2.errors));

// --- Fillets and chamfers on the 20 × 10 × 5 block.
const topFront = { mid: [10, 0, 5] as [number, number, number] };
const topBack = { mid: [10, 10, 5] as [number, number, number] };
const fl = buildShape(block({ id: "fl", kind: "fillet", name: "F", mode: "fillet", edges: [topFront, topBack], radius: 1 }));
const blockVol = 1000;
const filletLoss = 2 * 20 * (1 - Math.PI / 4); // two 20 mm edges, r = 1
check("fillet two edges", !fl.errors.fl && near(measureVolume(fl.shape!), blockVol - filletLoss, 1e-3), `${JSON.stringify(fl.errors)} vol=${fl.shape && measureVolume(fl.shape)}`);
const ch = buildShape(block({ id: "ch", kind: "fillet", name: "C", mode: "chamfer", edges: [topFront], radius: 2 }));
check("chamfer one edge", !ch.errors.ch && near(measureVolume(ch.shape!), blockVol - 20 * 2, 1e-3), `${JSON.stringify(ch.errors)} vol=${ch.shape && measureVolume(ch.shape)}`);
const big = buildShape(block({ id: "bg", kind: "fillet", name: "B", mode: "fillet", edges: [topFront], radius: 50 }));
check("too large radius reported", !!big.errors.bg, JSON.stringify(big.errors));
const moved = buildShape(block({ id: "gn", kind: "fillet", name: "G", mode: "fillet", edges: [{ mid: [10, 0, 7] }], radius: 1 }));
check("moved edge found again, with a warning", !moved.errors.gn && !!moved.warnings.gn && near(measureVolume(moved.shape!), blockVol - 20 * (1 - Math.PI / 4), 1e-3), JSON.stringify(moved.errors));
const gone = buildShape(block({ id: "gn", kind: "fillet", name: "G", mode: "fillet", edges: [{ mid: [10, 0, 90] }], radius: 1 }));
check("missing edge reported", !!gone.errors.gn, JSON.stringify(gone.errors));
const groups = buildResult(block()).edgeGroups;
check("12 edge groups with midpoints", groups.length === 12 && groups.some((g) => near(g.mid[0], 10) && near(g.mid[1], 0) && near(g.mid[2], 5)), String(groups.length));

// --- Holes in the 20 × 10 × 5 block, from its top face.
const holeBase = { normal: [0, 0, 1] as [number, number, number], size: "M3" as const, fit: "clearance" as const };
const hl = (extra: object) => buildShape(block({ id: "h", kind: "hole", name: "H", points: [[5, 5, 5], [15, 5, 5]], head: "none", depth: 0, ...holeBase, ...extra } as never));
const r34 = 3.4 / 2;
let hs = hl({});
check("two M3 through holes", !hs.errors.h && near(measureVolume(hs.shape!), 1000 - 2 * Math.PI * r34 * r34 * 5, 1e-2), `${JSON.stringify(hs.errors)} vol=${hs.shape && measureVolume(hs.shape)}`);
hs = hl({ depth: 3 });
check("blind 3 mm", !hs.errors.h && near(measureVolume(hs.shape!), 1000 - 2 * Math.PI * r34 * r34 * 3, 1e-2), `vol=${hs.shape && measureVolume(hs.shape)}`);
hs = hl({ head: "counterbore" });
const cb = 2 * (Math.PI * 3.25 * 3.25 * 3.3 + Math.PI * r34 * r34 * (5 - 3.3));
check("counterbore M3", !hs.errors.h && near(measureVolume(hs.shape!), 1000 - cb, 1e-2), `vol=${hs.shape && measureVolume(hs.shape)}`);
hs = hl({ head: "countersink" });
const h = 6.7 / 2 - r34;
const cone = (Math.PI * h * (3.35 * 3.35 + 3.35 * r34 + r34 * r34)) / 3;
check("countersink M3", !hs.errors.h && near(measureVolume(hs.shape!), 1000 - 2 * (cone + Math.PI * r34 * r34 * (5 - h)), 1e-2), `vol=${hs.shape && measureVolume(hs.shape)}`);
hs = hl({ fit: "plastic" });
check("pilot hole for plastic", !hs.errors.h && near(measureVolume(hs.shape!), 1000 - 2 * Math.PI * 1.25 * 1.25 * 5, 1e-2));
// From the free points of a sketch on the top face.
const hSk = newSketch("HS", { origin: [0, 0, 5], xDir: [1, 0, 0], normal: [0, 0, 1], label: "Face" });
hSk.entities.push({ id: "hp", type: "point", x: 10, y: 5 });
hs = buildShape(block(hSk, { id: "h", kind: "hole", name: "H", sketchId: hSk.id, normal: [0, 0, 1], size: "M5", fit: "clearance", head: "none", depth: 0 }));
check("hole at a sketch point", !hs.errors.h && near(measureVolume(hs.shape!), 1000 - Math.PI * 2.75 * 2.75 * 5, 1e-2), `${JSON.stringify(hs.errors)} vol=${hs.shape && measureVolume(hs.shape)}`);

// --- Patterns: repeat a hole, mirror a boss, mirror the whole solid.
const oneHole = { id: "h1", kind: "hole", name: "H1", points: [[3, 5, 5]], normal: [0, 0, 1], size: "M3", fit: "clearance", head: "none", depth: 0 } as const;
const holeVol = Math.PI * r34 * r34 * 5;
const pat = (p: object) =>
  buildShape(block(oneHole as never, { id: "pt", kind: "pattern", name: "PT", featureIds: ["h1"], axis: "X", count: 1, spacing: 0, axis2: "Y", count2: 1, spacing2: 0, angle: 360, offset: 0, type: "linear", ...p } as never));
let ps = pat({ count: 4, spacing: 4.5 });
check("linear pattern of a hole ×4", !ps.errors.pt && near(measureVolume(ps.shape!), 1000 - 4 * holeVol, 1e-2), `${JSON.stringify(ps.errors)} vol=${ps.shape && measureVolume(ps.shape)}`);
ps = pat({ count: 2, spacing: 14, axis2: "Y", count2: 2, spacing2: 3.5 });
check("rectangular 2 × 2 pattern", !ps.errors.pt && measureVolume(ps.shape!) < 1000 - 3 * holeVol, `vol=${ps.shape && measureVolume(ps.shape)}`);
ps = pat({ count: 2, spacing: 14, axis2: "Y", count2: 1 });
check("linear ×2 along X", !ps.errors.pt && near(measureVolume(ps.shape!), 1000 - 2 * holeVol, 1e-2));
ps = pat({ type: "mirror", axis: "X", offset: 10 });
check("mirror a hole about x = 10", !ps.errors.pt && near(measureVolume(ps.shape!), 1000 - 2 * holeVol, 1e-2), `vol=${ps.shape && measureVolume(ps.shape)}`);
ps = pat({ type: "circular", axis: "Z", count: 4, angle: 360, featureIds: ["h1"] });
check("circular pattern runs (copies outside the block are no-ops)", !ps.errors.pt, JSON.stringify(ps.errors));
const whole = buildShape(block({ id: "mw", kind: "pattern", name: "MW", type: "mirror", featureIds: [], axis: "X", count: 1, spacing: 0, axis2: "Y", count2: 1, spacing2: 0, angle: 360, offset: 0 }));
const wb = whole.shape!.boundingBox.bounds;
check("mirror the whole solid about YZ", !whole.errors.mw && near(wb[0][0], -20) && near(measureVolume(whole.shape!), 2000, 1e-3), JSON.stringify(wb));
const shellPat = buildShape(block({ id: "sh", kind: "shell", name: "SH", faces: [topRef], thickness: 1 }, { id: "pp", kind: "pattern", name: "PP", type: "linear", featureIds: ["sh"], axis: "X", count: 2, spacing: 30, axis2: "Y", count2: 1, spacing2: 0, angle: 360, offset: 0 }));
check("shell cannot be repeated", !!shellPat.errors.pp, JSON.stringify(shellPat.errors));

// --- Revolve: a 5 × 20 rectangle at 5 mm from the axis, on the XZ plane (sketch Y = world Z).
const rvSk = newSketch("RV", XZ);
const rvRect = rect(rvSk, 5, 0, 10, 20);
const rv = (p: object) =>
  buildShape({
    format: "waffle",
    version: 1,
    features: [rvSk, { id: "rv", kind: "revolve", name: "RV", sketchId: rvSk.id, axisLine: "AY", angle: 360, symmetric: false, op: "add", ...p } as never],
  });
const tube = Math.PI * (10 * 10 - 5 * 5) * 20;
let rs = rv({});
check("revolve 360° around sketch Y = tube", !rs.errors.rv && near(measureVolume(rs.shape!), tube, 1e-2), `${JSON.stringify(rs.errors)} vol=${rs.shape && measureVolume(rs.shape)}`);
check("tube axis is world Z", near(rs.shape!.boundingBox.bounds[1][2], 20) && near(rs.shape!.boundingBox.bounds[0][0], -10));
rs = rv({ angle: 90 });
check("revolve 90°", !rs.errors.rv && near(measureVolume(rs.shape!), tube / 4, 1e-2));
rs = rv({ angle: 90, symmetric: true });
check("symmetric 90° spans both sides", !rs.errors.rv && near(measureVolume(rs.shape!), tube / 4, 1e-2) && rs.shape!.boundingBox.bounds[0][1] < -1 && rs.shape!.boundingBox.bounds[1][1] > 1, JSON.stringify(rs.shape?.boundingBox.bounds));
// Around a drawn line: the rectangle's own left edge (x = 5) → a solid cylinder of radius 5.
rs = rv({ axisLine: rvRect.lines[3] });
check("revolve around the profile's own edge", !rs.errors.rv && near(measureVolume(rs.shape!), Math.PI * 25 * 20, 1e-2), `vol=${rs.shape && measureVolume(rs.shape)}`);
rs = rv({ axisLine: "nope" });
check("missing axis reported", !!rs.errors.rv, JSON.stringify(rs.errors));

// --- Parameters and expressions.
check("expression with names", evaluate("2 * w + 5", { w: 10 }) === 25);
check("unknown name fails", evaluate("w + 1", {}) === null);
const resolved = resolveParameters([
  { id: "a", name: "depth", expr: "width / 2 + wall" },
  { id: "b", name: "width", expr: "40" },
  { id: "c", name: "wall", expr: "2" },
  { id: "d", name: "x", expr: "y + 1" },
  { id: "e", name: "y", expr: "x * 2" },
]);
check("parameters resolve in dependency order", resolved.scope.depth === 22, JSON.stringify(resolved.scope));
check("cycle reported", !!resolved.errors.d && !!resolved.errors.e, JSON.stringify(resolved.errors));
check("rename whole words only", renameInExpr("w + width * w2 - w", "w", "len") === "len + width * w2 - len");

const pSk = newSketch("P", XY);
const pr = rect(pSk, 0, 0, 30, 10);
pSk.constraints.push(
  { id: "ph1", type: "horizontal", refs: [pr.lines[0]] },
  { id: "ph2", type: "horizontal", refs: [pr.lines[2]] },
  { id: "pv1", type: "vertical", refs: [pr.lines[1]] },
  { id: "pv2", type: "vertical", refs: [pr.lines[3]] },
  { id: "pw", type: "distance", refs: [pr.lines[0]], value: 30, expr: "width" },
);
solver.solve(pSk);
const pDoc: CadDocument = {
  format: "waffle",
  version: 1,
  parameters: [
    { id: "q1", name: "width", expr: "50" },
    { id: "q2", name: "height", expr: "width / 5" },
  ],
  features: [pSk, { id: "pe", kind: "extrude", name: "PE", sketchId: pSk.id, distance: 3, distanceExpr: "height", symmetric: false, op: "add" }],
};
const problems = applyParameters(pDoc, solver);
const pb = buildShape(pDoc).shape!.boundingBox.bounds;
check("parameters drive sketch and extrusion", !problems.length && near(pb[1][0] - pb[0][0], 50) && near(pb[1][2], 10), `${JSON.stringify(problems)} ${JSON.stringify(pb)}`);
pDoc.parameters![0].expr = "-5";
check("negative length reported", applyParameters(pDoc, solver).length > 0);

// --- Splines.
function splineSketch(pts: [number, number][], closed: boolean) {
  const s = newSketch("Sp", XY);
  const ids = pts.map(() => uid());
  s.entities.push(...pts.map(([x, y], i): SkEntity => ({ id: ids[i], type: "point", x, y })));
  s.entities.push({ id: "sp", type: "spline", pts: ids, closed });
  return { s, ids };
}
const blob = splineSketch([[0, 0], [20, -2], [24, 12], [4, 14]], true);
let spRegions = findRegions(blob.s);
check("closed spline → 1 region", spRegions.length === 1 && spRegions[0].outer.kind === "path", String(spRegions.length));
const spArea = spRegions[0].outer.kind === "path" ? signedArea(sampleSegments(spRegions[0].outer.segments)) : 0;
const spDoc: CadDocument = { format: "waffle", version: 1, features: [blob.s, { id: "se", kind: "extrude", name: "SE", sketchId: blob.s.id, distance: 5, symmetric: false, op: "add" }] };
const spBuilt = buildShape(spDoc);
check("spline extrusion matches the drawn area", !spBuilt.errors.se && near(measureVolume(spBuilt.shape!), spArea * 5, spArea * 5 * 0.005), `${JSON.stringify(spBuilt.errors)} vol=${spBuilt.shape && measureVolume(spBuilt.shape)} area=${spArea}`);
const spStep = await exportFile(spDoc, "step");
const spStepText = spStep ? await spStep.text() : "";
check("STEP keeps the spline exact", spStepText.includes("B_SPLINE_CURVE"), String(spStepText.length));
check("solver accepts splines, points stay free", (() => {
  const r = solver.solve(blob.s, { points: [{ id: blob.ids[1], x: 22, y: -4 }] });
  return r.ok && near(ent<SkPoint>(blob.s, blob.ids[1]).x, 22);
})());
// Open spline closed by a line, with a line from its middle point splitting the area.
const arch = splineSketch([[0, 0], [10, 6], [20, 0]], false);
const mid0 = uid();
arch.s.entities.push(
  { id: mid0, type: "point", x: 10, y: 0 },
  { id: uid(), type: "line", p1: arch.ids[2], p2: mid0 },
  { id: uid(), type: "line", p1: mid0, p2: arch.ids[0] },
);
check("open spline + line → 1 region", findRegions(arch.s).length === 1);
arch.s.entities.push({ id: uid(), type: "line", p1: arch.ids[1], p2: mid0 });
check("line to a spline point splits it → 2 regions", findRegions(arch.s).length === 2, String(findRegions(arch.s).length));
const arch2 = splineSketch([[0, 0], [10, 6], [20, 0], [10, -6], [0.1, 0.1]], false);
mergePoints(arch2.s, arch2.ids[0], arch2.ids[4]);
const merged = ent<{ pts: string[]; closed?: boolean }>(arch2.s, "sp");
check("joining the ends closes the spline", !!merged.closed && merged.pts.length === 4 && findRegions(arch2.s).length === 1);
deleteEntities(arch2.s, [arch2.ids[1]]);
check("deleting a spline point keeps the spline", ent<{ pts: string[] }>(arch2.s, "sp")?.pts.length === 3);

// --- Trim.
function lineSketch(segs: [number, number, number, number][]) {
  const s = newSketch("Tr", XY);
  const lines = segs.map(([x0, y0, x1, y1]) => {
    const a = uid();
    const b = uid();
    const l: SkLine = { id: uid(), type: "line", p1: a, p2: b };
    s.entities.push({ id: a, type: "point", x: x0, y: y0 }, { id: b, type: "point", x: x1, y: y1 }, l);
    return l.id;
  });
  return { s, lines };
}
const trim = (s: SketchFeature, id: string, at: [number, number]) => {
  const plan = trimPlan(s, id, at);
  plan?.apply(s);
  return plan;
};
const lineLen = (s: SketchFeature, id: string) => {
  const l = ent<SkLine>(s, id);
  const a = ent<SkPoint>(s, l.p1);
  const b = ent<SkPoint>(s, l.p2);
  return Math.hypot(b.x - a.x, b.y - a.y);
};
const cross = lineSketch([[-10, 0, 10, 0], [0, -10, 0, 10]]);
trim(cross.s, cross.lines[0], [5, 0]);
check("trim a line end at a crossing", near(lineLen(cross.s, cross.lines[0]), 10) && solver.solve(cross.s).ok, String(lineLen(cross.s, cross.lines[0])));
const bars = lineSketch([[-10, 0, 10, 0], [-5, -5, -5, 5], [5, -5, 5, 5]]);
trim(bars.s, bars.lines[0], [0, 0]);
const pieces = bars.s.entities.filter((e) => e.type === "line" && !e.axis);
check("trim the middle splits the line", pieces.length === 4 && solver.solve(bars.s).ok, String(pieces.length));
trim(bars.s, bars.lines[1], [-5, 4]);
check("trim at a line's end point reuses it", bars.s.entities.filter((e) => e.type === "point" && !e.fixed).length === 7);
const lone = lineSketch([[0, 0, 4, 4]]);
trim(lone.s, lone.lines[0], [2, 2]);
check("trim with no crossing deletes the curve", !lone.s.entities.some((e) => e.id === lone.lines[0]) && lone.s.entities.length === 5);
// Circle cut by a line: keep the lower half, then trim the line's ends → half disc.
const disc = lineSketch([[-10, 0, 10, 0]]);
const dc = uid();
disc.s.entities.push({ id: dc, type: "point", x: 0, y: 0 }, { id: "cir", type: "circle", c: dc, r: 5 });
trim(disc.s, "cir", [0, 5]);
const half = ent<{ type: string }>(disc.s, "cir");
trim(disc.s, disc.lines[0], [-8, 0]);
trim(disc.s, disc.lines[0], [8, 0]);
const halfRegions = findRegions(disc.s);
const halfArea = halfRegions.length === 1 && halfRegions[0].outer.kind === "path" ? signedArea(sampleSegments(halfRegions[0].outer.segments)) : 0;
check("trimmed circle + line → half disc", half.type === "arc" && near(halfArea, (Math.PI * 25) / 2, 0.3) && solver.solve(disc.s).ok, `${half.type} ${halfArea}`);
check("splines are not trimmed", trimPlan(blob.s, "sp", [10, 0]) === null);

// --- Sketch fillet, mirror, spline tangency.
const fsk = newSketch("F", XY);
const fr = rect(fsk, 0, 0, 20, 10);
fsk.constraints.push(
  { id: uid(), type: "horizontal", refs: [fr.lines[0]] },
  { id: uid(), type: "vertical", refs: [fr.lines[1]] },
  { id: uid(), type: "horizontal", refs: [fr.lines[2]] },
  { id: uid(), type: "vertical", refs: [fr.lines[3]] },
);
const ferr = filletCorner(fsk, fr.pts[2], 3);
const fres = solver.solve(fsk);
const fRegion = findRegions(fsk);
const fArea = fRegion[0]?.outer.kind === "path" ? signedArea(sampleSegments(fRegion[0].outer.segments)) : 0;
check("fillet a rectangle corner", !ferr && fres.ok && fRegion.length === 1 && near(fArea, 200 - (9 - (Math.PI * 9) / 4), 0.05), `${ferr} ${fres.ok} ${fArea}`);
check("fillet keeps the corner as a virtual sharp", (ent<SkPoint>(fsk, fr.pts[2]) as SkPoint & { sharp?: boolean })?.sharp === true && near(ent<SkPoint>(fsk, fr.pts[2]).x, 20) && near(ent<SkPoint>(fsk, fr.pts[2]).y, 10));
const fixedCorner = newSketch("FC", XY);
fixedCorner.entities.push({ id: "q1", type: "point", x: 0, y: 30 }, { id: "q2", type: "point", x: 40, y: 30 }, { id: "M1", type: "line", p1: "q1", p2: "O" }, { id: "M2", type: "line", p1: "q2", p2: "q1" });
fixedCorner.constraints.push({ id: "g1", type: "fix", refs: ["q1"], at: [0, 30] }, { id: "g2", type: "fix", refs: ["q2"], at: [40, 30] });
filletCorner(fixedCorner, "q1", 8);
const fcr = solver.solve(fixedCorner);
check("fillet of a fully constrained corner stays fully constrained", fcr.ok && fcr.dof === 0 && !fcr.redundant.length, `dof=${fcr.dof} ${JSON.stringify(fcr.redundant)}`);
check("fillet too large refused", filletCorner(fsk, fr.pts[0], 50) !== null);
const fDoc: CadDocument = { format: "waffle", version: 1, features: [fsk, { id: "fe", kind: "extrude", name: "FE", sketchId: fsk.id, distance: 2, symmetric: false, op: "add" }] };
const fBuilt = buildShape(fDoc);
check("filleted sketch extrudes", !fBuilt.errors.fe && near(measureVolume(fBuilt.shape!), 2 * (200 - (9 - (Math.PI * 9) / 4)), 0.05), `${JSON.stringify(fBuilt.errors)}`);

const msk = newSketch("M", XY);
const mr = rect(msk, 2, 0, 8, 5);
const madded = mirrorEntities(msk, [...mr.lines, "AY"], "AY");
const mres = solver.solve(msk);
const mpts = msk.entities.filter((e): e is SkPoint => e.type === "point" && !e.fixed);
check("mirror about the Y axis", madded === 4 && mres.ok && mpts.length === 8 && mpts.some((p) => near(p.x, -8) && near(p.y, 5)) && findRegions(msk).length === 2, `${madded} ${mpts.length}`);
const mp0 = mpts.find((p) => near(p.x, 2) && near(p.y, 0))!;
solver.solve(msk, { points: [{ id: mp0.id, x: 3, y: 0 }] });
check("mirrored copy follows the original", msk.entities.some((e) => e.type === "point" && near(e.x, -3) && near(e.y, 0)));

const tsk = newSketch("T", XY);
const ta = uid(), tb = uid(), tc = uid(), td = uid();
tsk.entities.push(
  { id: ta, type: "point", x: -10, y: 0 },
  { id: tb, type: "point", x: 0, y: 0 },
  { id: tc, type: "point", x: 10, y: 10 },
  { id: td, type: "point", x: 20, y: 0 },
  { id: "tl", type: "line", p1: ta, p2: tb },
  { id: "ts", type: "spline", pts: [tb, tc, td] },
);
const before0 = new SketchView(tsk).splineSpans(ent(tsk, "ts"))[0];
tsk.constraints.push({ id: "tt", type: "tangent", refs: ["ts", "tl"] });
const after0 = new SketchView(tsk).splineSpans(ent(tsk, "ts"))[0];
check("spline tangent to a line leaves along it", near(after0.c1[1], 0) && after0.c1[0] > 0 && !near(before0.c1[1], 0), JSON.stringify(after0.c1));
check("solver ignores the spline tangency", solver.solve(tsk).ok);

// --- Use edges: project the edges of a block's top face onto a sketch on it.
const blockDoc: CadDocument = { format: "waffle", version: 1, features: [sk, { id: "e1", kind: "extrude", name: "E1", sketchId: sk.id, distance: 5, symmetric: false, op: "add" }] };
const blockRes = buildResult(blockDoc);
const useFace = blockRes.planarFaces.find((f) => near(f.plane.normal[2], 1))!;
const usk = newSketch("U", useFace.plane);
const chainOf = (g: { start: number; count: number }) => {
  const out: [number, number, number][] = [];
  const L = blockRes.edges;
  for (let k = g.start; k < g.start + g.count; k += 2) out.push([L[k * 3], L[k * 3 + 1], L[k * 3 + 2]]);
  const e = (g.start + g.count - 1) * 3;
  out.push([L[e], L[e + 1], L[e + 2]]);
  return out;
};
const topEdges = blockRes.edgeGroups.filter((g) => near(g.mid[2], 5));
const uerr = topEdges.map((g) => projectEdge(usk, chainOf(g))).filter(Boolean);
const ures = solver.solve(usk);
check("projected top edges close a profile", topEdges.length >= 4 && !uerr.length && ures.ok && findRegions(usk).length >= 1 && ures.dof === 0, `${topEdges.length} ${JSON.stringify(uerr)} dof=${ures.dof}`);
const vertical = blockRes.edgeGroups.find((g) => near(g.mid[2], 2.5))!;
check("edge seen end-on is refused", projectEdge(newSketch("U2", useFace.plane), chainOf(vertical)) !== null);
const csk = newSketch("C", XY);
const ring: [number, number, number][] = Array.from({ length: 41 }, (_, i) => [3 + 4 * Math.cos((i / 40) * Math.PI * 2), 4 * Math.sin((i / 40) * Math.PI * 2), 7]);
projectEdge(csk, ring);
const ringC = csk.entities.find((e) => e.type === "circle") as { r: number } | undefined;
check("circular edge becomes a circle", !!ringC && near(ringC.r, 4, 1e-6));
const halfRing = ring.slice(0, 21);
projectEdge(csk, halfRing);
check("half circle becomes an arc", csk.entities.some((e) => e.type === "arc"));

// --- Hole placement on the 20 × 10 × 5 block's top face.
const hb = buildResult(block());
const hf = faceFrame([0, 0, 1], [10, 5, 5]);
const hEdges = edgesInPlane(hf, hb.edges, hb.edgeGroups);
check("top face edges found in plane", hEdges.segments.length === 4, String(hEdges.segments.length));
const hc = to2D(hf, [10, 5, 5]);
let hs2 = snapHole([10.4, 5.3], hEdges, hc, 1);
check("snaps to the face centre", near(hs2.at[0], 10) && near(hs2.at[1], 5) && hs2.label === "Face centre", JSON.stringify(hs2));
hs2 = snapHole([0.3, 5.2], hEdges, hc, 1);
check("snaps to an edge middle", near(hs2.at[0], 0) && near(hs2.at[1], 5) && hs2.label === "Edge middle", JSON.stringify(hs2));
hs2 = snapHole([3.4, 2.6], hEdges, hc, 1);
check("falls back to a 1 mm grid", near(hs2.at[0], 3) && near(hs2.at[1], 3) && hs2.label === null, JSON.stringify(hs2));
const hd = holeDims([3, 2], hEdges);
check("distances to the two nearest edges", hd.length === 2 && near(hd[0].dist, 2) && near(hd[1].dist, 3), JSON.stringify(hd.map((d) => d.dist)));
const moved3 = to3D(hf, atDistance(hd[0], 4));
check("typing a distance moves the hole square to the edge", near(moved3[0], 3) && near(moved3[1], 4) && near(moved3[2], 5), JSON.stringify(moved3));

// --- Step cache: changing the last step only replays that step.
const heavy = (d: number): CadDocument =>
  block(
    { id: "hc", kind: "hole", name: "H", points: [[4, 3, 5], [16, 3, 5], [4, 7, 5], [16, 7, 5]], normal: [0, 0, 1], size: "M3", fit: "clearance", head: "counterbore", depth: 0 },
    { id: "fc", kind: "fillet", name: "F", mode: "fillet", edges: [{ mid: [10, 0, 5] }, { mid: [10, 10, 5] }], radius: 1 },
    { id: "pc", kind: "pushpull", name: "P", face: { center: [0, 5, 2.5], normal: [-1, 0, 0] }, distance: d },
  );
let t0 = performance.now();
buildShape(heavy(1));
const cold = performance.now() - t0;
t0 = performance.now();
const warm = buildShape(heavy(2));
const warmTime = performance.now() - t0;
const fresh = buildShape({ ...heavy(2), features: heavy(2).features.map((f) => ({ ...f, name: f.name + " " })) });
check(
  "cached replay matches a full one and is faster",
  !Object.keys(warm.errors).length && near(measureVolume(warm.shape!), measureVolume(fresh.shape!), 1e-6) && warmTime < cold * 0.7,
  `cold ${cold.toFixed(0)} ms, warm ${warmTime.toFixed(0)} ms, ${JSON.stringify(warm.errors)}`,
);

// --- DXF import.
const dxf = (units: number, blocks: string[][], entities: string[][]) =>
  [
    ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", String(units), "0", "ENDSEC"],
    ["0", "SECTION", "2", "BLOCKS", ...blocks.flat(), "0", "ENDSEC"],
    ["0", "SECTION", "2", "ENTITIES", ...entities.flat(), "0", "ENDSEC"],
    ["0", "EOF"],
  ]
    .flat()
    .join("\n");
// A stadium (two straight sides, two half-circle ends as polyline bulges) with a circle hole,
// the hole coming from a block inserted at (10, 5).
const stadium = dxf(
  4,
  [["0", "BLOCK", "2", "HOLE", "10", "0", "20", "0", "0", "CIRCLE", "8", "0", "10", "0", "20", "0", "40", "2", "0", "ENDBLK"]],
  [
    ["0", "LWPOLYLINE", "8", "0", "90", "4", "70", "1", "10", "0", "20", "0", "10", "20", "20", "0", "42", "1", "10", "20", "20", "10", "10", "0", "20", "10", "42", "1"],
    ["0", "INSERT", "8", "0", "2", "HOLE", "10", "10", "20", "5"],
    ["0", "TEXT", "8", "0", "1", "hello"],
  ],
);
const dres = parseDxf(stadium);
check("DXF: polyline with bulges, block insert, skipped text", dres.shapes.length === 5 && dres.skipped.TEXT === 1 && dres.unitScale === 1, JSON.stringify({ n: dres.shapes.length, skipped: dres.skipped }));
const dsk = newSketch("DXF", XY);
insertShapes(dsk, dres.shapes, { scale: 1, place: "file", fixed: true });
const dsolve = solver.solve(dsk);
const dRegions = findRegions(dsk);
const dArea = dRegions.length === 1 && dRegions[0].outer.kind === "path" ? signedArea(sampleSegments(dRegions[0].outer.segments)) : 0;
check("DXF: outline closes, hole found, fully fixed", dsolve.ok && dsolve.dof === 0 && dRegions.length === 1 && dRegions[0].holes.length === 1 && near(dArea, 200 + Math.PI * 25, 0.3), `dof=${dsolve.dof} regions=${dRegions.length} area=${dArea}`);
const dDoc: CadDocument = { format: "waffle", version: 1, features: [dsk, { id: "de", kind: "extrude", name: "DE", sketchId: dsk.id, distance: 2, symmetric: false, op: "add" }] };
const dBuilt = buildShape(dDoc);
check("DXF: extrudes with exact arcs", !dBuilt.errors.de && near(measureVolume(dBuilt.shape!), 2 * (200 + Math.PI * 25 - Math.PI * 4), 1e-3), `vol=${dBuilt.shape && measureVolume(dBuilt.shape)}`);
const inch = parseDxf(dxf(1, [], [["0", "LINE", "8", "0", "10", "0", "20", "0", "11", "1", "21", "0"]]));
const isk = newSketch("I", XY);
insertShapes(isk, inch.shapes, { scale: inch.unitScale, place: "centre", fixed: false });
const ipts = isk.entities.filter((e): e is SkPoint => e.type === "point" && !e.fixed);
check("DXF: inches to mm, centred", inch.unitName === "inches" && ipts.length === 2 && near(Math.abs(ipts[0].x), 12.7) && near(ipts[0].x + ipts[1].x, 0));
const sp = parseDxf(dxf(4, [], [["0", "SPLINE", "8", "0", "70", "8", "71", "3", "72", "8", "73", "4", "40", "0", "40", "0", "40", "0", "40", "0", "40", "1", "40", "1", "40", "1", "40", "1", "10", "0", "20", "0", "10", "10", "20", "10", "10", "20", "20", "10", "10", "30", "20", "0"]]));
const spl = sp.shapes[0];
check("DXF: NURBS spline sampled through its ends", spl?.kind === "spline" && near(spl.pts[0][0], 0) && near(spl.pts[spl.pts.length - 1][0], 30) && near(spl.pts[Math.floor(spl.pts.length / 2)][1], 7.5, 0.05), JSON.stringify(spl && spl.kind === "spline" ? spl.pts[Math.floor(spl.pts.length / 2)] : spl));

// --- SVG import.
// 100 × 50 mm document (viewBox in mm units): a rounded rectangle (exact arcs), a circle hole,
// and a heart made of cubic Béziers, inside a translated group.
const svgDoc = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">
  <!-- comment -->
  <rect x="5" y="5" width="40" height="30" rx="5"/>
  <circle cx="25" cy="20" r="4"/>
  <g transform="translate(60 10)">
    <path d="M10 6 C10 0 0 0 0 6 C0 12 10 16 10 20 C10 16 20 12 20 6 C20 0 10 0 10 6 Z"/>
  </g>
  <text x="1" y="1">hi</text>
</svg>`;
const sres = parseSvg(svgDoc);
const kinds = sres.shapes.map((x) => x.kind);
check("SVG: rect corners as exact arcs, circle, Béziers, text skipped", near(sres.unitScale, 1) && kinds.filter((k) => k === "arc").length === 4 && kinds.includes("circle") && kinds.filter((k) => k === "bezier").length === 4 && Object.keys(sres.skipped).some((k) => k.startsWith("text")), `${kinds.join(",")} ${JSON.stringify(sres.skipped)}`);
const ssk = newSketch("SVG", XY);
insertShapes(ssk, sres.shapes, { scale: sres.unitScale, place: "file", fixed: true });
const sSolve = solver.solve(ssk);
const sRegions = findRegions(ssk);
const area = (r: (typeof sRegions)[number]) => (r.outer.kind === "path" ? signedArea(sampleSegments(r.outer.segments)) : r.outer.kind === "circle" ? Math.PI * r.outer.r ** 2 : Math.PI * r.outer.ra * r.outer.rb);
const roundRect = 40 * 30 - (4 - Math.PI) * 25;
check("SVG: two closed regions, the rectangle with its hole", sSolve.ok && sRegions.length === 2 && sRegions.some((r) => r.holes.length === 1 && near(area(r), roundRect, 0.5)), `regions=${sRegions.length} areas=${sRegions.map(area).join(",")}`);
const ymax = Math.max(...ssk.entities.filter((e): e is SkPoint => e.type === "point" && !e.fixed).map((q) => q.y));
check("SVG: Y flipped up (the top of the page is the top of the sketch)", near(ymax, -5, 1e-6) || ymax <= 0, String(ymax));
const sDoc: CadDocument = { format: "waffle", version: 1, features: [ssk, { id: "se2", kind: "extrude", name: "SE", sketchId: ssk.id, distance: 1, symmetric: false, op: "add" }] };
const sBuilt = buildShape(sDoc);
check("SVG: extrudes (Béziers exact in the kernel)", !sBuilt.errors.se2 && measureVolume(sBuilt.shape!) > roundRect - Math.PI * 16, JSON.stringify(sBuilt.errors));
const sStep = exportFile(sDoc, "step");
const sStepText = sStep ? await sStep.text() : "";
check("SVG: STEP keeps the Béziers as B-spline curves", sStepText.includes("B_SPLINE_CURVE"));
const px = parseSvg('<svg width="96" height="96"><path d="m0 0 h96"/><path d="M0 10 a5 5 0 016 0"/></svg>');
check("SVG: px at 96 per inch; compact arc flags", near(px.unitScale, 25.4 / 96) && px.shapes.length === 2 && px.shapes[1].kind === "arc", JSON.stringify(px.shapes.map((x) => x.kind)));

// --- Moving, turning and scaling a selection (an imported, pinned drawing).
const gsk = newSketch("G", XY);
insertShapes(gsk, parseDxf(stadium).shapes, { scale: 1, place: "file", fixed: true });
const gAll = gsk.entities.filter((e) => e.type !== "point" && !(e.type === "line" && e.axis)).map((e) => e.id);
let gr = transformGroup(gsk, gAll, { kind: "move", dx: 5, dy: -3 });
let gs = solver.solve(gsk);
const gPts = () => gsk.entities.filter((e): e is SkPoint => e.type === "point" && !e.fixed);
check("move a pinned drawing: pins follow", !gr.error && gs.ok && gs.dof === 0 && gPts().some((q) => near(q.x, 5) && near(q.y, -3)), JSON.stringify(gr));
const gc = groupCentre(gsk, gAll);
transformGroup(gsk, gAll, { kind: "scale", factor: 2, about: gc });
gs = solver.solve(gsk);
const gArea = (() => {
  const r = findRegions(gsk);
  return r[0]?.outer.kind === "path" ? signedArea(sampleSegments(r[0].outer.segments)) : 0;
})();
check("scale ×2 about its centre: radii and area follow", gs.ok && near(gArea, 4 * (200 + Math.PI * 25), 1.5) && gsk.entities.some((e) => e.type === "circle" && near(e.r, 4)), `area=${gArea}`);
const beforeTurn = gPts().map((q) => [q.id, q.x, q.y] as const);
transformGroup(gsk, gAll, { kind: "rotate", deg: 90, about: [0, 0] });
gs = solver.solve(gsk);
check("turn 90° about the origin", gs.ok && gs.dof === 0 && beforeTurn.every(([id, x, y]) => near(ent<SkPoint>(gsk, id).x, -y, 1e-6) && near(ent<SkPoint>(gsk, id).y, x, 1e-6)));
const hv = newSketch("HV", XY);
const hvr = rect(hv, 0, 0, 10, 5);
hv.constraints.push({ id: "hh", type: "horizontal", refs: [hvr.lines[0]] }, { id: "vv", type: "vertical", refs: [hvr.lines[1]] });
const hvDrop = transformGroup(hv, hvr.lines, { kind: "rotate", deg: 30, about: [0, 0] });
check("a turn drops the H/V it breaks", hvDrop.dropped === 2 && solver.solve(hv).ok);
check("the origin cannot move", !!transformGroup(newSketch("O", XY), ["O"], { kind: "move", dx: 1, dy: 0 }).error);

// --- A large pinned import stays light for the solver (pins are constants, not equations).
let bigSvg = "";
for (let i = 0; i < 150; i++) bigSvg += `<ellipse cx="${(i % 15) * 10 + 5}" cy="${Math.floor(i / 15) * 10 + 5}" rx="4" ry="3"/>`;
const bsk = newSketch("Big", XY);
insertShapes(bsk, parseSvg(`<svg width="160mm" height="110mm" viewBox="0 0 160 110">${bigSvg}</svg>`).shapes, { scale: 1, place: "file", fixed: true });
const tBig = performance.now();
const bres = solver.solve(bsk);
const bMs = performance.now() - tBig;
check("600 pinned Béziers solve quickly", bres.ok && bres.dof === 0 && bMs < 500, `${bMs.toFixed(0)} ms`);
const fixedPt = bsk.entities.find((e): e is SkPoint => e.type === "point" && !e.fixed)!;
solver.solve(bsk, { points: [{ id: fixedPt.id, x: fixedPt.x + 5, y: fixedPt.y }] });
check("a pinned point does not follow a drag", near(ent<SkPoint>(bsk, fixedPt.id).x, fixedPt.x));

// --- Measure, on the 20 × 10 × 5 block with an M3 clearance hole through it at (5, 5).
{
  const mDoc = block({ id: "h1", kind: "hole", name: "H1", points: [[5, 5, 5]], normal: [0, 0, 1], size: "M3", fit: "clearance", head: "none", depth: 0 } as never);
  const shape = buildShape(mDoc).shape!;
  const res = buildResult(mDoc);
  check("edge groups carry the B-rep edge ids", res.edgeGroups.every((g) => shape.edges.some((e) => e.hashCode === g.id)));
  const faceAt = (n: [number, number, number], c: number) =>
    shape.faces.find((f) => {
      if (f.geomType !== "PLANE") return false;
      const v = f.normalAt(f.center);
      const p = f.center;
      return Math.abs(v.x - n[0]) + Math.abs(v.y - n[1]) + Math.abs(v.z - n[2]) < 1e-6 && Math.abs(p.x * n[0] + p.y * n[1] + p.z * n[2] - c) < 1e-6;
    })!;
  const left = faceAt([-1, 0, 0], 0);
  const right = faceAt([1, 0, 0], 20);
  const top = faceAt([0, 0, 1], 5);
  const row = (r: ReturnType<typeof measure>, label: string) => r.rows.find((x) => x.label === label)?.value ?? NaN;
  let r = measure(shape, [{ kind: "face", id: left.hashCode }, { kind: "face", id: right.hashCode }]);
  check("measure: opposite faces 20 apart, parallel", near(row(r, "Distance"), 20) && near(row(r, "Angle"), 0), JSON.stringify(r.rows));
  r = measure(shape, [{ kind: "face", id: left.hashCode }, { kind: "face", id: top.hashCode }]);
  check("measure: side and top at 90°", near(row(r, "Angle"), 90) && near(row(r, "Distance"), 0), JSON.stringify(r.rows));
  r = measure(shape, [{ kind: "face", id: right.hashCode }]);
  check("measure: face area", near(row(r, "Area"), 50), JSON.stringify(r.rows));
  const circle = shape.edges.find((e) => e.geomType === "CIRCLE")!;
  r = measure(shape, [{ kind: "edge", id: circle.hashCode }]);
  check("measure: hole edge diameter 3.4 (M3 clearance)", near(row(r, "Diameter"), 3.4, 1e-3), JSON.stringify(r.rows));
  const cz = circle.startPoint.z;
  r = measure(shape, [{ kind: "edge", id: circle.hashCode }, { kind: "point", p: [20, 5, cz] }]);
  check("measure: hole centre to a point", near(row(r, "Centre distance"), 15) && !!r.line, JSON.stringify(r.rows));
  r = measure(shape, [{ kind: "point", p: [0, 0, 0] }, { kind: "point", p: [20, 10, 5] }]);
  check("measure: two corners", near(row(r, "Distance"), Math.hypot(20, 10, 5)) && near(row(r, "ΔY"), 10), JSON.stringify(r.rows));
  const cyl = shape.faces.find((f) => f.geomType === "CYLINDRE")!;
  r = measure(shape, [{ kind: "face", id: cyl.hashCode }]);
  check("measure: hole wall radius", near(row(r, "Radius"), 1.7, 1e-3), JSON.stringify(r.rows));
  r = measure(shape, [{ kind: "face", id: cyl.hashCode }, { kind: "face", id: top.hashCode }]);
  check("measure: hole axis square to the top", near(row(r, "Angle"), 90), JSON.stringify(r.rows));
  check("measure: a face of another build", !!measure(shape, [{ kind: "face", id: -1 }]).error);
}

// --- Text: letter outlines extrude, holes of O / 8 / a stay holes.
{
  const buf = readFileSync("node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff");
  const font = parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const shapes = textShapes(font, "Oa8", 10);
  const hb = shapes.flatMap((s) => (s.kind === "line" ? [s.a, s.b] : s.kind === "bezier" ? [s.a, s.b] : []));
  const top = Math.max(...hb.map((p) => p[1]));
  check("text: capitals are as tall as asked (round letters overshoot a little)", Math.abs(top - 10) < 0.3, top.toFixed(2));
  const tSk = newSketch("T", XY);
  insertShapes(tSk, shapes, { scale: 1, place: "file", fixed: true });
  const tRegions = findRegions(tSk);
  check("text: one region per letter (holes inside)", tRegions.length === 3, String(tRegions.length));
  const tDoc: CadDocument = { format: "waffle", version: 1, features: [tSk, { id: "te", kind: "extrude", name: "TE", sketchId: tSk.id, distance: 2, symmetric: false, op: "add" }] };
  const tb = buildShape(tDoc);
  const vol = tb.shape ? measureVolume(tb.shape) : 0;
  check("text extrudes", !!tb.shape && !Object.keys(tb.errors).length && vol > 20, `${vol.toFixed(1)} mm³ ${JSON.stringify(tb.errors)}`);
}

// --- Offset.
{
  const box = (pts: [number, number][]) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((n) => +n.toFixed(6));
  };
  const newPts = (k: SketchFeature, ids: string[]) => ids.map((id) => k.entities.find((e) => e.id === id)).filter((e): e is SkPoint => e?.type === "point").map((e) => [e.x, e.y] as [number, number]);
  // Rectangle, drawn clockwise or counter-clockwise: positive grows it either way.
  for (const cw of [false, true]) {
    const o = newSketch("O", XY);
    const r = cw ? rect(o, 0, 10, 20, 0) : rect(o, 0, 0, 20, 10);
    const res = offsetEntities(o, r.lines, 2);
    const pts = newPts(o, res.added);
    check(`offset: rectangle grows by 2 (${cw ? "clockwise" : "counter-clockwise"})`, !res.error && pts.length === 4 && JSON.stringify(box(pts)) === JSON.stringify([-2, -2, 22, 12]), JSON.stringify(box(pts)));
    check("offset: the outline and its offset make a ring", findRegions(o).length === 2 || findRegions(o).some((g) => g.holes?.length), String(findRegions(o).length));
  }
  const inner = newSketch("I", XY);
  const ri = rect(inner, 0, 0, 20, 10);
  const resIn = offsetEntities(inner, ri.lines, -2);
  check("offset: negative shrinks", JSON.stringify(box(newPts(inner, resIn.added))) === JSON.stringify([2, 2, 18, 8]), JSON.stringify(box(newPts(inner, resIn.added))));
  // Slot: lines and half circles; arcs stay concentric, tangent corners stay shared.
  const so = newSketch("S", XY);
  const P = (x: number, y: number) => {
    const id = uid();
    so.entities.push({ id, type: "point", x, y });
    return id;
  };
  const [c1, c2, lo1, lo2, hi2, hi1] = [P(0, 0), P(20, 0), P(0, -5), P(20, -5), P(20, 5), P(0, 5)];
  const slotIds = [uid(), uid(), uid(), uid()];
  so.entities.push(
    { id: slotIds[0], type: "line", p1: lo1, p2: lo2 },
    { id: slotIds[1], type: "arc", c: c2, s: lo2, e: hi2 },
    { id: slotIds[2], type: "line", p1: hi2, p2: hi1 },
    { id: slotIds[3], type: "arc", c: c1, s: hi1, e: lo1 },
  );
  const rs = offsetEntities(so, slotIds, 1);
  const arcs = rs.added.map((id) => so.entities.find((e) => e.id === id)).filter((e) => e?.type === "arc") as { c: string; s: string }[];
  const sv = new SketchView(so);
  check(
    "offset: slot arcs concentric, radius 6, 4 corner points",
    arcs.length === 2 && arcs.every((a) => near(Math.hypot(sv.xy(a.s)[0] - sv.xy(a.c)[0], sv.xy(a.s)[1] - sv.xy(a.c)[1]), 6)) && arcs.some((a) => a.c === c1) && newPts(so, rs.added).length === 4,
    JSON.stringify(box(newPts(so, rs.added))),
  );
  const slotRegions = findRegions(so);
  check("offset: slot ring is extrudable", slotRegions.length >= 1);
  // Circle, and an open L.
  const co = newSketch("C", XY);
  const cc = uid();
  const circ = uid();
  co.entities.push({ id: cc, type: "point", x: 0, y: 0 }, { id: circ, type: "circle", c: cc, r: 5 });
  const rc = offsetEntities(co, [circ], -1.5);
  check("offset: circle shrinks around the same centre", (co.entities.find((e) => e.id === rc.added[0]) as { r: number; c: string }).r === 3.5);
  check("offset: too far inside is refused", !!offsetEntities(co, [circ], -6).error);
  const lo = newSketch("L", XY);
  const lp = [uid(), uid(), uid()];
  lo.entities.push({ id: lp[0], type: "point", x: 0, y: 10 }, { id: lp[1], type: "point", x: 0, y: 0 }, { id: lp[2], type: "point", x: 10, y: 0 });
  const ll = [uid(), uid()];
  lo.entities.push({ id: ll[0], type: "line", p1: lp[0], p2: lp[1] }, { id: ll[1], type: "line", p1: lp[1], p2: lp[2] });
  const rl = offsetEntities(lo, ll, 1);
  const lpts = newPts(lo, rl.added);
  // Running down then right, its right side is the outside of the corner.
  check("offset: open L keeps a sharp corner", lpts.length === 3 && lpts.some((p) => near(p[0], -1) && near(p[1], -1)), JSON.stringify(lpts));
}

// --- Ellipse: solver, minor radius dimension, extrusion (tilted), as a hole.
{
  const ek = newSketch("E", XY);
  const [ec, em] = [uid(), uid()];
  const ang = Math.PI / 6;
  ek.entities.push({ id: ec, type: "point", x: 5, y: 3 }, { id: em, type: "point", x: 5 + 10 * Math.cos(ang), y: 3 + 10 * Math.sin(ang) });
  const ell = uid();
  ek.entities.push({ id: ell, type: "ellipse", c: ec, m: em, rb: 4 });
  let er = solver.solve(ek);
  check("ellipse: 5 degrees of freedom, unchanged by solving", er.ok && er.dof === 5 && near((ek.entities.find((e) => e.id === ell) as { rb: number }).rb, 4), `dof=${er.dof}`);
  const rdim = { id: uid(), type: "radius" as const, refs: [ell], value: 2.5 };
  ek.constraints.push(rdim);
  er = solver.solve(ek);
  const ev = new SketchView(ek);
  check("ellipse: minor radius dimension", er.ok && er.dof === 4 && near((ek.entities.find((e) => e.id === ell) as { rb: number }).rb, 2.5), `dof=${er.dof}`);
  const ra = Math.hypot(ev.xy(em)[0] - ev.xy(ec)[0], ev.xy(em)[1] - ev.xy(ec)[1]);
  const eRegions = findRegions(ek);
  check("ellipse: one region", eRegions.length === 1 && eRegions[0].outer.kind === "ellipse");
  const eDoc: CadDocument = { format: "waffle", version: 1, features: [ek, { id: "ee", kind: "extrude", name: "EE", sketchId: ek.id, distance: 2, symmetric: false, op: "add" }] };
  const eb = buildShape(eDoc);
  const ev2 = eb.shape ? measureVolume(eb.shape) : 0;
  check("ellipse extrudes (π·ra·rb·h)", near(ev2, Math.PI * ra * 2.5 * 2, 1e-3), `${ev2.toFixed(4)} ra=${ra.toFixed(3)}`);
  const ebb = eb.shape!.boundingBox.bounds;
  // The tilt shows in the box: wider than the minor radius both ways.
  check("ellipse keeps its tilt", ebb[1][1] - ebb[0][1] > 2 * 2.5 + 1, JSON.stringify(ebb));
  const hk = newSketch("H", XY);
  rect(hk, -20, -10, 30, 20);
  const [hc, hm] = [uid(), uid()];
  hk.entities.push({ id: hc, type: "point", x: 5, y: 5 }, { id: hm, type: "point", x: 13, y: 5 }, { id: uid(), type: "ellipse", c: hc, m: hm, rb: 3 });
  const hr = findRegions(hk);
  check("ellipse inside a rectangle is a hole", hr.length === 1 && hr[0].holes.length === 1, JSON.stringify(hr.map((r) => r.holes.length)));
}

// --- 3MF: a closed mesh in a valid zip.
{
  const blob = exportFile(block(), "3mf", "Block & co")!;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const nv = (text.match(/<vertex /g) ?? []).length;
  const nt = (text.match(/<triangle /g) ?? []).length;
  check("3MF: zip with the model, block welded to 8 vertices / 12 triangles", bytes[0] === 0x50 && bytes[1] === 0x4b && text.includes("3D/3dmodel.model") && nv === 8 && nt === 12, `${nv} ${nt}`);
  check("3MF: name escaped", text.includes('name="Block &#38; co"'));
}

// --- STEP import: the block exported, read back as a step of another model.
{
  const stepText = await exportFile(block(), "step")!.text();
  const imp = (op: "add" | "cut", before: CadDocument["features"] = []): CadDocument => ({
    format: "waffle",
    version: 1,
    features: [...before, { id: "im", kind: "import", name: "Block", fileId: "f1", op }],
    files: { f1: stepText },
  });
  const ib = buildShape(imp("add"));
  check("STEP import: the block comes back whole", !!ib.shape && !Object.keys(ib.errors).length && near(measureVolume(ib.shape), 1000, 1e-3), JSON.stringify(ib.errors));
  // Cut from a bigger block (30 × 10 × 5 from x = -5): 1500 − 1000 left.
  const bigSk = newSketch("Big", XY);
  rect(bigSk, -5, 0, 25, 10);
  const cutDoc = imp("cut", [bigSk, { id: "eb2", kind: "extrude", name: "E", sketchId: bigSk.id, distance: 5, symmetric: false, op: "add" }]);
  const cb = buildShape(cutDoc);
  check("STEP import: cut from the model", !!cb.shape && near(measureVolume(cb.shape), 500, 1e-3), JSON.stringify(cb.errors));
  const bad = buildShape({ ...imp("add"), files: { f1: "ISO-10303-21; nonsense" } });
  check("STEP import: an unreadable file is reported on its step", !!bad.errors.im, JSON.stringify(bad.errors));
}

// --- Bodies: a 20 × 10 × 5 box and a 2 mm lid on it, kept apart.
{
  const lidSk = newSketch("L", { ...XY, origin: [0, 0, 5] });
  rect(lidSk, 0, 0, 20, 10);
  const two = (...more: CadDocument["features"]): CadDocument =>
    block(lidSk, { id: "lid", kind: "extrude", name: "Lid", sketchId: lidSk.id, distance: 2, symmetric: false, op: "add", body: "new" }, ...more);
  const vol = (d: CadDocument) => {
    const r = buildShape(d);
    return { r, v: r.bodies.map((b) => measureVolume(b.shape)) };
  };
  let t = vol(two());
  check("bodies: box and lid stay two solids", t.r.bodies.length === 2 && near(t.v[0], 1000) && near(t.v[1], 400), JSON.stringify(t.v));
  const joined = vol(block(lidSk, { id: "lid", kind: "extrude", name: "Lid", sketchId: lidSk.id, distance: 2, symmetric: false, op: "add" }));
  check("bodies: without New body it joins (as before)", joined.r.bodies.length === 1 && near(joined.v[0], 1400), JSON.stringify(joined.v));
  // A hole goes through both.
  const hole = { id: "h", kind: "hole", name: "H", points: [[10, 5, 7]], normal: [0, 0, 1], size: "M3", fit: "clearance", head: "none", depth: 0 } as never;
  t = vol(two(hole));
  const hv = Math.PI * 1.7 * 1.7;
  check("bodies: a hole drills both", near(t.v[0], 1000 - hv * 5, 1e-3) && near(t.v[1], 400 - hv * 2, 1e-3), JSON.stringify(t.v));
  // Press Pull on the lid's top only grows the lid.
  t = vol(two({ id: "pp", kind: "pushpull", name: "PP", face: { center: [10, 5, 7], normal: [0, 0, 1] }, distance: 3 }));
  check("bodies: Press Pull works on the face's body", near(t.v[0], 1000) && near(t.v[1], 1000), JSON.stringify(t.v));
  // A fillet on a top edge of the lid.
  t = vol(two({ id: "fl", kind: "fillet", name: "F", mode: "fillet", edges: [{ mid: [10, 0, 7] }], radius: 1 }));
  check("bodies: a fillet rounds the lid, not the box", near(t.v[0], 1000) && t.v[1] < 400 && t.v[1] > 395, JSON.stringify(t.v));
  // A cut limited to the lid.
  const cutSk = newSketch("C", { ...XY, origin: [0, 0, 7] });
  rect(cutSk, 5, 2, 15, 8);
  t = vol(two(cutSk, { id: "cl", kind: "extrude", name: "Cut", sketchId: cutSk.id, distance: -4, symmetric: false, op: "cut", body: "lid" }));
  check("bodies: a cut can keep to one body", near(t.v[0], 1000) && near(t.v[1], 400 - 120), JSON.stringify(t.v));
  t = vol(two(cutSk, { id: "cl", kind: "extrude", name: "Cut", sketchId: cutSk.id, distance: -4, symmetric: false, op: "cut" }));
  check("bodies: a cut with no body chosen cuts them all", near(t.v[0], 1000 - 120) && near(t.v[1], 400 - 120), JSON.stringify(t.v));
  const res = buildResult({ ...two(), bodyNames: { lid: "Lid" } });
  check("bodies: names and faces reported", res.bodies?.map((b) => b.name).join() === "Body 1,Lid" && res.bodies.every((b) => b.faceIds.length === 6), JSON.stringify(res.bodies?.map((b) => [b.name, b.faceIds.length])));
  const text = new TextDecoder().decode(new Uint8Array(await exportFile({ ...two(), bodyNames: { lid: "Lid" } }, "3mf", "Box")!.arrayBuffer()));
  check("bodies: 3MF has one object per body", (text.match(/<object /g) ?? []).length === 2 && text.includes('name="Lid"') && (text.match(/<item /g) ?? []).length === 2);
}

// --- Assemblies: a part (the 20 × 10 × 5 box) placed twice, from another project.
{
  setPartDocs({ p1: block() });
  const asm = (...instances: PartInstance[]): CadDocument => ({ format: "waffle", version: 1, features: [], kind: "assembly", instances });
  const a: PartInstance = { id: "a", project: "p1", name: "Box 1", at: [0, 0, 0], rot: [0, 0, 0] };
  const b: PartInstance = { id: "b", project: "p1", name: "Box 2", at: [30, 0, 0], rot: [0, 0, 90] };
  const r = buildShape(asm(a, b));
  const bb = r.bodies[1]?.shape.boundingBox.bounds;
  check("assembly: two copies of a part, apart", r.bodies.length === 2 && r.bodies.every((x) => near(measureVolume(x.shape), 1000, 1e-3)), JSON.stringify(r.errors));
  check("assembly: turned about Z, then moved", !!bb && near(bb[0][0], 20, 1e-3) && near(bb[1][0], 30, 1e-3) && near(bb[0][1], 0, 1e-3) && near(bb[1][1], 20, 1e-3), JSON.stringify(bb));
  // Any turn matches the app's own matrix (three.js "XYZ" Euler angles).
  const c: PartInstance = { id: "c", project: "p1", name: "C", at: [1, 2, 3], rot: [30, 45, 60] };
  const cb = buildShape(asm(c)).bodies[0].shape.boundingBox.bounds;
  const m = new THREE.Matrix4().compose(new THREE.Vector3(1, 2, 3), new THREE.Quaternion().setFromEuler(new THREE.Euler(...([30, 45, 60].map((d) => (d * Math.PI) / 180) as [number, number, number]), "XYZ")), new THREE.Vector3(1, 1, 1));
  const box = new THREE.Box3();
  for (const x of [0, 20]) for (const y of [0, 10]) for (const z of [0, 5]) box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(m));
  check("assembly: turns match the view", [0, 1, 2].every((k) => near(cb[0][k], box.min.getComponent(k), 1e-3) && near(cb[1][k], box.max.getComponent(k), 1e-3)), JSON.stringify([cb, box.min, box.max]));
  check("assembly: unchanged, the same shape comes back (its mesh is reused)", buildShape(asm(a, b)).shape === buildShape(asm(a, b)).shape);
  const gone = buildShape(asm(a, { ...b, project: "nope" }));
  check("assembly: a part whose project is gone is reported", gone.bodies.length === 1 && !!gone.errors.b, JSON.stringify(gone.errors));
  const one = buildResult(asm(a));
  check("assembly: a single part is still told apart", one.bodies?.length === 1 && one.bodies[0].name === "Box 1" && one.bodies[0].faceIds.length === 6 && one.bodies[0].edgeIds.length === 12);
  const text = new TextDecoder().decode(new Uint8Array(await exportFile(asm(a, b), "3mf", "Asm")!.arrayBuffer()));
  check("assembly: 3MF has one object per part, by name", (text.match(/<object /g) ?? []).length === 2 && text.includes('name="Box 1"') && text.includes('name="Box 2"'));
}

// --- Mates: B (the 20 × 10 × 5 box, placed anyhow) brought onto A (fixed at the origin).
{
  const A: PartInstance = { id: "A", project: "p", name: "A", at: [0, 0, 0], rot: [0, 0, 0], fixed: true };
  const B: PartInstance = { id: "B", project: "p", name: "B", at: [60, 20, 3], rot: [20, -35, 50] };
  const ref = (part: string, kind: MateRef["kind"], origin: [number, number, number], dir: [number, number, number]): MateRef => ({ part, kind, origin, dir });
  const top = ref("A", "plane", [10, 5, 5], [0, 0, 1]);
  const bottom = ref("B", "plane", [10, 5, 0], [0, 0, -1]);
  const mate = (id: string, kind: Mate["kind"], a: MateRef, b: MateRef, value = 0): Mate => ({ id, name: id, kind, a, b, value });
  const placedB = (sol: ReturnType<typeof solveMates>) => ({ ...B, ...sol.placed.get("B")! });
  let sol = solveMates([A, B], [mate("t", "touch", top, bottom)]);
  let wb = worldRef(bottom, instanceMatrix(placedB(sol)));
  check("mates: touch puts B's bottom on A's top", !sol.failing.length && near(wb.origin.z, 5, 1e-5) && near(wb.dir.z, -1, 1e-6) && sol.dof === 3, JSON.stringify([sol, wb]));
  // Two pins: a hole axis at (5, 5) and one at (15, 5) on each part.
  const axisA1 = ref("A", "axis", [5, 5, 0], [0, 0, 1]);
  const axisB1 = ref("B", "axis", [5, 5, 0], [0, 0, 1]);
  sol = solveMates([A, B], [mate("t", "touch", top, bottom), mate("x", "axis", axisA1, axisB1)]);
  check("mates: touch + one axis leaves the turn about it", !sol.failing.length && sol.dof === 1, JSON.stringify(sol));
  sol = solveMates([A, B], [mate("t", "touch", top, bottom), mate("x", "axis", axisA1, axisB1), mate("y", "axis", ref("A", "axis", [15, 5, 0], [0, 0, 1]), ref("B", "axis", [15, 5, 0], [0, 0, 1]))]);
  const p = placedB(sol);
  check("mates: two axes place B exactly on A", !sol.failing.length && sol.dof === 0 && near(p.at[0], 0, 1e-5) && near(p.at[1], 0, 1e-5) && near(p.at[2], 5, 1e-5) && p.rot.every((r) => near(r, 0, 1e-4)), JSON.stringify(p));
  // Flush tops, from B lying upside down with its top facing A's top exactly.
  const topB = ref("B", "plane", [10, 5, 5], [0, 0, 1]);
  sol = solveMates([A, { ...B, at: [40, 0, 10], rot: [180, 0, 0] }], [mate("f", "align", top, topB)]);
  const fb = worldRef(topB, instanceMatrix({ ...B, ...sol.placed.get("B")! }));
  check("mates: flush from upside down turns it over", !sol.failing.length && near(fb.dir.z, 1, 1e-6) && near(fb.origin.z, 5, 1e-5), JSON.stringify([sol, fb]));
  // A drawer: flush with travel limits keeps a slide free inside them, and brings it back inside.
  const travel = { ...mate("f", "align", top, topB), min: 0, max: 10 };
  sol = solveMates([A, { ...B, at: [40, 0, 20], rot: [0, 0, 0] }], [travel]);
  const fz = worldRef(topB, instanceMatrix({ ...B, ...sol.placed.get("B")! })).origin.z;
  check("mates: limits bring a part back to the nearest one", !sol.failing.length && near(fz, 15, 1e-5) && sol.dof === 3, JSON.stringify([sol, fz]));
  sol = solveMates([A, { ...B, at: [40, 0, 4], rot: [0, 0, 0] }], [travel]);
  check("mates: inside its limits a part stays where it is", !sol.failing.length && JSON.stringify(sol.placed.get("B")) === JSON.stringify({ at: [40, 0, 4], rot: [0, 0, 0] }) && sol.dof === 4, JSON.stringify(sol));
  sol = solveMates([A, B], [mate("t", "touch", top, bottom), mate("g", "touch", top, bottom, 3)]);
  check("mates: contradicting mates are reported, nothing moves", sol.failing.length > 0 && sol.placed.size === 0, JSON.stringify(sol.failing));
  sol = solveMates([A, B], [mate("x", "axis", axisA1, axisB1), mate("a", "angle", ref("A", "plane", [20, 5, 2.5], [1, 0, 0]), ref("B", "plane", [20, 5, 2.5], [1, 0, 0]), 90)]);
  const wa = worldRef(ref("B", "plane", [20, 5, 2.5], [1, 0, 0]), instanceMatrix(placedB(sol)));
  check("mates: an angle about an axis", !sol.failing.length && near(wa.dir.x, 0, 1e-5) && near(Math.abs(wa.dir.y), 1, 1e-5) && sol.dof === 1, JSON.stringify([sol, wa]));
  // Faces and holes of a real part, read for mates, and found again only while they are there.
  const holed = buildShape(block({ id: "h", kind: "hole", name: "H", points: [[5, 5, 5]], normal: [0, 0, 1], size: "M3", fit: "clearance", head: "none", depth: 0 } as never)).shape!;
  const topFace = holed.faces.find((f) => f.geomType === "PLANE" && near(f.center.z, 5))!;
  const hole = holed.faces.find((f) => f.geomType === "CYLINDRE")!;
  const g1 = refGeometry(holed, { kind: "face", id: topFace.hashCode });
  const g2 = refGeometry(holed, { kind: "face", id: hole.hashCode });
  check("mates: a flat face gives its plane, a hole its axis", g1?.kind === "plane" && near(g1.dir[2], 1) && g2?.kind === "axis" && near(g2.origin[0], 5, 1e-6) && near(g2.origin[1], 5, 1e-6) && near(Math.abs(g2.dir[2]), 1), JSON.stringify([g1, g2]));
  check("mates: a face still there is found, a moved one is not", hasRef(holed, g2!) && hasRef(holed, g1!) && !hasRef(holed, { ...g2!, origin: [6, 5, 0] }));
  const asmDoc: CadDocument = { format: "waffle", version: 1, features: [], kind: "assembly", instances: [{ id: "a", project: "p1", name: "A", at: [0, 0, 0], rot: [0, 0, 0] }], mates: [{ id: "m", name: "M", kind: "touch", a: { part: "a", kind: "plane", origin: [10, 5, 7], dir: [0, 0, 1] }, b: { part: "a", kind: "plane", origin: [10, 5, 5], dir: [0, 0, 1] }, value: 0 }] };
  setPartDocs({ p1: block() });
  check("mates: a face gone from its part is reported", !!buildShape(asmDoc).warnings.m, JSON.stringify(buildShape(asmDoc).warnings));
}

// --- Interference: two boxes 10 mm into each other, and two only touching.
{
  setPartDocs({ p1: block() });
  const two = (x: number): CadDocument => ({ format: "waffle", version: 1, features: [], kind: "assembly", instances: [
    { id: "a", project: "p1", name: "A", at: [0, 0, 0], rot: [0, 0, 0] },
    { id: "b", project: "p1", name: "B", at: [x, 0, 0], rot: [0, 0, 0] },
  ] });
  const over = interferences(two(10));
  check("interference: overlapping parts, with the volume", over.length === 1 && near(over[0].volume, 500, 1e-3) && over[0].triangles.length > 0, JSON.stringify(over.map((c) => c.volume)));
  check("interference: parts that only touch do not count", interferences(two(20)).length === 0);
  check("interference: hidden parts are left out", interferences(two(10), ["b"]).length === 0);
}

// --- Outputs: named STEP, the 3MF plate, an assembly's STEP read back as parts.
{
  setPartDocs({ p1: block() });
  const asmDoc: CadDocument = { format: "waffle", version: 1, features: [], kind: "assembly", instances: [
    { id: "a", project: "p1", name: "Box 1", at: [0, 0, 0], rot: [0, 0, 0] },
    { id: "b", project: "p1", name: "Box 2", at: [0, 0, 30], rot: [90, 0, 0] },
  ] };
  const step = await exportFile(asmDoc, "step", "Asm")!.text();
  check("outputs: STEP names and colours each part", step.includes("'Box 1'") && step.includes("'Box 2'") && /COLOUR_RGB/.test(step));
  const stood = placeShape(buildShape(block()).shape!, { at: [3, 4, 9], rot: [90, 0, 0] });
  const flat = layFlat(stood).boundingBox.bounds;
  check("outputs: a part stood on its side lies flat again", near(flat[0][2], 0, 1e-6) && near(flat[1][2], 5, 1e-6) && near(flat[0][0], 0, 1e-6), JSON.stringify(flat));
  const plate3mf = new TextDecoder().decode(new Uint8Array(await exportFile(asmDoc, "plate", "Asm")!.arrayBuffer()));
  const zs = [...plate3mf.matchAll(/ z="([-\d.e]+)"/g)].map((m) => Number(m[1]));
  check("outputs: the plate has every part, all resting on z = 0", (plate3mf.match(/<object /g) ?? []).length === 2 && Math.min(...zs) > -1e-6 && Math.max(...zs) < 5 + 1e-6, JSON.stringify([Math.min(...zs), Math.max(...zs)]));
  const parts = await splitStep(step);
  check("outputs: an assembly's STEP splits into its parts", parts.length === 2 && parts.every((t) => near(measureVolume(readStep(t)), 1000, 1e-3)), String(parts.length));
  check("outputs: a single solid is not split", (await splitStep(await exportFile(block(), "step")!.text())).length === 0);
}

console.log(failures ? `${failures} failure(s)` : "all tests passed");
process.exit(failures ? 1 : 0);
