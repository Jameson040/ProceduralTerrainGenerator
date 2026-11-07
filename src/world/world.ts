/** Finite source-data views and crack-free indexed LOD. No renderer imports. */
import type { TerrainData } from "../terrain/types";
import type { ChunkDescriptor, ChunkLayout, IndexedMesh, Lod, WorldData } from "./types";
import { defaultVisualSettings } from "../terrain/visual";

export const spacing = (t: TerrainData): [number, number] => [t.spacing_x ?? t.cell_size, t.spacing_z ?? t.cell_size];

export function globalNormals(h: Float32Array, w: number, d: number, sx: number, sz: number): Float32Array {
  const out = new Float32Array(w * d * 3);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    const l = Math.max(0, x - 1), r = Math.min(w - 1, x + 1);
    const n = Math.max(0, z - 1), s = Math.min(d - 1, z + 1);
    const nx = -(h[z * w + r] - h[z * w + l]) / ((r - l) * sx);
    const nz = -(h[s * w + x] - h[n * w + x]) / ((s - n) * sz);
    const len = Math.hypot(nx, 1, nz), i = (z * w + x) * 3;
    // Canonical positive zero survives JSON without changing the buffer bits.
    out[i] = nx / len || 0; out[i + 1] = 1 / len; out[i + 2] = nz / len || 0;
  }
  return out;
}

/** Resolve the shoreline halo ONCE on the whole world, never per chunk. */
export function globalWaterSurface(t: TerrainData): Float32Array {
  const { width: w, depth: d, water } = t;
  let y = new Float32Array(w * d).fill(NaN);
  if (!water) return new Float32Array(t.heights);
  for (let i = 0; i < y.length; i++) if (water.mask[i]) y[i] = water.surface[i];
  for (let pass = 0; pass < 2; pass++) {
    const next = y.slice();
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (Number.isFinite(y[i])) continue;
      let sum = 0, count = 0;
      for (const [a, b] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
        if (a < 0 || b < 0 || a >= w || b >= d) continue;
        const v = y[b * w + a];
        if (Number.isFinite(v)) { sum += v; count++; }
      }
      if (count) next[i] = sum / count;
    }
    y = next;
  }
  for (let i = 0; i < y.length; i++) if (!Number.isFinite(y[i])) y[i] = t.heights[i];
  return y;
}

