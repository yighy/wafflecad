// On-screen numeric keypad with expressions (no system keyboard covering half the screen).
// A physical keyboard works too while it is open.

export interface KeypadOptions {
  title: string;
  value: number;
  unit?: string;
  /** Extra toggle buttons shown above the keys (e.g. extrude options). */
  extras?: { label: string; active: () => boolean; toggle: () => void }[];
  /** Called on each valid edit, for live previews. */
  onInput?: (v: number) => void;
}

let open: HTMLElement | null = null;

export function keypad(opt: KeypadOptions): Promise<number | null> {
  open?.remove();
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "keypad";
    root.innerHTML = `
      <div class="kp-head"><span class="kp-title"></span><button class="kp-close" aria-label="Cancel">✕</button></div>
      <div class="kp-extras"></div>
      <div class="kp-display"><span class="kp-expr"></span><span class="kp-unit"></span></div>
      <div class="kp-result"></div>
      <div class="kp-keys"></div>`;
    root.querySelector(".kp-title")!.textContent = opt.title;
    root.querySelector(".kp-unit")!.textContent = opt.unit ?? "mm";
    const exprEl = root.querySelector(".kp-expr") as HTMLElement;
    const resEl = root.querySelector(".kp-result") as HTMLElement;
    let expr = trimNum(opt.value);
    let fresh = true; // first key replaces the value

    const extras = root.querySelector(".kp-extras") as HTMLElement;
    const refreshExtras = () => {
      extras.replaceChildren(
        ...(opt.extras ?? []).map((x) => {
          const b = document.createElement("button");
          b.textContent = x.label;
          b.className = x.active() ? "on" : "";
          b.onclick = () => {
            x.toggle();
            refreshExtras();
          };
          return b;
        }),
      );
    };
    refreshExtras();

    const update = () => {
      exprEl.textContent = expr || "0";
      exprEl.classList.toggle("fresh", fresh);
      const v = evaluate(expr);
      resEl.textContent = v === null ? "…" : /[-+*/()]/.test(expr.replace(/^-/, "")) ? "= " + trimNum(v) : "";
      if (v !== null) opt.onInput?.(v);
    };

    const press = (k: string) => {
      if (k === "ok") return finish(evaluate(expr));
      if (k === "back") {
        expr = fresh ? "" : expr.slice(0, -1);
      } else if (k === "clear") {
        expr = "";
      } else if (k === "neg") {
        expr = expr.startsWith("-") ? expr.slice(1) : "-" + expr;
      } else {
        const isOp = "+-*/".includes(k);
        if (fresh && !isOp) expr = "";
        expr += k;
      }
      fresh = false;
      update();
    };

    const keys: [string, string][] = [
      ["7", "7"], ["8", "8"], ["9", "9"], ["÷", "/"], ["⌫", "back"],
      ["4", "4"], ["5", "5"], ["6", "6"], ["×", "*"], ["(", "("],
      ["1", "1"], ["2", "2"], ["3", "3"], ["−", "-"], [")", ")"],
      ["±", "neg"], ["0", "0"], [".", "."], ["+", "+"], ["OK", "ok"],
    ];
    const grid = root.querySelector(".kp-keys")!;
    for (const [label, k] of keys) {
      const b = document.createElement("button");
      b.textContent = label;
      if (k === "ok") b.className = "ok";
      if ("+-*/()".includes(k) && k.length === 1) b.className = "op";
      b.onpointerdown = (e) => e.preventDefault();
      b.onclick = () => press(k);
      grid.appendChild(b);
    }

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

    const finish = (v: number | null) => {
      window.removeEventListener("keydown", onKey, true);
      root.remove();
      if (open === root) open = null;
      resolve(v);
    };
    root.querySelector(".kp-close")!.addEventListener("click", () => finish(null));

    document.body.appendChild(root);
    open = root;
    update();
  });
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
