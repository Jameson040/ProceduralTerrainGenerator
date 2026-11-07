/** Versioned, renderer-independent chunk files. JSON numbers preserve float32 exactly. */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { TerrainData, TerrainLayers, TerrainMetadata, TerrainSettings } from "../terrain/types";
import { chunkMesh, createWorld, spacing } from "./world";
import { SUPPORTED_WORLD_VERSIONS, WORLD_VERSION, type ChunkDescriptor, type ChunkLayout, type IndexedMesh, type Lod, type WorldData } from "./types";
import { defaultVisualSettings, type VisualSettings } from "../terrain/visual";
import { ensureMaterials, materialSettingsKey, terrainVertexColors, waterVertexColors } from "./shading";
import { MATERIAL_FORMAT_VERSION, packAlbedo, packWeights, type MaterialId } from "../terrain/materials";

export interface MeshFile {
  positions: number[]; normals: number[]; uvs: number[]; indices: number[]; samples: number[];
  /** World-space UVs in metres (format 1.1.0+), identical across chunks. */
  uv_world?: number[];
  /** RGBA vertex colours quantised to bytes (format 1.1.0+). */
  colors?: number[];
  colors_format?: "u8-linear-v1";
}

/** Per-source-vertex material masks (format 1.1.0+). */
export interface MaterialFile {
  format: "u8-linear-v1";
  version: number;
  /** Channel order of `weights`. */
  ids: MaterialId[];
  /** shape[0] * shape[1] * ids.length bytes. */
  weights: number[];
  /** shape[0] * shape[1] * 3 bytes. */
  albedo: number[];
}
export interface WorldHeader {
  id: string;
  source_shape: [number, number];
  origin: [number, number];
  spacing: [number, number];
  dimensions: [number, number];
  chunk_grid: [number, number];
  chunk_cells: [number, number];
  layout: ChunkLayout;
  settings: TerrainSettings;
  metadata: TerrainMetadata;
  water_info: { level: number; lakes: NonNullable<TerrainData["water"]>["lakes"]; rivers: NonNullable<TerrainData["water"]>["rivers"] } | null;
  /** Material + water appearance, so an imported world looks like the exported one. */
  render: VisualSettings;
  coordinates: "global-x-y-z-metres";
  winding: "clockwise-from-above-left-handed-y-up";
  normals: "global-source-central-differences";
  stitching: "pinned-source-boundary-and-conforming-transition-fans-no-skirts";
}
export interface ChunkFile {
  kind: "terrain-chunk";
  version: string;
  world: WorldHeader;
  chunk: ChunkDescriptor;
  source: {
    shape: [number, number]; heights: number[]; normals: number[];
    water_mesh_surface: number[]; water_normals: number[];
    water: { mask: number[]; surface: number[]; depth: number[]; lake_mask: number[]; river_mask: number[] } | null;
    layers: Record<string, number[]>;
  };
  materials: MaterialFile | null;
  lods: { level: Lod; interior_stride: number; boundary_stride: 1; water_refinement: true; mesh: MeshFile }[];
  water_mesh: MeshFile;
}
export interface WorldManifest {
  kind: "terrain-world"; version: string; world: WorldHeader;
  chunks: (ChunkDescriptor & { file: string })[];
}

export function worldHeader(w: WorldData): WorldHeader {
  const t = w.terrain, [sx, sz] = spacing(t);
  return { id: w.id, source_shape: [t.width, t.depth], origin: [t.origin_x, t.origin_z], spacing: [sx, sz],
    dimensions: [(t.width - 1) * sx, (t.depth - 1) * sz], chunk_grid: [w.columns, w.rows], chunk_cells: w.chunk_cells,
    layout: w.layout, settings: { ...t.settings }, metadata: t.metadata,
    water_info: t.water ? { level: t.water.level, lakes: t.water.lakes, rivers: t.water.rivers } : null,
    render: w.visual ?? defaultVisualSettings(),
    coordinates: "global-x-y-z-metres", winding: "clockwise-from-above-left-handed-y-up",
    normals: "global-source-central-differences", stitching: "pinned-source-boundary-and-conforming-transition-fans-no-skirts" };
}

const quantise = (rgba: Float32Array): number[] => {
  const out: number[] = new Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, rgba[i])) * 255);
  return out;
};

export const meshToFile = (m: IndexedMesh, colors?: Float32Array): MeshFile => ({
  positions: Array.from(m.positions), normals: Array.from(m.normals),
  uvs: Array.from(m.uvs), indices: Array.from(m.indices), samples: Array.from(m.samples),
  uv_world: Array.from(m.world_uv),
  ...(colors ? { colors: quantise(colors), colors_format: "u8-linear-v1" as const } : {}),
});