export function sourceHash(t: TerrainData): string {
  let hash = 2166136261;
  for (const array of [t.heights, t.water?.surface, t.water?.mask]) {
    if (!array) continue;
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (const b of bytes) hash = Math.imul(hash ^ b, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function createWorld(t: TerrainData, layout: ChunkLayout = { chunk_width: 256, chunk_depth: 256 }): WorldData {
  if (![layout.chunk_width, layout.chunk_depth].every(v => Number.isFinite(v) && v > 0)) throw new Error("Chunk dimensions must be positive.");
  const [sx, sz] = spacing(t), w = t.width, d = t.depth;
  if (![w, d].every(n => Number.isInteger(n) && n >= 2) || w * d > 1_100_000
    || t.heights.length !== w * d || !t.heights.every(Number.isFinite)
    || ![sx, sz].every(n => Number.isFinite(n) && n > 0) || ![t.origin_x, t.origin_z].every(Number.isFinite))
    throw new Error("Invalid or oversized terrain source grid.");
  if (t.water && [t.water.mask, t.water.surface, t.water.depth, t.water.lake_mask, t.water.river_mask]
    .some(a => a.length !== w * d || !a.every(Number.isFinite))) throw new Error("Invalid source water buffers.");
  const cx = Math.max(1, Math.min(w - 1, Math.round(layout.chunk_width / sx)));
  const cz = Math.max(1, Math.min(d - 1, Math.round(layout.chunk_depth / sz)));
  const columns = Math.ceil((w - 1) / cx), rows = Math.ceil((d - 1) / cz);
  if (columns * rows > 4096) throw new Error("Use larger chunks: this preview supports up to 4096 chunks.");
  const id = (x: number, z: number) => x >= 0 && z >= 0 && x < columns && z < rows ? `c_${x}_${z}` : null;
  const chunks: ChunkDescriptor[] = [];
  for (let z = 0; z < rows; z++) for (let x = 0; x < columns; x++) chunks.push({
    id: id(x, z)!, coord: [x, z], rect: [x * cx, z * cz, Math.min((x + 1) * cx, w - 1), Math.min((z + 1) * cz, d - 1)],
    neighbors: { north: id(x, z - 1), east: id(x + 1, z), south: id(x, z + 1), west: id(x - 1, z) },
  });
  const waterCells = new Uint8Array((w - 1) * (d - 1));
  // Riverbeds and their banks are incised source geometry: coarse LOD must not
  // flatten the channel, so the carved footprint is protected exactly like water.
  const bedCells = t.layers?.river_bed_mask;
  const protectedCells = new Uint8Array((w - 1) * (d - 1));
  const mask = t.water?.mask;
  for (let z = 0; z < d - 1; z++) for (let x = 0; x < w - 1; x++) {
    const i = z * w + x;
    const wet = mask ? (mask[i] || mask[i + 1] || mask[i + w] || mask[i + w + 1] ? 1 : 0) : 0;
    waterCells[z * (w - 1) + x] = wet;
    const incised = bedCells ? (bedCells[i] || bedCells[i + 1] || bedCells[i + w] || bedCells[i + w + 1] ? 1 : 0) : 0;
    protectedCells[z * (w - 1) + x] = wet || incised ? 1 : 0;
  }
  // A summed-area table makes detail preservation O(1) per LOD cell.
  const prefix = new Uint32Array(w * d);
  for (let z = 0; z < d - 1; z++) {
    let sum = 0;
    for (let x = 0; x < w - 1; x++) {
      sum += protectedCells[z * (w - 1) + x];
      prefix[(z + 1) * w + x + 1] = prefix[z * w + x + 1] + sum;
    }
  }
  const waterSurface = globalWaterSurface(t);
  return {
    id: `world-${t.settings.seed}-${w}x${d}-${sourceHash(t)}`, terrain: t, layout: { ...layout }, columns, rows,
    chunk_cells: [cx, cz], chunks, normals: globalNormals(t.heights, w, d, sx, sz),
    water_surface: waterSurface, water_normals: globalNormals(waterSurface, w, d, sx, sz),
    water_cells: waterCells, protected_cells: protectedCells, protected_prefix: prefix, meshes: new Map(),
    imported: false, available: new Set(chunks.map(c => c.id)), materials: null, materialsKey: "",
    visual: defaultVisualSettings(),
  };
}

export function sampleField(a: Float32Array, w: number, d: number, x: number, z: number, channels = 1, channel = 0): number {
  const x0 = Math.floor(x), z0 = Math.floor(z), x1 = Math.min(w - 1, x0 + 1), z1 = Math.min(d - 1, z0 + 1);
  const fx = x - x0, fz = z - z0;
  const at = (u: number, v: number) => a[(v * w + u) * channels + channel];
  const n = at(x0, z0) * (1 - fx) + at(x1, z0) * fx;
  const s = at(x0, z1) * (1 - fx) + at(x1, z1) * fx;
  return n * (1 - fz) + s * fz;
}

function meshWriter(world: WorldData, water: boolean) {
  const t = world.terrain, w = t.width, d = t.depth, [sx, sz] = spacing(t);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], worldUvs: number[] = [], samples: number[] = [], indices: number[] = [];
  const map = new Map<string, number>();
  const field = water ? world.water_surface : t.heights, nf = water ? world.water_normals : world.normals;
  const vert = (x: number, z: number) => {
    const key = `${x}:${z}`, existing = map.get(key);
    if (existing !== undefined) return existing;
    const i = positions.length / 3;
    map.set(key, i);
    const wx = t.origin_x + x * sx, wz = t.origin_z + z * sz;
    positions.push(wx, sampleField(field, w, d, x, z), wz);
    if (Number.isInteger(x) && Number.isInteger(z)) {
      const k = (z * w + x) * 3;
      normals.push(nf[k], nf[k + 1], nf[k + 2]);
    } else {
      const n = [0, 1, 2].map(c => sampleField(nf, w, d, x, z, 3, c)), len = Math.hypot(...n);
      normals.push(n[0] / len || 0, n[1] / len, n[2] / len || 0);
    }
    // Normalised UVs stay for interchange; the world UV is metres and therefore
    // independent of which chunk (or LOD) a vertex happens to belong to.
    uvs.push(x / (w - 1), z / (d - 1)); worldUvs.push(wx, wz); samples.push(x, z);
    return i;
  };
  const quad = (x: number, z: number, right: number, bottom: number) => {
    const a = vert(x, z), b = vert(right, z), c = vert(x, bottom), e = vert(right, bottom);
    indices.push(a, b, c, b, e, c);
  };
  const finish = (): IndexedMesh => ({ positions: Float32Array.from(positions), normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs), world_uv: Float32Array.from(worldUvs), samples: Float32Array.from(samples),
    indices: Uint32Array.from(indices) });
  return { vert, quad, indices, finish };
}

export function chunkMesh(world: WorldData, chunk: ChunkDescriptor, lod: Lod, water = false): IndexedMesh {
  const key = `${chunk.id}:${water ? "water" : lod}`, cached = world.meshes.get(key);
  if (cached) return cached;
  const [x0, z0, x1, z1] = chunk.rect, writer = meshWriter(world, water), w = world.terrain.width;
  if (water) {
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++)
      if (world.water_cells[z * (w - 1) + x]) writer.quad(x, z, x + 1, z + 1);
  } else {
    const stride = 2 ** lod;
    const cells: [number, number, number, number][] = [];
    const horizontal = new Map<number, Set<number>>(), vertical = new Map<number, Set<number>>();
    const point = (x: number, z: number) => {
      if (!horizontal.has(z)) horizontal.set(z, new Set());
      if (!vertical.has(x)) vertical.set(x, new Set());
      horizontal.get(z)!.add(x); vertical.get(x)!.add(z);
    };
    const add = (x: number, z: number, r: number, b: number) => {
      cells.push([x, z, r, b]); point(x, z); point(r, z); point(x, b); point(r, b);
    };
    const wet = (x: number, z: number, r: number, b: number) => {
      const p = world.protected_prefix;
      return p[b * w + r] - p[z * w + r] - p[b * w + x] + p[z * w + x] > 0;
    };
    for (let z = z0; z < z1; z += stride) for (let x = x0; x < x1; x += stride) {
      const r = Math.min(x1, x + stride), b = Math.min(z1, z + stride);
      if (stride > 1 && wet(x, z, r, b)) {
        for (let v = z; v < b; v++) for (let u = x; u < r; u++) add(u, v, u + 1, v + 1);
      } else add(x, z, r, b);
    }
    // The pinned source-detail perimeter is an actual shared surface, not a skirt.
    // Both sides have identical vertices/segments/normals at every LOD.
    for (let x = x0; x <= x1; x++) { point(x, z0); point(x, z1); }
    for (let z = z0; z <= z1; z++) { point(x0, z); point(x1, z); }
    for (const [x, z, r, b] of cells) {
      const ring: [number, number][] = [[x, z]];
      for (let u = x + 1; u < r; u++) if (horizontal.get(z)!.has(u)) ring.push([u, z]);
      ring.push([r, z]);
      for (let v = z + 1; v < b; v++) if (vertical.get(r)!.has(v)) ring.push([r, v]);
      ring.push([r, b]);
      for (let u = r - 1; u > x; u--) if (horizontal.get(b)!.has(u)) ring.push([u, b]);
      ring.push([x, b]);
      for (let v = b - 1; v > z; v--) if (vertical.get(x)!.has(v)) ring.push([x, v]);
      if (ring.length === 4) writer.quad(x, z, r, b);
      else {
        const center = writer.vert((x + r) / 2, (z + b) / 2);
        const perimeter = ring.map(([u, v]) => writer.vert(u, v));
        for (let k = 0; k < perimeter.length; k++) writer.indices.push(center, perimeter[k], perimeter[(k + 1) % perimeter.length]);
      }
    }
  }
  const mesh = writer.finish(); world.meshes.set(key, mesh); return mesh;
}

