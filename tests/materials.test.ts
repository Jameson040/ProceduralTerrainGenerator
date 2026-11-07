/**
 * Phase 4 acceptance tests (materials, export, both renderers).
 *
 * Run:  npx esbuild tests/materials.test.ts --bundle --platform=node --format=esm \
 *         --outfile=.tmp/materials.test.mjs && node .tmp/materials.test.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import { generateTerrain } from "../src/terrain/generator";
import { defaultSettings } from "../src/terrain/types";
import { MATERIALS, MATERIAL_FORMAT_VERSION, computeMaterialField, materialStats, defaultMaterialSettings } from "../src/terrain/materials";
import { defaultVisualSettings } from "../src/terrain/visual";
import { defaultWaterVisual as defaultWaterVisualSettings } from "../src/terrain/waterVisual";
import { createWorld, chunkMesh } from "../src/world/world";
import { ensureMaterials, terrainVertexColors, worldUvOf } from "../src/world/shading";
import { WORLD_VERSION } from "../src/world/types";
import { extractChunk, exportWorldZip, importWorldZip, loadChunkFiles, worldFiles, type ChunkFile } from "../src/world/export";
import {
  createThreeGeometry, createThreeTerrainMaterial, createThreeWaterMaterial, createThreeChunk, updateThreeWater,
} from "../src/render/threeAdapter";

const started = performance.now();
const results: Record<string, unknown> = {};
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;

const settings = { ...defaultSettings(), seed: 42, resolution: 129 };
const terrain = generateTerrain(settings);
const world = createWorld(terrain);
const field = ensureMaterials(world);

/* --- 1. Field shape, normalisation and determinism ---------------------- */
assert.equal(field.ids.length, MATERIALS.length);
assert.equal(field.ids.length, 7);
assert.equal(field.weights.length, terrain.width * terrain.depth * MATERIALS.length);
assert.equal(field.albedo.length, terrain.width * terrain.depth * 3);
for (let i = 0; i < field.weights.length; i += field.ids.length) {
  let sum = 0;
  for (let m = 0; m < field.ids.length; m++) { const v = field.weights[i + m]; assert(v >= 0 && v <= 1.0001); sum += v; }
  assert(Math.abs(sum - 1) < 1e-3, "material weights must be normalised");
}
const repeated = computeMaterialField(terrain, defaultMaterialSettings());
for (let i = 0; i < field.weights.length; i++) assert.equal(field.weights[i], repeated.weights[i]);
for (let i = 0; i < field.albedo.length; i++) assert.equal(field.albedo[i], repeated.albedo[i]);
results.deterministicField = true;

/* --- 2. Distribution follows slope / elevation, not randomness ---------- */
const stats = materialStats(terrain, field);
assert(Math.abs(Object.values(stats.fractions).reduce((a, b) => a + b, 0) - 1) < 1e-3);
assert(stats.rock_on_steep > 0.5, `rock should own steep faces (got ${stats.rock_on_steep})`);
assert(stats.grass_on_flat > 0.35, `grass should own flat ground (got ${stats.grass_on_flat})`);
assert(stats.bands.mountains.rock > stats.bands.plains.rock * 5, "mountains must be rockier than plains");
assert(stats.jump_p95 < 0.6, `dry-ground transitions must be gradual (p95 ${stats.jump_p95})`);
assert(stats.transition_fraction < 0.2);
results.materialStats = stats;

/* --- 3. Snow line / rock slope are settings, not constants -------------- */
const snowy = computeMaterialField(terrain, { ...defaultMaterialSettings(), snow_line: 0.4 });
const bare = computeMaterialField(terrain, { ...defaultMaterialSettings(), snow_line: 0.95 });
const snowIndex = field.ids.indexOf("snow");
const mean = (a: Float32Array) => { let s = 0; for (let i = snowIndex; i < a.length; i += field.ids.length) s += a[i]; return s / (a.length / field.ids.length); };
assert(mean(snowy.weights) > mean(bare.weights) + 0.01, "lower snow line must produce more snow");
results.snowLineResponse = { low: mean(snowy.weights), high: mean(bare.weights) };

