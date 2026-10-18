// Worker: loads OpenCascade (WASM) and does all the heavy geometry off the UI thread.
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import { bodyNames, buildResult, buildShape, exportFile, interferences, setPartDocs, splitStep } from "./build";
import { measure, refGeometry } from "./measure";
import type { PreviewResult, WorkerRequest, WorkerResponse } from "../types";

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

/**
 * The kernel (some 20 MB) is fetched here rather than by OpenCascade's loader, so the app can show
 * how far the download is, and tell a stalled one from a slow one.
 */
async function fetchKernel(): Promise<ArrayBuffer> {
  const res = await fetch(wasmUrl);
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  // Compressed in transit, the header gives the compressed size: then the total is unknown.
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let told = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = performance.now();
    if (now - told > 250) {
      told = now;
      post({ type: "progress", loaded, total: total >= loaded ? total : 0 });
    }
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

const ready = (async () => {
  const wasmBinary = await fetchKernel();
  const OC = await opencascade({ locateFile: () => wasmUrl, wasmBinary } as Parameters<typeof opencascade>[0]);
  setOC(OC);
})();

ready.then(
  () => post({ type: "ready" }),
  (e) => post({ type: "fatal", message: String(e) }),
);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  await ready;
  const req = ev.data;
  if (req.type === "parts") {
    setPartDocs(req.parts);
    return;
  }
  if (req.type === "build") {
    try {
      const ex = req.pickExclude;
      // Under an operation being edited, the model without it does not change while its values
      // are dragged: it is always built fine (from the cache after the first time), and only the
      // preview follows the draft quality.
      const r = ex
        ? buildResult({ ...req.doc, features: req.doc.features.filter((f) => f.id !== ex) })
        : buildResult(req.doc, { draft: req.draft });
      const transfer: Transferable[] = [r.edges.buffer];
      if (r.mesh) transfer.push(r.mesh.vertices.buffer, r.mesh.normals.buffer, r.mesh.triangles.buffer);
      let preview: PreviewResult | undefined;
      if (ex) {
        const full = buildResult(req.doc, { draft: req.draft, planar: false });
        preview = { mesh: full.mesh, edges: full.edges, edgeGroups: full.edgeGroups, bodies: full.bodies, error: full.errors[ex] };
        transfer.push(full.edges.buffer);
        if (full.mesh) transfer.push(full.mesh.vertices.buffer, full.mesh.normals.buffer, full.mesh.triangles.buffer);
      }
      post({ type: "built", reqId: req.reqId, ...r, preview }, transfer);
    } catch (e) {
      post({
        type: "built",
        reqId: req.reqId,
        mesh: null,
        edges: new Float32Array(),
        edgeGroups: [],
        planarFaces: [],
        errors: { _: String(e) },
      });
    }
    return;
  }
  if (req.type === "bodies") {
    let bodies: { id: string; name: string }[] = [];
    try {
      const ids = buildShape(req.doc).bodies.map((b) => b.id);
      const names = bodyNames(req.doc, ids);
      bodies = ids.map((id, i) => ({ id, name: names[i] }));
    } catch {
      // Unbuildable: inserted whole.
    }
    post({ type: "bodies", reqId: req.reqId, bodies });
    return;
  }
  if (req.type === "split") {
    try {
      post({ type: "split", reqId: req.reqId, parts: await splitStep(req.text) });
    } catch (e) {
      post({ type: "split", reqId: req.reqId, parts: [], error: String(e) });
    }
    return;
  }
  if (req.type === "clash") {
    try {
      const clashes = interferences(req.doc, req.skip);
      post({ type: "clash", reqId: req.reqId, clashes }, clashes.flatMap((c) => [c.vertices.buffer, c.triangles.buffer]));
    } catch (e) {
      post({ type: "clash", reqId: req.reqId, clashes: [], error: String(e) });
    }
    return;
  }
  if (req.type === "ref") {
    let ref = null;
    let error: string | undefined;
    try {
      ref = refGeometry(buildShape(req.doc).shape, req.pick);
    } catch (e) {
      error = String(e);
    }
    post({ type: "ref", reqId: req.reqId, ref, error });
    return;
  }
  if (req.type === "measure") {
    let result;
    try {
      result = measure(buildShape(req.doc).shape, req.picks);
    } catch (e) {
      result = { rows: [], error: String(e) };
    }
    post({ type: "measured", reqId: req.reqId, result });
    return;
  }
  try {
    post({ type: "file", reqId: req.reqId, blob: exportFile(req.doc, req.format, req.name) });
  } catch (e) {
    post({ type: "file", reqId: req.reqId, blob: null, error: String(e) });
  }
};
