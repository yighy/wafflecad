// Numeric keypad shown in the side panel (no system keyboard covering half the screen).
// Accepts expressions; a physical keyboard works too while it is open.
import { icon } from "./icons";

export interface Segmented {
  options: { value: string; label: string }[];
  get: () => string;
  set: (v: string) => void;
}

export interface KeypadOptions {
  title: string;
  subtitle?: string;
  /** Label inside the display, e.g. "Distance". */
  label?: string;
  value: number;
  unit?: string;
  /** Rows of segmented choices under the keys (e.g. one side / symmetric). */
  segments?: Segmented[];
  /** Small extra buttons (e.g. flip direction). */
  extras?: { label: string; icon?: string; run: () => void }[];
  confirmLabel?: string;
  /** Called on each valid edit, for live previews. */
  onInput?: (v: number) => void;
}

export interface KeypadHandle {
  result: Promise<number | null>;
  /** Changes the value from outside (e.g. a drag handle). */
  set(v: number): void;
  close(): void;
}

let host: HTMLElement | null = null;
let current: KeypadHandle | null = null;

/** The element the keypad renders into (the side panel). */
export function setKeypadHost(el: HTMLElement) {
  host = el;
}

export function isKeypadOpen() {
  return current !== null;
}

export function keypad(opt: KeypadOptions): Promise<number | null> {
  return openKeypad(opt).result;
}

export function openKeypad(opt: KeypadOptions): KeypadHandle {
  current?.close();
  const target = host ?? document.body;
  const root = document.createElement("div");
  root.className = "keypad";
  root.innerHTML = `
    <div class="kp-head">
      <div><div class="kp-title"></div><div class="kp-sub"></div></div>
    </div>
    <div class="kp-display">
      <span class="kp-label"></span>
      <span class="kp-value"><span class="kp-expr"></span><span class="kp-unit"></span></span>
    </div>
    <div class="kp-result"></div>
    <div class="kp-ops"></div>
    <div class="kp-keys"></div>
    <div class="kp-segs"></div>
    <div class="kp-foot">
      <button class="kp-cancel">Cancel</button>
      <button class="kp-ok primary"></button>
    </div>`;
  root.querySelector(".kp-title")!.textContent = opt.title;
  root.querySelector(".kp-sub")!.textContent = opt.subtitle ?? "";
  root.querySelector(".kp-label")!.textContent = opt.label ?? "Value";
  root.querySelector(".kp-unit")!.textContent = opt.unit ?? "mm";
  root.querySelector(".kp-ok")!.innerHTML = icon("check", 18) + `<span>${opt.confirmLabel ?? "OK"}</span>`;
  const exprEl = root.querySelector(".kp-expr") as HTMLElement;
  const resEl = root.querySelector(".kp-result") as HTMLElement;
  let expr = trimNum(opt.value);
  let fresh = true; // the first key replaces the value

  const update = (notify = true) => {
    exprEl.textContent = expr || "0";
    exprEl.classList.toggle("fresh", fresh);
    const v = evaluate(expr);
    resEl.textContent = v === null ? "…" : /[-+*/()]/.test(expr.replace(/^-/, "")) ? "= " + trimNum(v) : "";
    if (v !== null && notify) opt.onInput?.(v);
  };

  const press = (k: string) => {
    if (k === "ok") return finish(evaluate(expr));
    if (k === "back") expr = fresh ? "" : expr.slice(0, -1);
    else {
      if (fresh && !"+-*/".includes(k)) expr = "";
      expr += k;
    }
    fresh = false;
    update();
  };

  const key = (label: string, k: string, cls = "") => {
    const b = document.createElement("button");
    b.innerHTML = label;
    if (cls) b.className = cls;
    b.onpointerdown = (e) => e.preventDefault();
    b.onclick = () => press(k);
    return b;
  };
  const ops = root.querySelector(".kp-ops")!;
  for (const [l, k] of [["+", "+"], ["−", "-"], ["×", "*"], ["÷", "/"], ["(", "("], [")", ")"]]) ops.appendChild(key(l, k));
  const keys = root.querySelector(".kp-keys")!;
  for (const k of ["7", "8", "9", "4", "5", "6", "1", "2", "3", "."]) keys.appendChild(key(k, k));
  keys.appendChild(key("0", "0"));
  keys.appendChild(key(icon("backspace", 22), "back"));

  const segs = root.querySelector(".kp-segs")!;
  const renderSegs = () => {
    segs.replaceChildren();
    for (const s of opt.segments ?? []) {
      const row = document.createElement("div");
      row.className = "seg";
      for (const o of s.options) {
        const b = document.createElement("button");
        b.textContent = o.label;
        if (s.get() === o.value) b.classList.add("on");
        b.onclick = () => {
          s.set(o.value);
          renderSegs();
        };
        row.appendChild(b);
      }
      segs.appendChild(row);
    }
    if (opt.extras?.length) {
      const row = document.createElement("div");
      row.className = "kp-extras";
      for (const x of opt.extras) {
        const b = document.createElement("button");
        b.innerHTML = (x.icon ? icon(x.icon, 18) : "") + `<span>${x.label}</span>`;
        b.onclick = () => {
          x.run();
          renderSegs();
        };
        row.appendChild(b);
      }
      segs.appendChild(row);
    }
  };
  renderSegs();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") press("ok");
    else if (e.key === "Escape") finish(null);
    else if (e.key === "Backspace") press("back");
    else if (/^[0-9.+\-*/()]$/.test(e.key)) press(e.key);
    else if (e.key === ",") press(".");
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("keydown", onKey, true);

  let resolve!: (v: number | null) => void;
  const result = new Promise<number | null>((r) => (resolve = r));
  const finish = (v: number | null) => {
    window.removeEventListener("keydown", onKey, true);
    root.remove();
    target.classList.remove("keypad-open");
    if (current === handle) current = null;
    resolve(v);
  };
  root.querySelector(".kp-cancel")!.addEventListener("click", () => finish(null));
  root.querySelector(".kp-ok")!.addEventListener("click", () => press("ok"));

  const handle: KeypadHandle = {
    result,
    set(v) {
      expr = trimNum(v);
      fresh = true;
      update(false);
    },
    close: () => finish(null),
  };
  target.appendChild(root);
  target.classList.add("keypad-open");
  current = handle;
  update(false);
  return handle;
}

function trimNum(v: number) {
  return String(Math.round(v * 1e6) / 1e6);
}

/** Evaluates + − × ÷ and parentheses. Returns null on a syntax error. */
export function evaluate(src: string): number | null {
  const s = src.replace(/\s+/g, "");
  let i = 0;
  const peek = () => s[i];
  const num = (): number | null => {
    if (peek() === "(") {
      i++;
      const v = sum();
      if (v === null || peek() !== ")") return null;
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      const v = num();
      return v === null ? null : -v;
    }
    const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const prod = (): number | null => {
    let v = num();
    while (v !== null && (peek() === "*" || peek() === "/")) {
      const op = s[i++];
      const r = num();
      if (r === null) return null;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number | null => {
    let v = prod();
    while (v !== null && (peek() === "+" || peek() === "-")) {
      const op = s[i++];
      const r = prod();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  if (!s) return null;
  const v = sum();
  return v !== null && i === s.length && Number.isFinite(v) ? v : null;
}