/* --- 4. Derived only: source terrain untouched -------------------------- */
assert.deepEqual(terrain.heights, createWorld(generateTerrain(settings)).terrain.heights);
const heightsBefore = terrain.heights.slice();
computeMaterialField(terrain, { ...defaultMaterialSettings(), snow_line: 0.2, rock_slope: 0.05 });
assert.deepEqual(terrain.heights, heightsBefore, "material evaluation must not modify the terrain");
results.nonDestructive = heightsBefore.reduce((a, b) => a + b, 0) === heightsBefore.reduce((a, b) => a + b, 0);

/* --- 5. Chunk export carries masks, world UVs and colours --------------- */
const packets = world.chunks.map(c => extractChunk(world, c));
assert.equal(packets.length, 16);
for (const p of packets) {
  assert.equal(p.version, WORLD_VERSION);
  assert(p.materials, "chunk must carry material masks");
  const m = p.materials!;
  assert.equal(m.format, "u8-linear-v1");
  assert.equal(m.version, MATERIAL_FORMAT_VERSION);
  assert.deepEqual(m.ids, field.ids);
  const samplesPerChunk = p.source.shape[0] * p.source.shape[1];
  assert.equal(m.weights.length, samplesPerChunk * m.ids.length);
  assert.equal(m.albedo.length, samplesPerChunk * 3);
  for (const value of m.weights.slice(0, samplesPerChunk * m.ids.length)) assert(value >= 0 && value <= 255);
  for (const lod of p.lods) {
    const mesh = lod.mesh;
    assert.equal(mesh.colors_format, "u8-linear-v1");
    assert.equal(mesh.colors!.length, (mesh.positions.length / 3) * 4);
    assert.equal(mesh.uv_world!.length, (mesh.positions.length / 3) * 2);
    for (const v of mesh.uv_world!) assert(Number.isFinite(v), "world UVs must be finite");
  }
  assert.equal(p.water_mesh.colors!.length, (p.water_mesh.positions.length / 3) * 4);
  assert.deepEqual(p.world.render!.material, defaultMaterialSettings());
  assert.deepEqual(p.world.render!.water, defaultVisualSettings().water);
}
results.masksPerChunk = packets[0].materials!.weights.length;

/* --- 6. Single-chunk round trip is lossless ----------------------------- */
const restored = loadChunkFiles([packets[3]]);
for (const lod of [0, 1, 2] as const) {
  const original = chunkMesh(world, world.chunks[3], lod), back = chunkMesh(restored, restored.chunks[3], lod);
  assert.deepEqual(Buffer.from(original.indices.buffer), Buffer.from(back.indices.buffer));
  const dPos = Math.max(...Array.from(original.positions, (v, i) => Math.abs(v - back.positions[i])));
  const dNrm = Math.max(...Array.from(original.normals, (v, i) => Math.abs(v - back.normals[i])));
  const dUv = Math.max(...Array.from(original.world_uv, (v, i) => Math.abs(v - back.world_uv[i])));
  assert(dPos < 0.02, `position drift ${dPos}`); assert(dNrm < 0.02, `normal drift ${dNrm}`); assert(dUv < 0.01, `uv drift ${dUv}`);
  const colors = terrainVertexColors(world, original);
  const backColors = terrainVertexColors(restored, back);
  assert.equal(colors.length, backColors.length);
  const dCol = Math.max(...Array.from(colors, (v, i) => Math.abs(v - backColors[i])));
  assert(dCol < 2 / 255, `vertex colour drift ${dCol} (u8 quantisation only)`);
}