export function extractChunk(w: WorldData, chunk: ChunkDescriptor, visual?: VisualSettings): ChunkFile {
  if (!w.available.has(chunk.id)) throw new Error(`Chunk ${chunk.id} is not loaded.`);
  const t = w.terrain, [x0, z0, x1, z1] = chunk.rect;
  const look = visual ?? w.visual ?? defaultVisualSettings();
  const slice = (array: ArrayLike<number>, components = 1) => {
    const out: number[] = [];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++)
      for (let c = 0; c < components; c++) out.push(array[(z * t.width + x) * components + c]);
    return out;
  };
  const layers: Record<string, number[]> = {};
  if (t.layers) for (const [key, array] of Object.entries(t.layers)) layers[key] = slice(array);
  const field = ensureMaterials(w, look.material);
  const materials: MaterialFile = {
    format: "u8-linear-v1", version: MATERIAL_FORMAT_VERSION, ids: [...field.ids],
    weights: slice(packWeights(field), field.ids.length), albedo: slice(packAlbedo(field), 3),
  };
  const meshFile = (level: Lod, water: boolean) => {
    const mesh = chunkMesh(w, chunk, level, water);
    return meshToFile(mesh, water ? waterVertexColors(w, mesh, look.water) : terrainVertexColors(w, mesh, look.material));
  };
  return {
    kind: "terrain-chunk", version: WORLD_VERSION, world: worldHeader(w), chunk,
    source: { shape: [x1 - x0 + 1, z1 - z0 + 1], heights: slice(t.heights), normals: slice(w.normals, 3),
      water_mesh_surface: slice(w.water_surface), water_normals: slice(w.water_normals, 3), layers,
      water: t.water ? { mask: slice(t.water.mask), surface: slice(t.water.surface), depth: slice(t.water.depth),
        lake_mask: slice(t.water.lake_mask), river_mask: slice(t.water.river_mask) } : null },
    materials,
    lods: ([0, 1, 2] as Lod[]).map(level => ({ level, interior_stride: 2 ** level, boundary_stride: 1, water_refinement: true,
      mesh: meshFile(level, false) })), water_mesh: meshFile(0, true),
  };
}

export function worldFiles(w: WorldData, visual?: VisualSettings): Record<string, Uint8Array> {
  if (w.available.size !== w.chunks.length) throw new Error("Load every source chunk before exporting a complete world.");
  const look = visual ?? w.visual ?? defaultVisualSettings();
  const manifest: WorldManifest = { kind: "terrain-world", version: WORLD_VERSION, world: worldHeader({ ...w, visual: look }),
    chunks: w.chunks.map(c => ({ ...c, file: `chunks/${c.id}.json` })) };
  const files: Record<string, Uint8Array> = { "world.json": strToU8(JSON.stringify(manifest, null, 2)) };
  for (const c of w.chunks) files[`chunks/${c.id}.json`] = strToU8(JSON.stringify(extractChunk(w, c, look)));
  return files;
}

export function exportWorldZip(w: WorldData, visual?: VisualSettings): Uint8Array {
  return zipSync(worldFiles(w, visual), { level: 1, mtime: new Date("2000-01-01T00:00:00Z") });
}

function checkedArray(a: unknown, length: number, name: string): number[] {
  if (!Array.isArray(a) || a.length !== length || !a.every(Number.isFinite)) throw new Error(`Invalid ${name} buffer.`);
  return a;
}

export function meshFromFile(m: MeshFile): IndexedMesh {
  if (!m || !Array.isArray(m.positions) || m.positions.length % 3 !== 0) throw new Error("Invalid mesh positions.");
  const count = m.positions.length / 3;
  checkedArray(m.positions, count * 3, "positions"); checkedArray(m.normals, count * 3, "normals");
  checkedArray(m.uvs, count * 2, "UV"); checkedArray(m.samples, count * 2, "samples");
  if (!Array.isArray(m.indices) || m.indices.length % 3 || !m.indices.every(i => Number.isInteger(i) && i >= 0 && i < count))
    throw new Error("Invalid mesh triangle indices.");
  if (m.uv_world) checkedArray(m.uv_world, count * 2, "world UV");
  if (m.colors) checkedArray(m.colors, count * 4, "vertex colours");
  // Format 1.0.0 meshes have no world UV; positions are global metres, so the
  // world UV is recovered exactly from x/z.
  let worldUv: Float32Array;
  if (m.uv_world) worldUv = Float32Array.from(m.uv_world);
  else {
    worldUv = new Float32Array(count * 2);
    for (let v = 0; v < count; v++) {
      worldUv[v * 2] = m.positions[v * 3];
      worldUv[v * 2 + 1] = m.positions[v * 3 + 2];
    }
  }
  return { positions: Float32Array.from(m.positions), normals: Float32Array.from(m.normals), uvs: Float32Array.from(m.uvs),
    world_uv: worldUv, indices: Uint32Array.from(m.indices), samples: Float32Array.from(m.samples) };
}

