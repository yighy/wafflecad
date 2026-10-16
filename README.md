# Touch CAD

A parametric 3D CAD that runs in the browser and is designed first for **fingers and styluses**
(Android phones and tablets). A keyboard and a mouse work too, but are never required.

- Constrained 2D sketches, solved by FreeCAD's solver ([planegcs](https://github.com/Salusoft89/planegcs), WebAssembly)
- Exact B-rep solids with OpenCascade ([replicad](https://replicad.xyz), WebAssembly, in a worker)
- Feature history in the style of Onshape/FreeCAD: Sketch → Extrude (add / cut / intersect), every feature editable
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
When drawing with a finger, a loupe shows the area under it.

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
6. **Done**, then **Extrude**.

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
- No fillets, chamfers, revolve or patterns yet.
- One body: every extrusion adds to, cuts or intersects the same solid.
