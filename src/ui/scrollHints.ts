// Shows that an area scrolls, since touch screens hide scrollbars: the content fades out on the
// side where there is more, a small arrow there scrolls one step when tapped, and the first time
// an area overflows it nudges a little and comes back.
import { icon } from "./icons";

type Axis = "x" | "y";

const nudged = new Set<string>();
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function scrollHints(el: HTMLElement, axis: Axis, name: string) {
  el.dataset.scroll = axis;
  const arrow = (end: boolean) => {
    const b = document.createElement("button");
    b.className = `scroll-arrow ${axis} ${end ? "end" : "start"}`;
    b.innerHTML = icon("chevron", 14);
    b.setAttribute("aria-label", end ? "Scroll for more" : "Scroll back");
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.onclick = () => {
      const step = (axis === "y" ? el.clientHeight : el.clientWidth) * 0.6 * (end ? 1 : -1);
      el.scrollBy(axis === "y" ? { top: step, behavior: "smooth" } : { left: step, behavior: "smooth" });
    };
    document.body.appendChild(b);
    return b;
  };
  const start = arrow(false);
  const end = arrow(true);

  let frame = 0;
  const update = () => {
    frame = 0;
    const pos = axis === "y" ? el.scrollTop : el.scrollLeft;
    const size = axis === "y" ? el.clientHeight : el.clientWidth;
    const full = axis === "y" ? el.scrollHeight : el.scrollWidth;
    // (offsetParent is always null for fixed elements: ask for its boxes instead.)
    const visible = !el.hidden && el.getClientRects().length > 0 && size > 0;
    const moreStart = visible && pos > 2;
    const moreEnd = visible && pos + size < full - 2;
    el.classList.toggle("more-start", moreStart);
    el.classList.toggle("more-end", moreEnd);
    // Arrows sit inside the faded edge, centred across the area.
    const r = el.getBoundingClientRect();
    for (const [b, on, atEnd] of [
      [start, moreStart, false],
      [end, moreEnd, true],
    ] as const) {
      b.classList.toggle("shown", on);
      if (!on) continue;
      if (axis === "y") {
        b.style.left = `${r.left + Math.min(r.width, 64) / 2}px`;
        b.style.top = `${atEnd ? r.bottom - 14 : r.top + 14}px`;
      } else {
        b.style.left = `${atEnd ? r.right - 14 : r.left + 14}px`;
        b.style.top = `${r.top + r.height / 2}px`;
      }
    }
    // Once per session and area, the first time it overflows: a small nudge forward and back.
    if (moreEnd && !moreStart && !nudged.has(name) && !reduceMotion()) {
      nudged.add(name);
      const d = 28;
      setTimeout(() => {
        el.scrollBy(axis === "y" ? { top: d, behavior: "smooth" } : { left: d, behavior: "smooth" });
        setTimeout(() => el.scrollBy(axis === "y" ? { top: -d, behavior: "smooth" } : { left: -d, behavior: "smooth" }), 380);
      }, 500);
    }
  };
  // A short timer rather than an animation frame: it also runs while the page is in the background.
  const schedule = () => {
    if (!frame) frame = window.setTimeout(update, 16);
  };
  el.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  new ResizeObserver(schedule).observe(el);
  // Content changes, and the area moving or showing/hiding (the right panel can be dragged).
  new MutationObserver(schedule).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden"] });
  schedule();
  return schedule;
}
