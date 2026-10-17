// Bridge between the sketch model and FreeCAD's planegcs solver (WebAssembly).
import { DebugMode, GcsWrapper, SolveStatus, init_planegcs_module, type SketchPrimitive } from "@salusoft89/planegcs";
import type { SkConstraint, SkEntity, SketchFeature } from "../types";
import { SketchView } from "./model";

const DEG = Math.PI / 180;

export interface Drag {
  /** Points pulled towards a target position (soft constraints). */
  points?: { id: string; x: number; y: number }[];
  /** Circle pulled towards a radius. */
  radius?: { id: string; r: number };
}

export interface SolveResult {
  ok: boolean;
  dof: number;
  /** Ids of our constraints that conflict, or are redundant. */
  conflicting: string[];
  redundant: string[];
}

/** Planegcs ids of helper constraints are "<our id>#<n>": map them back. */
const ownerId = (gcsId: string) => gcsId.split("#")[0];

export class Solver {
  private constructor(private gcs: GcsWrapper) {}

  static async create(wasmUrl?: string) {
    const mod = await init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
    const gcs = new GcsWrapper(new mod.GcsSystem(), mod);
    gcs.debug_mode = DebugMode.NoDebug;
    return new Solver(gcs);
  }

  /** Solves in place: point coordinates and circle radii of `sk` are updated on success. */
  solve(sk: SketchFeature, drag: Drag = {}): SolveResult {
    const view = new SketchView(sk);
    const prims = toPrimitives(sk, view);
    for (const p of drag.points ?? []) {
      prims.push({ id: `drag#x${p.id}`, type: "coordinate_x", p_id: p.id, x: p.x, temporary: true });
      prims.push({ id: `drag#y${p.id}`, type: "coordinate_y", p_id: p.id, y: p.y, temporary: true });
    }
    if (drag.radius) {
      const e = view.get(drag.radius.id);
      if (e?.type === "circle")
        prims.push({ id: "drag#r", type: "circle_radius", c_id: e.id, radius: drag.radius.r, temporary: true });
    }

    const gcs = this.gcs;
    gcs.clear_data();
    gcs.push_primitives_and_params(prims);
    const status = gcs.solve();
    const ok = status === SolveStatus.Success || status === SolveStatus.Converged;
    const uniq = (ids: string[]) => [...new Set(ids.map(ownerId))].filter((id) => id !== "drag");
    const result: SolveResult = {
      ok,
      dof: gcs.gcs.dof(),
      conflicting: uniq(gcs.get_gcs_conflicting_constraints()),
      redundant: uniq(gcs.get_gcs_redundant_constraints()),
    };
    if (!ok) return result;

    gcs.apply_solution();
    for (const p of gcs.sketch_index.get_primitives()) {
      const e = view.get(p.id);
      if (!e) continue;
      if (p.type === "point" && e.type === "point" && !e.fixed) {
        e.x = p.x;
        e.y = p.y;
      } else if (p.type === "circle" && e.type === "circle") {
        e.r = p.radius;
      }
    }
    return result;
  }
}

function toPrimitives(sk: SketchFeature, view: SketchView): SketchPrimitive[] {
  const out: SketchPrimitive[] = [];
  // Pinned points are constants for the solver, not unknowns held by two equations each: an
  // imported drawing pins thousands of them, which would otherwise exhaust the solver's memory.
  const pinned = new Map<string, [number, number]>();
  for (const c of sk.constraints) if (c.type === "fix") pinned.set(c.refs[0], c.at ?? view.xy(c.refs[0]));
  for (const e of sk.entities) {
    if (e.type !== "point") continue;
    const pin = pinned.get(e.id);
    out.push({ id: e.id, type: "point", x: pin ? pin[0] : e.x, y: pin ? pin[1] : e.y, fixed: !!e.fixed || !!pin });
  }
  for (const e of sk.entities) {
    switch (e.type) {
      case "line":
        out.push({ id: e.id, type: "line", p1_id: e.p1, p2_id: e.p2 });
        break;
      case "circle":
        out.push({ id: e.id, type: "circle", c_id: e.c, radius: e.r });
        break;
      case "arc": {
        const [sa, ea] = view.arcAngles(e);
        out.push({
          id: e.id,
          type: "arc",
          c_id: e.c,
          start_id: e.s,
          end_id: e.e,
          radius: view.arcRadius(e),
          start_angle: sa,
          end_angle: ea,
        });
        out.push({ id: `${e.id}#rules`, type: "arc_rules", a_id: e.id });
        break;
      }
    }
  }
  for (const c of sk.constraints) out.push(...constraintPrims(c, view));
  return out;
}