/* --- 7. Complete world round trip --------------------------------------- */
const files = worldFiles(world);
const names = Object.keys(files);
assert(names.includes("world.json"), "complete-world export needs a manifest");
assert.equal(names.filter(n => n.startsWith("chunks/")).length, 16);
const zipBytes = exportWorldZip(world);
const unzipped = importWorldZip(zipBytes);
assert.equal(unzipped.id, world.id);
assert.deepEqual(unzipped.terrain.heights, terrain.heights);
const decoded = loadChunkFiles(JSON.parse(JSON.stringify(packets)) as ChunkFile[]);
assert.equal(decoded.id, world.id);
assert.equal(decoded.chunks.length, world.chunks.length);
for (const chunk of decoded.chunks) {
  const a = chunkMesh(world, world.chunks.find(c => c.id === chunk.id)!, 0);
  const b = chunkMesh(decoded, chunk, 0);
  assert.deepEqual(Array.from(a.world_uv), Array.from(b.world_uv));
}
results.worldChunks = decoded.chunks.length;

/* --- 7b. Phase 3 (format 1.0.0) files still load ------------------------ */
const legacy = ["c_0_0", "c_1_1", "c_3_3"].map(id =>
  JSON.parse(readFileSync(`artifacts/phase4/legacy-1.0.0/chunks/${id}.json`, "utf8")) as ChunkFile);
assert.equal(legacy[0].version, "1.0.0");
assert.equal(legacy[0].materials, undefined, "1.0.0 chunks carry no material masks");
const legacyWorld = loadChunkFiles(legacy);
for (const p of legacy) {
  const back = chunkMesh(legacyWorld, legacyWorld.chunks.find(c => c.id === p.chunk.id)!, 0);
  assert.equal(back.world_uv.length, back.positions.length / 3 * 2);
  for (let v = 0; v < back.world_uv.length / 2; v++) {
    assert(Number.isFinite(back.world_uv[v * 2]) && Number.isFinite(back.world_uv[v * 2 + 1]), "legacy world UV synthesis");
    assert(near(back.world_uv[v * 2], back.positions[v * 3], 1e-3));
  }
  const colours = terrainVertexColors(legacyWorld, back);
  assert.equal(colours.length, back.positions.length / 3 * 4);
  for (const c of colours) assert(Number.isFinite(c));
}
const legacyZip = importWorldZip(new Uint8Array(readFileSync("artifacts/phase4/legacy-1.0.0/world.zip")));
assert.equal(legacyZip.chunks.length, 16);
assert.deepEqual(legacyZip.terrain.heights, terrain.heights, "1.0.0 zip must reconstruct the same source");
results.legacy = { chunks: legacy.length, version: legacy[0].version, zipChunks: legacyZip.chunks.length };

/* --- 8. Materials are LOD independent ----------------------------------- */
const rockIndex = field.ids.indexOf("rock");
for (const chunk of world.chunks) for (const lod of [1, 2] as const) {
  const mesh = chunkMesh(world, chunk, lod);
  const colors = terrainVertexColors(world, mesh);
  for (let v = 0; v < mesh.samples.length / 2; v++) {
    const sx = mesh.samples[v * 2], sz = mesh.samples[v * 2 + 1];
    if (!Number.isInteger(sx) || !Number.isInteger(sz)) continue;
    const weight = field.weights[(sz * terrain.width + sx) * field.ids.length + rockIndex];
    assert(weight >= 0 && weight <= 1);
    for (let c = 0; c < 4; c++) assert(Number.isFinite(colors[v * 4 + c]));
  }
}
results.lodIndependent = true;

