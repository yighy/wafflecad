// Shows that an area scrolls, since touch screens hide scrollbars: the content fades out on the
// side where there is more, and the first time an area overflows it nudges a little and comes back.
// Columns also get a round arrow on the edge where there is more: the fade alone can fall on an
// empty gap between tools and show nothing. Tapping the arrow scrolls by most of a page.

type Axis = "x" | "y";

const nudged = new Set<string>();
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const CHEVRON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

/** `arrowX`: where the arrows sit across the column, from its left edge (default: its middle). */
export function scrollHints(el: HTMLElement, axis: Axis, name: string, opts: { arrowX?: number } = {}) {
  el.dataset.scroll = axis;
  let frame = 0;
  const arrows =
    axis === "y"
      ? (["up", "down"] as const).map((dir) => {
          const b = document.createElement("button");
          b.className = `scroll-more ${dir}`;
          b.innerHTML = CHEVRON;
          b.setAttribute("aria-label", dir === "up" ? "Scroll up" : "Scroll down");
          b.tabIndex = -1;
          b.onclick = () => el.scrollBy({ top: (dir === "up" ? -1 : 1) * el.clientHeight * 0.8, behavior: "smooth" });
          document.body.appendChild(b);
          return b;
        })
      : [];
  const placeArrows = (moreStart: boolean, moreEnd: boolean) => {
    if (!arrows.length) return;
    const r = el.getBoundingClientRect();
    // (Never past the middle: the folded and phone columns are narrow.)
    const x = r.left + Math.min(opts.arrowX ?? Infinity, r.width / 2);
    const [up, down] = arrows;
    up.hidden = !moreStart;
    down.hidden = !moreEnd;
    // Half over the edge, so they read as belonging to it.
    up.style.transform = `translate(${x}px, ${r.top}px)`;
    down.style.transform = `translate(${x}px, ${r.bottom}px)`;
  };
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
    placeArrows(moreStart, moreEnd);
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
