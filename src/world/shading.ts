/**
 * Shading data shared by every renderer and by the exporters.
 *
 * A mesh only carries geometry (positions, normals, UVs, indices, world UVs).
 * Colours and material masks are derived here from the material field, so the
 * Babylon adapter, the Three.js adapter and the JSON exporters all consume the
 * exact same numbers.
 */
import type { TerrainData } from "../terrain/types";
import {
  computeMaterialField, defaultMaterialSettings, materialStats, sampleAlbedo, sampleMaterial,
  type MaterialField, type MaterialId, type MaterialSettings, type MaterialStats,
} from "../terrain/materials";
import { defaultWaterVisual, waterColor, waterSample, type WaterVisualSettings } from "../terrain/waterVisual";
import { defaultVisualSettings, type VisualSettings } from "../terrain/visual";
import type { IndexedMesh, WorldData } from "./types";

export { defaultVisualSettings };
export type { VisualSettings };

/** Cache key for the material field, exported so importers can adopt restored masks. */
export const materialSettingsKey = (s: MaterialSettings) =>
  [s.rock_slope, s.sand_shore_m, s.snow_line, s.soil_bias, s.variation].map(v => v.toFixed(4)).join(":");

/** Cached material field for a world; recomputed only when a rule parameter changes. */
export function ensureMaterials(world: WorldData, settings: MaterialSettings = defaultMaterialSettings()): MaterialField {
  const key = materialSettingsKey(settings);
  if (world.materials && world.materialsKey === key) return world.materials;
  const field = computeMaterialField(world.terrain, settings, world.normals);
  world.materials = field;
  world.materialsKey = key;
  return field;
}

export function worldMaterialStats(world: WorldData, settings?: MaterialSettings): MaterialStats {
  return materialStats(world.terrain, ensureMaterials(world, settings), world.normals);
}

/** Per-vertex RGBA for a terrain mesh, from the blended material albedo. */
export function terrainVertexColors(world: WorldData, mesh: IndexedMesh, settings?: MaterialSettings): Float32Array {
  const field = ensureMaterials(world, settings);
  const t = world.terrain, count = mesh.positions.length / 3;
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const [r, g, b] = sampleAlbedo(field, t.width, t.depth, mesh.samples[i * 2], mesh.samples[i * 2 + 1]);
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 1;
  }
  return out;
}

/** Per-vertex material weights split into two vec4 attributes for the shaders. */
export function materialAttributes(world: WorldData, mesh: IndexedMesh, settings?: MaterialSettings):
  { a: Float32Array; b: Float32Array; ids: MaterialId[] } {
  const field = ensureMaterials(world, settings);
  const t = world.terrain, count = mesh.positions.length / 3;
  const a = new Float32Array(count * 4), b = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const x = mesh.samples[i * 2], z = mesh.samples[i * 2 + 1];
    for (let c = 0; c < 4; c++) {
      a[i * 4 + c] = c < field.count ? sampleMaterial(field, t.width, t.depth, x, z, c) : 0;
      const ci = c + 4;
      b[i * 4 + c] = ci < field.count ? sampleMaterial(field, t.width, t.depth, x, z, ci) : 0;
    }
  }
  return { a, b, ids: field.ids };
}

/** Per-vertex RGBA for a water mesh: depth-driven colour, alpha and shoreline fade. */
export function waterVertexColors(world: WorldData, mesh: IndexedMesh, visual?: WaterVisualSettings): Float32Array {
  const s = visual ?? defaultWaterVisual();
  const t = world.terrain, count = mesh.positions.length / 3;
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const { depth, river, mask } = waterSample(t, mesh.samples[i * 2], mesh.samples[i * 2 + 1]);
    const [r, g, b, alpha] = waterColor(depth, river, s);
    // Shoreline halo corners (dry terrain handed to the water mesh) fade out.
    const fade = Math.min(1, Math.max(0, mask)) * 0.85 + 0.15;
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = alpha * fade;
  }
  return out;
}

/** World-space UV in metres for a mesh vertex (chunk independent by construction). */
export function worldUvOf(world: WorldData, mesh: IndexedMesh): Float32Array {
  const t = world.terrain;
  const [sx, sz] = [t.spacing_x ?? t.cell_size, t.spacing_z ?? t.cell_size];
  if (mesh.world_uv) return mesh.world_uv;
  const count = mesh.positions.length / 3, out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[i * 2] = t.origin_x + mesh.samples[i * 2] * sx;
    out[i * 2 + 1] = t.origin_z + mesh.samples[i * 2 + 1] * sz;
  }
  return out;
}

export type { MaterialField, MaterialSettings, MaterialStats, WaterVisualSettings };
export type { TerrainData };
