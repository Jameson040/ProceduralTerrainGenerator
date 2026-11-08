/**
 * Three.js render harness.
 *
 * The Babylon harness (harness.ts) and this page consume the *identical* world
 * data: same generator output, same `chunkMesh` geometry, same material field and
 * same water colours. Only the adapter differs, so screenshots from the two pages
 * can be compared directly to judge renderer parity.
 *
 *   three.html?view=overview|cliff|lake|river|under|seam|topdown
 */
import * as THREE from "three";
import { generateTerrain } from "../../src/terrain/generator";
import { defaultSettings, type TerrainData } from "../../src/terrain/types";
import { createWorld, spacing } from "../../src/world/world";
import type { Lod, WorldData } from "../../src/world/types";
import { createThreeChunk, updateThreeWater } from "../../src/render/threeAdapter";
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

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb4d8);
scene.fog = new THREE.FogExp2(0x99b8e0, 0.00025);

/* Cheap procedural sky environment so the water has something to reflect. */
const skyCanvas = document.createElement("canvas");
skyCanvas.width = 64; skyCanvas.height = 32;
{
  const ctx = skyCanvas.getContext("2d")!;
  const sky = ctx.createLinearGradient(0, 0, 0, 32);
  sky.addColorStop(0, "#5d86bd"); sky.addColorStop(0.45, "#a8c6e4");
  sky.addColorStop(0.52, "#c9d6dd"); sky.addColorStop(1, "#4b463c");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 64, 32);
}
const environment = new THREE.CanvasTexture(skyCanvas);
environment.mapping = THREE.EquirectangularReflectionMapping;
environment.colorSpace = THREE.SRGBColorSpace;
scene.environment = environment;
scene.environmentIntensity = 0.22;

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 40000);

const hemi = new THREE.HemisphereLight(0xbcd4ee, 0x474337, 0.16);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3df, 3.1);
sun.position.set(900, 1200, -700);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.8;
scene.add(sun);
scene.add(sun.target);

const terrain: TerrainData = generateTerrain({ ...defaultSettings(), seed, resolution, world_width: 1024, world_depth: 1024 });
const world: WorldData = createWorld(terrain, { chunk_width: chunkMeters, chunk_depth: chunkMeters });
world.visual = visual;

const [sx, sz] = spacing(terrain);
const cx = terrain.origin_x + (terrain.width - 1) * sx * 0.5;
const cz = terrain.origin_z + (terrain.depth - 1) * sz * 0.5;
const extent = Math.max((terrain.width - 1) * sx, (terrain.depth - 1) * sz);

function levelsFor(): Record<string, Lod> {
  if (lodParam === "low") return Object.fromEntries(world.chunks.map(c => [c.id, 2 as Lod]));
  if (lodParam === "mid") return Object.fromEntries(world.chunks.map(c => [c.id, 1 as Lod]));
  return Object.fromEntries(world.chunks.map(c => [c.id, ((c.coord[0] + c.coord[1]) % 3) as Lod]));
}

const terrainMeshes: THREE.Mesh[] = [], waterMeshes: THREE.Mesh[] = [];
const clock = { start: performance.now() };
const levels = levelsFor();
let triangles = 0, waterTriangles = 0;
for (const chunk of world.chunks) {
  const { terrain: t, water } = createThreeChunk(THREE, world, chunk.id, levels[chunk.id] ?? 0, visual);
  const mesh = new THREE.Mesh(t.geometry as unknown as THREE.BufferGeometry, t.material as THREE.Material);
  mesh.receiveShadow = true; mesh.castShadow = true; mesh.name = `terrain:${chunk.id}`;
  scene.add(mesh); terrainMeshes.push(mesh);
  triangles += (t.geometry as unknown as THREE.BufferGeometry).getIndex()!.count / 3;
  if (water) {
    const wm = new THREE.Mesh(water.geometry as unknown as THREE.BufferGeometry, water.material as THREE.Material);
    wm.renderOrder = 2; wm.name = `water:${chunk.id}`;
    scene.add(wm); waterMeshes.push(wm);
    waterTriangles += (water.geometry as unknown as THREE.BufferGeometry).getIndex()!.count / 3;
  }
}
if (hide === "water") waterMeshes.forEach(m => (m.visible = false));
if (hide === "terrain") terrainMeshes.forEach(m => (m.visible = false));

/** Steepest / deepest / widest cells reuse the Babylon harness heuristics. */
function steepestCell() {
  const n = world.normals; let best = { x: 0, z: 0, h: 0, slope: 0 };
  for (let z = 1; z < terrain.depth - 1; z++) for (let x = 1; x < terrain.width - 1; x++) {
    const k = z * terrain.width + x, slope = 1 - n[k * 3 + 1];
    if (slope > best.slope) best = { slope, x, z, h: terrain.heights[k] };
  }
  return best;
}
function deepestWater() {
  let best = { x: 0, z: 0, h: 0, depth: 0 };
  const w = terrain.water; if (!w) return best;
  for (let k = 0; k < w.depth.length; k++) if (w.depth[k] > best.depth)
    best = { depth: w.depth[k], x: k % terrain.width, z: Math.floor(k / terrain.width), h: w.surface[k] };
  return best;
}
function widestRiver() {
  let best = { x: 0, z: 0, h: 0, depth: 0 };
  const w = terrain.water; if (!w) return best;
  for (let k = 0; k < w.depth.length; k++) if (w.river_mask[k] && w.depth[k] > best.depth)
    best = { depth: w.depth[k], x: k % terrain.width, z: Math.floor(k / terrain.width), h: w.surface[k] };
  return best;
}
const at = (x: number, z: number, y: number) => new THREE.Vector3(terrain.origin_x + x * sx, y, terrain.origin_z + z * sz);

