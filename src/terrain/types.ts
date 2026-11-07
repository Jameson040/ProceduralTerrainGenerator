/** Renderer-agnostic terrain data model (mirrors terrain/config.py & generator.py). */

export const SETTINGS_VERSION = 3;
export const FORMAT_VERSION = 1;
export const GENERATOR_VERSION = "0.4.0";

export interface TerrainSettings {
  seed: number;
  world_width: number;
  world_depth: number;
  origin_x: number;
  origin_z: number;
  resolution: number;
  height_scale: number;
  mountain_amount: number;
  /** Frequency multiplier for oriented mountain belts. */
  mountain_frequency: number;
  /** Normalized mountain relief multiplier. */
  mountain_height: number;
  mountain_sharpness: number;
  hill_amount: number;
  valley_depth: number;
  cliff_amount: number;
  terrain_roughness: number;
  /** Fine-detail wavelength in world units (metres). */
  detail_scale: number;
  warp_strength: number;
  base_frequency: number;
  water_enabled: boolean;
  water_level: number;
  shore_softness: number;
  basin_lakes_enabled: boolean;
  min_lake_depth: number;

  /** 0 = processing off, 1 = fast preview, 2 = high quality. */
  erosion_quality: number;
  hydraulic_enabled: boolean;
  hydraulic_strength: number;
  thermal_enabled: boolean;
  thermal_talus: number;
  thermal_strength: number;
  rivers_enabled: boolean;
  river_density: number;
  river_width: number;
  river_depth: number;
  settings_version: number;
}

export const defaultSettings = (): TerrainSettings => ({
  seed: 42,
  world_width: 1024,
  world_depth: 1024,
  origin_x: 0,
  origin_z: 0,
  resolution: 256,
  height_scale: 180,
  mountain_amount: 0.55,
  mountain_frequency: 1.0,
  mountain_height: 1.0,
  mountain_sharpness: 1.4,
  hill_amount: 0.5,
  valley_depth: 0.45,
  cliff_amount: 0.6,
  terrain_roughness: 0.45,
  detail_scale: 42.0,
  warp_strength: 60,
  base_frequency: 1 / 420,
  water_enabled: true,
  water_level: 0.2,
  shore_softness: 0.6,
  basin_lakes_enabled: true,
  min_lake_depth: 1.5,
  erosion_quality: 1,
  hydraulic_enabled: true,
  hydraulic_strength: 0.55,
  thermal_enabled: true,
  thermal_talus: 34,
  thermal_strength: 0.6,
  rivers_enabled: true,
  river_density: 0.5,
  river_width: 8,
  river_depth: 1.4,
  settings_version: SETTINGS_VERSION,
});

export interface LakeInfo {
  cell_count: number;
  area_m2: number;
  surface_elevation_m: number;
  lakebed_min_m: number;
  lakebed_max_m: number;
  max_depth_m: number;
  mean_depth_m: number;
  centroid: [number, number];
  source: "global-level" | "closed-basin";
}

export interface RiverInfo {
  source_cell: [number, number];
  length_m: number;
  mean_width_m: number;
  max_accumulation: number;
  cell_count: number;
}

export interface WaterData {
  level: number;
  /** depth*width, 1 where water covers the cell */
  mask: Uint8Array;
  /** Per-cell water surface elevation (varies for rivers and perched lakes). */
  surface: Float32Array;
  depth: Float32Array;
  lake_mask: Uint8Array;
  river_mask: Uint8Array;
  lakes: LakeInfo[];
  rivers: RiverInfo[];
}

export interface TerrainLayers {
  flow_accumulation: Float32Array;
  flow_direction: Float32Array;
  drainage_slope: Float32Array;
  watershed: Float32Array;
  erosion: Float32Array;
  river_mask: Float32Array;
  lake_mask: Float32Array;
}

export interface TerrainMetadata {
  generator_version: string;
  settings_version: number;
  seed: number;
  grid: [number, number];
  cell_size: number;
  min_height: number;
  max_height: number;
  generation_time_ms: number;
  water_cells: number;
  source: "browser" | "python" | "file";
  [k: string]: unknown;
}

export interface TerrainData {
  width: number;
  depth: number;
  origin_x: number;
  origin_z: number;
  cell_size: number;
  /** depth*width row-major (z-major) heights in world units */
  heights: Float32Array;
  /** Exact rectangular-world spacing; legacy files use cell_size for both. */
  spacing_x?: number;
  spacing_z?: number;
  settings: TerrainSettings;
  metadata: TerrainMetadata;
  water: WaterData | null;
  layers: TerrainLayers | null;
}
