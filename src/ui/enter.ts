/** What each area last showed: enter animations play only when it changes, not on every refresh. */
const shownKey = new Map<string, string>();
export function playEnter(slot: string, key: string, el: HTMLElement) {
  if (shownKey.get(slot) === key) return;
  shownKey.set(slot, key);
  el.classList.remove("enter");
  void el.offsetWidth; // restart the animation
  el.classList.add("enter");
  // Played once: showing the panel again later must not replay it.
  el.addEventListener("animationend", () => el.classList.remove("enter"), { once: true });
}
