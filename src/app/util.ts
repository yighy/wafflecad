// Small helpers with no state of their own, shared across the app.
import type { CadDocument } from "../types";

export const emptyDoc = (): CadDocument => ({ format: "waffle", version: 1, features: [] });

export function asDocument(d: unknown): CadDocument | null {
  const x = d as { format?: string; features?: unknown } | null;
  if (!x || (x.format !== "waffle" && x.format !== "touch-cad") || !Array.isArray(x.features)) return null;
  return { ...(x as CadDocument), format: "waffle" };
}

/** Listed by name, in natural order: "Part 2" before "Part 10", whatever the case. */
export const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

/** A name brought in stays as it is unless a project here has it: "Box" then becomes "Box 2", "Box 2" becomes "Box 3". */
export function keepName(name: string, taken: string[]) {
  if (!taken.includes(name)) return name;
  const base = name.replace(/ \d+$/, "");
  let i = 2;
  while (taken.includes(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

export function fmtNum(v: number) {
  return String(Math.round(v * 1000) / 1000);
}

export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

