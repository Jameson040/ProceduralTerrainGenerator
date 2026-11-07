import { chunkMesh } from "./world";
import type { IndexedMesh, Lod, WorldData } from "./types";

export interface SeamReport {
  pass: boolean; boundaries: number; comparedVertices: number; maxPositionError: number; maxNormalError: number;
  waterVertices: number; riverCrossings: number; lakeCrossings: number; errors: string[];
}

function edgeVertices(m: IndexedMesh, axis: number, value: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < m.samples.length / 2; i++) if (m.samples[2 * i + axis] === value) out.set(m.samples[2 * i + 1 - axis], i);
  return out;
}

export function validateSeams(world: WorldData, levels: Record<string, Lod>): SeamReport {
  const report: SeamReport = { pass: true, boundaries: 0, comparedVertices: 0, maxPositionError: 0, maxNormalError: 0,
    waterVertices: 0, riverCrossings: 0, lakeCrossings: 0, errors: [] };
  for (const c of world.chunks) for (const side of ["east", "south"] as const) {
    const id = c.neighbors[side], b = world.chunks.find(ch => ch.id === id);
    if (!b || !world.available.has(c.id) || !world.available.has(b.id)) continue;
    report.boundaries++;
    if (Math.abs((levels[c.id] ?? 0) - (levels[b.id] ?? 0)) > 1) report.errors.push(`${c.id}/${b.id}: LOD ratio exceeds 2:1`);
    const axis = side === "east" ? 0 : 1, boundary = c.rect[axis + 2];
    for (const water of [false, true]) {
      const aMesh = chunkMesh(world, c, levels[c.id] ?? 0, water), bMesh = chunkMesh(world, b, levels[b.id] ?? 0, water);
      const ae = edgeVertices(aMesh, axis, boundary), be = edgeVertices(bMesh, axis, boundary);
      if (!water && ae.size !== be.size) report.errors.push(`${c.id}/${b.id}: incompatible boundary vertex count`);
      for (const [coordinate, ai] of ae) {
        const bi = be.get(coordinate);
        if (bi === undefined) { if (!water) report.errors.push(`${c.id}/${b.id}: missing boundary vertex`); continue; }
        for (let component = 0; component < 3; component++) {
          report.maxPositionError = Math.max(report.maxPositionError, Math.abs(aMesh.positions[ai * 3 + component] - bMesh.positions[bi * 3 + component]));
          report.maxNormalError = Math.max(report.maxNormalError, Math.abs(aMesh.normals[ai * 3 + component] - bMesh.normals[bi * 3 + component]));
        }
        if (water) report.waterVertices++; else report.comparedVertices++;
      }
    }
    let river = false, lake = false;
    const mask = world.terrain.water, w = world.terrain.width;
    if (mask) for (let v = c.rect[1 - axis]; v <= c.rect[3 - axis]; v++) {
      const i = axis === 0 ? v * w + boundary : boundary * w + v;
      river ||= !!mask.river_mask[i]; lake ||= !!mask.lake_mask[i];
    }
    if (river) report.riverCrossings++; if (lake) report.lakeCrossings++;
  }
  if (report.maxPositionError !== 0) report.errors.push("Boundary position mismatch");
  if (report.maxNormalError !== 0) report.errors.push("Boundary normal mismatch");
  report.pass = report.errors.length === 0;
  return report;
}