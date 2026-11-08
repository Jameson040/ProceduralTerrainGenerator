/**
 * Headless render harness (Phase 4 validation).
 *
 * Builds a world with the real generator + real Babylon adapter, parks the
 * camera at a named pose, renders, and exposes pixel probes so the test script
 * can assert things like "looking up from below the ground shows no water".
 *
 * Bundled by tests/browser/build-harness.mjs and driven by tests/browser/shots.mjs.
 */
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Materials/standardMaterial";
import { generateTerrain } from "../../src/terrain/generator";
import { defaultSettings, type TerrainData } from "../../src/terrain/types";
import { createWorld, spacing } from "../../src/world/world";
import type { Lod, WorldData } from "../../src/world/types";
import { ChunkScene } from "../../src/viewer/chunkAdapter";
import { defaultVisualSettings, type VisualSettings } from "../../src/terrain/visual";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "overview";
const seed = Number(params.get("seed") ?? 42);
const resolution = Number(params.get("resolution") ?? 257);
const chunkMeters = Number(params.get("chunk") ?? 256);
const quality = Number(params.get("quality") ?? 2) as 0 | 1 | 2;
const lodParam = params.get("lod");
const hide = params.get("hide") ?? "";

const visual: VisualSettings = defaultVisualSettings();
visual.material.quality = quality;
if (params.get("waves") === "0") visual.water.motion = 0;
if (params.get("opacity")) visual.water.opacity = Number(params.get("opacity"));

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, antialias: true }, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.55, 0.7, 0.9, 1);
scene.fogMode = Scene.FOGMODE_EXP2;
scene.fogColor = new Color3(0.6, 0.72, 0.88);
scene.fogDensity = 0.00025;
// Filmic tone mapping keeps highlights (snow, water sun glints) from clipping.
const ip = scene.imageProcessingConfiguration;
ip.toneMappingEnabled = true;
ip.toneMappingType = 1; // ACES
ip.exposure = 1.15;
ip.contrast = 1.12;

const camera = new ArcRotateCamera("cam", -Math.PI / 3, Math.PI / 3.2, 1500, new Vector3(0, 60, 0), scene);
camera.lowerRadiusLimit = 20;
camera.upperRadiusLimit = 20000;
camera.upperBetaLimit = Math.PI; // the harness may look from under the world
camera.minZ = 1;
camera.maxZ = 40000;

const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
hemi.intensity = 0.62;
hemi.groundColor = new Color3(0.28, 0.27, 0.24);
const sun = new DirectionalLight("sun", new Vector3(-0.6, -0.8, 0.45), scene);
sun.position = new Vector3(900, 1200, -700);
sun.intensity = 1.9;
const shadows = new ShadowGenerator(1024, sun);
shadows.useBlurExponentialShadowMap = true;
shadows.blurKernel = 16;
shadows.bias = 0.002;
shadows.normalBias = 0.5;
shadows.darkness = 0.35;

const terrain: TerrainData = generateTerrain({ ...defaultSettings(), seed, resolution, world_width: 1024, world_depth: 1024 });
const world: WorldData = createWorld(terrain, { chunk_width: chunkMeters, chunk_depth: chunkMeters });
world.visual = visual;
const manager = new ChunkScene(scene, world, shadows, visual);

const [sx, sz] = spacing(terrain);
const cx = terrain.origin_x + (terrain.width - 1) * sx * 0.5;
const cz = terrain.origin_z + (terrain.depth - 1) * sz * 0.5;
const extent = Math.max((terrain.width - 1) * sx, (terrain.depth - 1) * sz);

function levelsFor(): Record<string, Lod> {
  if (lodParam === "low") return Object.fromEntries(world.chunks.map(c => [c.id, 2 as Lod]));
  if (lodParam === "mid") return Object.fromEntries(world.chunks.map(c => [c.id, 1 as Lod]));
  // Mixed LOD: alternate per chunk so seams between different detail levels show.
  return Object.fromEntries(world.chunks.map(c => [c.id, ((c.coord[0] + c.coord[1]) % 3) as Lod]));
}

