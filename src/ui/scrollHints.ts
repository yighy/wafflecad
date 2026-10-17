// Shows that an area scrolls, since touch screens hide scrollbars: the content fades out on the
// side where there is more, and the first time an area overflows it nudges a little and comes back.

type Axis = "x" | "y";

const nudged = new Set<string>();
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function scrollHints(el: HTMLElement, axis: Axis, name: string) {
  el.dataset.scroll = axis;
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
