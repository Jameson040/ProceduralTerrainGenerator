/** Heightfield assembly — port of terrain/generator.py. Pure function of (world x, world z, seed). */
import { fbm, ridged, billow, domainWarp, smoothstep, clamp01, seedOrientation } from "./noise";
import type { TerrainSettings, TerrainData } from "./types";
import { GENERATOR_VERSION } from "./types";
import { hydraulicErosion, thermalErosion } from "./erosion";
import { d8Drainage, fillDepressions } from "./hydrology";
import { buildRiverNetwork } from "./rivers";
import { assembleWater, detectLakes } from "./water";
import type { TerrainLayers } from "./types";

function terrace(h: number, steps: number): number {
  const s = h * steps;
  const base = Math.floor(s);
  const f = s - base;
  const f3 = f * f * f;
  const g = 1 - f;
  const g3 = g * g * g;
  const sharp = f3 / (f3 + g3 + 1e-9);
  return (base + sharp) / steps;
}

/** Normalized height in [0,1] at a world coordinate. */
export function sampleHeight(x: number, z: number, s: TerrainSettings): number {
  const seed = s.seed | 0;
  const f = s.base_frequency;

  // Low-frequency warp bends formations without making every layer share one field.
  const [wx, wz] = domainWarp(x, z, seed, s.warp_strength, f * 0.6);

  // A seed-derived orientation gives each world one long, coherent orogenic axis.
  const angle = seedOrientation(seed);
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const along = wx * ca + wz * sa;
  const across = -wx * sa + wz * ca;

  // Broad continent context combined with an anisotropic range-belt field.
  const continent = fbm(wx, wz, seed + 11, 3, f * 0.58) * 0.5 + 0.5;
  const mf = Math.max(0.1, s.mountain_frequency);
  const rangeContext = fbm(
    along * 0.22, across * 0.90, seed + 31, 3,
    f * 0.78 * mf, 1.95, 0.55
  ) * 0.5 + 0.5;
  const tectonic = 0.54 * continent + 0.46 * rangeContext;
  const lo = 0.68 - s.mountain_amount * 0.5;
  const mountainMask = smoothstep(lo, lo + 0.20, tectonic);

  // Plains and rolling hills use distinct broad and medium scales.
  const broadHills = fbm(wx, wz, seed + 23, 5, f * 1.45) * 0.5 + 0.5;
  let plains = 0.18 + broadHills * 0.23 * s.hill_amount;
  plains += fbm(x, z, seed + 29, 2, f * 0.48) * 0.035;
  const rollingDetail = fbm(wx, wz, seed + 61, 3, f * 2.7);
  plains += rollingDetail * (0.006 + 0.026 * s.terrain_roughness);

  // Anisotropic ridged spines create connected directional ranges; smaller
  // isotropic spurs provide local peaks without uniformly distributed spikes.
  const spine = ridged(
    along * 0.24, across * 0.95, seed + 37, 6,
    f * 1.30 * mf, 2.0, 0.5, s.mountain_sharpness
  );
  const spurs = ridged(
    wx, wz, seed + 43, 4,
    f * 2.65 * mf, 2.06, 0.47,
    Math.max(0.8, s.mountain_sharpness * 0.9)
  );
  const ridgeField = Math.min(1, Math.max(0,
    spine * (0.88 - 0.18 * s.terrain_roughness)
    + spurs * (0.12 + 0.18 * s.terrain_roughness)
  ));
  const mountainRelief = (0.11 + 0.63 * ridgeField) * s.mountain_height;

  // A formation-specific foothill band softens the transition into plains.
  const foothillBand = 4.0 * mountainMask * (1.0 - mountainMask);
  const foothillShape = fbm(
    along * 0.32, across * 0.72, seed + 47, 3,
    f * 1.45 * mf
  ) * 0.5 + 0.5;
  let foothills = foothillBand * (0.035 + 0.075 * foothillShape);
  foothills *= (0.25 + 0.75 * s.hill_amount) * s.mountain_height;
  let h = plains + mountainMask * mountainRelief + foothills;

  // Trunk valleys and finer tributaries carve more strongly through uplands.
  const trunkNoise = billow(wx, wz, seed + 53, 4, f * 1.45);
  const branchNoise = billow(wx, wz, seed + 67, 3, f * 3.0);
  const trunkChannel = 1.0 - smoothstep(0.0, 0.31, trunkNoise);
  const branchChannel = 1.0 - smoothstep(0.0, 0.21, branchNoise);
  const channel = Math.min(1, Math.max(0, 0.74 * trunkChannel + 0.26 * branchChannel));
  let carve = channel * s.valley_depth * (0.25 + 0.10 * mountainMask);
  carve *= smoothstep(0.10, 0.42, h);
  h -= carve;

  // Localized escarpments, not global terracing.
  const cliffZone = mountainMask * smoothstep(0.30, 0.55, h);
  const cliffNoise = fbm(x, z, seed + 71, 2, f * 1.1) * 0.5 + 0.5;
  const blend = Math.min(0.85, Math.max(0, cliffZone * s.cliff_amount * (0.5 + cliffNoise)));
  h += (terrace(h, 7) - h) * blend;

  // Terrain-carved lake basins remain independent of the water mask.
  const basinN = fbm(wx, wz, seed + 113, 3, f * 0.9) * 0.5 + 0.5;
  const rim0 = 0.30;
  const rim1 = rim0 + 0.08 + s.shore_softness * 0.12;
  let bowl = 1.0 - smoothstep(rim0, rim1, basinN);
  const lowland = (1.0 - mountainMask * 0.85) * (1.0 - smoothstep(0.35, 0.60, h));
  bowl *= lowland;
  const profile = bowl * bowl * (3.0 - 2.0 * bowl);
  h -= profile * 0.10;
  h += bowl * fbm(x, z, seed + 127, 2, f * 6.0) * 0.01;

  // Detail has an explicit world-space wavelength, independent of grid density.
  const detailWavelength = Math.max(2.0, s.detail_scale);
  const detailAmplitude = 0.003 + 0.018 * s.terrain_roughness;
  h += fbm(x, z, seed + 97, 3, 1.0 / detailWavelength) * detailAmplitude;

  return clamp01(h);
}

