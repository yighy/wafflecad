// A short message at the bottom of the screen, gone after a few seconds.
let toastTimer = 0;
export function toast(msg: string) {
  const t = document.querySelector("#toast") as HTMLElement;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 2600);
}
