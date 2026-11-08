/**
 * 2D diagnostic map: material distribution, elevation, slope and water depth
 * for the same source world the 3D harness renders. Used by the visual tests to
 * prove materials follow terrain properties rather than random placement.
 */
import { generateTerrain } from "../../src/terrain/generator";
import { defaultSettings } from "../../src/terrain/types";
import { computeMaterialField, defaultMaterialSettings, materialDefs, materialNormals, type MaterialDef } from "../../src/terrain/materials";
import { waterSample } from "../../src/terrain/waterVisual";

const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? 42);
const resolution = Number(params.get("resolution") ?? 257);

const terrain = generateTerrain({ ...defaultSettings(), seed, resolution });
const settings = defaultMaterialSettings();
const normals = materialNormals(terrain.heights, terrain.width, terrain.depth, terrain.spacing_x!, terrain.spacing_z!);
const field = computeMaterialField(terrain, settings, normals);

const canvas = document.getElementById("map") as HTMLCanvasElement;
const size = terrain.width;
const PANELS = ["dominant", "elevation", "slope", "water", "sand", "gravel", "grass", "rock", "snow"];
canvas.width = size * 3;
canvas.height = size * 3;
const ctx = canvas.getContext("2d")!;

const defs: readonly MaterialDef[] = materialDefs();
const albedoOf = (id: string): number[] => {
  const def = defs.find(d => d.id === id);
  return (def ? def.albedo : [1, 0, 1]).map(v => Math.round(v * 255));
};

function panel(ox: number, oy: number, label: string) {
  ctx.fillStyle = "#0c0a09";
  ctx.fillRect(ox, oy, size, size);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(ox, oy, size, 30);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "15px monospace";
  ctx.fillText(label, ox + 10, oy + 21);
}

/** Grayscale weight map for one material channel. */
function weightPanel(ox: number, oy: number, id: string) {
  panel(ox, oy, `${id} weight`);
  const channel = field.ids.indexOf(id as never);
  const data = ctx.createImageData(size, size);
  for (let k = 0; k < size * size; k++) {
    const v = channel >= 0 ? field.weights[k * field.count + channel] : 0;
    const g = Math.round(255 * Math.min(1, v * 1.15));
    data.data[k * 4] = g; data.data[k * 4 + 1] = g; data.data[k * 4 + 2] = g; data.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(data, ox, oy);
}

// 1. Dominant material
panel(0, 0, "dominant material");
const img = ctx.createImageData(size, size);
for (let k = 0; k < size * size; k++) {
  let best = 0;
  for (let c = 1; c < field.count; c++) if (field.weights[k * field.count + c] > field.weights[k * field.count + best]) best = c;
  const [r, g, b] = albedoOf(field.ids[best]);
  img.data[k * 4] = r; img.data[k * 4 + 1] = g; img.data[k * 4 + 2] = b; img.data[k * 4 + 3] = 255;
}
ctx.putImageData(img, 0, 0);
ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(0, 0, size, 30);
ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = "15px monospace"; ctx.fillText("dominant material", 10, 21);

// 2. Elevation
panel(size, 0, "elevation");
const lo = terrain.metadata.min_height, hi = terrain.metadata.max_height;
const elevImg = ctx.createImageData(size, size);
for (let k = 0; k < size * size; k++) {
  const t = (terrain.heights[k] - lo) / Math.max(1e-3, hi - lo);
  elevImg.data[k * 4] = Math.round(255 * Math.min(1, Math.max(0, t * 1.4 - 0.1)));
  elevImg.data[k * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, 1 - Math.abs(t - 0.45) * 2.2)));
  elevImg.data[k * 4 + 2] = Math.round(255 * (1 - t));
  elevImg.data[k * 4 + 3] = 255;
}
ctx.putImageData(elevImg, size, 0);
ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(size, 0, size, 30);
ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = "15px monospace"; ctx.fillText("elevation", size + 10, 21);

// 3. Slope (+ water)
panel(0, size, "slope / water");
const slopeImg = ctx.createImageData(size, size);
for (let k = 0; k < size * size; k++) {
  const slope = 1 - normals[k * 3 + 1];
  const wet = terrain.water?.mask[k] ? 1 : 0;
  slopeImg.data[k * 4] = wet ? 20 : Math.round(255 * Math.min(1, slope * 2.4));
  slopeImg.data[k * 4 + 1] = wet ? 90 : Math.round(255 * Math.min(1, slope * 1.6));
  slopeImg.data[k * 4 + 2] = wet ? 220 : Math.round(255 * Math.min(1, slope * 2.0));
  slopeImg.data[k * 4 + 3] = 255;
}
ctx.putImageData(slopeImg, 0, size);

// 4. Water depth
panel(size, size, "water depth");
const depthImg = ctx.createImageData(size, size);
for (let k = 0; k < size * size; k++) {
  const x = k % size, z = (k - x) / size;
  const { depth } = waterSample(terrain, x, z);
  const t = Math.min(1, depth / 4);
  depthImg.data[k * 4] = Math.round(10 + 30 * (1 - t));
  depthImg.data[k * 4 + 1] = Math.round(40 + 140 * (1 - t));
  depthImg.data[k * 4 + 2] = Math.round(80 + 160 * (1 - t));
  depthImg.data[k * 4 + 3] = 255;
}
ctx.putImageData(depthImg, size, size);

for (const [i, id] of ["sand", "gravel", "grass", "rock", "snow"].entries()) {
  const index = i + 4;
  weightPanel((index % 3) * size, Math.floor(index / 3) * size, id);
}

(window as unknown as { __mapReady: boolean }).__mapReady = true;
document.title = "ready";