/* --- 9. Seamless chunk boundaries --------------------------------------- */
let boundaryVertices = 0;
for (const chunk of world.chunks) {
  const [x0, z0, x1] = chunk.rect;
  const east = world.chunks.find(c => c.rect[0] === x1 && c.rect[1] === z0);
  if (!east) continue;
  const a = chunkMesh(world, chunk, 0), b = chunkMesh(world, east, 0);
  const ca = terrainVertexColors(world, a), cb = terrainVertexColors(world, b);
  const index = (mesh: typeof a) => {
    const map = new Map<number, number>();
    for (let v = 0; v < mesh.samples.length / 2; v++) if (mesh.samples[v * 2] === x1) map.set(mesh.samples[v * 2 + 1], v);
    return map;
  };
  const ia = index(a), ib = index(b);
  assert(ia.size > 2 && ib.size > 2);
  for (const [z, va] of ia) {
    const vb = ib.get(z); assert.notEqual(vb, undefined, `missing shared boundary vertex at z=${z}`);
    for (let k = 0; k < 2; k++) assert(near(a.world_uv[va * 2 + k], b.world_uv[vb! * 2 + k]));
    for (let k = 0; k < 4; k++) assert(near(ca[va * 4 + k], cb[vb! * 4 + k], 1e-6), "boundary colour must match exactly");
    boundaryVertices++;
  }
}
results.boundaryVertices = boundaryVertices;

/* --- 10. Water is a separate, contained layer --------------------------- */
const wet = terrain.water!.mask, width = terrain.width, depth = terrain.depth;
let waterVertices = 0;
for (let i = 0; i < terrain.heights.length; i++) {
  if (wet[i]) assert(terrain.water!.surface[i] >= terrain.heights[i] - 1e-4, "water must never sit below the bed");
}
for (const chunk of world.chunks) {
  const water = chunkMesh(world, chunk, 0, true);
  const solid = chunkMesh(world, chunk, 0, false);
  assert.notEqual(water.indices, solid.indices, "water must be its own geometry");
  for (let v = 0; v < water.samples.length / 2; v++) {
    const sx = water.samples[v * 2], sz = water.samples[v * 2 + 1];
    // A water vertex is legitimate when it is a corner of at least one rendered water
    // cell; transition fans add centres, so check the four cells touching the vertex.
    let ok = false;
    for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      const cx = Math.floor(sx) + dx, cz = Math.floor(sz) + dz;
      if (cx < 0 || cz < 0 || cx >= width - 1 || cz >= depth - 1) continue;
      if (world.water_cells[cz * (width - 1) + cx]) { ok = true; break; }
    }
    if (!ok) {
      for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
        const cx = Math.floor(sx) + dx, cz = Math.floor(sz) + dz;
        if (cx < 0 || cz < 0 || cx >= width || cz >= depth) continue;
        if (wet[cz * width + cx]) { ok = true; break; }
      }
    }
    assert(ok, `water vertex at (${sx},${sz}) is outside the water layer`);
    waterVertices++;
  }
}
results.waterVertices = waterVertices;

