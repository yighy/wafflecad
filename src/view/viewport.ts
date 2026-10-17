// three.js scene: orthographic or perspective CAD camera (Z up), model, sketch layer, labels.
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { BuildResult, PreviewResult, EdgeGroup, MeshData, PlaneDef, Vec3 } from "../types";

export const V = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);

/** A batch of thick screen-space lines with per-segment colours. */
export interface LineBatch {
  positions: number[];
  colors: number[];
  width: number;
  /** Drawn on top of the model. */
  overlay?: boolean;
  dashed?: boolean;
}

export interface PointBatch {
  positions: number[];
  colors: number[];
  size: number;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private ortho = new THREE.OrthographicCamera();
  private persp = new THREE.PerspectiveCamera(30);
  /** The user's choice of projection; sketches are always shown orthographic (`forceOrtho`). */
  private perspectiveOn = false;
  private orthoForced = false;
  get camera(): THREE.OrthographicCamera | THREE.PerspectiveCamera {
    return this.perspectiveOn && !this.orthoForced ? this.persp : this.ortho;
  }
  readonly overlay: HTMLDivElement;

  // Camera state: looks at `target` from the direction of the quaternion's +Z.
  target = new THREE.Vector3();
  quat = new THREE.Quaternion();
  viewHeight = 120;

  private modelGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private helperGroup = new THREE.Group();
  private gridGroup = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private faceGroups: MeshData["faceGroups"] = [];
  private edgeLines: Float32Array<ArrayBufferLike> = new Float32Array();
  private edgeGroups: EdgeGroup[] = [];
  private edgeHighlight: THREE.Object3D | null = null;
  private highlight: THREE.Mesh | null = null;
  private lineMaterials: LineMaterial[] = [];
  private needsRender = true;
  private anim: { t0: number; q0: THREE.Quaternion; q1: THREE.Quaternion; p0: THREE.Vector3; p1: THREE.Vector3; h0: number; h1: number } | null = null;
  private labels: { el: HTMLElement; at: THREE.Vector3; dx: number; dy: number }[] = [];
  private gridPlane: PlaneDef | null = null;
  private dotTexture = makeDotTexture();

  private cameraListeners: (() => void)[] = [];
  private gridVisible = true;
  private modelColor = "#8fa8c8";

  /** Called whenever the camera moves (animations included). */
  onCamera(fn: () => void): () => void {
    this.cameraListeners.push(fn);
    return () => (this.cameraListeners = this.cameraListeners.filter((f) => f !== fn));
  }

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add("gl");

    this.overlay = document.createElement("div");
    this.overlay.className = "overlay";
    container.appendChild(this.overlay);

    this.scene.background = new THREE.Color();
    this.applyThemeColors();
    this.scene.add(this.gridGroup, this.modelGroup, this.helperGroup, this.sketchGroup);
    // Bright, flat-ish lighting: top faces lightest, sides in two distinct greys.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a93a0, 2.0));
    const top = new THREE.DirectionalLight(0xffffff, 1.3);
    top.position.set(0.3, -0.5, 1);
    this.scene.add(top);
    for (const cam of [this.ortho, this.persp]) {
      const sun = new THREE.DirectionalLight(0xffffff, 0.9);
      sun.position.set(-0.4, 0.6, 1);
      cam.add(sun);
      this.scene.add(cam);
    }

    this.setStandardView("iso", false);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      this.tick();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------- Camera ----------

  get width() {
    return this.container.clientWidth;
  }
  get height() {
    return this.container.clientHeight;
  }
  /** World units per CSS pixel. */
  get wpp() {
    return this.viewHeight / Math.max(this.height, 1);
  }

  private resize() {
    this.renderer.setSize(this.width, this.height);
    for (const m of this.lineMaterials) m.resolution.set(this.width, this.height);
    this.requestRender();
  }

  requestRender() {
    this.needsRender = true;
  }

  get perspective() {
    return this.perspectiveOn;
  }
  set perspective(on: boolean) {
    this.perspectiveOn = on;
    this.changed();
  }
  set forceOrtho(on: boolean) {
    if (on === this.orthoForced) return;
    this.orthoForced = on;
    this.changed();
  }

