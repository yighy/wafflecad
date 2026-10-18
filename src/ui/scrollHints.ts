// Shows that an area scrolls, since touch screens hide scrollbars: the content fades out on the
// side where there is more, and the first time an area overflows it nudges a little and comes back.
// A column can also be shortened a little so that its edge cuts through an item (a tool cut in
// half says there is more) rather than through an empty gap, where the fade would show nothing.

type Axis = "x" | "y";

const nudged = new Set<string>();
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * `cutItems`: the items the edge should cut through (a selector inside the area). The area's CSS
 * takes the shortening from the `--cut` property it is given.
 */
export function scrollHints(el: HTMLElement, axis: Axis, name: string, opts: { cutItems?: string } = {}) {
  el.dataset.scroll = axis;
  let frame = 0;
  let cut = 0;
  /** Shortens the area so its far edge falls across an item, a little past its middle. */
  const cutThrough = () => {
    if (!opts.cutItems || axis !== "y") return;
    // The height it would have without the cut (stretched or full, since it overflows).
    const natural = el.clientHeight + cut;
    let next = 0;
    if (el.scrollHeight > natural + 2) {
      const top = el.getBoundingClientRect().top - el.scrollTop;
      let best = -1;
      for (const item of el.querySelectorAll<HTMLElement>(opts.cutItems)) {
        const r = item.getBoundingClientRect();
        if (!r.height) continue;
        const at = r.top - top + r.height * 0.6;
        if (at <= natural - 2 && at > best) best = at;
      }
      if (best > 0) next = Math.round(natural - best);
    }
    if (next !== cut) {
      cut = next;
      el.style.setProperty("--cut", `${cut}px`);
    }
  };
  const update = () => {
    frame = 0;
    cutThrough();
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