/** Spherical orbit pose, matching the Babylon harness angles. */
function orbit(target: THREE.Vector3, alpha: number, beta: number, radius: number) {
  const r = radius;
  camera.position.set(
    target.x + r * Math.sin(beta) * Math.cos(alpha),
    target.y + r * Math.cos(beta),
    target.z + r * Math.sin(beta) * Math.sin(alpha),
  );
  camera.lookAt(target);
}

function pose() {
  const mid = world.chunks[Math.floor(world.chunks.length / 2)];
  switch (view) {
    case "cliff": { const s = steepestCell(); orbit(at(s.x, s.z, s.h), -2.2, 1.15, 150); scene.fog!.density = 0.00025; break; }
    case "lake": { const s = deepestWater(); orbit(at(s.x, s.z, s.h), -2.4, 1.02, 320); scene.fog!.density = 0.00018; break; }
    case "river": { const s = widestRiver(); orbit(at(s.x, s.z, s.h), -2.1, 0.85, 90); scene.fog!.density = 0.00018; break; }
    case "under": {
      const y = terrain.metadata.min_height - extent * 0.28;
      camera.position.set(cx + extent * 0.05, y, cz + extent * 0.05);
      camera.lookAt(new THREE.Vector3(cx, (terrain.metadata.max_height as number) * 0.5, cz));
      scene.fog!.density = 0;
      break;
    }
    case "seam": {
      const [x0] = mid.rect;
      const target = at(x0, Math.floor(terrain.depth / 2), terrain.heights[Math.floor(terrain.depth / 2) * terrain.width + x0]);
      orbit(target, -1.6, 1.15, 420); scene.fog!.density = 0.0002; break;
    }
    case "topdown": {
      const target = new THREE.Vector3(cx, terrain.settings.height_scale * 0.3, cz);
      orbit(target, -Math.PI / 2, 0.02, extent * 1.05); scene.fog!.density = 0; break;
    }
    default: {
      const target = new THREE.Vector3(cx, terrain.settings.height_scale * 0.32, cz);
      orbit(target, -Math.PI / 3, 1.02, extent * 1.15); scene.fog!.density = 0.26 / extent;
    }
  }
  sun.target.position.set(cx, 0, cz);
  sun.target.updateMatrixWorld();
  // The default shadow box is 10 m wide; the world is ~1 km, so widen it to the scene.
  const half = extent * 0.72, cam = sun.shadow.camera as THREE.OrthographicCamera;
  cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
  cam.near = 100; cam.far = extent * 6;
  cam.updateProjectionMatrix();
  sun.position.set(cx + extent * 0.7, (terrain.metadata.max_height as number) * 6, cz - extent * 0.55);
  sun.updateMatrixWorld();
}
pose();

function animateWater() {
  const now = (performance.now() - clock.start) / 1000;
  for (const m of waterMeshes) updateThreeWater(m.material, now);
}

function probe(rect?: { x: number; y: number; w: number; h: number }) {
  const gl = renderer.domElement;
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
    if (pb > pr + 22 && pb > pg + 6 && pb > 60) waterish++;
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
    animateWater();
    renderer.render(scene, camera);
    await new Promise(r => requestAnimationFrame(r));
    animateWater();
    renderer.render(scene, camera);
    return api.probe();
  },
  probe,
  info: () => ({
    view, seed, resolution, chunkMeters, renderer: "three", version: THREE.REVISION,
    generator: terrain.metadata.generator_version,
    chunks: world.chunks.length, chunkGrid: [world.columns, world.rows],
    triangles, waterTriangles,
    waterMeshes: waterMeshes.length,
    waterCells: terrain.metadata.water_cells,
    camera: { position: camera.position.toArray(), target: (camera.userData.target as number[] | undefined) ?? null },
    quality: visual.material.quality, levels,
    glRenderer: (renderer.getContext().getParameter(renderer.getContext().RENDERER) as string) ?? "unknown",
    outputColorSpace: renderer.outputColorSpace, toneMapping: renderer.toneMapping,
  }),
  setCamera(p) {
    const target = new THREE.Vector3(cx, terrain.settings.height_scale * 0.32, cz);
    orbit(target, p.alpha ?? -Math.PI / 3, p.beta ?? 1.02, p.radius ?? extent * 1.15);
    if (p.y !== undefined) camera.position.y = p.y;
    camera.lookAt(target);
  },
};

(window as unknown as { __harness: HarnessApi }).__harness = api;
animateWater();
renderer.render(scene, camera);
api.render().then(() => { api.ready = true; document.title = "ready"; });
