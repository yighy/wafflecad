// The size of an imported STL: the file's units (mm, cm, inch, m), or any factor. Set on the
// import step of the part, so every copy of the part follows, in every assembly.
import { decodeMesh, isMeshText } from "../cad/mesh";
import type { CadDocument, ImportFeature } from "../types";
import { openKeypad } from "../ui/keypad";
import { toast } from "../ui/toast";
import { fmtNum } from "./util";

const UNITS: { value: string; label: string; scale: number }[] = [
  { value: "mm", label: "mm", scale: 1 },
  { value: "cm", label: "cm", scale: 10 },
  { value: "in", label: "inch", scale: 25.4 },
  { value: "m", label: "m", scale: 1000 },
];

/** The size of the mesh as stored (before its scale), from its file. */
function fileSize(doc: CadDocument, f: ImportFeature): number[] | null {
  const text = doc.files?.[f.fileId];
  if (!text || !isMeshText(text)) return null;
  const v = decodeMesh(text).vertices;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[i + k]);
      hi[k] = Math.max(hi[k], v[i + k]);
    }
  return v.length ? hi.map((h, k) => h - lo[k]) : null;
}

/**
 * Asks for the scale of an STL import step, showing the size it gives. `apply` gets the new
 * scale (1: as in the file). `note`: a line under the title (who else changes with it).
 */
export async function stlSizeTool(doc: CadDocument, f: ImportFeature, apply: (scale: number) => void | Promise<void>, note?: string) {
  const size = fileSize(doc, f);
  if (!size) return toast("This step's mesh could not be read");
  let scale = f.scale ?? 1;
  const sizeText = () => `${size.map((d) => fmtNum(d * scale)).join(" × ")} mm`;
  const kp = openKeypad({
    title: `Size of ${f.name}`,
    subtitle: sizeText(),
    label: "Scale",
    unit: "×",
    value: scale,
    confirmLabel: "Confirm",
    segments: [
      {
        // The file's units: an STL has none, most are in mm, some in inches or cm.
        options: UNITS.map(({ value, label }) => ({ value, label: `File in ${label}` })),
        get: () => UNITS.find((u) => Math.abs(u.scale - scale) < 1e-9)?.value ?? "",
        set: (v) => {
          scale = UNITS.find((u) => u.value === v)?.scale ?? scale;
          kp.set(scale);
          kp.setSubtitle(sizeText());
        },
      },
    ],
    onInput: (v) => {
      if (!(v > 0)) return;
      scale = v;
      kp.setSubtitle(sizeText());
      kp.refresh();
    },
  });
  if (note) kp.setNote(note);
  const r = await kp.result;
  if (r === null) return;
  if (!(r.value > 0)) return toast("The scale must be more than 0");
  await apply(r.value);
}
