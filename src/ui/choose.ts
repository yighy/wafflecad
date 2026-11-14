// A question with a few answers, in a card over the app: each answer is a button with a line
// saying what it does. Resolves to the answer's index, or null when closed without one.
import { icon } from "./icons";

export interface Choice {
  label: string;
  detail?: string;
  primary?: boolean;
  danger?: boolean;
}

export function choose(title: string, lines: string[], choices: Choice[]): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "choose";
    el.innerHTML = `<div class="choose-card" role="dialog" aria-modal="true"><header><h2></h2><button class="choose-close" aria-label="Close">${icon("close", 22)}</button></header><div class="choose-text"></div><div class="choose-list"></div></div>`;
    el.querySelector("h2")!.textContent = title;
    const text = el.querySelector(".choose-text")!;
    for (const l of lines) {
      const p = document.createElement("p");
      p.textContent = l;
      text.appendChild(p);
    }
    const done = (v: number | null) => {
      el.remove();
      window.removeEventListener("keydown", key, true);
      resolve(v);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      done(null);
    };
    const list = el.querySelector(".choose-list")!;
    choices.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = (c.primary ? "primary" : "") + (c.danger ? " danger" : "");
      b.innerHTML = `<strong></strong>${c.detail ? "<span></span>" : ""}`;
      b.querySelector("strong")!.textContent = c.label;
      if (c.detail) b.querySelector("span")!.textContent = c.detail;
      b.onclick = () => done(i);
      list.appendChild(b);
    });
    el.querySelector<HTMLElement>(".choose-close")!.onclick = () => done(null);
    el.addEventListener("pointerdown", (e) => {
      if (e.target === el) done(null);
    });
    window.addEventListener("keydown", key, true);
    document.body.appendChild(el);
    requestAnimationFrame(() => list.querySelector<HTMLElement>("button")?.focus());
  });
}
