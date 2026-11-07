import type { TerrainData } from "../terrain/types";

export const WORLD_VERSION = "1.0.0";
export type Lod = 0 | 1 | 2;
export interface ChunkLayout { chunk_width: number; chunk_depth: number }
export interface ChunkDescriptor {
  id: string;
  coord: [number, number];
  /** Inclusive source vertex bounds; only the cells inside are owned. */
  rect: [number, number, number, number];
  neighbors: { north: string | null; east: string | null; south: string | null; west: string | null };
}
export interface IndexedMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Global grid coordinates, including transition-cell centers. */
  samples: Float32Array;
}
export interface WorldData {
  id: string;
  terrain: TerrainData;
  layout: ChunkLayout;
  columns: number;
  rows: number;
  chunk_cells: [number, number];
  chunks: ChunkDescriptor[];
  normals: Float32Array;
  water_surface: Float32Array;
  water_normals: Float32Array;
  water_cells: Uint8Array;
  /** Quads that must keep source-detail topology at every LOD (water + riverbeds). */
  protected_cells: Uint8Array;
  protected_prefix: Uint32Array;
  meshes: Map<string, IndexedMesh>;
  imported: boolean;
  available: Set<string>;
}
export interface ChunkViewOptions {
  selected: string;
  scope: "world" | "neighbors" | "selected";
  lod: "adaptive" | Lod;
  grid: boolean;
  debug: "off" | "lod" | "resolution";
  hidden: string[];
}
export interface WorldViewStats {
  loaded: number;
  triangles: number;
  waterTriangles: number;
  lods: Record<string, Lod>;
  buildMs: number;
}