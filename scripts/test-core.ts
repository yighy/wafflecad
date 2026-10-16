// Core tests under Node: solver, profile detection, solid build. Run: npm test
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { Solver } from "../src/sketch/solver";
import { newSketch, uid } from "../src/sketch/model";
import { findRegions } from "../src/sketch/profiles";
import { buildResult, buildShape, exportFile } from "../src/cad/build";
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
check("pull top face +3", !pp.errors.pp && near(pp.shape!.boundingBox.bounds[1][2], 8), JSON.stringify(pp.errors));
pp = buildShape(block({ id: "pp", kind: "pushpull", name: "PP", face: topRef, distance: -2 }));
check("push top face −2", !pp.errors.pp && near(pp.shape!.boundingBox.bounds[1][2], 3), JSON.stringify(pp.errors));
pp = buildShape(block({ id: "pp", kind: "pushpull", name: "PP", face: { center: [10, 5, 9], normal: [0, 0, 1] }, distance: 1 }));
check("missing face reported", !!pp.errors.pp, JSON.stringify(pp.errors));
const sh = buildShape(block({ id: "sh", kind: "shell", name: "SH", faces: [topRef], thickness: 1 }));
check("shell open top, 1 mm walls", !sh.errors.sh && near(measureVolume(sh.shape!), 1000 - 18 * 8 * 4, 1e-3), `${JSON.stringify(sh.errors)} vol=${sh.shape && measureVolume(sh.shape)}`);
check("shell keeps outer size", near(sh.shape!.boundingBox.bounds[1][0], 20) && near(sh.shape!.boundingBox.bounds[1][2], 5));
// Faces reported by the build can be used as references.
const pfs = buildResult(block()).planarFaces;
const topFace = pfs.find((f) => near(f.plane.normal[2], 1));
const pp2 = buildShape(block({ id: "pp", kind: "pushpull", name: "PP", face: { center: topFace!.center, normal: topFace!.plane.normal }, distance: 2 }));
check("planarFaces centre works as reference", !pp2.errors.pp && near(pp2.shape!.boundingBox.bounds[1][2], 7), JSON.stringify(pp2.errors));

console.log(failures ? `${failures} failure(s)` : "all tests passed");
process.exit(failures ? 1 : 0);
