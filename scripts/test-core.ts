// Core tests under Node: solver, profile detection, solid build. Run: npm test
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { Solver } from "../src/sketch/solver";
import { deleteEntities, mergePoints, newSketch, uid } from "../src/sketch/model";
import { findRegions, sampleSegments, signedArea } from "../src/sketch/profiles";
import { trimPlan } from "../src/sketch/trim";
import { filletCorner, mirrorEntities, projectEdge } from "../src/sketch/ops";
import { SketchView } from "../src/sketch/model";
import { buildResult, buildShape, exportFile } from "../src/cad/build";
import { applyParameters, evaluate, renameInExpr, resolveParameters } from "../src/params";
import type { CadDocument, PlaneDef, SkEntity, SkLine, SkPoint, SketchFeature } from "../src/types";

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
  format: "touch-cad",
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
  format: "touch-cad",
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
  format: "touch-cad",
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
    format: "touch-cad",
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
  format: "touch-cad",
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
const spDoc: CadDocument = { format: "touch-cad", version: 1, features: [blob.s, { id: "se", kind: "extrude", name: "SE", sketchId: blob.s.id, distance: 5, symmetric: false, op: "add" }] };
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
check("fillet removes the sharp corner point", !fsk.entities.some((e) => e.id === fr.pts[2]));
check("fillet too large refused", filletCorner(fsk, fr.pts[0], 50) !== null);
const fDoc: CadDocument = { format: "touch-cad", version: 1, features: [fsk, { id: "fe", kind: "extrude", name: "FE", sketchId: fsk.id, distance: 2, symmetric: false, op: "add" }] };
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
const blockDoc: CadDocument = { format: "touch-cad", version: 1, features: [sk, { id: "e1", kind: "extrude", name: "E1", sketchId: sk.id, distance: 5, symmetric: false, op: "add" }] };
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

console.log(failures ? `${failures} failure(s)` : "all tests passed");
process.exit(failures ? 1 : 0);