/** Refine requests until every edge neighbour differs by at most one level. */
export function balanceLods(chunks: ChunkDescriptor[], requested: Record<string, Lod>): Record<string, Lod> {
  const levels = { ...requested };
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of chunks) for (const neighbor of Object.values(c.neighbors)) {
      if (neighbor === null || levels[c.id] === undefined || levels[neighbor] === undefined) continue;
      if (levels[c.id] > levels[neighbor] + 1) { levels[c.id] = (levels[neighbor] + 1) as Lod; changed = true; }
    }
  }
  return levels;
}

export function distanceLods(world: WorldData, x: number, z: number, near?: number, far?: number, previous?: Record<string, Lod>): Record<string, Lod> {
  const [sx, sz] = spacing(world.terrain), t = world.terrain;
  const span = Math.max(world.chunk_cells[0] * sx, world.chunk_cells[1] * sz);
  const requested: Record<string, Lod> = {};
  for (const c of world.chunks) {
    const [a, b, r, s] = c.rect;
    const dx = Math.max(t.origin_x + a * sx - x, 0, x - (t.origin_x + r * sx));
    const dz = Math.max(t.origin_z + b * sz - z, 0, z - (t.origin_z + s * sz));
    const distance = Math.hypot(dx, dz);
    const old = previous?.[c.id], n = near ?? span * 2.2, f = far ?? span * 3.2;
    // A ten-percent dead band prevents repeated GPU uploads at a distance threshold.
    const nearThreshold = n * (old === undefined ? 1 : old === 0 ? 1.1 : 0.9);
    const farThreshold = f * (old === undefined ? 1 : old === 2 ? 0.9 : 1.1);
    requested[c.id] = distance < nearThreshold ? 0 : distance < farThreshold ? 1 : 2;
  }
  return balanceLods(world.chunks, requested);
}

export function releaseChunk(world: WorldData, id: string): void {
  for (const key of world.meshes.keys()) if (key.startsWith(`${id}:`)) world.meshes.delete(key);
}