/** Steepest source cell: a rock/cliff close-up. */
function steepestCell(): { x: number; z: number; h: number; slope: number } {
  const n = world.normals, best = { x: 0, z: 0, h: 0, slope: 0 };
  for (let z = 1; z < terrain.depth - 1; z++) for (let x = 1; x < terrain.width - 1; x++) {
    const k = z * terrain.width + x, slope = 1 - n[k * 3 + 1];
    if (slope > best.slope) { best.slope = slope; best.x = x; best.z = z; best.h = terrain.heights[k]; }
  }
  return best;
}

/** Deepest lake cell: a water close-up over a real lakebed. */
function deepestWater(): { x: number; z: number; h: number; depth: number } {
  const best = { x: 0, z: 0, h: 0, depth: 0 };
  const w = terrain.water;
  if (!w) return best;
  for (let k = 0; k < w.depth.length; k++) {
    if (w.depth[k] > best.depth) {
      best.depth = w.depth[k];
      best.x = k % terrain.width; best.z = Math.floor(k / terrain.width);
      best.h = w.surface[k];
    }
  }
  return best;
}

/** Widest river cell, so the river look is judged on a real carved channel. */
function widestRiver(): { x: number; z: number; h: number; depth: number } {
  const best = { x: 0, z: 0, h: 0, depth: 0 };
  const w = terrain.water;
  if (!w) return best;
  for (let k = 0; k < w.depth.length; k++) {
    if (w.river_mask[k] && w.depth[k] > best.depth) {
      best.depth = w.depth[k];
      best.x = k % terrain.width; best.z = Math.floor(k / terrain.width);
      best.h = w.surface[k];
    }
  }
  return best;
}

function pose() {
  const mid = world.chunks[Math.floor(world.chunks.length / 2)];
  switch (view) {
    case "cliff": {
      const s = steepestCell();
      camera.setTarget(new Vector3(terrain.origin_x + s.x * sx, s.h, terrain.origin_z + s.z * sz));
      camera.alpha = -2.2; camera.beta = 1.15; camera.radius = 150;
      scene.fogDensity = 0.00025;
// Filmic tone mapping keeps highlights (snow, water sun glints) from clipping.
const ip = scene.imageProcessingConfiguration;
ip.toneMappingEnabled = true;
ip.toneMappingType = 1; // ACES
ip.exposure = 1.15;
ip.contrast = 1.12;
      break;
    }
    case "lake": {
      const s = deepestWater();
      camera.setTarget(new Vector3(terrain.origin_x + s.x * sx, s.h, terrain.origin_z + s.z * sz));
      camera.alpha = -2.4; camera.beta = 1.02; camera.radius = 320;
      scene.fogDensity = 0.00018;
      break;
    }
    case "river": {
      const s = widestRiver();
      camera.setTarget(new Vector3(terrain.origin_x + s.x * sx, s.h, terrain.origin_z + s.z * sz));
      camera.alpha = -2.1; camera.beta = 0.85; camera.radius = 90;
      scene.fogDensity = 0.00018;
      break;
    }
    case "under": {
      // Camera below the whole heightfield, looking up at its underside.
      const y = terrain.metadata.min_height - extent * 0.28;
      camera.setTarget(new Vector3(cx, terrain.metadata.max_height * 0.5, cz));
      camera.setPosition(new Vector3(cx + extent * 0.05, y, cz + extent * 0.05));
      scene.fogDensity = 0;
      break;
    }
    case "seam": {
      // Straddle a shared chunk boundary between two chunks.
      const [x0] = mid.rect;
      camera.setTarget(new Vector3(terrain.origin_x + x0 * sx, terrain.heights[Math.floor(terrain.depth / 2) * terrain.width + x0], cz));
      camera.alpha = -1.6; camera.beta = 1.15; camera.radius = 420;
      scene.fogDensity = 0.0002;
      break;
    }
    case "topdown": {
      camera.setTarget(new Vector3(cx, terrain.settings.height_scale * 0.3, cz));
      camera.alpha = -Math.PI / 2; camera.beta = 0.02; camera.radius = extent * 1.05;
      scene.fogDensity = 0;
      break;
    }
    default: {
      camera.setTarget(new Vector3(cx, terrain.settings.height_scale * 0.32, cz));
      camera.alpha = -Math.PI / 3; camera.beta = 1.02; camera.radius = extent * 1.15;
      scene.fogDensity = 0.26 / extent;
    }
  }
}

