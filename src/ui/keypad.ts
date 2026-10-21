// Numeric keypad shown in the side panel (no system keyboard covering half the screen).
// Accepts expressions; a physical keyboard works too while it is open.
import { icon } from "./icons";
import { evaluate, explain, hasNames, type Scope } from "../params";

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
  /** Parameters offered as chips, usable in the expression. */
  scope?: Scope;
  /** Expression to start from (instead of the plain value). */
  expr?: string;
  /** A line of text to type above the number (e.g. the words of a text). */
  text?: { value: string; placeholder?: string; onInput: (v: string) => void };
}

/** The typed value, and the expression when it uses parameters. */
export interface KeypadResult {
  value: number;
  expr?: string;
}

export interface KeypadHandle {
  result: Promise<KeypadResult | null>;
  /** Changes the value from outside (e.g. a drag handle). */
  set(v: number): void;
  /** Changes the label in the display (when the keypad edits another field). */
  setLabel(text: string, unit?: string): void;
  setSubtitle(text: string): void;
  /** A warning under the title (null clears it). */
  setNote(text: string | null): void;
  /** Redraws the segments (what they show was changed from outside). */
  refresh(): void;
  close(): void;
}

let host: HTMLElement | null = null;
let current: KeypadHandle | null = null;

/** The element the keypad renders into (the side panel). */
export function setKeypadHost(el: HTMLElement) {
  host = el;
}

export function keypad(opt: KeypadOptions): Promise<KeypadResult | null> {
  return openKeypad(opt).result;
}

export function openKeypad(opt: KeypadOptions): KeypadHandle {
  current?.close();
  const target = host ?? document.body;
  const root = document.createElement("div");
  root.className = "keypad";
  root.innerHTML = `
    <div class="kp-head">
      <div><div class="kp-title"></div><div class="kp-sub"></div><div class="kp-note"></div></div>
    </div>
    <input class="kp-text" type="text" enterkeyhint="done" autocomplete="off" hidden>
    <div class="kp-display">
      <span class="kp-label"></span>
      <span class="kp-value"><span class="kp-expr"></span><span class="kp-unit"></span></span>
    </div>
    <div class="kp-result"></div>
    <div class="kp-params"></div>
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
  const textEl = root.querySelector<HTMLInputElement>(".kp-text")!;
  if (opt.text) {
    textEl.hidden = false;
    textEl.value = opt.text.value;
    textEl.placeholder = opt.text.placeholder ?? "";
    textEl.oninput = () => opt.text!.onInput(textEl.value);
  }
  const exprEl = root.querySelector(".kp-expr") as HTMLElement;
  const resEl = root.querySelector(".kp-result") as HTMLElement;
  const scope = opt.scope ?? {};
  let expr = opt.expr ?? trimNum(opt.value);
  let fresh = true; // the first key replaces the value

  const update = (notify = true) => {
    exprEl.textContent = expr || "0";
    exprEl.classList.toggle("fresh", fresh);
    const v = evaluate(expr, scope);
    resEl.classList.toggle("err", v === null && expr !== "");
    resEl.textContent =
      v === null ? (expr ? explain(expr, scope) : "…") : /[-+*/()A-Za-z_]/.test(expr.replace(/^-/, "")) ? "= " + trimNum(v) : "";
    if (v !== null && notify) opt.onInput?.(v);
  };

  const press = (k: string) => {
    if (k === "ok") {
      const v = evaluate(expr, scope);
      if (v === null) return;
      return finish({ value: v, expr: hasNames(expr) ? expr : undefined });
    }
    // Backspace removes a whole parameter name at once.
    if (k === "back") expr = fresh ? "" : expr.replace(/([A-Za-z_][A-Za-z0-9_]*|.)$/, "");
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
  const params = root.querySelector(".kp-params")!;
  for (const name of Object.keys(scope)) {
    const b = key("", name, "kp-param");
    b.textContent = name;
    b.title = `${name} = ${trimNum(scope[name])}`;
    params.appendChild(b);
  }
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
    // Typing in the text line: only Enter and Escape are the keypad's.
    if (e.target === textEl && e.key !== "Enter" && e.key !== "Escape") return;
    if (e.key === "Enter") press("ok");
    else if (e.key === "Escape") finish(null);
    else if (e.key === "Backspace") press("back");
    else if (/^[0-9.+\-*/()]$/.test(e.key)) press(e.key);
    else if (/^[A-Za-z_]$/.test(e.key) && Object.keys(scope).length) press(e.key);
    else if (e.key === ",") press(".");
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("keydown", onKey, true);

  let resolve!: (v: KeypadResult | null) => void;
  const result = new Promise<KeypadResult | null>((r) => (resolve = r));
  const finish = (v: KeypadResult | null) => {
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
    setLabel(text, unit) {
      root.querySelector(".kp-label")!.textContent = text;
      if (unit !== undefined) root.querySelector(".kp-unit")!.textContent = unit;
    },
    setNote(text) {
      root.querySelector(".kp-note")!.textContent = text ?? "";
    },
    setSubtitle(text) {
      root.querySelector(".kp-sub")!.textContent = text;
    },
    refresh: renderSegs,
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
