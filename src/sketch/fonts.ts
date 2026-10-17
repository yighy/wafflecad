// The fonts offered for text in sketches (open licence, bundled so text works offline).
import { parse, type Font } from "opentype.js";
import sansUrl from "@fontsource/roboto/files/roboto-latin-400-normal.woff?url";
import boldUrl from "@fontsource/roboto/files/roboto-latin-700-normal.woff?url";
import monoUrl from "@fontsource/roboto-mono/files/roboto-mono-latin-700-normal.woff?url";

export const FONTS = [
  { id: "bold", label: "Bold", url: boldUrl },
  { id: "sans", label: "Regular", url: sansUrl },
  { id: "mono", label: "Mono", url: monoUrl },
] as const;
export type FontId = (typeof FONTS)[number]["id"];

const loaded = new Map<FontId, Promise<Font>>();

export function loadFont(id: FontId): Promise<Font> {
  let p = loaded.get(id);
  if (!p) {
    const url = FONTS.find((f) => f.id === id)!.url;
    p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => parse(b));
    // A failed load can be tried again.
    p.catch(() => loaded.delete(id));
    loaded.set(id, p);
  }
  return p;
}
