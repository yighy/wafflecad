// Named parameters and expressions: `width = 40`, `wall = 2`, `depth = width / 2 + wall`.
// Dimensions and feature values can store an expression; changing a parameter re-evaluates
// every expression, re-solves the sketches whose dimensions changed, and the model rebuilds.
import type { CadDocument, Parameter, SketchFeature } from "./types";
import type { Solver } from "./sketch/solver";

export type Scope = Record<string, number>;

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENT_G = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Names used by an expression. */
export function identifiers(src: string): string[] {
  return [...new Set(src.match(IDENT_G) ?? [])];
}

/** True when the expression depends on a parameter (otherwise it is just a number). */
export function hasNames(src: string) {
  return identifiers(src).length > 0;
}

/** Evaluates + − × ÷, parentheses and parameter names. Returns null on any error. */
export function evaluate(src: string, scope: Scope = {}): number | null {
  const s = src.replace(/\s+/g, "");
  let i = 0;
  const peek = () => s[i];
  const atom = (): number | null => {
    if (peek() === "(") {
      i++;
      const v = sum();
      if (v === null || peek() !== ")") return null;
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      const v = atom();
      return v === null ? null : -v;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (name) {
      i += name[0].length;
      return Object.prototype.hasOwnProperty.call(scope, name[0]) ? scope[name[0]] : null;
    }
    const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const prod = (): number | null => {
    let v = atom();
    while (v !== null && (peek() === "*" || peek() === "/")) {
      const op = s[i++];
      const r = atom();
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

/** Why an expression does not evaluate, in a few words. */
export function explain(src: string, scope: Scope): string {
  const unknown = identifiers(src).filter((n) => !(n in scope));
  if (unknown.length) return `Unknown: ${unknown.join(", ")}`;
  return "Incomplete expression";
}

/** Values of all parameters, in dependency order. Cycles and errors are reported per parameter. */
export function resolveParameters(params: Parameter[]): { scope: Scope; errors: Record<string, string> } {
  const byName = new Map(params.map((p) => [p.name, p]));
  const scope: Scope = {};
  const errors: Record<string, string> = {};
  const state = new Map<string, "visiting" | "done">();
  const visit = (p: Parameter, path: string[]): boolean => {
    const st = state.get(p.name);
    if (st === "done") return p.name in scope;
    if (st === "visiting") {
      errors[p.id] = `Circular: ${[...path, p.name].join(" → ")}`;
      return false;
    }
    state.set(p.name, "visiting");
    let ok = true;
    for (const n of identifiers(p.expr)) {
      const dep = byName.get(n);
      if (!dep) {
        errors[p.id] = `Unknown: ${n}`;
        ok = false;
      } else if (!visit(dep, [...path, p.name])) {
        errors[p.id] ??= `Depends on ${n}, which has an error`;
        ok = false;
      }
    }
    state.set(p.name, "done");
    if (!ok) return false;
    const v = evaluate(p.expr, scope);
    if (v === null) {
      errors[p.id] = explain(p.expr, scope);
      return false;
    }
    scope[p.name] = v;
    return true;
  };
  for (const p of params) visit(p, []);
  return { scope, errors };
}

/**
 * The parameters a part sees: the shared ones (kept in the app, for every part), then its own.
 * A part's own parameter of the same name wins over the shared one, in that part only.
 */
export function partParameters(doc: CadDocument, shared: Parameter[] = []): Parameter[] {
  const own = doc.parameters ?? [];
  const mine = new Set(own.map((p) => p.name));
  return [...shared.filter((p) => !mine.has(p.name)), ...own];
}

/**
 * Drops a part's own parameters that only repeat a shared one: same name, same value, and the same
 * expression or a plain number. The part then follows the shared one. Returns whether any went.
 */
export function dropSharedCopies(doc: CadDocument, shared: Parameter[]): boolean {
  const own = doc.parameters ?? [];
  if (!own.length || !shared.length) return false;
  const byName = new Map(shared.map((p) => [p.name, p]));
  const here = resolveParameters(partParameters(doc, shared)).scope;
  const there = resolveParameters(shared).scope;
  const copy = (p: Parameter) => {
    const s = byName.get(p.name);
    if (!s || here[p.name] === undefined || there[p.name] === undefined) return false;
    if (Math.abs(here[p.name] - there[p.name]) > 1e-9) return false;
    return s.expr.trim() === p.expr.trim() || !identifiers(p.expr).length;
  };
  const kept = own.filter((p) => !copy(p));
  if (kept.length === own.length) return false;
  doc.parameters = kept;
  return true;
}

/** Shared parameters the part uses (directly or through other parameters), and those they use. */
export function sharedUsed(doc: CadDocument, shared: Parameter[]): Parameter[] {
  const own = new Set((doc.parameters ?? []).map((p) => p.name));
  const byName = new Map(shared.map((p) => [p.name, p]));
  const out = new Map<string, Parameter>();
  const todo = [...usedNames(doc)].filter((n) => !own.has(n));
  while (todo.length) {
    const p = byName.get(todo.pop()!);
    if (!p || out.has(p.name)) continue;
    out.set(p.name, p);
    todo.push(...identifiers(p.expr));
  }
  return [...out.values()];
}

/** Replaces a parameter name in an expression (whole words only). */
export function renameInExpr(src: string, from: string, to: string) {
  return src.replace(IDENT_G, (n) => (n === from ? to : n));
}

/** Every expression of the document, with a setter, so they can be renamed or frozen. */
export function* expressionSlots(doc: CadDocument): Generator<{ get: () => string; set: (e: string | undefined) => void }> {
  for (const p of doc.parameters ?? []) yield { get: () => p.expr, set: (e) => (p.expr = e ?? "0") };
  for (const f of doc.features) {
    if (f.kind === "sketch") {
      for (const c of f.constraints) if (c.expr) yield { get: () => c.expr!, set: (e) => (c.expr = e) };
    } else if (f.kind === "extrude" || f.kind === "pushpull") {
      if (f.distanceExpr) yield { get: () => f.distanceExpr!, set: (e) => (f.distanceExpr = e) };
    } else if (f.kind === "shell" && f.thicknessExpr) {
      yield { get: () => f.thicknessExpr!, set: (e) => (f.thicknessExpr = e) };
    } else if (f.kind === "fillet" && f.radiusExpr) {
      yield { get: () => f.radiusExpr!, set: (e) => (f.radiusExpr = e) };
    } else if (f.kind === "hole" && f.depthExpr) {
      yield { get: () => f.depthExpr!, set: (e) => (f.depthExpr = e) };
    } else if (f.kind === "revolve" && f.angleExpr) {
      yield { get: () => f.angleExpr!, set: (e) => (f.angleExpr = e) };
    }
  }
}

/** Names of parameters used anywhere (features and other parameters). */
export function usedNames(doc: CadDocument, except?: string): Set<string> {
  const out = new Set<string>();
  for (const f of doc.features) {
    const exprs =
      f.kind === "sketch"
        ? f.constraints.map((c) => c.expr ?? "")
        : f.kind === "shell"
          ? [f.thicknessExpr ?? ""]
          : f.kind === "fillet"
            ? [f.radiusExpr ?? ""]
            : f.kind === "hole"
              ? [f.depthExpr ?? ""]
              : f.kind === "pattern" || f.kind === "import" || f.kind === "combine"
                ? []
                : f.kind === "revolve"
                  ? [f.angleExpr ?? ""]
                  : [f.distanceExpr ?? ""];
    for (const e of exprs) for (const n of identifiers(e)) out.add(n);
  }
  for (const p of doc.parameters ?? []) if (p.name !== except) for (const n of identifiers(p.expr)) out.add(n);
  return out;
}

/**
 * Re-evaluates every expression and re-solves the sketches whose dimensions changed.
 * Works in place; returns the problems found (the caller decides whether to keep the result).
 */
export function applyParameters(doc: CadDocument, solver: Solver, shared: Parameter[] = []): string[] {
  const problems: string[] = [];
  const all = partParameters(doc, shared);
  const { scope, errors } = resolveParameters(all);
  // A broken shared parameter matters only where it is used: the values using it say so.
  const used = usedNames(doc);
  for (const p of all) if (errors[p.id] && ((doc.parameters ?? []).includes(p) || used.has(p.name))) problems.push(`${p.name}: ${errors[p.id]}`);
  const val = (expr: string, what: string): number | null => {
    const v = evaluate(expr, scope);
    if (v === null) problems.push(`${what}: ${explain(expr, scope)}`);
    return v;
  };
  for (const f of doc.features) {
    if (f.kind === "sketch") resolveSketch(f, scope, problems, solver);
    else if (f.kind === "extrude") {
      if (!f.distanceExpr) continue;
      const v = val(f.distanceExpr, f.name);
      if (v === null) continue;
      if (v <= 0) problems.push(`${f.name}: the distance must be positive`);
      else f.distance = Math.sign(f.distance || 1) * v;
    } else if (f.kind === "pushpull") {
      if (!f.distanceExpr) continue;
      const v = val(f.distanceExpr, f.name);
      if (v === null) continue;
      if (v === 0) problems.push(`${f.name}: the distance cannot be zero`);
      else f.distance = v;
    } else if (f.kind === "shell" && f.thicknessExpr) {
      const v = val(f.thicknessExpr, f.name);
      if (v === null) continue;
      if (v <= 0) problems.push(`${f.name}: the thickness must be positive`);
      else f.thickness = v;
    } else if (f.kind === "revolve" && f.angleExpr) {
      const v = val(f.angleExpr, f.name);
      if (v === null) continue;
      if (v === 0 || Math.abs(v) > 360) problems.push(`${f.name}: the angle must be between 0 and 360°`);
      else f.angle = Math.sign(f.angle || 1) * Math.abs(v);
    } else if (f.kind === "hole" && f.depthExpr) {
      const v = val(f.depthExpr, f.name);
      if (v === null) continue;
      if (v < 0) problems.push(`${f.name}: the depth cannot be negative`);
      else f.depth = v;
    } else if (f.kind === "fillet" && f.radiusExpr) {
      const v = val(f.radiusExpr, f.name);
      if (v === null) continue;
      if (v <= 0) problems.push(`${f.name}: the size must be positive`);
      else f.radius = v;
    }
  }
  return problems;
}

/** Updates a sketch's driven dimensions; re-solves it if one changed. */
function resolveSketch(sk: SketchFeature, scope: Scope, problems: string[], solver: Solver) {
  let changed = false;
  for (const c of sk.constraints) {
    if (!c.expr) continue;
    const v = evaluate(c.expr, scope);
    if (v === null) {
      problems.push(`${sk.name}: ${explain(c.expr, scope)}`);
      continue;
    }
    if (c.type !== "angle" && v <= 0) {
      problems.push(`${sk.name}: ${c.expr} must be positive`);
      continue;
    }
    // Angles keep the side they were drawn on.
    const signed = c.type === "angle" && (c.value ?? 0) < 0 ? -Math.abs(v) : v;
    if (signed !== c.value) {
      c.value = signed;
      changed = true;
    }
  }
  if (changed) {
    const r = solver.solve(sk);
    if (!r.ok || r.conflicting.length) problems.push(`${sk.name} cannot be solved with these values`);
  }
}