export function generateTerrain(settings: TerrainSettings): TerrainData {
  const t0 = performance.now();
  if (![settings.world_width, settings.world_depth, settings.height_scale].every(v => Number.isFinite(v) && v > 0)
    || !Number.isInteger(settings.resolution) || settings.resolution < 16 || settings.resolution > 1025) {
    throw new Error("Use positive world dimensions and a source resolution from 16 to 1025.");
  }
  const res = Math.max(2, Math.floor(settings.resolution));
  const cell = Math.min(settings.world_width / (res - 1), settings.world_depth / (res - 1));
  const width = Math.max(2, Math.round(settings.world_width / cell) + 1);
  const depth = Math.max(2, Math.round(settings.world_depth / cell) + 1);
  const total = width * depth;
  if (total > 1_100_000) throw new Error("This finite-world preview supports up to 1.1 million source samples. Reduce source resolution or the aspect ratio.");
  const sx = settings.world_width / (width - 1), sz = settings.world_depth / (depth - 1);
  const base = new Float32Array(total);
  for (let j = 0; j < depth; j++) {
    const z = settings.origin_z + j * sz;
    for (let i = 0; i < width; i++) {
      base[j * width + i] = sampleHeight(settings.origin_x + i * sx, z, settings) * settings.height_scale;
    }
  }
  const tBase = performance.now();
  let heights: Float32Array = base.slice();
  let droplets = 0, thermalIterations = 0;
  if (settings.erosion_quality > 0) {
    if (settings.hydraulic_enabled) {
      const result = hydraulicErosion(heights, depth, width, settings);
      heights = result.heights;
      droplets = result.droplets;
    }
    if (settings.thermal_enabled) {
      const result = thermalErosion(heights, depth, width, cell, settings);
      heights = result.heights;
      thermalIterations = result.thermal_iterations;
    }
  }
  const tErosion = performance.now();

  // Depressions are filled only for routing; lakebeds remain real terrain.
  const routingSurface = fillDepressions(heights, depth, width, 0.0005);
  const drainage = d8Drainage(routingSurface, depth, width, cell);
  const tDrainage = performance.now();
  const lakeField = detectLakes(heights, depth, width, cell, settings);
  let network = null;
  if (settings.water_enabled && settings.rivers_enabled) {
    const carved = buildRiverNetwork(heights, depth, width, cell, drainage, lakeField.mask, settings);
    heights = carved.heights;
    network = carved.network;
  }
  const tRivers = performance.now();

  const data: TerrainData = {
    width, depth, cell_size: cell, spacing_x: sx, spacing_z: sz,
    origin_x: settings.origin_x, origin_z: settings.origin_z,
    heights, settings: { ...settings }, water: null, layers: null,
    metadata: {
      generator_version: GENERATOR_VERSION, settings_version: settings.settings_version,
      seed: settings.seed, grid: [width, depth], cell_size: cell,
      min_height: 0, max_height: 0, generation_time_ms: 0, water_cells: 0, source: "browser",
    },
  };
  data.water = assembleWater(data, lakeField, network ?? undefined);

  const layers: TerrainLayers = {
    flow_accumulation: drainage.accumulation,
    flow_direction: drainage.direction,
    drainage_slope: drainage.slope,
    watershed: drainage.watershed,
    erosion: new Float32Array(total),
    river_mask: new Float32Array(total),
    lake_mask: new Float32Array(total),
  };
  let min = Infinity, max = -Infinity, erosionAbs = 0, maxCut = 0, maxFill = 0;
  let waterCells = 0, lakeCells = 0, riverCells = 0;
  for (let i = 0; i < total; i++) {
    const v = heights[i];
    min = Math.min(min, v); max = Math.max(max, v);
    const delta = v - base[i];
    layers.erosion[i] = delta;
    erosionAbs += Math.abs(delta);
    maxCut = Math.max(maxCut, -delta); maxFill = Math.max(maxFill, delta);
    if (data.water?.mask[i]) waterCells++;
    if (lakeField.mask[i]) { lakeCells++; layers.lake_mask[i] = 1; }
    if (network?.mask[i]) { riverCells++; layers.river_mask[i] = 1; }
  }
  layers.erosion = layers.erosion;
  data.layers = layers;
  const tWater = performance.now();
  data.metadata.min_height = min;
  data.metadata.max_height = max;
  data.metadata.generation_time_ms = Math.round((tWater - t0) * 100) / 100;
  data.metadata.water_cells = waterCells;
  data.metadata.lake_cells = lakeCells;
  data.metadata.river_cells = riverCells;
  data.metadata.river_count = network?.rivers.length ?? 0;
  data.metadata.lake_count = lakeField.lakes.length;
  data.metadata.watershed_count = drainage.watershed_count;
  data.metadata.sink_count = drainage.sink_count;
  data.metadata.max_flow_accumulation = drainage.max_accumulation;
  data.metadata.erosion_quality = settings.erosion_quality;
  data.metadata.hydraulic_droplets = droplets;
  data.metadata.thermal_iterations = thermalIterations;
  data.metadata.erosion_mean_abs_m = Math.round((erosionAbs / total) * 10000) / 10000;
  data.metadata.erosion_max_cut_m = Math.round(maxCut * 10000) / 10000;
  data.metadata.erosion_max_fill_m = Math.round(maxFill * 10000) / 10000;
  data.metadata.river_carved_volume_m3 = Math.round((network?.carved_volume ?? 0) * 100) / 100;
  data.metadata.timing_ms = {
    terrain: Math.round((tBase - t0) * 100) / 100,
    erosion: Math.round((tErosion - tBase) * 100) / 100,
    drainage: Math.round((tDrainage - tErosion) * 100) / 100,
    lakes_rivers: Math.round((tRivers - tDrainage) * 100) / 100,
    water: Math.round((tWater - tRivers) * 100) / 100,
  };
  if (data.water && waterCells) {
    let bedMin = Infinity, bedMax = -Infinity, bedSum = 0, maxDepth = 0;
    for (let i = 0; i < total; i++) if (data.water.mask[i]) {
      const bed = heights[i];
      bedMin = Math.min(bedMin, bed); bedMax = Math.max(bedMax, bed); bedSum += bed;
      maxDepth = Math.max(maxDepth, data.water.depth[i]);
    }
    data.metadata.lakebed_min = Math.round(bedMin * 1000) / 1000;
    data.metadata.lakebed_max = Math.round(bedMax * 1000) / 1000;
    data.metadata.lakebed_mean = Math.round((bedSum / waterCells) * 1000) / 1000;
    data.metadata.max_water_depth = Math.round(maxDepth * 1000) / 1000;
    data.metadata.water_level = Math.round(data.water.level * 1000) / 1000;
    data.metadata.underwater_terrain_cells = waterCells;
  }
  return data;
}

