// What the app remembers between visits (theme, panel place, display, last project…), in localStorage.
import { cssVar, type DisplayMode } from "../view/viewport";
import type { SelectMode } from "../sketch/selectModes";
import type { SketchEditor } from "../sketch/editor";

const PREFS_KEY = "waffle.prefs";

// The app was called "Touch CAD" first: what that version remembered moves over before it is read.
try {
  const old = localStorage.getItem("touch-cad.prefs");
  if (old !== null && localStorage.getItem(PREFS_KEY) === null) localStorage.setItem(PREFS_KEY, old);
  localStorage.removeItem("touch-cad.prefs");
} catch {
  // Private mode: nothing saved anyway.
}
export interface Prefs {
  theme: "light" | "dark";
  collapsed: boolean;
  /** Where the user dragged the side panel (top-left corner, CSS px); null = default place. */
  panelPos: { x: number; y: number } | null;
  /** The side panel is folded to its title (and its Cancel / Confirm). */
  panelFolded: boolean;
  /** How to unfold the panel was said once, the first time it was folded. */
  panelFoldTold: boolean;
  perspective: boolean;
  display: DisplayMode;
  /** The project open last. */
  project: string | null;
  /** How the sketch Select tool picks. */
  selectMode: SelectMode;
  /** The selected element's constraint list is folded (sketch panel). */
  constraintsFolded: boolean;
  /** Which constraint symbols a sketch shows. */
  glyphs: SketchEditor["glyphs"];
}
export const prefs: Prefs = { theme: "light", collapsed: false, panelPos: null, panelFolded: false, panelFoldTold: false, perspective: false, display: "shaded-edges", project: null, selectMode: "box", constraintsFolded: false, glyphs: "all" };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"));
} catch {
  // Defaults.
}
export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered: fine.
  }
}
export function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.body.classList.toggle("collapsed", prefs.collapsed);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", cssVar("--bg3d", "#efebe3"));
}
applyPrefs();