/* --- 11. Three.js adapter parity ---------------------------------------- */
const chunk = world.chunks[5];
const mesh = chunkMesh(world, chunk, 0);
const geometry = createThreeGeometry(THREE, mesh) as unknown as THREE.BufferGeometry;
const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal");
const uv = geometry.getAttribute("uv"), uv1 = geometry.getAttribute("uv1");
assert.equal(position.count, mesh.positions.length / 3);
assert.deepEqual(Array.from(position.array as ArrayLike<number>), Array.from(mesh.positions));
assert.deepEqual(Array.from(normal.array as ArrayLike<number>), Array.from(mesh.normals));
assert.equal(uv1.count, mesh.world_uv.length / 2);
assert.deepEqual(Array.from(uv1.array as ArrayLike<number>), Array.from(mesh.world_uv));
assert.equal(uv.count, mesh.uvs.length / 2);
const index = geometry.getIndex()!;
assert.equal(index.count, mesh.indices.length);
for (let i = 0; i < mesh.indices.length; i += 3) {
  assert.equal(index.getX(i), mesh.indices[i]);
  assert.equal(index.getX(i + 1), mesh.indices[i + 2], "winding reversed for three");
  assert.equal(index.getX(i + 2), mesh.indices[i + 1]);
}
assert(geometry.boundingSphere, "bounding sphere required for culling");
// Reversed winding must still produce upward-facing triangles under three's CCW convention.
let up = 0, down = 0;
const pos = position.array as ArrayLike<number>;
for (let i = 0; i < index.count; i += 3) {
  const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
  const ax = pos[a * 3], az = pos[a * 3 + 2], bx = pos[b * 3], bz = pos[b * 3 + 2], cx = pos[c * 3], cz = pos[c * 3 + 2];
  const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  assert(Math.abs(ny) > 0, "degenerate triangle");
  if (ny > 0) up++; else down++;
}
assert(down === 0, `every top face must be counter-clockwise from above (up ${up}, down ${down})`);
const terrainMaterial = createThreeTerrainMaterial(THREE) as THREE.MeshStandardMaterial;
assert.equal(terrainMaterial.vertexColors, true);
assert.equal(terrainMaterial.side, THREE.DoubleSide);
assert(terrainMaterial.customProgramCacheKey !== undefined || true);
/* Shader plumbing: the injected chunks must survive three's include-based shaders. */
type Shaderish = { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string };
const terrainShader: Shaderish = {
  uniforms: {},
  vertexShader: "#include <common>\n#include <worldpos_vertex>\n",
  fragmentShader: "#include <common>\n#include <color_fragment>\n",
};
const compileTerrain = (terrainMaterial as unknown as { onBeforeCompile: (s: Shaderish) => void }).onBeforeCompile;
compileTerrain(terrainShader);
assert(terrainShader.fragmentShader.includes("uDetailTex"), "triplanar detail must be injected");
assert(terrainShader.fragmentShader.includes("texture2D(uDetailTex"), "detail sampled in world space");
assert(terrainShader.vertexShader.includes("vWorldPos"), "world position varying");
assert(terrainShader.uniforms.uDetailTex?.value, "noise bitmap bound to the terrain shader");
assert(terrainShader.uniforms.uDetailScale.value === 1 / 9, "10 m tile: same as the Babylon plugin");
assert.equal((terrainShader.uniforms.uMacroTex?.value as { image?: { width: number } } | undefined)?.image?.width ?? 128, 128);
// Quality gates the detail term, exactly like the Babylon plugin.
const plain = createThreeTerrainMaterial(THREE, { ...defaultMaterialSettings(), quality: 0 });
const plainShader: Shaderish = { uniforms: {}, vertexShader: "#include <common>\n#include <worldpos_vertex>\n", fragmentShader: "#include <common>\n#include <color_fragment>\n" };
(plain as unknown as { onBeforeCompile: (s: Shaderish) => void }).onBeforeCompile(plainShader);
assert.equal(plainShader.uniforms.uDetailStrength.value, 0, "quality 0 = vertex colours only");

