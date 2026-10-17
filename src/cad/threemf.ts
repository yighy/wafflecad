// 3MF export: the model's mesh in the 3D Manufacturing Format that slicers prefer to STL (units
// and a name travel with it). A 3MF file is a zip; this one is written stored (uncompressed),
// with no dependency. No DOM: runs in the worker, and is testable under Node.

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of the files, stored without compression. */
export function zipStored(files: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, f.data.length, true);
    dir.setUint32(24, f.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const dirSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(new ArrayBuffer(all.reduce((s, p) => s + p.length, 0)));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (v: number) => String(Math.round(v * 1e5) / 1e5);

/**
 * The 3MF of a triangle mesh (millimetres). Vertices shared by several faces are merged, so the
 * mesh is closed for the slicer; triangles left flat by the merge are dropped.
 */
export function make3mf(vertices: ArrayLike<number>, triangles: ArrayLike<number>, name: string): Uint8Array<ArrayBuffer> {
  const index = new Map<string, number>();
  const verts: string[] = [];
  const remap: number[] = [];
  for (let i = 0; i < vertices.length / 3; i++) {
    const [x, y, z] = [num(vertices[i * 3]), num(vertices[i * 3 + 1]), num(vertices[i * 3 + 2])];
    const key = `${x} ${y} ${z}`;
    let k = index.get(key);
    if (k === undefined) {
      k = verts.length;
      index.set(key, k);
      verts.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
    }
    remap.push(k);
  }
  const tris: string[] = [];
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const [a, b, c] = [remap[triangles[i]], remap[triangles[i + 1]], remap[triangles[i + 2]]];
    if (a !== b && b !== c && a !== c) tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
  }
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Application">WaffleCAD</metadata><metadata name="Title">${xml(name)}</metadata>` +
    `<resources><object id="1" name="${xml(name)}" type="model"><mesh><vertices>${verts.join("")}</vertices>` +
    `<triangles>${tris.join("")}</triangles></mesh></object></resources>` +
    `<build><item objectid="1"/></build></model>`;
  const types =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return zipStored([
    { name: "[Content_Types].xml", data: enc.encode(types) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "3D/3dmodel.model", data: enc.encode(model) },
  ]);
}
