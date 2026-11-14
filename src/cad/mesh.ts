// Triangle meshes (STL files) as bodies of a part, and the booleans between them and exact solids.
// The exact solids are OpenCascade's; meshes go through Manifold (WASM), which is fast and robust
// on large meshes where OpenCascade's booleans on triangles are slow and fail.
import type { Shape3D } from "replicad";
import type { Manifold, ManifoldToplevel, Mat4 } from "manifold-3d";

let wasm: ManifoldToplevel | null = null;

/** Loads Manifold (once). `wasmUrl`: where the browser finds its .wasm (Node finds it by itself). */
export async function initManifold(wasmUrl?: string) {
  if (wasm) return;
  const Module = (await import("manifold-3d")).default;
  const m = await Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  m.setup();
  wasm = m;
}

function kernel(): ManifoldToplevel {
  if (!wasm) throw new Error("The mesh kernel is not loaded");
  return wasm;
}

/**
 * A body made of triangles: indexed, with vertices shared between triangles. `closed`: it encloses
 * a volume (no holes, no loose triangles), so it can be joined, cut and intersected.
 */
export class MeshSolid {
  readonly isMesh = true;
  constructor(
    readonly vertices: Float32Array,
    readonly triangles: Uint32Array,
    readonly closed: boolean,
  ) {}
  get triangleCount() {
    return this.triangles.length / 3;
  }
  bounds(): [[number, number, number], [number, number, number]] {
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const v = this.vertices;
    for (let i = 0; i < v.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (v[i + k] < lo[k]) lo[k] = v[i + k];
        if (v[i + k] > hi[k]) hi[k] = v[i + k];
      }
    return [lo, hi];
  }
}

export type AnySolid = Shape3D | MeshSolid;
export const isMesh = (s: unknown): s is MeshSolid => !!s && (s as MeshSolid).isMesh === true;

// ---------- Reading STL files ----------

/** Vertices merged where they are at the same place (STL repeats them in every triangle). */
function weld(points: ArrayLike<number>, triangles: ArrayLike<number> | null): { vertices: Float32Array; triangles: Uint32Array } {
  const n = points.length / 3;
  const index = new Map<string, number>();
  const verts: number[] = [];
  const remap = new Uint32Array(n);
  // 0.1 µm: points meant to be the same are written the same, or within float rounding.
  const q = (x: number) => Math.round(x * 1e4);
  for (let i = 0; i < n; i++) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    const key = `${q(x)},${q(y)},${q(z)}`;
    let k = index.get(key);
    if (k === undefined) {
      k = verts.length / 3;
      index.set(key, k);
      verts.push(x, y, z);
    }
    remap[i] = k;
  }
  const out: number[] = [];
  const count = triangles ? triangles.length / 3 : n / 3;
  for (let t = 0; t < count; t++) {
    const a = remap[triangles ? triangles[t * 3] : t * 3];
    const b = remap[triangles ? triangles[t * 3 + 1] : t * 3 + 1];
    const c = remap[triangles ? triangles[t * 3 + 2] : t * 3 + 2];
    if (a !== b && b !== c && a !== c) out.push(a, b, c); // degenerate ones dropped
  }
  return { vertices: new Float32Array(verts), triangles: new Uint32Array(out) };
}

/** Whether a mesh encloses a volume (Manifold accepts it as a solid). */
function isClosed(vertices: Float32Array, triangles: Uint32Array): boolean {
  if (!triangles.length) return false;
  const w = kernel();
  const mesh = new w.Mesh({ numProp: 3, vertProperties: vertices, triVerts: triangles });
  mesh.merge();
  let m: Manifold | null = null;
  try {
    m = new w.Manifold(mesh);
    return m.status() === "NoError" && !m.isEmpty();
  } catch {
    return false;
  } finally {
    m?.delete();
  }
}

