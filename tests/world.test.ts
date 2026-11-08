import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { generateTerrain } from "../src/terrain/generator";
import { defaultSettings } from "../src/terrain/types";
import { balanceLods, chunkMesh, createWorld, distanceLods, releaseChunk } from "../src/world/world";
import { exportWorldZip, extractChunk, importWorldZip, loadChunkFiles, worldFiles, type ChunkFile } from "../src/world/export";
import { validateSeams } from "../src/world/validate";
import { auditRiverbeds, riverSections } from "../src/terrain/riverAudit";
import { ChunkScene } from "../src/viewer/chunkAdapter";
import type { ChunkDescriptor, IndexedMesh, Lod } from "../src/world/types";

/** Every non-perimeter edge must have exactly two incident faces, not a T-junction. */
function topology(m: IndexedMesh, chunk: ChunkDescriptor, water = false) {
  const edges = new Map<string, { a: number; b: number; count: number }>();
  let area = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i], b = m.indices[i + 1], c = m.indices[i + 2];
    assert.notEqual(a, b); assert.notEqual(a, c); assert.notEqual(b, c);
    const xy = (n: number, axis: number) => m.samples[n * 2 + axis];
    const signed = ((xy(b, 0) - xy(a, 0)) * (xy(c, 1) - xy(a, 1)) - (xy(c, 0) - xy(a, 0)) * (xy(b, 1) - xy(a, 1))) / 2;
    assert(signed > 0, "zero-area or flipped triangle");
    area += signed;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      const edge = edges.get(key);
      if (edge) edge.count++; else edges.set(key, { a: u, b: v, count: 1 });
    }
  }
  const [x0, z0, x1, z1] = chunk.rect;
  if (!water) assert.equal(area, (x1 - x0) * (z1 - z0), "missing or overlapping source area");
  for (const e of edges.values()) {
    assert(e.count <= 2, "non-manifold overlapping faces");
    if (e.count === 1 && !water) {
      const ax = m.samples[e.a * 2], az = m.samples[e.a * 2 + 1], bx = m.samples[e.b * 2], bz = m.samples[e.b * 2 + 1];
      assert((ax === bx && (ax === x0 || ax === x1)) || (az === bz && (az === z0 || az === z1)), "interior open edge / T-junction");
      assert.equal(Math.abs(ax - bx) + Math.abs(az - bz), 1, "boundary skipped a shared source sample");
    }
  }
  for (let i = 0; i < m.normals.length; i += 3) {
    assert(Math.abs(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]) - 1) < 1e-6);
    assert(m.normals[i + 1] > 0);
  }
}

const start = performance.now();
const settings = { ...defaultSettings(), seed: 42, resolution: 129 };
const terrain = generateTerrain(settings), world = createWorld(terrain);
assert.equal(world.columns, 4); assert.equal(world.rows, 4);
const repeated = generateTerrain(settings);
assert.deepEqual(terrain.heights, repeated.heights);
assert.deepEqual(terrain.water, repeated.water);
const sourceCopy = terrain.heights.slice();

