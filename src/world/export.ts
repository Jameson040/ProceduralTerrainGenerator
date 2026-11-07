/** Versioned, renderer-independent chunk files. JSON numbers preserve float32 exactly. */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { TerrainData, TerrainLayers, TerrainMetadata, TerrainSettings } from "../terrain/types";
import { chunkMesh, createWorld, spacing } from "./world";
import { WORLD_VERSION, type ChunkDescriptor, type ChunkLayout, type IndexedMesh, type Lod, type WorldData } from "./types";

export interface MeshFile {
  positions: number[]; normals: number[]; uvs: number[]; indices: number[]; samples: number[];
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
    coordinates: "global-x-y-z-metres", winding: "clockwise-from-above-left-handed-y-up",
    normals: "global-source-central-differences", stitching: "pinned-source-boundary-and-conforming-transition-fans-no-skirts" };
}

export const meshToFile = (m: IndexedMesh): MeshFile => ({ positions: Array.from(m.positions), normals: Array.from(m.normals),
  uvs: Array.from(m.uvs), indices: Array.from(m.indices), samples: Array.from(m.samples) });

export function extractChunk(w: WorldData, chunk: ChunkDescriptor): ChunkFile {
  if (!w.available.has(chunk.id)) throw new Error(`Chunk ${chunk.id} is not loaded.`);
  const t = w.terrain, [x0, z0, x1, z1] = chunk.rect;
  const slice = (array: ArrayLike<number>, components = 1) => {
    const out: number[] = [];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++)
      for (let c = 0; c < components; c++) out.push(array[(z * t.width + x) * components + c]);
    return out;
  };
  const layers: Record<string, number[]> = {};
  if (t.layers) for (const [key, array] of Object.entries(t.layers)) layers[key] = slice(array);
  return {
    kind: "terrain-chunk", version: WORLD_VERSION, world: worldHeader(w), chunk,
    source: { shape: [x1 - x0 + 1, z1 - z0 + 1], heights: slice(t.heights), normals: slice(w.normals, 3),
      water_mesh_surface: slice(w.water_surface), water_normals: slice(w.water_normals, 3), layers,
      water: t.water ? { mask: slice(t.water.mask), surface: slice(t.water.surface), depth: slice(t.water.depth),
        lake_mask: slice(t.water.lake_mask), river_mask: slice(t.water.river_mask) } : null },
    lods: ([0, 1, 2] as Lod[]).map(level => ({ level, interior_stride: 2 ** level, boundary_stride: 1, water_refinement: true,
      mesh: meshToFile(chunkMesh(w, chunk, level)) })), water_mesh: meshToFile(chunkMesh(w, chunk, 0, true)),
  };
}

export function worldFiles(w: WorldData): Record<string, Uint8Array> {
  if (w.available.size !== w.chunks.length) throw new Error("Load every source chunk before exporting a complete world.");
  const manifest: WorldManifest = { kind: "terrain-world", version: WORLD_VERSION, world: worldHeader(w),
    chunks: w.chunks.map(c => ({ ...c, file: `chunks/${c.id}.json` })) };
  const files: Record<string, Uint8Array> = { "world.json": strToU8(JSON.stringify(manifest, null, 2)) };
  for (const c of w.chunks) files[`chunks/${c.id}.json`] = strToU8(JSON.stringify(extractChunk(w, c)));
  return files;
}

export function exportWorldZip(w: WorldData): Uint8Array {
  return zipSync(worldFiles(w), { level: 1, mtime: new Date("2000-01-01T00:00:00Z") });
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
  return { positions: Float32Array.from(m.positions), normals: Float32Array.from(m.normals), uvs: Float32Array.from(m.uvs),
    indices: Uint32Array.from(m.indices), samples: Float32Array.from(m.samples) };
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
  for (const p of packets) {
    if (p.kind !== "terrain-chunk" || p.version !== WORLD_VERSION) throw new Error("Unsupported chunk format version.");
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
      seen[i] = 1;
    }
  }
  if (["flow_accumulation", "flow_direction", "drainage_slope", "watershed", "erosion", "river_mask", "lake_mask"].every(k => k in layers)) t.layers = layers as unknown as TerrainLayers;
  const world = createWorld(t, header.layout);
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
  if (manifest.kind !== "terrain-world" || manifest.version !== WORLD_VERSION || !Array.isArray(manifest.chunks)) throw new Error("Unsupported world manifest.");
  const packets = manifest.chunks.map(c => {
    if (!files[c.file]) throw new Error(`Missing chunk file ${c.file}`);
    return JSON.parse(strFromU8(files[c.file])) as ChunkFile;
  });
  const world = loadChunkFiles(packets);
  if (world.id !== manifest.world.id || world.available.size !== world.chunks.length) throw new Error("Manifest does not describe a complete world.");
  return world;
}