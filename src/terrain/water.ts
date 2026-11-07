/** Terrain-aware basins + independent lake/river water-surface assembly. */
import { connectedComponents, fillDepressions } from "./hydrology";
import type { RiverNetwork } from "./rivers";
import type { LakeInfo, TerrainData, TerrainSettings, WaterData } from "./types";

export interface LakeField {
  mask: Uint8Array;
  surface: Float32Array;
  level: number;
  lakes: LakeInfo[];
  cells: number;
}

function lakeInfo(comp: Int32Array, heights: Float32Array, surface: Float32Array, cols: number, cellArea: number, source: "global-level" | "closed-basin"): LakeInfo {
  let bedMin = Infinity, bedMax = -Infinity, depthMax = 0, depthSum = 0, surfSum = 0, cx = 0, cz = 0;
  for (let k = 0; k < comp.length; k++) {
    const i = comp[k];
    const bed = heights[i], surf = surface[i];
    const depth = Math.max(0, surf - bed);
    bedMin = Math.min(bedMin, bed); bedMax = Math.max(bedMax, bed);
    depthMax = Math.max(depthMax, depth); depthSum += depth; surfSum += surf;
    cx += i % cols; cz += (i / cols) | 0;
  }
  return {
    cell_count: comp.length,
    area_m2: Math.round(comp.length * cellArea * 100) / 100,
    surface_elevation_m: Math.round((surfSum / comp.length) * 1000) / 1000,
    lakebed_min_m: Math.round(bedMin * 1000) / 1000,
    lakebed_max_m: Math.round(bedMax * 1000) / 1000,
    max_depth_m: Math.round(depthMax * 1000) / 1000,
    mean_depth_m: Math.round((depthSum / comp.length) * 1000) / 1000,
    centroid: [Math.round((cx / comp.length) * 100) / 100, Math.round((cz / comp.length) * 100) / 100],
    source,
  };
}

export function detectLakes(heights: Float32Array, rows: number, cols: number, cellSize: number, settings: TerrainSettings): LakeField {
  const total = rows * cols;
  const level0 = settings.water_level * settings.height_scale;
  if (!settings.water_enabled) {
    return { mask: new Uint8Array(total), surface: heights.slice(), level: level0, lakes: [], cells: 0 };
  }
  const level = level0;
  let mask = new Uint8Array(total);
  const surface = heights.slice();
  const minCells = Math.max(10, Math.floor(total * 0.0018));
  const below = new Uint8Array(total);
  for (let i = 0; i < total; i++) if (heights[i] < level) below[i] = 1;
  for (const comp of connectedComponents(below, rows, cols)) {
    if (comp.length < minCells) continue;
    for (let k = 0; k < comp.length; k++) { mask[comp[k]] = 1; surface[comp[k]] = level; }
  }
  if (settings.basin_lakes_enabled) {
    const filled = fillDepressions(heights, rows, cols, 0);
    const candidates = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      if (filled[i] - heights[i] > 0.10 && filled[i] > level + 0.15) candidates[i] = 1;
    }
    for (const comp of connectedComponents(candidates, rows, cols)) {
      if (comp.length < minCells) continue;
      let maxDepth = 0, fillableCount = 0;
      const fillable = new Uint8Array(comp.length);
      for (let k = 0; k < comp.length; k++) {
        const i = comp[k];
        const surf = filled[i] - 0.08;
        if (surf > heights[i] + 0.03) fillable[k] = 1;
        maxDepth = Math.max(maxDepth, surf - heights[i]);
        if (fillable[k]) fillableCount++;
      }
      if (fillableCount < minCells || maxDepth < settings.min_lake_depth) continue;
      for (let k = 0; k < comp.length; k++) if (fillable[k]) {
        const i = comp[k];
        mask[i] = 1;
        surface[i] = Math.max(surface[i], filled[i] - 0.08);
      }
    }
  }
  const lakes: LakeInfo[] = [];
  for (const comp of connectedComponents(mask, rows, cols)) {
    if (comp.length < minCells) continue;
    let isBasin = false;
    if (settings.basin_lakes_enabled) {
      // Classify a basin by the fact that its surface sits above the global level.
      for (let k = 0; k < comp.length; k++) if (surface[comp[k]] > level + 0.15) { isBasin = true; break; }
    }
    lakes.push(lakeInfo(comp, heights, surface, cols, cellSize * cellSize, isBasin ? "closed-basin" : "global-level"));
  }
  lakes.sort((a, b) => b.area_m2 - a.area_m2);
  let cells = 0;
  for (let i = 0; i < total; i++) if (mask[i]) cells++;
  return { mask, surface: mask.some(v => v) ? surface : heights.slice(), level, lakes, cells };
}

export function assembleWater(t: TerrainData, lakes?: LakeField, rivers?: RiverNetwork): WaterData {
  const { width: cols, depth: rows, heights, settings } = t;
  const total = rows * cols;
  const lakeField = lakes ?? detectLakes(heights, rows, cols, t.cell_size, settings);
  if (!settings.water_enabled) {
    return {
      level: lakeField.level, mask: new Uint8Array(total), surface: heights.slice(),
      depth: new Float32Array(total), lake_mask: new Uint8Array(total), river_mask: new Uint8Array(total),
      lakes: [], rivers: [],
    };
  }
  const mask = new Uint8Array(total);
  const lakeMask = lakeField.mask.slice();
  const riverMask = rivers ? rivers.mask.slice() : new Uint8Array(total);
  const surface = heights.slice();
  const depth = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (lakeMask[i]) surface[i] = lakeField.surface[i];
    if (riverMask[i] && !lakeMask[i] && rivers) surface[i] = rivers.surface[i];
    if (riverMask[i] && lakeMask[i] && rivers) surface[i] = Math.max(surface[i], rivers.surface[i]);
    if (lakeMask[i] || riverMask[i]) {
      mask[i] = 1;
      depth[i] = Math.max(0, surface[i] - heights[i]);
    }
  }
  return {
    level: lakeField.level, mask, surface, depth, lake_mask: lakeMask, river_mask: riverMask,
    lakes: lakeField.lakes, rivers: rivers?.rivers ?? [],
  };
}

/** Backward-compatible lake-only water pass. */
export function generateLake(t: TerrainData): WaterData {
  return assembleWater(t);
}

/** Full lake + river water pass. */
export function generateWater(t: TerrainData, lakes?: LakeField, rivers?: RiverNetwork): WaterData {
  return assembleWater(t, lakes, rivers);
}