// --- Riverbed terrain contract: water sits in an incised, banked channel ---
const audit = auditRiverbeds(terrain);
assert(audit.hasRivers, "expected a river network");
assert(audit.riverCells > 0 && audit.carvedBedCells > audit.riverCells, "riverbed not carved");
assert.equal(audit.waterSpillEdges, 0, "river water stands above dry ground");
assert(audit.bedBelowWaterSurface, "riverbed is not below its water surface");
assert(audit.positiveWaterDepth, "negative river water depth");
assert(audit.waterHasTerrainBeneath && audit.terrainFiniteEverywhere, "missing terrain under water");
assert(audit.sectionsBedBelowSurface && audit.sectionsTerrainAboveBed, "cross-section has no bed/banks");
assert(audit.sectionsAllEnclosed, "river cross-section is not enclosed by banks");
assert(audit.bedSlopeMedian <= 0.25, `riverbed too steep: ${audit.bedSlopeMedian}`);
assert(audit.gentlySlopedBedFraction >= 0.95, "riverbed is not walkable");
const sections = riverSections(terrain, 3);
assert(sections.length >= 3, "expected several river cross-sections");
for (const section of sections) {
  assert(section.wetCells >= 1 && section.allTerrainFinite);
  assert(section.bed < (section.waterSurface ?? Infinity), "water not above the bed in section");
  assert(Math.max(...section.heights) > (section.waterSurface ?? 0), "no terrain above the waterline");
  for (let i = 0; i < section.heights.length; i++) {
    if (section.wet[i]) assert(section.heights[i] <= (section.surface[i] ?? -Infinity) + 1e-4, "dry land above water");
  }
}
const levels = distanceLods(world, 64, 64, 180, 440);
assert.equal(new Set(Object.values(levels)).size, 3);
assert(Object.values(levels).includes(0) && Object.values(levels).includes(2));
const relaxed = balanceLods(world.chunks, Object.fromEntries(world.chunks.map(c => [c.id, c.id === "c_0_0" ? 0 : 2])) as Record<string, Lod>);
for (const c of world.chunks) for (const n of Object.values(c.neighbors)) if (n) assert(Math.abs(relaxed[c.id] - relaxed[n]) <= 1);
const counts = [0, 0, 0];
for (const c of world.chunks) for (const l of [0, 1, 2] as Lod[]) {
  const m = chunkMesh(world, c, l); topology(m, c);
  assert.strictEqual(chunkMesh(world, c, l), m, "unchanged mesh not cached");
  counts[l] += m.indices.length / 3;
  const present = new Map<number, number>();
  for (let i = 0; i < m.samples.length / 2; i++) {
    const x = m.samples[i * 2], z = m.samples[i * 2 + 1];
    if (Number.isInteger(x) && Number.isInteger(z)) present.set(z * terrain.width + x, m.positions[i * 3 + 1]);
  }
  const bed = terrain.layers!.river_bed_mask!;
  for (let z = c.rect[1]; z <= c.rect[3]; z++) for (let x = c.rect[0]; x <= c.rect[2]; x++) {
    const i = z * terrain.width + x;
    if (terrain.water!.mask[i]) assert.equal(present.get(i), terrain.heights[i], "LOD lost underwater ground");
    if (bed[i] > 0.5) assert.equal(present.get(i), terrain.heights[i], "LOD flattened the carved riverbed");
  }
}
assert.equal(counts[0], (terrain.width - 1) * (terrain.depth - 1) * 2);
assert(counts[2] < counts[0] * 0.8, "low LOD did not reduce dry geometry");
assert.deepEqual(terrain.heights, sourceCopy, "LOD modified source terrain");
const seams = validateSeams(world, levels);
assert(seams.pass, seams.errors.join("\n")); assert.equal(seams.boundaries, 24);
assert(seams.riverCrossings >= 2); assert(seams.lakeCrossings >= 2); assert(seams.waterVertices > 0);
let waterTriangleCount = 0;
for (const c of world.chunks) {
  const m = chunkMesh(world, c, 0, true);
  topology(m, c, true); waterTriangleCount += m.indices.length / 3;
}
assert.equal(waterTriangleCount, 2 * world.water_cells.reduce((a, b) => a + b, 0), "water faces lost or duplicated by chunking");
// Every neighbouring pair at every allowed LOD combination.
for (const a of [0, 1, 2] as Lod[]) for (const b of [0, 1, 2] as Lod[]) {
  if (Math.abs(a - b) > 1) continue;
  const plan = Object.fromEntries(world.chunks.map(c => [c.id, (c.coord[0] + c.coord[1]) % 2 ? a : b]));
  assert(validateSeams(world, plan).pass);
}