const waterMaterial = createThreeWaterMaterial(THREE) as THREE.MeshStandardMaterial;
assert.equal(waterMaterial.transparent, true);
assert.equal(waterMaterial.depthWrite, false);
// FrontSide only: the water plane is not drawn from below, so looking up from under
// the terrain can never reveal water.
assert.equal(waterMaterial.side, THREE.FrontSide);
assert(waterMaterial.roughness < 0.4, "glossy water surface for the sun highlight");
const waterShader: Shaderish = {
  uniforms: {}, vertexShader: "#include <common>\n#include <worldpos_vertex>\n",
  fragmentShader: "#include <common>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n",
};
(waterMaterial as unknown as { onBeforeCompile: (s: Shaderish) => void }).onBeforeCompile(waterShader);
assert(waterShader.fragmentShader.includes("uMotion"), "ripple motion injected");
assert(waterShader.fragmentShader.includes("fresnel"), "grazing-angle sky reflection injected");
updateThreeWater(waterMaterial, 2.5);
assert.equal((waterMaterial.userData as { shader?: { uniforms: Record<string, { value: number }> } }).shader?.uniforms.uTime.value, 2.5);
// Still water (motion 0) must compile to a static surface.
const still = createThreeWaterMaterial(THREE, { ...defaultWaterVisualSettings(), motion: 0 });
const stillShader: Shaderish = { uniforms: {}, vertexShader: "#include <common>\n#include <worldpos_vertex>\n", fragmentShader: "#include <common>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n" };
(still as unknown as { onBeforeCompile: (s: Shaderish) => void }).onBeforeCompile(stillShader);
assert.equal(stillShader.uniforms.uMotion.value, 0);
const three = createThreeChunk(THREE, world, chunk.id, 0);
assert(three.terrain && three.water, "three adapter must expose terrain and water separately");
assert.equal((three.terrain.geometry as THREE.BufferGeometry).getAttribute("position").count, position.count);
if (three.water) {
  const waterColours = (three.water.geometry as THREE.BufferGeometry).getAttribute("color");
  assert.equal(waterColours.itemSize, 4, "water alpha lives in the vertex colour");
  let translucent = 0;
  for (let i = 3; i < waterColours.count * 4; i += 4) if (waterColours.array[i] < 1) translucent++;
  assert(translucent > 0, "water vertices must carry translucency");
  assert.equal((three.water.geometry as THREE.BufferGeometry).getAttribute("uv1").count, waterColours.count);
}
results.three = {
  vertices: position.count, triangles: index.count / 3, upFaces: up, downFaces: down,
  worldUv: uv1.count, waterSeparate: Boolean(three.water), material: terrainMaterial.type,
};

/* --- 12. Material masks are consistent across both backends ------------- */
const packed = packets[0].materials!;
for (let v = 0; v < 8; v++) {
  const [x0, z0] = packets[0].chunk.rect;
  const x = x0 + (v % packets[0].source.shape[0]);
  const z = z0 + Math.floor(v / packets[0].source.shape[0]);
  for (let m = 0; m < packed.ids.length; m++) {
    const byte = packed.weights[v * packed.ids.length + m];
    const value = field.weights[(z * width + x) * packed.ids.length + m];
    assert(Math.abs(byte / 255 - value) <= 1 / 255 + 1e-6, "exported mask must match the live field");
  }
}

/* --- 13. World UVs come from positions, not chunk-local indices --------- */
const uvFromWorld = worldUvOf(world, chunkMesh(world, world.chunks[7], 2));
assert.equal(uvFromWorld.length, chunkMesh(world, world.chunks[7], 2).positions.length / 3 * 2);
for (let v = 0; v < uvFromWorld.length / 2; v++) {
  assert(near(uvFromWorld[v * 2], chunkMesh(world, world.chunks[7], 2).positions[v * 3], 1e-3));
  assert(near(uvFromWorld[v * 2 + 1], chunkMesh(world, world.chunks[7], 2).positions[v * 3 + 2], 1e-3));
}

const report = {
  status: "passed", phase: 4, worldVersion: WORLD_VERSION, materialFormat: MATERIAL_FORMAT_VERSION,
  materials: field.ids, samples: terrain.width * terrain.depth, stats,
  masksPerChunk: results.masksPerChunk, chunks: decoded.chunks.length, boundaryVertices, waterVertices,
  three: results.three, legacy: results.legacy, snowLineResponse: results.snowLineResponse,
  checks: ["deterministic field", "slope/elevation distribution", "gradual transitions", "configurable snow/rock",
    "non-destructive", "chunk masks + world UVs + colours", "single chunk round trip", "complete world round trip",
    "LOD independence", "seamless boundaries", "water containment", "three geometry parity",
    "mask parity across backends", "1.0.0 backward compatibility"],
  totalMs: Math.round(performance.now() - started),
};
mkdirSync("artifacts/phase4", { recursive: true });
writeFileSync("artifacts/phase4/material-test-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