/** A mesh from arrays, told whether it is closed. */
export function meshSolid(vertices: Float32Array, triangles: Uint32Array): MeshSolid {
  return new MeshSolid(vertices, triangles, isClosed(vertices, triangles));
}

/** The triangles of an STL file (binary or text), welded. Units are taken as millimetres. */
export function parseStl(bytes: Uint8Array): { vertices: Float32Array; triangles: Uint32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binaryCount = bytes.length >= 84 ? view.getUint32(80, true) : -1;
  const binary = binaryCount >= 0 && 84 + binaryCount * 50 === bytes.length;
  let points: Float32Array;
  if (binary) {
    points = new Float32Array(binaryCount * 9);
    for (let t = 0; t < binaryCount; t++) {
      const at = 84 + t * 50 + 12; // after the normal, which is worked out again
      for (let k = 0; k < 9; k++) points[t * 9 + k] = view.getFloat32(at + k * 4, true);
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    if (!/^\s*solid/i.test(text) || !/vertex/i.test(text)) throw new Error("This is not an STL file");
    const nums: number[] = [];
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
    for (let m = re.exec(text); m; m = re.exec(text)) nums.push(+m[1], +m[2], +m[3]);
    if (nums.length % 9 || nums.some((x) => !Number.isFinite(x))) throw new Error("This STL file is damaged");
    points = new Float32Array(nums);
  }
  if (!points.length) throw new Error("This STL file has no triangles");
  if (points.some((x) => !Number.isFinite(x))) throw new Error("This STL file is damaged");
  return weld(points, null);
}

// ---------- Storing a mesh in the document ----------

const PREFIX = "wmesh1:";
export const isMeshText = (text: string) => text.startsWith(PREFIX);

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=") + (i + 2 < bytes.length ? B64[c & 63] : "=");
    if (s.length > 8192) {
      parts.push(s);
      s = "";
    }
  }
  parts.push(s);
  return parts.join("");
}
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;
function fromBase64(text: string, start: number): Uint8Array {
  let end = text.length;
  while (end > start && text[end - 1] === "=") end--;
  const n = end - start;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  for (let i = start; i < end; i += 4) {
    const a = B64_INDEX[text.charCodeAt(i)];
    const b = B64_INDEX[text.charCodeAt(i + 1)];
    const c = i + 2 < end ? B64_INDEX[text.charCodeAt(i + 2)] : 0;
    const d = i + 3 < end ? B64_INDEX[text.charCodeAt(i + 3)] : 0;
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("The stored mesh is damaged");
    out[o++] = (a << 2) | (b >> 4);
    if (o < out.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (o < out.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

/** A mesh as text for the document's files: vertex and triangle counts, then the arrays, in base64. */
export function encodeMesh(m: { vertices: Float32Array; triangles: Uint32Array }): string {
  const bytes = new Uint8Array(8 + m.vertices.byteLength + m.triangles.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, m.vertices.length / 3, true);
  view.setUint32(4, m.triangles.length / 3, true);
  bytes.set(new Uint8Array(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength), 8);
  bytes.set(new Uint8Array(m.triangles.buffer, m.triangles.byteOffset, m.triangles.byteLength), 8 + m.vertices.byteLength);
  return PREFIX + toBase64(bytes);
}

export function decodeMesh(text: string): { vertices: Float32Array; triangles: Uint32Array } {
  if (!isMeshText(text)) throw new Error("This is not a stored mesh");
  const bytes = fromBase64(text, PREFIX.length);
  const view = new DataView(bytes.buffer);
  const nv = view.getUint32(0, true);
  const nt = view.getUint32(4, true);
  if (bytes.length < 8 + nv * 12 + nt * 12) throw new Error("The stored mesh is damaged");
  // Copied out, so the arrays are aligned whatever the offsets.
  const vertices = new Float32Array(bytes.slice(8, 8 + nv * 12).buffer);
  const triangles = new Uint32Array(bytes.slice(8 + nv * 12, 8 + nv * 12 + nt * 12).buffer);
  if (triangles.some((i) => i >= nv)) throw new Error("The stored mesh is damaged");
  return { vertices, triangles };
}

// ---------- Booleans ----------

const TESSELLATE = { tolerance: 0.01, angularTolerance: 0.1 };

/** An exact solid turned into triangles, fine enough for printing (the export's quality). */
export function tessellate(s: Shape3D): { vertices: Float32Array; triangles: Uint32Array } {
  const m = s.mesh(TESSELLATE);
  // Each face is meshed apart: the points along shared edges are repeated, so welded.
  return weld(m.vertices, m.triangles);
}

function toManifold(s: AnySolid): Manifold {
  const w = kernel();
  const m = isMesh(s) ? s : tessellate(s);
  if (isMesh(s) && !s.closed) throw new Error("The mesh is not closed (holes or loose triangles): it can only be shown and exported, not joined, cut or intersected");
  const mesh = new w.Mesh({ numProp: 3, vertProperties: m.vertices, triVerts: m.triangles });
  mesh.merge();
  const out = new w.Manifold(mesh);
  if (out.status() !== "NoError") {
    out.delete();
    throw new Error(isMesh(s) ? "The mesh could not be read as a solid" : "This solid could not be turned into a mesh");
  }
  return out;
}

function fromManifold(m: Manifold): MeshSolid {
  const g = m.getMesh();
  const n = g.numProp;
  let vertices = g.vertProperties;
  if (n !== 3) {
    vertices = new Float32Array((g.vertProperties.length / n) * 3);
    for (let i = 0; i < vertices.length / 3; i++) for (let k = 0; k < 3; k++) vertices[i * 3 + k] = g.vertProperties[i * n + k];
  } else vertices = vertices.slice();
  return new MeshSolid(vertices, g.triVerts.slice(), true);
}

/** a joined with, cut by, or cut down to b. One of them at least is a mesh; so is the result. */
export function meshBoolean(a: AnySolid, b: AnySolid, op: "add" | "cut" | "intersect"): MeshSolid {
  const ma = toManifold(a);
  let mb: Manifold | null = null;
  let r: Manifold | null = null;
  try {
    mb = toManifold(b);
    r = op === "add" ? ma.add(mb) : op === "cut" ? ma.subtract(mb) : ma.intersect(mb);
    return fromManifold(r);
  } finally {
    ma.delete();
    mb?.delete();
    r?.delete();
  }
}

/** An exact solid as a closed mesh (a mesh stays as it is). */
export function asMesh(s: AnySolid): MeshSolid {
  if (isMesh(s)) return s;
  const m = toManifold(s);
  try {
    return fromManifold(m);
  } finally {
    m.delete();
  }
}

/** Whether two solids' boxes overlap (a boolean between them can change something). */
export function boxesMeet(a: [number[], number[]], b: [number[], number[]]) {
  return [0, 1, 2].every((k) => a[1][k] > b[0][k] - 1e-6 && b[1][k] > a[0][k] - 1e-6);
}

export function meshVolume(s: MeshSolid): number {
  if (!s.closed) return 0;
  const m = toManifold(s);
  try {
    return m.volume();
  } finally {
    m.delete();
  }
}

// ---------- Moving copies (patterns, assemblies) ----------

/** A copy moved by a 4×4 matrix (column-major, as three.js and Manifold store it). */
export function transformMesh(s: MeshSolid, m: Mat4 | number[]): MeshSolid {
  const v = s.vertices;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i];
    const y = v[i + 1];
    const z = v[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  // A mirror turns the triangles inside out: their order is flipped back.
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  let t = s.triangles;
  if (det < 0) {
    t = t.slice();
    for (let i = 0; i < t.length; i += 3) [t[i + 1], t[i + 2]] = [t[i + 2], t[i + 1]];
  }
  return new MeshSolid(out, t, s.closed);
}

export const translation = (d: readonly number[]): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0], d[1], d[2], 1];

/** Turn by `deg` about an axis through the origin. */
export function rotation(deg: number, axis: readonly number[]): number[] {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  const [x, y, z] = [axis[0] / len, axis[1] / len, axis[2] / len];
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
}

/** Mirror in the plane through `origin` with normal `n`. */
export function mirroring(n: readonly number[], origin: readonly number[]): number[] {
  const len = Math.hypot(n[0], n[1], n[2]);
  const [x, y, z] = [n[0] / len, n[1] / len, n[2] / len];
  const d = 2 * (x * origin[0] + y * origin[1] + z * origin[2]);
  return [1 - 2 * x * x, -2 * x * y, -2 * x * z, 0, -2 * x * y, 1 - 2 * y * y, -2 * y * z, 0, -2 * x * z, -2 * y * z, 1 - 2 * z * z, 0, d * x, d * y, d * z, 1];
}

// ---------- Display ----------

/**
 * Triangles for display: each with its own three corners and the triangle's normal (flat shading:
 * a mesh has no smooth surfaces to follow), and the lines where its surface folds sharply.
 */
export function displayMesh(s: MeshSolid): { vertices: Float32Array; normals: Float32Array; triangles: Uint32Array; edges: Float32Array } {
  const v = s.vertices;
  const t = s.triangles;
  const nt = t.length / 3;
  const vertices = new Float32Array(nt * 9);
  const normals = new Float32Array(nt * 9);
  const triNormals = new Float32Array(nt * 3);
  for (let i = 0; i < nt; i++) {
    const a = t[i * 3] * 3;
    const b = t[i * 3 + 1] * 3;
    const c = t[i * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    triNormals.set([nx, ny, nz], i * 3);
    for (let k = 0; k < 3; k++) {
      const p = t[i * 3 + k] * 3;
      vertices.set([v[p], v[p + 1], v[p + 2]], i * 9 + k * 3);
      normals.set([nx, ny, nz], i * 9 + k * 3);
    }
  }
  const triangles = new Uint32Array(nt * 3);
  for (let i = 0; i < triangles.length; i++) triangles[i] = i;
  // Edges shared by triangles at more than 30° from each other, and open edges.
  const FOLD = Math.cos((30 * Math.PI) / 180);
  const seen = new Map<number, number>();
  const nv = v.length / 3;
  const lines: number[] = [];
  const line = (p: number, q: number) => lines.push(v[p * 3], v[p * 3 + 1], v[p * 3 + 2], v[q * 3], v[q * 3 + 1], v[q * 3 + 2]);
  for (let i = 0; i < nt; i++)
    for (let k = 0; k < 3; k++) {
      const p = t[i * 3 + k];
      const q = t[i * 3 + ((k + 1) % 3)];
      const key = Math.min(p, q) * nv + Math.max(p, q);
      const other = seen.get(key);
      if (other === undefined) seen.set(key, i);
      else {
        seen.delete(key);
        const d = triNormals[i * 3] * triNormals[other * 3] + triNormals[i * 3 + 1] * triNormals[other * 3 + 1] + triNormals[i * 3 + 2] * triNormals[other * 3 + 2];
        if (d < FOLD) line(p, q);
      }
    }
  for (const [key] of seen) line(Math.floor(key / nv), key % nv);
  return { vertices, normals, triangles, edges: new Float32Array(lines) };
}

/** Binary STL of several meshes together. */
export function stlBlob(meshes: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }[]): Blob {
  const count = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  let at = 84;
  for (const m of meshes) {
    const v = m.vertices;
    const t = m.triangles;
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3;
      const b = t[i + 1] * 3;
      const c = t[i + 2] * 3;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      const vals = [nx / l, ny / l, nz / l, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]];
      vals.forEach((x, k) => view.setFloat32(at + k * 4, x, true));
      at += 50;
    }
  }
  return new Blob([bytes], { type: "model/stl" });
}
