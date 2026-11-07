/**
 * Converts renderer-agnostic TerrainData into Babylon.js VertexData.
 * This is the only place terrain data touches the rendering engine.
 *
 * UNDERWATER-TERRAIN CONTRACT (v0.1.1):
 * - The terrain mesh ALWAYS covers the full W×D grid, including the lakebed
 *   beneath every water cell. No holes, no deleted faces, no displaced
 *   duplicates — one heightfield, one vertex per cell, valid topology.
 * - Water is a SEPARATE mesh at `water.level`. Building it never reads or
 *   writes terrain positions; hiding water reveals the submerged ground.
 * - Normals are computed from the full terrain faces, so the lakebed shades
 *   consistently with dry land.
 */
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { TerrainData } from "../terrain/types";

export type ColorMode = "natural" | "elevation" | "slope" | "flow" | "erosion" | "drainage";

function debugColor(mode: ColorMode, t: TerrainData, k: number, slope: number, maxFlow: number, maxErosion: number): number[] | null {
  const layers = t.layers;
  if (!layers) return null;
  if (mode === "flow") {
    const v = Math.log1p(layers.flow_accumulation[k]) / Math.log1p(Math.max(1, maxFlow));
    if (v < 0.25) return mix([0.04, 0.09, 0.2], [0.02, 0.55, 0.65], v / 0.25);
    if (v < 0.52) return mix([0.02, 0.55, 0.65], [0.85, 0.82, 0.22], (v - 0.25) / 0.27);
    if (v < 0.78) return mix([0.85, 0.82, 0.22], [0.95, 0.44, 0.1], (v - 0.52) / 0.26);
    return mix([0.95, 0.44, 0.1], [1.0, 0.92, 0.9], (v - 0.78) / 0.22);
  }
  if (mode === "erosion") {
    const delta = layers.erosion[k];
    const amount = Math.min(1, Math.abs(delta) / Math.max(1, maxErosion));
    if (delta < 0) return mix([0.11, 0.15, 0.18], [0.08, 0.5, 0.95], amount);
    return mix([0.11, 0.15, 0.18], [0.95, 0.66, 0.18], amount);
  }
  if (mode === "drainage") {
    const dir = layers.flow_direction[k];
    if (dir < 0) return [0.7, 0.08, 0.12];
    const strength = Math.min(1, Math.log1p(layers.flow_accumulation[k]) / Math.log1p(Math.max(1, maxFlow)));
    const h = dir;
    const rgb = hsv(h, 0.72, 0.35 + 0.65 * Math.max(0.15, strength));
    return mix([0.16, 0.17, 0.16], rgb, Math.min(1, 0.32 + slope * 1.4));
  }
  return null;
}

function hsv(h: number, s: number, v: number): number[] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), u = v * (1 - (1 - f) * s);
  return [[v, u, p], [q, v, p], [p, v, u], [p, q, v], [u, p, v], [v, p, q]][i % 6];
}

export function buildTerrainVertexData(t: TerrainData, mode: ColorMode): VertexData {
  const { width: w, depth: d, heights, cell_size: cs } = t;
  const n = w * d;
  const positions = new Float32Array(n * 3);
  const indices = new Uint32Array((w - 1) * (d - 1) * 6);

  const ox = -(w - 1) * cs * 0.5; // center the world around the origin for viewing
  const oz = -(d - 1) * cs * 0.5;
  for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    positions[k * 3] = ox + i * cs;
    positions[k * 3 + 1] = heights[k];
    positions[k * 3 + 2] = oz + j * cs;
  }
  let p = 0;
  for (let j = 0; j < d - 1; j++) for (let i = 0; i < w - 1; i++) {
    const a = j * w + i, b = a + 1, c = a + w, e = c + 1;
    indices[p++] = a; indices[p++] = b; indices[p++] = c;
    indices[p++] = b; indices[p++] = e; indices[p++] = c;
  }
  const normals = new Float32Array(n * 3);
  VertexData.ComputeNormals(positions, indices, normals);

  const colors = terrainColors(t, mode, normals);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.colors = colors;
  return vd;
}

