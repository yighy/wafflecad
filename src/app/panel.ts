// The side panel: dragged by its bar to where it suits, folded to its title with a tap.
import { prefs, savePrefs } from "./prefs";
import { toast } from "../ui/toast";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
/** Phones show the panel as a bottom sheet: no free placement there. */
export const narrow = window.matchMedia("(max-width: 760px)");

export function placePanel() {
  const panel = $("#panel");
  const pos = prefs.panelPos;
  if (!pos || narrow.matches) {
    panel.style.left = panel.style.top = panel.style.right = panel.style.transform = "";
    return;
  }
  const w = panel.offsetWidth || 272;
  const h = panel.offsetHeight || 200;
  // Stay clear of the timeline at the bottom when there is room for it.
  const bottom = window.innerHeight - ($("#timeline").offsetHeight + 24);
  const x = Math.min(Math.max(pos.x, 8), window.innerWidth - w - 8);
  const y = Math.max(Math.min(pos.y, (h <= bottom - 8 ? bottom : window.innerHeight - 8) - h), 8);
  Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, right: "auto", transform: "none" });
}

export function setupPanelDrag() {
  const panel = $("#panel");
  const grip = panel.querySelector<HTMLElement>(".panel-grip")!;
  // A tap on the bar folds the panel to its title, or unfolds it; dragging the bar moves it.
  panel.classList.toggle("folded", prefs.panelFolded);
  let drag: { id: number; dx: number; dy: number; x: number; y: number; moved: boolean } | null = null;
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer.
    }
    const r = panel.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, moved: false };
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
    // Phones show the panel as a bottom sheet: it folds, but stays in place.
    if (narrow.matches) return;
    drag.moved = true;
    panel.classList.add("dragging");
    prefs.panelPos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    placePanel();
  });
  const end = (e: PointerEvent) => {
    if (!drag) return;
    const tap = !drag.moved && e.type === "pointerup";
    drag = null;
    panel.classList.remove("dragging");
    if (tap) {
      prefs.panelFolded = !prefs.panelFolded;
      panel.classList.toggle("folded", prefs.panelFolded);
      if (prefs.panelFolded && !prefs.panelFoldTold) {
        prefs.panelFoldTold = true;
        toast("Panel folded: tap the bar to unfold it");
      }
    }
    savePrefs();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  // While a finger or the pen is held on the view (a handle dragged, a face pulled, a part moved,
  // a line drawn, a box swept, the view turned), the panel fades and lets the press through, so
  // what lies under it shows. Caught on the way down: handles stop the press from bubbling.
  const view = $("#view");
  let held: { id: number; x: number; y: number; timer: number } | null = null;
  const seeThrough = (on: boolean) => panel.classList.toggle("see-through", on);
  view.addEventListener(
    "pointerdown",
    (e) => {
      if ((e.target as HTMLElement).closest("button") || held) return;
      held = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: window.setTimeout(() => seeThrough(true), 250) };
    },
    true,
  );
  // Moves and the release are caught on the way down too, for the same reason.
  window.addEventListener(
    "pointermove",
    (e) => {
      if (held?.id === e.pointerId && Math.hypot(e.clientX - held.x, e.clientY - held.y) > 6) seeThrough(true);
    },
    true,
  );
  const release = (e: PointerEvent) => {
    if (held?.id !== e.pointerId) return;
    clearTimeout(held.timer);
    held = null;
    seeThrough(false);
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
  // Double tap on the bar puts the panel back in its default place.
  grip.addEventListener("dblclick", () => {
    prefs.panelPos = null;
    savePrefs();
    placePanel();
  });
  window.addEventListener("resize", placePanel);
  narrow.addEventListener("change", placePanel);
  // The panel changes height with its content (keypad, constraints): keep it on screen.
  new MutationObserver(placePanel).observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
}