  private updateCamera() {
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat);
    const h = this.viewHeight / 2;
    const aspect = this.width / Math.max(this.height, 1);
    const w = h * aspect;
    const cam = this.camera;
    if (cam instanceof THREE.PerspectiveCamera) {
      // Same scale as the orthographic view on the plane through the target.
      const d = h / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
      cam.position.copy(this.target).addScaledVector(dir, d);
      Object.assign(cam, { aspect, near: d / 200, far: d * 50 + 20000 });
    } else {
      cam.position.copy(this.target).addScaledVector(dir, 5000);
      Object.assign(cam, { left: -w, right: w, top: h, bottom: -h, near: 1, far: 20000 });
    }
    cam.quaternion.copy(this.quat);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  get right() {
    return new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat);
  }
  get up() {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
  }
  get viewDir() {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
  }

  /** Turntable orbit around world Z, plus pitch around the screen's horizontal axis. */
  orbit(dx: number, dy: number) {
    this.anim = null;
    const k = 0.008;
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx * k);
    const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy * k);
    this.quat.premultiply(yaw).multiply(pitch).normalize();
    this.changed();
  }

  pan(dx: number, dy: number) {
    this.anim = null;
    const s = this.wpp;
    this.target.addScaledVector(this.right, -dx * s).addScaledVector(this.up, dy * s);
    this.changed();
  }

  /** Zooms by `factor` (>1 = closer) keeping the point under (x, y) fixed. */
  zoomAt(factor: number, x: number, y: number) {
    this.anim = null;
    const before = this.screenToView(x, y);
    this.viewHeight = THREE.MathUtils.clamp(this.viewHeight / factor, 0.01, 1e5);
    const after = this.screenToView(x, y);
    this.target.add(before.sub(after));
    this.changed();
  }

  /** World point on the plane through the target, under a screen point. */
  private screenToView(x: number, y: number) {
    const s = this.wpp;
    return this.target
      .clone()
      .addScaledVector(this.right, (x - this.width / 2) * s)
      .addScaledVector(this.up, (this.height / 2 - y) * s);
  }

  private changed() {
    this.updateCamera();
    for (const fn of this.cameraListeners) fn();
    this.requestRender();
  }

  setStandardView(name: "iso" | "top" | "front" | "right", animate = true) {
    const dirs: Record<string, [Vec3, Vec3]> = {
      iso: [[1, -1, 0.8], [0, 0, 1]],
      top: [[0, 0, 1], [0, 1, 0]],
      front: [[0, -1, 0], [0, 0, 1]],
      right: [[1, 0, 0], [0, 0, 1]],
    };
    const [eye, up] = dirs[name];
    this.viewAlong(eye, up, animate);
  }

  /** Looks from direction `eye` (towards the target), with `up` pointing up on screen. */
  viewAlong(eye: Vec3, up: Vec3, animate = true) {
    const m = new THREE.Matrix4().lookAt(V(eye), new THREE.Vector3(), V(up));
    this.animateTo(new THREE.Quaternion().setFromRotationMatrix(m), undefined, undefined, animate);
  }

  /** Re-reads the colours from the CSS theme. */
  applyThemeColors() {
    (this.scene.background as THREE.Color).set(cssVar("--bg3d", "#1d2026"));
    this.modelColor = cssVar("--model", "#8fa8c8");
    if (this.mesh) (this.mesh.material as THREE.MeshStandardMaterial).color.set(this.modelColor);
    this.lastGrid = "";
    this.requestRender();
  }

  setGridVisible(on: boolean) {
    this.gridVisible = on;
    this.gridGroup.visible = on;
    this.requestRender();
  }
  get isGridVisible() {
    return this.gridVisible;
  }

  /** Looks straight at a sketch plane, sketch X to the right. */
  viewNormalTo(p: PlaneDef, animate = true) {
    const x = V(p.xDir).normalize();
    const z = V(p.normal).normalize();
    const y = z.clone().cross(x);
    const m = new THREE.Matrix4().makeBasis(x, y, z);
    this.animateTo(new THREE.Quaternion().setFromRotationMatrix(m), undefined, undefined, animate);
  }

  animateTo(q: THREE.Quaternion, target?: THREE.Vector3, h?: number, animate = true) {
    const t = target ?? this.target.clone();
    const hh = h ?? this.viewHeight;
    if (!animate) {
      this.quat.copy(q);
      this.target.copy(t);
      this.viewHeight = hh;
      this.changed();
      return;
    }
    this.anim = {
      t0: performance.now(),
      q0: this.quat.clone(),
      q1: q,
      p0: this.target.clone(),
      p1: t,
      h0: this.viewHeight,
      h1: hh,
    };
  }

  /** Frames a bounding box (or the model if none given). */
  fit(box?: THREE.Box3) {
    const b = box ?? new THREE.Box3().setFromObject(this.modelGroup);
    if (b.isEmpty()) {
      this.animateTo(this.quat.clone(), new THREE.Vector3(), 120);
      return;
    }
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3()).length();
    const aspect = this.width / Math.max(this.height, 1);
    this.animateTo(this.quat.clone(), center, Math.max(size * 1.3, 1) / Math.min(1, aspect));
  }

  private tick() {
    if (this.anim) {
      const a = this.anim;
      const t = Math.min((performance.now() - a.t0) / 280, 1);
      const e = 1 - (1 - t) ** 3;
      this.quat.slerpQuaternions(a.q0, a.q1, e);
      this.target.lerpVectors(a.p0, a.p1, e);
      this.viewHeight = a.h0 + (a.h1 - a.h0) * e;
      if (t >= 1) this.anim = null;
      this.updateCamera();
      for (const fn of this.cameraListeners) fn();
      this.needsRender = true;
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    this.render();
  }

  private render() {
    this.updateCamera();
    this.updateGrid();
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    r.clear();
    r.render(this.scene, this.camera);
    this.placeLabels();
  }


  // ---------- Projection helpers ----------

  toScreen(p: THREE.Vector3): [number, number] {
    const v = p.clone().project(this.camera);
    return [((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.height];
  }

  ray(x: number, y: number) {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, 1 - (y / this.height) * 2);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc;
  }

  /** Intersection of the view ray with a plane, in that plane's 2D coordinates. */
  screenToPlane(x: number, y: number, p: PlaneDef): [number, number] | null {
    const ray = this.ray(x, y).ray;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(V(p.normal), V(p.origin));
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    hit.sub(V(p.origin));
    const xd = V(p.xDir);
    const yd = V(p.normal).cross(xd);
    return [hit.dot(xd), hit.dot(yd)];
  }

  // ---------- Model ----------

  /**
   * Shows a build. With a preview, the preview is what is drawn, while the build itself stays
   * invisible underneath: faces and edges are still picked (and highlighted) on it.
   */
  setModel(r: BuildResult | null, preview?: PreviewResult) {
    disposeChildren(this.modelGroup);
    this.mesh = null;
    this.edgeHighlight = null;
    this.edgeLines = new Float32Array();
    this.edgeGroups = [];
    this.clearHighlight();
    if (!r?.mesh) {
      this.requestRender();
      return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(r.mesh.vertices, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(r.mesh.normals, 3));
    g.setIndex(new THREE.BufferAttribute(r.mesh.triangles, 1));
    const mat = new THREE.MeshStandardMaterial({
      color: this.modelColor,
      metalness: 0.05,
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.faceGroups = r.mesh.faceGroups;
    this.edgeLines = r.edges;
    this.edgeGroups = r.edgeGroups;
    this.modelGroup.add(this.mesh);
    const drawEdges = (edges: Float32Array) => {
      if (!edges.length) return;
      const edge = new THREE.Color(cssVar("--edge", "#141414"));
      const colors: number[] = [];
      for (let i = 0; i < edges.length / 3; i++) colors.push(edge.r, edge.g, edge.b);
      this.modelGroup.add(this.makeLines({ positions: Array.from(edges), colors, width: 1.5 }));
    };
    if (preview?.mesh) {
      // Raycasting ignores visibility: the hidden build is still what gets picked.
      this.mesh.visible = false;
      const pg = new THREE.BufferGeometry();
      pg.setAttribute("position", new THREE.BufferAttribute(preview.mesh.vertices, 3));
      pg.setAttribute("normal", new THREE.BufferAttribute(preview.mesh.normals, 3));
      pg.setIndex(new THREE.BufferAttribute(preview.mesh.triangles, 1));
      this.modelGroup.add(new THREE.Mesh(pg, mat));
      drawEdges(preview.edges);
    } else drawEdges(r.edges);
    this.requestRender();
  }

  setModelOpacity(o: number) {
    if (!this.mesh) return;
    const m = this.mesh.material as THREE.MeshStandardMaterial;
    m.transparent = o < 1;
    m.opacity = o;
    m.depthWrite = o >= 1;
    this.requestRender();
  }

  /** Point of the model under a screen point, with its face. */
  pickPoint(x: number, y: number): { point: Vec3; faceId: number | null } | null {
    if (!this.mesh) return null;
    const hit = this.ray(x, y).intersectObject(this.mesh)[0];
    if (!hit) return null;
    const i = (hit.faceIndex ?? -1) * 3;
    const faceId = this.faceGroups.find((g) => i >= g.start && i < g.start + g.count)?.faceId ?? null;
    return { point: [hit.point.x, hit.point.y, hit.point.z], faceId };
  }

  /** B-rep face id under a screen point, if any. */
  pickFace(x: number, y: number): number | null {
    if (!this.mesh) return null;
    const hit = this.ray(x, y).intersectObject(this.mesh)[0];
    if (!hit || hit.faceIndex == null) return null;
    const i = hit.faceIndex * 3;
    return this.faceGroups.find((g) => i >= g.start && i < g.start + g.count)?.faceId ?? null;
  }

  highlightFace(faceId: number | null) {
    this.highlightFaces(faceId == null ? [] : [faceId]);
  }

  /** Tints faces of the model (selection, faces to open…). */
  highlightFaces(faceIds: number[]) {
    this.clearHighlight();
    if (!faceIds.length || !this.mesh) return;
    const src = this.mesh.geometry;
    const all = src.index!.array as Uint32Array;
    const parts: number[] = [];
    for (const id of faceIds) {
      const g = this.faceGroups.find((f) => f.faceId === id);
      if (g) parts.push(...all.slice(g.start, g.start + g.count));
    }
    if (!parts.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", src.getAttribute("position"));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(parts), 1));
    this.highlight = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: cssVar("--accent", "#ffb648"), transparent: true, opacity: 0.55, depthTest: false }),
    );
    this.highlight.renderOrder = 5;
    this.modelGroup.add(this.highlight);
    this.requestRender();
  }

  /**
   * B-rep edge under a screen point (index into the build's edgeGroups), within `radius` px.
   * Edges hidden behind the model are ignored.
   */
  pickEdge(x: number, y: number, radius: number): number | null {
    const L = this.edgeLines;
    // Closest point of each edge within the radius.
    const near = new Map<number, { d: number; p: THREE.Vector3 }>();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    this.edgeGroups.forEach((g, i) => {
      for (let k = g.start; k < g.start + g.count; k += 2) {
        a.fromArray(L, k * 3);
        b.fromArray(L, (k + 1) * 3);
        const [ax, ay] = this.toScreen(a);
        const [bx, by] = this.toScreen(b);
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
        const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
        const cur = near.get(i);
        if (d < radius && (!cur || d < cur.d)) near.set(i, { d, p: a.clone().lerp(b, t) });
      }
    });
    if (!near.size) return null;
    const rc = this.ray(x, y);
    const depth = (p: THREE.Vector3) => p.clone().sub(rc.ray.origin).dot(rc.ray.direction);
    // Edges that look the same on screen (one straight behind another): the one in front first.
    const order = [...near.entries()].sort(([, u], [, v]) => (Math.abs(u.d - v.d) < 2 ? depth(u.p) - depth(v.p) : u.d - v.d));
    const front = this.mesh ? rc.intersectObject(this.mesh)[0] : undefined;
    const slack = Math.max(this.viewHeight * 0.01, 0.05);
    // Visible only if nothing of the model is clearly in front of that point.
    const visible = order.find(([, h]) => !front || front.distance >= depth(h.p) - slack);
    return visible ? visible[0] : null;
  }

  /** Index of the build's edge whose midpoint is at `mid`, if any. */
  edgeAt(mid: Vec3): number | null {
    const i = this.edgeGroups.findIndex((g) => Math.hypot(g.mid[0] - mid[0], g.mid[1] - mid[1], g.mid[2] - mid[2]) < 0.05);
    return i < 0 ? null : i;
  }

  edgeMid(i: number): Vec3 {
    return this.edgeGroups[i].mid;
  }

  /** The points of an edge's polyline, in order. */
  edgePolyline(i: number): Vec3[] {
    const g = this.edgeGroups[i];
    const L = this.edgeLines;
    const out: Vec3[] = [];
    for (let k = g.start; k < g.start + g.count; k += 2) out.push([L[k * 3], L[k * 3 + 1], L[k * 3 + 2]]);
    const e = (g.start + g.count - 1) * 3;
    out.push([L[e], L[e + 1], L[e + 2]]);
    return out;
  }

  /** Draws chosen edges thick, in the accent colour, over the model. */
  highlightEdges(indices: number[]) {
    if (this.edgeHighlight) {
      this.modelGroup.remove(this.edgeHighlight);
      this.edgeHighlight = null;
    }
    const pos: number[] = [];
    for (const i of indices) {
      const g = this.edgeGroups[i];
      if (g) pos.push(...this.edgeLines.slice(g.start * 3, (g.start + g.count) * 3));
    }
    if (pos.length) {
      const c = new THREE.Color(cssVar("--accent", "#ffb648"));
      const colors: number[] = [];
      for (let k = 0; k < pos.length / 3; k++) colors.push(c.r, c.g, c.b);
      this.edgeHighlight = this.makeLines({ positions: pos, colors, width: 5, overlay: true });
      this.modelGroup.add(this.edgeHighlight);
    }
    this.requestRender();
  }

  private clearHighlight() {
    if (this.highlight) {
      this.highlight.geometry.dispose();
      this.modelGroup.remove(this.highlight);
      this.highlight = null;
      this.requestRender();
    }
  }

  // ---------- Grid / helpers ----------

  /** Grid on the active sketch plane (or the XY ground when null). */
  setGridPlane(p: PlaneDef | null) {
    this.gridPlane = p;
    this.lastGrid = "";
    this.requestRender();
  }

  private lastGrid = "";
  private updateGrid() {
    const p: PlaneDef = this.gridPlane ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1], label: "XY" };
    const step = gridStep(this.viewHeight);
    const local = this.gridPlane ? this.screenToPlane(this.width / 2, this.height / 2, p) : null;
    const [cx, cy] = local ?? [this.target.x, this.target.y];
    const ext = Math.max(this.viewHeight * Math.max(this.width / Math.max(this.height, 1), 1), 10) * 1.2;
    const key = [step, Math.round(cx / step), Math.round(cy / step), Math.round(ext / step), p.origin, p.normal].join();
    if (key === this.lastGrid) return;
    this.lastGrid = key;
    disposeChildren(this.gridGroup);

    const xd = V(p.xDir);
    const yd = V(p.normal).cross(xd);
    const o = V(p.origin);
    const at = (u: number, v: number) => o.clone().addScaledVector(xd, u).addScaledVector(yd, v);
    const minor: number[] = [];
    const major: number[] = [];
    const n = Math.ceil(ext / step);
    const u0 = Math.round(cx / step) * step;
    const v0 = Math.round(cy / step) * step;
    for (let i = -n; i <= n; i++) {
      const u = u0 + i * step;
      const v = v0 + i * step;
      const isMajorU = Math.abs(Math.round(u / step) % 5) === 0;
      const isMajorV = Math.abs(Math.round(v / step) % 5) === 0;
      (isMajorU ? major : minor).push(...at(u, v0 - n * step).toArray(), ...at(u, v0 + n * step).toArray());
      (isMajorV ? major : minor).push(...at(u0 - n * step, v).toArray(), ...at(u0 + n * step, v).toArray());
    }
    const mk = (pos: number[], color: string, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      return new THREE.LineSegments(g, m);
    };
    const gridColor = cssVar("--grid", "#8892a0");
    this.gridGroup.add(mk(minor, gridColor, 0.14), mk(major, gridColor, 0.32));
    // World axes.
    const L = ext * 2;
    const axes = new THREE.Group();
    const ax = (d: Vec3, color: string) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), V(d).multiplyScalar(L)]);
      axes.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 })));
    };
    if (!this.gridPlane) {
      ax([1, 0, 0], "#e05555");
      ax([0, 1, 0], "#55c46a");
      ax([0, 0, 1], "#5588ee");
    }
    this.gridGroup.add(axes);
  }

  /** Semi-transparent reference planes, for choosing a sketch plane. */
  showPlanes(planes: { def: PlaneDef; color: string }[] | null) {
    disposeChildren(this.helperGroup);
    if (planes) {
      const s = Math.max(this.viewHeight * 0.3, 10);
      for (const { def, color } of planes) {
        const xd = V(def.xDir);
        const yd = V(def.normal).cross(xd);
        const geo = new THREE.PlaneGeometry(s, s);
        const m = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
        );
        m.matrixAutoUpdate = false;
        m.matrix.makeBasis(xd, yd, V(def.normal)).setPosition(V(def.origin).addScaledVector(xd, s / 2).addScaledVector(yd, s / 2));
        m.userData.label = def.label;
        this.helperGroup.add(m);
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
        );
        edges.matrixAutoUpdate = false;
        edges.matrix.copy(m.matrix);
        this.helperGroup.add(edges);
      }
    }
    this.requestRender();
  }

  pickPlane(x: number, y: number): string | null {
    const meshes = this.helperGroup.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    meshes.forEach((m) => m.updateMatrixWorld(true));
    const hit = this.ray(x, y).intersectObjects(meshes)[0];
    return (hit?.object.userData.label as string) ?? null;
  }

  // ---------- Sketch layer ----------

  setSketchLayer(lines: LineBatch[], points: PointBatch[]) {
    disposeChildren(this.sketchGroup);
    this.lineMaterials = this.lineMaterials.filter((m) => !m.userData.sketch);
    for (const b of lines) {
      if (!b.positions.length) continue;
      const obj = this.makeLines(b);
      (obj.material as LineMaterial).userData.sketch = true;
      this.sketchGroup.add(obj);
    }
    for (const b of points) {
      if (!b.positions.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(b.positions, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(b.colors, 3));
      const m = new THREE.PointsMaterial({
        size: b.size,
        sizeAttenuation: false,
        vertexColors: true,
        map: this.dotTexture,
        alphaTest: 0.5,
        depthTest: false,
        transparent: true,
      });
      const pts = new THREE.Points(g, m);
      pts.renderOrder = 20;
      this.sketchGroup.add(pts);
    }
    this.requestRender();
  }

  /** Faint fills of the closed regions of a sketch (what an extrusion would use). */
  setFills(plane: PlaneDef | null, regions: { outer: [number, number][]; holes: [number, number][][] }[], color: string) {
    const old = this.sketchGroup.getObjectByName("fills");
    if (old) disposeChildren(old), this.sketchGroup.remove(old);
    if (!plane || !regions.length) return this.requestRender();
    const group = new THREE.Group();
    group.name = "fills";
    const xd = V(plane.xDir);
    const yd = V(plane.normal).cross(xd);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
    for (const r of regions) {
      const shape = new THREE.Shape(r.outer.map(([x, y]) => new THREE.Vector2(x, y)));
      shape.holes = r.holes.map((h) => new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
      m.matrixAutoUpdate = false;
      m.matrix.makeBasis(xd, yd, V(plane.normal)).setPosition(V(plane.origin));
      m.renderOrder = 2;
      group.add(m);
    }
    this.sketchGroup.add(group);
    this.requestRender();
  }

  private makeLines(b: LineBatch) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(b.positions);
    geo.setColors(b.colors);
    const mat = new LineMaterial({
      linewidth: b.width,
      vertexColors: true,
      dashed: !!b.dashed,
      dashSize: 3,
      gapSize: 2,
      dashScale: 1 / this.wpp,
      depthTest: !b.overlay,
      transparent: !!b.overlay,
    });
    mat.resolution.set(this.width, this.height);
    this.lineMaterials.push(mat);
    const obj = new LineSegments2(geo, mat);
    if (b.dashed) obj.computeLineDistances();
    obj.renderOrder = b.overlay ? 10 : 1;
    return obj;
  }

  // ---------- HTML labels anchored to 3D points ----------

  setLabels(items: { el: HTMLElement; at: THREE.Vector3; dx?: number; dy?: number }[]) {
    for (const l of this.labels) l.el.remove();
    this.labels = items.map((i) => ({ el: i.el, at: i.at, dx: i.dx ?? 0, dy: i.dy ?? 0 }));
    for (const l of this.labels) this.overlay.appendChild(l.el);
    this.placeLabels();
  }

  private placeLabels() {
    for (const l of this.labels) {
      const [x, y] = this.toScreen(l.at);
      l.el.style.transform = `translate(${x + l.dx}px, ${y + l.dy}px) translate(-50%, -50%)`;
    }
  }
}

export function gridStep(viewHeight: number) {
  const raw = viewHeight / 12;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

function disposeChildren(g: THREE.Object3D) {
  for (const c of [...g.children]) {
    g.remove(c);
    c.traverse((o) => {
      const any = o as THREE.Mesh;
      any.geometry?.dispose();
      const m = any.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
  }
}

function makeDotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

export function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