/** One world-wide color field, sampled by every chunk to avoid color seams. */
export function terrainColors(t: TerrainData, mode: ColorMode, normals: Float32Array): Float32Array {
  const n = t.width * t.depth, heights = t.heights;
  const colors = new Float32Array(n * 4);
  let maxFlow = 1, maxErosion = 1;
  if (t.layers && (mode === "flow" || mode === "drainage" || mode === "erosion")) {
    for (let i = 0; i < n; i++) {
      maxFlow = Math.max(maxFlow, t.layers.flow_accumulation[i]);
      maxErosion = Math.max(maxErosion, Math.abs(t.layers.erosion[i]));
    }
  }
  const min = t.metadata.min_height, max = t.metadata.max_height;
  const range = Math.max(1e-3, max - min);
  const level = t.water?.level ?? -Infinity;
  const scale = t.settings.height_scale;

  for (let k = 0; k < n; k++) {
    const h = heights[k];
    const slope = 1 - normals[k * 3 + 1];
    const tt = (h - min) / range;
    let r: number, g: number, b: number;
    if (mode === "elevation") {
      [r, g, b] = hypsometric(tt);
    } else if (mode === "slope") {
      const s = Math.min(1, slope * 1.6);
      r = 0.15 + s * 0.85; g = 0.6 - s * 0.45; b = 0.9 - s * 0.85;
    } else {
      const debug = debugColor(mode, t, k, slope, maxFlow, maxErosion);
      if (debug) [r, g, b] = debug;
      else [r, g, b] = naturalColor(h, slope, level, scale, k);
    }
    colors[k * 4] = r; colors[k * 4 + 1] = g; colors[k * 4 + 2] = b; colors[k * 4 + 3] = 1;
  }

  return colors;
}

function mix(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const sm = (e0: number, e1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

const SAND = [0.74, 0.68, 0.5];
const GRASS = [0.34, 0.5, 0.22];
const GRASS_DRY = [0.52, 0.56, 0.3];
const ROCK = [0.43, 0.4, 0.37];
const ROCK_DARK = [0.3, 0.28, 0.27];
const SNOW = [0.93, 0.94, 0.97];

function naturalColor(h: number, slope: number, level: number, scale: number, k: number): number[] {
  // cheap deterministic per-vertex variation
  const v = (((k * 2654435761) >>> 0) % 1000) / 1000 - 0.5;
  let c = mix(GRASS, GRASS_DRY, sm(0.25, 0.6, h / scale) * 0.6 + v * 0.15);
  // sand near the water line
  const shore = 1 - sm(0, 4 + scale * 0.02, h - level);
  c = mix(c, SAND, shore);
  // rock on steep slopes
  const rock = sm(0.18, 0.42, slope);
  c = mix(c, mix(ROCK, ROCK_DARK, sm(0.45, 0.8, slope)), rock);
  // snow on high, not-too-steep ground
  const snow = sm(0.68, 0.8, h / scale + v * 0.03) * (1 - sm(0.35, 0.65, slope));
  c = mix(c, SNOW, snow);
  return c;
}

function hypsometric(t: number): number[] {
  const stops: [number, number[]][] = [
    [0, [0.1, 0.25, 0.6]], [0.2, [0.2, 0.55, 0.3]], [0.4, [0.55, 0.7, 0.3]],
    [0.6, [0.85, 0.65, 0.3]], [0.8, [0.6, 0.3, 0.2]], [1, [1, 1, 1]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]; const [t1, c1] = stops[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

export function buildWaterVertexData(t: TerrainData): VertexData | null {
  if (!t.water) return null;
  const { width: w, depth: d, cell_size: cs } = t;
  const n = w * d;
  const m = t.water.mask;
  const waterSurface = t.water.surface ?? new Float32Array(n).fill(t.water.level);
  const ox = -(w - 1) * cs * 0.5, oz = -(d - 1) * cs * 0.5;

  // Water surface at grid corners. Dry corners that belong to quads touching
  // water inherit a nearby water elevation so the rendered shoreline closes,
  // but no terrain is moved and the terrain mesh remains complete.
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = m[i] ? waterSurface[i] : NaN;
  for (let pass = 0; pass < 2; pass++) {
    const prev = y.slice();
    for (let r = 0; r < d; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (m[i] || !Number.isNaN(prev[i])) continue;
      let sum = 0, count = 0;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= d || nc < 0 || nc >= w) continue;
        const v = prev[nr * w + nc];
        if (Number.isFinite(v)) { sum += v; count++; }
      }
      if (count) y[i] = sum / count;
    }
  }
  const remap = new Int32Array(n).fill(-1);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vert = (k: number) => {
    if (remap[k] < 0) {
      remap[k] = positions.length / 3;
      const rr = Math.floor(k / w), cc = k % w;
      const surfaceY = Number.isFinite(y[k]) ? y[k] : t.water!.level;
      positions.push(ox + cc * cs, surfaceY, oz + rr * cs);
      uvs.push(cc / (w - 1), rr / (d - 1));
    }
    return remap[k];
  };
  for (let j = 0; j < d - 1; j++) for (let i = 0; i < w - 1; i++) {
    const a = j * w + i, b = a + 1, c = a + w, e = c + 1;
    if (!(m[a] || m[b] || m[c] || m[e])) continue;
    const va = vert(a), vb = vert(b), vc = vert(c), ve = vert(e);
    indices.push(va, vb, vc, vb, ve, vc);
  }
  if (!indices.length) return null;
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.uvs = uvs;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vd.normals = normals;
  return vd;
}