/** Slice a sub-region (basis for future chunk extraction). */
export function extractRegion(t: TerrainData, x0: number, z0: number, w: number, d: number): TerrainData {
  const heights = new Float32Array(w * d);
  const total = w * d;
  const mask = new Uint8Array(total);
  const surface = new Float32Array(total);
  const depthArr = new Float32Array(total);
  const lakeMask = new Uint8Array(total);
  const riverMask = new Uint8Array(total);
  for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) {
    const src = (z0 + j) * t.width + (x0 + i);
    const dst = j * w + i;
    heights[dst] = t.heights[src];
    if (t.water) {
      mask[dst] = t.water.mask[src];
      surface[dst] = t.water.surface[src];
      depthArr[dst] = t.water.depth[src];
      lakeMask[dst] = t.water.lake_mask[src];
      riverMask[dst] = t.water.river_mask[src];
    }
  }
  const layers = t.layers ? {
    flow_accumulation: sliceLayer(t.layers.flow_accumulation, t.width, w, d, x0, z0),
    flow_direction: sliceLayer(t.layers.flow_direction, t.width, w, d, x0, z0),
    drainage_slope: sliceLayer(t.layers.drainage_slope, t.width, w, d, x0, z0),
    watershed: sliceLayer(t.layers.watershed, t.width, w, d, x0, z0),
    erosion: sliceLayer(t.layers.erosion, t.width, w, d, x0, z0),
    river_mask: sliceLayer(t.layers.river_mask, t.width, w, d, x0, z0),
    lake_mask: sliceLayer(t.layers.lake_mask, t.width, w, d, x0, z0),
  } : null;
  return {
    ...t, width: w, depth: d, heights,
    origin_x: t.origin_x + x0 * (t.spacing_x ?? t.cell_size), origin_z: t.origin_z + z0 * (t.spacing_z ?? t.cell_size),
    water: t.water ? { ...t.water, mask, surface, depth: depthArr, lake_mask: lakeMask, river_mask: riverMask } : null,
    layers,
    metadata: { ...t.metadata, extracted_from: [x0, z0, w, d] },
  };
}

function sliceLayer(source: Float32Array, sourceWidth: number, w: number, d: number, x0: number, z0: number): Float32Array {
  const out = new Float32Array(w * d);
  for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) out[j * w + i] = source[(z0 + j) * sourceWidth + x0 + i];
  return out;
}