/** Reconstruction uses only exported buffers. It does not import the generator. */
export function loadChunkFiles(packets: ChunkFile[]): WorldData {
  if (!packets.length) throw new Error("No chunk files were selected.");
  const header = packets[0].world;
  if (!header || !Array.isArray(header.source_shape)) throw new Error("Missing world header.");
  const [w, d] = header.source_shape, total = w * d;
  if (![w, d].every(n => Number.isInteger(n) && n >= 2) || total > 1_100_000) throw new Error("Unsupported world source dimensions.");
  if (!header.spacing?.every(n => Number.isFinite(n) && n > 0) || !header.origin?.every(Number.isFinite)) throw new Error("Invalid world coordinates.");
  const h = new Float32Array(total), normals = new Float32Array(total * 3), waterNormals = new Float32Array(total * 3), waterMeshSurface = new Float32Array(total);
  const materialIdsSeen = new Set<string>();
  const seen = new Uint8Array(total), water = header.water_info ? {
    ...header.water_info, mask: new Uint8Array(total), surface: new Float32Array(total), depth: new Float32Array(total),
    lake_mask: new Uint8Array(total), river_mask: new Uint8Array(total),
  } : null;
  const layers: Record<string, Float32Array> = {};
  const t: TerrainData = { width: w, depth: d, origin_x: header.origin[0], origin_z: header.origin[1], cell_size: Math.min(...header.spacing),
    spacing_x: header.spacing[0], spacing_z: header.spacing[1], heights: h, water, layers: null,
    settings: { ...header.settings }, metadata: { ...header.metadata, source: "file" } };
  const expected = createWorld(t, header.layout);
  const accepted = new Set<string>();
  // Per-source material masks, restored verbatim from format 1.1.0 files.
  const materialWeights = new Map<string, Uint8Array>();
  const materialAlbedo = new Map<string, Uint8Array>();
  let materialChannelIds: string[] = [];
  for (const p of packets) {
    if (p.kind !== "terrain-chunk" || !SUPPORTED_WORLD_VERSIONS.includes(p.version)) throw new Error("Unsupported chunk format version.");
    if (p.world.id !== header.id || JSON.stringify(p.world.source_shape) !== JSON.stringify(header.source_shape)
      || JSON.stringify(p.world.spacing) !== JSON.stringify(header.spacing) || JSON.stringify(p.world.origin) !== JSON.stringify(header.origin)
      || JSON.stringify(p.world.layout) !== JSON.stringify(header.layout)) throw new Error("These chunks belong to different worlds.");
    const desc = expected.chunks.find(c => c.id === p.chunk?.id);
    if (!desc || JSON.stringify(desc) !== JSON.stringify(p.chunk)) throw new Error("Invalid chunk coordinates or relationships.");
    if (accepted.has(desc.id)) throw new Error(`Duplicate chunk: ${desc.id}`);
    accepted.add(desc.id);
    const [x0, z0, x1, z1] = desc.rect, count = (x1 - x0 + 1) * (z1 - z0 + 1);
    if (p.source.shape[0] !== x1 - x0 + 1 || p.source.shape[1] !== z1 - z0 + 1) throw new Error("Chunk source shape mismatch.");
    checkedArray(p.source.heights, count, "heightfield"); checkedArray(p.source.normals, count * 3, "source normals");
    checkedArray(p.source.water_mesh_surface, count, "water halo"); checkedArray(p.source.water_normals, count * 3, "water normals");
    if (Boolean(p.source.water) !== Boolean(water)) throw new Error("Inconsistent water dataset.");
    if (water && p.source.water) for (const key of ["mask", "surface", "depth", "lake_mask", "river_mask"] as const) checkedArray(p.source.water[key], count, key);
    for (const [key, values] of Object.entries(p.source.layers)) {
      checkedArray(values, count, key); if (!layers[key]) layers[key] = new Float32Array(total);
    }
    if (p.materials) {
      if (p.materials.format !== "u8-linear-v1") throw new Error("Unsupported material mask format.");
      if (materialChannelIds.length && JSON.stringify(materialChannelIds) !== JSON.stringify(p.materials.ids))
        throw new Error("Chunks disagree about the material channel order.");
      materialChannelIds = p.materials.ids;
      p.materials.ids.forEach(id => materialIdsSeen.add(id));
    }
    let local = 0;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++, local++) {
      const i = z * w + x;
      const assign = (target: Float32Array | Uint8Array, values: number[], components = 1) => {
        for (let c = 0; c < components; c++) {
          const v = Math.fround(values[local * components + c]), index = i * components + c;
          if (seen[i] && target[index] !== v) throw new Error(`Shared boundary mismatch at ${x},${z} (${desc.id}).`);
          target[index] = v;
        }
      };
      assign(h, p.source.heights); assign(normals, p.source.normals, 3);
      assign(waterMeshSurface, p.source.water_mesh_surface); assign(waterNormals, p.source.water_normals, 3);
      if (water && p.source.water) for (const key of ["mask", "surface", "depth", "lake_mask", "river_mask"] as const) assign(water[key], p.source.water[key]);
      for (const [key, values] of Object.entries(p.source.layers)) assign(layers[key], values);
      if (p.materials) {
        const channels = p.materials.ids.length;
        for (let c = 0; c < channels; c++) {
          const key = p.materials.ids[c];
          let target = materialWeights.get(key);
          if (!target) { target = new Uint8Array(total); materialWeights.set(key, target); }
          target[i] = p.materials.weights[local * channels + c];
        }
        for (let c = 0; c < 3; c++) {
          let target = materialAlbedo.get("rgb");
          if (!target) { target = new Uint8Array(total * 3); materialAlbedo.set("rgb", target); }
          target[i * 3 + c] = p.materials.albedo[local * 3 + c];
        }
      }
      seen[i] = 1;
    }
  }
  if (["flow_accumulation", "flow_direction", "drainage_slope", "watershed", "erosion", "river_mask", "lake_mask"].every(k => k in layers)) t.layers = layers as unknown as TerrainLayers;
  const world = createWorld(t, header.layout);
  if (header.render) world.visual = header.render;
  if (materialChannelIds.length) {
    // Interleave the per-channel masks back into one field so the loaded world
    // renders exactly like the exported one without recomputing anything.
    const count = materialChannelIds.length, weights = new Float32Array(total * count);
    for (let k = 0; k < total; k++) for (let c = 0; c < count; c++) {
      weights[k * count + c] = (materialWeights.get(materialChannelIds[c])?.[k] ?? 0) / 255;
    }
    const albedoBytes = materialAlbedo.get("rgb");
    const albedo = albedoBytes ? Float32Array.from(albedoBytes, v => v / 255) : new Float32Array(total * 3);
    world.materials = { ids: materialChannelIds as never, count, weights, albedo, settings: world.visual.material };
    // Adopt the exported masks: re-deriving them from a partially loaded world would
    // normalise against empty cells and shift every colour.
    world.materialsKey = materialSettingsKey(world.visual.material);
  }
  if (accepted.size === expected.chunks.length && world.id !== header.id) throw new Error("Complete-world source fingerprint mismatch.");
  world.id = header.id; world.normals = normals; world.water_normals = waterNormals; world.water_surface = waterMeshSurface;
  world.imported = true; world.available = accepted;
  for (const p of packets) {
    if (!Array.isArray(p.lods) || p.lods.length !== 3 || new Set(p.lods.map(l => l.level)).size !== 3) throw new Error("Expected all three exported LOD meshes.");
    for (const l of p.lods) {
      if (![0, 1, 2].includes(l.level) || l.boundary_stride !== 1) throw new Error("Unsupported LOD topology.");
      world.meshes.set(`${p.chunk.id}:${l.level}`, meshFromFile(l.mesh));
    }
    world.meshes.set(`${p.chunk.id}:water`, meshFromFile(p.water_mesh));
  }
  if (accepted.size === expected.chunks.length && seen.some(v => !v)) throw new Error("Incomplete world source coverage.");
  return world;
}

export function importWorldZip(bytes: Uint8Array): WorldData {
  if (bytes.byteLength > 80_000_000) throw new Error("World archive is too large for this preview.");
  let budget = 0;
  const files = unzipSync(bytes, { filter: file => {
    if (!file.name.endsWith(".json")) return false;
    budget += file.originalSize;
    if (budget > 300_000_000) throw new Error("Expanded world exceeds the preview memory budget.");
    return true;
  } });
  if (!files["world.json"]) throw new Error("Missing world.json manifest.");
  const manifest: WorldManifest = JSON.parse(strFromU8(files["world.json"]));
  if (manifest.kind !== "terrain-world" || !SUPPORTED_WORLD_VERSIONS.includes(manifest.version) || !Array.isArray(manifest.chunks)) throw new Error("Unsupported world manifest.");
  const packets = manifest.chunks.map(c => {
    if (!files[c.file]) throw new Error(`Missing chunk file ${c.file}`);
    return JSON.parse(strFromU8(files[c.file])) as ChunkFile;
  });
  const world = loadChunkFiles(packets);
  if (world.id !== manifest.world.id || world.available.size !== world.chunks.length) throw new Error("Manifest does not describe a complete world.");
  return world;
}