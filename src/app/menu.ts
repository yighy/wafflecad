// The menu: theme and About.
import { $ } from "./util";
import { renderAll, vp } from "../main";
import { applyPrefs, prefs, savePrefs, type Prefs } from "./prefs";
import { S } from "./state";
import { icon } from "../ui/icons";

export function setTheme(theme: Prefs["theme"]) {
  prefs.theme = theme;
  savePrefs();
  applyPrefs();
  vp.applyThemeColors();
  if (S.mode.kind === "sketch") S.mode.editor.render();
  renderAll();
}

export function setupMenu() {
  const menu = $("#menu-panel");
  type Item = [string, () => void];
  // An entry with a list unfolds its choices in place.
  // The file actions are in the top bar; the menu keeps the theme and About.
  const items: [string, (() => void) | Item[]][] = [
    ["Light / dark theme", () => setTheme(prefs.theme === "light" ? "dark" : "light")],
    ["About", () => $("#about").classList.add("open")],
  ];
  const run = (fn: () => void) => () => {
    menu.classList.remove("open");
    fn();
  };
  for (const [label, act] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    if (typeof act === "function") {
      b.onclick = run(act);
      menu.appendChild(b);
      continue;
    }
    const sub = document.createElement("div");
    sub.className = "menu-sub";
    const inner = document.createElement("div");
    for (const [l, fn] of act) {
      const c = document.createElement("button");
      c.textContent = l;
      c.onclick = run(fn);
      inner.appendChild(c);
    }
    sub.appendChild(inner);
    b.classList.add("menu-fold");
    b.innerHTML = `<span>${label}</span>${icon("chevron", 18)}`;
    b.onclick = () => b.classList.toggle("open", sub.classList.toggle("open"));
    menu.append(b, sub);
  }
  const version = document.createElement("div");
  version.className = "menu-version";
  version.textContent = `WaffleCAD ${__APP_VERSION__}`;
  menu.appendChild(version);
  const btn = $("#menu");
  btn.innerHTML = icon("menu", 22);
  btn.onclick = (e) => {
    e.stopPropagation();
    // Opens folded again.
    for (const el of menu.querySelectorAll(".menu-fold, .menu-sub")) el.classList.remove("open");
    menu.classList.toggle("open");
  };
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target as Node) && !btn.contains(e.target as Node)) menu.classList.remove("open");
  });
}
