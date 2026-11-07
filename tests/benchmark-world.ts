import { writeFileSync } from "node:fs";
import { generateTerrain } from "../src/terrain/generator";
import { defaultSettings } from "../src/terrain/types";
import { createWorld, chunkMesh } from "../src/world/world";
import type { Lod } from "../src/world/types";
import { exportWorldZip } from "../src/world/export";

const results = [];
for (const resolution of [129, 257]) {
  const start = performance.now();
  const t = generateTerrain({ ...defaultSettings(), seed: 42, resolution });
  const generated = performance.now();
  const w = createWorld(t);
  const prepared = performance.now(), meshTimes: number[] = [], counts: number[] = [];
  for (const lod of [0, 1, 2] as Lod[]) {
    const now = performance.now();
    let triangles = 0;
    for (const c of w.chunks) triangles += chunkMesh(w, c, lod).indices.length / 3;
    meshTimes.push(Math.round(performance.now() - now)); counts.push(triangles);
  }
  const exportStart = performance.now();
  const zip = exportWorldZip(w);
  let cacheBytes = 0;
  for (const m of w.meshes.values()) cacheBytes += m.positions.byteLength + m.normals.byteLength + m.uvs.byteLength + m.samples.byteLength + m.indices.byteLength;
  results.push({ resolution, generationMs: Math.round(generated - start), prepareMs: Math.round(prepared - generated),
    meshMs: meshTimes, terrainTriangles: counts, cachedMeshMiB: +(cacheBytes / 1048576).toFixed(2),
    exportMs: Math.round(performance.now() - exportStart), zipMiB: +(zip.length / 1048576).toFixed(2) });
}
writeFileSync("artifacts/phase3/benchmarks.json", JSON.stringify(results, null, 2));
console.log(results);