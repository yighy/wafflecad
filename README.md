# Touch CAD

A parametric 3D CAD that runs in the browser and is designed first for **fingers and styluses**
(Android phones and tablets). A keyboard and a mouse work too, but are never required.

- Constrained 2D sketches, solved by FreeCAD's solver ([planegcs](https://github.com/Salusoft89/planegcs), WebAssembly)
- Exact B-rep solids with OpenCascade ([replicad](https://replicad.xyz), WebAssembly, in a worker)
- Feature history in the style of Onshape/FreeCAD: Sketch → Extrude (join / cut / intersect), Press Pull, Shell,
  Fillet / Chamfer, Hole (M2.5 to M5, counterbore, countersink), Mirror, linear/rectangular and circular
  patterns, every feature editable
- **STEP** export for other CAD software, **STL** for slicers
- Installable PWA, works offline once loaded

## Run

```bash
npm install
npm run dev
```

- `npm run build`: static site in `dist/` (relative paths, can be hosted on any sub-path such as GitHub Pages)
- `npm test`: core tests under Node (solver, profile detection, extrusions, exports)

## Gestures

| Input | Action |
|---|---|
| One finger / stylus / left mouse | Use the active tool: draw, tap to select, drag to move |
| Two fingers moving together | Rotate the view (in a sketch: pan) |
| Two-finger pinch | Zoom and pan |
| Two-finger tap | Undo |
| Three-finger tap | Redo |
| Android back gesture | Cancel the current step, then leave the sketch |
| Right mouse drag / middle drag / wheel | Rotate / pan / zoom |

While a stylus touches the screen, finger contacts are ignored (palm rejection).

## Layout

The 3D view fills the screen; the controls float above it.

- **Left**: the tools of the current mode, grouped by section. The panel folds down to icons only.
- **Right**: a panel for the current selection: constraints in a sketch, actions for a feature or a face,
  and the keypad when a value is being typed. Drag its top bar to move it anywhere (double tap the bar to put it back).
- **Top right**: an axis gizmo (tap X, Y, Z or their opposites to look along that axis, tap the house for the
  isometric view, drag the gizmo to rotate), then Fit, Isometric, Grid, and Look at sketch.
- **Bottom**: the feature history as a timeline (tap a step to edit, rename or delete it), Undo/Redo, and the menu.
- An extrusion shows a handle that can be pulled along the sketch normal, next to the keypad.

Menu → Light / dark theme. On phones the tools shrink to icons and the panel becomes a bottom sheet.

## Sketching

1. **Sketch**, then tap a reference plane (XY, XZ, YZ) or a flat face of the model.
2. Draw with Line, Rect, Circle, Arc (centre → start → end) or Point. A drag or two taps both work.
   Points snap to existing points and curves; nearly horizontal/vertical lines get the constraint automatically.
3. Tap geometry to select it (tap empty space to clear, drag on empty space for a box selection).
   The bar above the tools offers the constraints that fit the selection:
   horizontal, vertical, parallel, perpendicular, equal, tangent, coincident, concentric, point on curve,
   midpoint, symmetric, fix, and dimensions (length, distance, horizontal/vertical distance, radius, diameter, angle).
4. Dimensions open an on-screen keypad that accepts expressions (`20*2+3`). Tap a dimension to edit it.
5. The status bar shows the remaining degrees of freedom; geometry turns green when fully constrained.
   Closed regions are shaded: that is what an extrusion uses (nested loops become holes).
6. **Finish sketch**, then **Extrude**.

## Parameters

**Parameters** (left panel, or `P`) lists named values such as `width`, `wall` or `screw_d`.
A parameter is a number or an expression of other parameters (`depth = width / 2 + wall`).

Every keypad shows the parameters as chips: tap one to use it in a dimension, an extrusion distance,
a Press Pull or a shell thickness (`width - 2*wall`). The dimension then reads `width = 60`.
Changing a parameter updates every value that uses it, re-solves the sketches and rebuilds the part;
if a sketch cannot be solved with the new value, the change is refused with a message.
Renaming a parameter updates every expression; deleting one that is used replaces it by its value.
Dragging a handle replaces an expression by the dragged number.

## Working on faces

Tap a flat face of the solid: the right panel offers **Sketch on this face**, **Press Pull** and **Shell**.
(The Press Pull and Shell tools on the left also work the other way round: choose the tool, then tap a face.)

- **Press Pull**: pull the handle or type a distance. Positive pulls the face out and adds material,
  negative pushes it in and removes material.
- **Shell**: hollows the solid with walls of the given thickness, leaving the chosen faces open.
  While the keypad is open, tap more faces to open or close them.

## Holes

**Hole** (or `H`) drills metric screw holes, M2.5 to M5:

- **Plain**, **Counterbore** (socket head, ISO 4762) or **Countersink** (90° flat head, ISO 10642);
- **Screw passes** (clearance hole, ISO 273 medium) or **Screw into plastic** (pilot hole for a screw
  cut straight into a printed part);
- depth in mm, or 0 for through all.

Two ways to place them:

- **Quick**: tap a flat face, then **Hole here**; while the keypad is open, tap the face again to add
  holes, or tap a hole to remove it.
- **Precise**: draw a sketch on the face with points where the holes go, dimension them, then select the
  sketch in the timeline and tap **Holes at its points**. The holes then follow the sketch's dimensions and
  parameters. **Flip direction** drills the other way for sketches on reference planes.

## Mirror and patterns

**Mirror**, **Linear pattern** and **Circular pattern** repeat the material added or removed by earlier
features: extrusions (join or cut), Press Pull, holes, and other patterns. While the panel is open, tap steps
in the timeline to add or remove them (they get an orange outline). The step selected before starting is
included automatically.

- **Linear pattern**: count and spacing along X, Y or Z; set *Count 2* above 1 for a second direction
  (rectangular grid). A negative spacing goes the other way.
- **Circular pattern**: count around the X, Y or Z axis through the origin, over a total angle
  (360° spreads them evenly).
- **Mirror**: about the YZ, XZ or XY plane, moved by *Plane position*. With no step chosen, the whole solid
  is mirrored and joined to itself: model one half, mirror it.

The segmented control at the top chooses which value the keypad is typing (Count, Spacing, Angle…).
Shells and fillets cannot be repeated; repeat what they apply to instead.

## Fillets and chamfers

**Fillet / Chamfer** (or `R`): tap the edges to round or bevel (tap again to drop one), type the size,
choose Fillet or Chamfer, then Confirm. Edges hidden behind the model cannot be picked: rotate the view
with two fingers to reach them. Like Shell, the edges are chosen on the solid as it is before the feature,
so the rounding appears after Confirm. A radius too large for the chosen edges is reported in red in the timeline.

Faces are found again by a point on them and their normal, edges by the point at the middle of their length. If an earlier change moves the face,
the feature turns red in the timeline instead of applying somewhere else.

Optional keyboard shortcuts: `L` line, `R` rectangle, `C` circle, `A` arc, `P` point, `G` construction,
`Esc` cancel, `Enter` end a line / finish, `Del` delete, `Ctrl+Z` / `Ctrl+Y`;
with a selection: `H`, `V`, `E`, `T`, `D`, `X`, `Y`, `O`, `M`, `S`, `F`.
In the part view: `S` sketch, `E` extrude, `F` fit, `V` cycle views.

## Architecture

```
src/
  types.ts              document model (features, sketch entities, constraints) and worker protocol
  sketch/model.ts       sketch helpers: reference geometry, deleting, merging points
  sketch/solver.ts      sketch → planegcs primitives, solving, drag with temporary constraints
  sketch/profiles.ts    closed regions of a sketch (planar face tracing + even-odd nesting)
  sketch/editor.ts      sketch mode: tools, snapping, selection, contextual constraints, rendering
  cad/build.ts          replays features with replicad: profiles → extrusions → booleans, mesh, exports
  cad/worker.ts         loads OpenCascade and builds off the UI thread
  view/viewport.ts      three.js scene, orthographic Z-up camera, loupe, labels
  view/input.ts         pointer routing: tool vs. camera gestures, palm rejection
  ui/keypad.ts          numeric keypad with expression evaluation
  main.ts               app state, feature tree, undo/redo, files
```

The document is a JSON list of features, rebuilt from scratch on every change.
It is saved automatically in the browser; **Save** / **Open** use `.json` files.

## Known limitations

- A sketch on a face stores a copy of the face's plane: it does not follow the face if earlier features change.
- No revolve yet. Patterns rotate around axes through the origin only, and their counts and spacings
  cannot use parameters yet.
- Shell faces are chosen on the solid as it is before the shell, so the preview shows the shell only after Confirm.
- One body: every extrusion adds to, cuts or intersects the same solid.
