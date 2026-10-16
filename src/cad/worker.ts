// Worker: loads OpenCascade (WASM) and does all the heavy geometry off the UI thread.
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import { buildResult, exportFile } from "./build";
import type { WorkerRequest, WorkerResponse } from "../types";

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

const ready = (async () => {
  const OC = await opencascade({ locateFile: () => wasmUrl });
  setOC(OC);
})();

ready.then(
  () => post({ type: "ready" }),
  (e) => post({ type: "fatal", message: String(e) }),
);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  await ready;
  const req = ev.data;
  if (req.type === "build") {
    try {
      const r = buildResult(req.doc);
      const transfer: Transferable[] = [r.edges.buffer];
      if (r.mesh) transfer.push(r.mesh.vertices.buffer, r.mesh.normals.buffer, r.mesh.triangles.buffer);
      post({ type: "built", reqId: req.reqId, ...r }, transfer);
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
  try {
    post({ type: "file", reqId: req.reqId, blob: exportFile(req.doc, req.format) });
  } catch (e) {
    post({ type: "file", reqId: req.reqId, blob: null, error: String(e) });
  }
};