const levels = levelsFor();
manager.update({ selected: world.chunks[0].id, scope: "world", lod: 0, grid: false, debug: "off", hidden: [] }, levels, {
  visual, colorMode: "natural", wireframe: false, showWater: hide !== "water", shadows: true, debug: "off",
});
if (hide === "terrain") for (const e of manager.entries.values()) e.terrain.setEnabled(false);
pose();
camera.getViewMatrix(true);

/** Average colour + water-ish pixel share of the rendered frame. */
function probe(rect?: { x: number; y: number; w: number; h: number }) {
  const gl = engine.getRenderingCanvas()!;
  const w = rect?.w ?? gl.width, h = rect?.h ?? gl.height;
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const ctx = off.getContext("2d")!;
  ctx.drawImage(gl, rect?.x ?? 0, rect?.y ?? 0, w, h, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let r = 0, g = 0, b = 0, waterish = 0, skyish = 0, landish = 0, dark = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const pr = data[i * 4], pg = data[i * 4 + 1], pb = data[i * 4 + 2];
    r += pr; g += pg; b += pb;
    // Water in this palette is blue-dominant and greenish-blue; terrain is not.
    if (pb > pr + 22 && pb > pg + 6 && pb > 60) waterish++;
    // The clear colour / sky is a pale desaturated blue.
    if (pr > 120 && pg > 150 && pb > 200 && pb - pr > 40) skyish++;
    if (pr < 90 && pg < 90 && pb < 90) dark++;
    if (!(pb > pr + 22 && pb > pg + 6 && pb > 60)) landish++;
  }
  return {
    avg: [r / n, g / n, b / n].map(v => Math.round(v * 10) / 10),
    waterFraction: waterish / n, skyFraction: skyish / n, landFraction: landish / n, darkFraction: dark / n,
    width: w, height: h,
  };
}

interface HarnessApi {
  ready: boolean;
  render(): Promise<unknown>;
  probe(rect?: { x: number; y: number; w: number; h: number }): ReturnType<typeof probe>;
  info(): unknown;
  setCamera(p: { alpha?: number; beta?: number; radius?: number; y?: number }): void;
}

const api: HarnessApi = {
  ready: false,
  async render() {
    scene.render();
    for (let i = 0; i < 3; i++) { manager.updateVisual(1 / 60); scene.render(); }
    await new Promise(r => requestAnimationFrame(r));
    scene.render();
    return api.probe();
  },
  probe,
  info: () => ({
    view, seed, resolution, chunkMeters,
    generator: terrain.metadata.generator_version,
    chunks: world.chunks.length,
    chunkGrid: [world.columns, world.rows],
    triangles: world.chunks.reduce((sum, c) => sum + (world.meshes.has(`${c.id}:0`) ? 0 : 0), 0),
    materials: terrain.layers ? "present" : "absent",
    waterCells: terrain.metadata.water_cells,
    renderer: engine.getGlInfo().renderer,
    camera: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, position: camera.position.asArray() },
    plugin: (manager.terrain.pluginAttached ? "triplanar" : "fallback"),
    quality: visual.material.quality,
    levels,
  }),
  setCamera(p) {
    if (p.alpha !== undefined) camera.alpha = p.alpha;
    if (p.beta !== undefined) camera.beta = p.beta;
    if (p.radius !== undefined) camera.radius = p.radius;
    if (p.y !== undefined) camera.setPosition(new Vector3(camera.position.x, p.y, camera.position.z));
    camera.getViewMatrix(true);
  },
};

(window as unknown as { __harness: HarnessApi }).__harness = api;
engine.runRenderLoop(() => scene.render());
api.render().then(() => { api.ready = true; document.title = "ready"; });