const files = worldFiles(world);
mkdirSync("artifacts/phase3/chunks", { recursive: true });
for (const [name, bytes] of Object.entries(files)) writeFileSync(`artifacts/phase3/${name}`, bytes);
assert.equal(Object.keys(files).filter(n => n.startsWith("chunks/")).length, 16);
// Read all 16 independent files back from disk, not from live generation memory.
const packets = world.chunks.map(c => JSON.parse(readFileSync(`artifacts/phase3/chunks/${c.id}.json`, "utf8")) as ChunkFile);
const loaded = loadChunkFiles(packets);
assert.deepEqual(loaded.terrain.heights, terrain.heights);
assert.deepEqual(loaded.normals, world.normals);
assert.deepEqual(loaded.water_surface, world.water_surface);
assert.deepEqual(loaded.terrain.water, world.terrain.water);
assert.deepEqual(loaded.terrain.layers!.river_bed_mask, terrain.layers!.river_bed_mask, "riverbed lost on export");
for (const c of world.chunks) {
  const packet = packets.find(p => p.chunk.id === c.id)!;
  assert.deepEqual(Object.keys(packet.source.layers).includes("river_bed_mask"), true, "chunk file dropped the riverbed layer");
}
for (const c of world.chunks) for (const l of [0, 1, 2] as Lod[]) {
  const original = chunkMesh(world, c, l), restored = chunkMesh(loaded, c, l);
  assert.deepEqual(restored, original, "reconstructed geometry differs");
}
const single = loadChunkFiles([packets[5]]);
assert.equal(single.available.size, 1);
assert.deepEqual(chunkMesh(single, single.chunks[5], 2), chunkMesh(world, world.chunks[5], 2));
const bad = JSON.parse(JSON.stringify(packets[1])) as ChunkFile;
bad.source.heights[0] += 1;
assert.throws(() => loadChunkFiles([packets[0], bad]), /boundary mismatch/);
const zip = exportWorldZip(world); writeFileSync("artifacts/phase3/world.zip", zip);
assert.deepEqual(importWorldZip(zip).terrain.heights, terrain.heights);

// Fresh Babylon engine + scene. Upload exports only, then exercise GPU lifecycle.
const engine = new NullEngine(), scene = new Scene(engine);
const manager = new ChunkScene(scene, loaded);
const view = { selected: "c_0_0", scope: "world" as const, lod: "adaptive" as const, grid: true, debug: "off" as const, hidden: [] as string[] };
const options = { colorMode: "natural" as const, wireframe: false, showWater: true, shadows: false };
let stats = manager.update(view, levels, options);
assert.equal(stats.loaded, 16);
for (const [id, e] of manager.entries) {
  const c = loaded.chunks.find(c => c.id === id)!;
  assert.deepEqual(e.terrain.getVerticesData(VertexBuffer.PositionKind), chunkMesh(world, c, levels[id]).positions);
  assert.deepEqual(e.terrain.getVerticesData(VertexBuffer.NormalKind), chunkMesh(world, c, levels[id]).normals);
}
assert(validateSeams(loaded, levels).pass);
stats = manager.update({ ...view, hidden: ["c_1_1"] }, levels, options); assert.equal(stats.loaded, 15);
stats = manager.update(view, levels, options); assert.equal(stats.loaded, 16);
assert(validateSeams(loaded, levels).pass);
manager.dispose(); scene.dispose(); engine.dispose();
releaseChunk(single, "c_1_1");
assert.deepEqual(chunkMesh(single, single.chunks[5], 0), chunkMesh(world, world.chunks[5], 0), "standalone source cannot rebuild after unload");

// Non-square, non-divisible extents, negative origins and partial last chunks.
const irregular = createWorld(generateTerrain({ ...settings, resolution: 65, world_width: 1234.5, world_depth: 813.75, origin_x: -4096, origin_z: 2048 }), { chunk_width: 260, chunk_depth: 190 });
const [sx, sz] = [irregular.terrain.spacing_x!, irregular.terrain.spacing_z!];
assert.equal((irregular.terrain.width - 1) * sx, 1234.5);
assert.equal((irregular.terrain.depth - 1) * sz, 813.75);
for (const c of irregular.chunks) for (const l of [0, 1, 2] as Lod[]) topology(chunkMesh(irregular, c, l), c);
assert(validateSeams(irregular, distanceLods(irregular, -4000, 2100)).pass);
const report = { status: "passed", chunks: 16, source: [terrain.width, terrain.depth], normalError: seams.maxNormalError,
  positionError: seams.maxPositionError, boundaryEdges: seams.boundaries, riverCrossings: seams.riverCrossings,
  lakeCrossings: seams.lakeCrossings, trianglesByLod: counts, mixedTriangles: stats.triangles, zipBytes: zip.length,
  totalMs: Math.round(performance.now() - start), freshBabylonScene: true, skirts: false };
writeFileSync("artifacts/phase3/test-report.json", JSON.stringify(report, null, 2));
console.log(report);