function constraintPrims(c: SkConstraint, view: SketchView): SketchPrimitive[] {
  const id = c.id;
  const [a, b, d] = c.refs;
  const A = view.get(a);
  const B = b !== undefined ? view.get(b) : undefined;
  const t = (A?.type ?? "") + "/" + (B?.type ?? "");
  const v = c.value ?? 0;
  switch (c.type) {
    case "horizontal":
      return A?.type === "line"
        ? [{ id, type: "horizontal_l", l_id: a }]
        : [{ id, type: "horizontal_pp", p1_id: a, p2_id: b }];
    case "vertical":
      return A?.type === "line"
        ? [{ id, type: "vertical_l", l_id: a }]
        : [{ id, type: "vertical_pp", p1_id: a, p2_id: b }];
    case "parallel":
      return [{ id, type: "parallel", l1_id: a, l2_id: b }];
    case "perpendicular":
      return [{ id, type: "perpendicular_ll", l1_id: a, l2_id: b }];
    case "equal":
      switch (t) {
        case "line/line":
          return [{ id, type: "equal_length", l1_id: a, l2_id: b }];
        case "circle/circle":
          return [{ id, type: "equal_radius_cc", c1_id: a, c2_id: b }];
        case "circle/arc":
          return [{ id, type: "equal_radius_ca", c1_id: a, a2_id: b }];
        case "arc/circle":
          return [{ id, type: "equal_radius_ca", c1_id: b, a2_id: a }];
        case "arc/arc":
          return [{ id, type: "equal_radius_aa", a1_id: a, a2_id: b }];
      }
      return [];
    case "tangent": {
      // Curves joined at an end (a sketch fillet): tangency as the angle between them at that
      // point, as FreeCAD does. The distance form is degenerate there and reads as redundant.
      const joint = jointOf(view, A, B);
      if (joint) return [{ id, type: "angle_via_point", crv1_id: a, crv2_id: b, p_id: joint.p, angle: joint.angle }];
      switch (t) {
        case "line/circle":
          return [{ id, type: "tangent_lc", l_id: a, c_id: b }];
        case "circle/line":
          return [{ id, type: "tangent_lc", l_id: b, c_id: a }];
        case "line/arc":
          return [{ id, type: "tangent_la", l_id: a, a_id: b }];
        case "arc/line":
          return [{ id, type: "tangent_la", l_id: b, a_id: a }];
        case "circle/circle":
          return [{ id, type: "tangent_cc", c1_id: a, c2_id: b }];
        case "arc/arc":
          return [{ id, type: "tangent_aa", a1_id: a, a2_id: b }];
        case "circle/arc":
          return [{ id, type: "tangent_ca", c_id: a, a_id: b }];
        case "arc/circle":
          return [{ id, type: "tangent_ca", c_id: b, a_id: a }];
      }
      return [];
    }
    case "pointOn":
      switch (B?.type) {
        case "line":
          return [{ id, type: "point_on_line_pl", p_id: a, l_id: b }];
        case "circle":
          return [{ id, type: "point_on_circle", p_id: a, c_id: b }];
        case "arc":
          return [{ id, type: "point_on_arc", p_id: a, a_id: b }];
      }
      return [];
    case "midpoint":
      return [
        { id, type: "point_on_line_pl", p_id: a, l_id: b },
        { id: `${id}#2`, type: "point_on_perp_bisector_pl", p_id: a, l_id: b },
      ];
    case "symmetric":
      return view.get(d)?.type === "point"
        ? [{ id, type: "p2p_symmetric_ppp", p1_id: a, p2_id: b, p_id: d }]
        : [{ id, type: "p2p_symmetric_ppl", p1_id: a, p2_id: b, l_id: d }];
    case "fix":
      // Handled as a constant point (see toPrimitives).
      return [];
    case "distance":
      if (A?.type === "line") return [{ id, type: "p2p_distance", p1_id: A.p1, p2_id: A.p2, distance: v }];
      if (B?.type === "line") return [{ id, type: "p2l_distance", p_id: a, l_id: b, distance: v }];
      if (A?.type === "point" && B?.type === "point")
        return [{ id, type: "p2p_distance", p1_id: a, p2_id: b, distance: v }];
      return [];
    case "distanceX":
      return [{ id, type: "difference", param1: { o_id: a, prop: "x" }, param2: { o_id: b, prop: "x" }, difference: v }];
    case "distanceY":
      return [{ id, type: "difference", param1: { o_id: a, prop: "y" }, param2: { o_id: b, prop: "y" }, difference: v }];
    case "radius":
      return A?.type === "arc"
        ? [{ id, type: "arc_radius", a_id: a, radius: v }]
        : [{ id, type: "circle_radius", c_id: a, radius: v }];
    case "diameter":
      return A?.type === "arc"
        ? [{ id, type: "arc_diameter", a_id: a, diameter: v }]
        : [{ id, type: "circle_diameter", c_id: a, diameter: v }];
    case "angle":
      return [{ id, type: "l2l_angle_ll", l1_id: a, l2_id: b, angle: v * DEG }];
  }
}

/** Shared end of a line and an arc (or two arcs), and whether their directions there agree (0) or oppose (π). */
function jointOf(view: SketchView, A: SkEntity | undefined, B: SkEntity | undefined): { p: string; angle: number } | null {
  const ends = (e: SkEntity | undefined): string[] => (e?.type === "line" ? [e.p1, e.p2] : e?.type === "arc" ? [e.s, e.e] : []);
  if (!A || !B || A.type === "point" || B.type === "point" || (A.type === "line" && B.type === "line")) return null;
  const p = ends(A).find((id) => ends(B).includes(id));
  if (!p) return null;
  // Direction of each curve at p, following its own parameter (line p1 → p2, arc counter-clockwise).
  const dir = (e: SkEntity): [number, number] => {
    if (e.type === "line") {
      const [x1, y1] = view.xy(e.p1);
      const [x2, y2] = view.xy(e.p2);
      return [x2 - x1, y2 - y1];
    }
    const [cx, cy] = view.xy((e as { c: string }).c);
    const [px, py] = view.xy(p);
    return [-(py - cy), px - cx];
  };
  const [u, w] = [dir(A), dir(B)];
  return { p, angle: u[0] * w[0] + u[1] * w[1] >= 0 ? 0 : Math.PI };
}
