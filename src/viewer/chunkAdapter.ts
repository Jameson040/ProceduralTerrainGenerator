/** Thin Babylon adapter: it consumes numerical meshes, never generates terrain. */
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { chunkMesh, sampleField, releaseChunk, spacing } from "../world/world";
import type { ChunkDescriptor, ChunkViewOptions, IndexedMesh, Lod, WorldData, WorldViewStats } from "../world/types";
import { terrainColors, type ColorMode } from "./buildMeshes";

export const LOD_COLORS = [[0.29, 0.78, 0.60], [0.90, 0.67, 0.31], [0.54, 0.51, 0.90]];

export function uploadMesh(scene: Scene, name: string, data: IndexedMesh): Mesh {
  const mesh = new Mesh(name, scene), vd = new VertexData();
  vd.positions = data.positions; vd.normals = data.normals; vd.uvs = data.uvs; vd.indices = data.indices;
  vd.applyToMesh(mesh, false);
  return mesh;
}

interface Entry { terrain: Mesh; water: Mesh | null; outline: LinesMesh; lod: Lod; colorKey: string }

export class ChunkScene {
  readonly entries = new Map<string, Entry>();
  readonly terrainMaterial: StandardMaterial;
  readonly waterMaterial: StandardMaterial;
  private colorFields = new Map<ColorMode, Float32Array>();

  constructor(readonly scene: Scene, readonly world: WorldData, private shadow?: ShadowGenerator) {
    this.terrainMaterial = new StandardMaterial("chunkTerrain", scene);
    this.terrainMaterial.specularColor = new Color3(0.03, 0.03, 0.03);
    this.waterMaterial = new StandardMaterial("chunkWater", scene);
    this.waterMaterial.diffuseColor = new Color3(0.1, 0.35, 0.55);
    this.waterMaterial.specularColor = new Color3(0.6, 0.6, 0.6);
    this.waterMaterial.specularPower = 64;
    this.waterMaterial.alpha = 0.72;
    this.waterMaterial.emissiveColor = new Color3(0.02, 0.08, 0.12);
    this.waterMaterial.backFaceCulling = false;
  }

  private outline(c: ChunkDescriptor): LinesMesh {
    const [x0, z0, x1, z1] = c.rect, t = this.world.terrain, [sx, sz] = spacing(t);
    const coords: [number, number][] = [];
    for (let x = x0; x < x1; x++) coords.push([x, z0]);
    for (let z = z0; z < z1; z++) coords.push([x1, z]);
    for (let x = x1; x > x0; x--) coords.push([x, z1]);
    for (let z = z1; z > z0; z--) coords.push([x0, z]);
    coords.push([x0, z0]);
    const outline = CreateLines(`boundary-${c.id}`, { points: coords.map(([x, z]) => new Vector3(
      t.origin_x + x * sx, t.heights[z * t.width + x] + 0.45, t.origin_z + z * sz)) }, this.scene);
    outline.isPickable = false;
    return outline;
  }

  private colorMesh(data: IndexedMesh, lod: Lod, mode: ColorMode, debug: ChunkViewOptions["debug"]): Float32Array {
    const count = data.positions.length / 3, colors = new Float32Array(count * 4), t = this.world.terrain;
    let field = this.colorFields.get(mode);
    if (!field) { field = terrainColors(t, mode, this.world.normals); this.colorFields.set(mode, field); }
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) colors[i * 4 + c] = debug !== "off" ? LOD_COLORS[lod][c]
        : sampleField(field, t.width, t.depth, data.samples[i * 2], data.samples[i * 2 + 1], 4, c);
      colors[i * 4 + 3] = 1;
    }
    return colors;
  }

  update(view: ChunkViewOptions, levels: Record<string, Lod>, options: { colorMode: ColorMode; wireframe: boolean; showWater: boolean; shadows: boolean }): WorldViewStats {
    const start = performance.now(), selected = this.world.chunks.find(c => c.id === view.selected);
    const visible = new Set(this.world.chunks.filter(c => this.world.available.has(c.id) && !view.hidden.includes(c.id)
      && (view.scope === "world" || c.id === view.selected || (view.scope === "neighbors" && selected
        && Math.abs(c.coord[0] - selected.coord[0]) <= 1 && Math.abs(c.coord[1] - selected.coord[1]) <= 1))).map(c => c.id));
    for (const [id, e] of this.entries) if (!visible.has(id)) {
      this.shadow?.removeShadowCaster(e.terrain); e.terrain.dispose(); e.water?.dispose(); e.outline.dispose();
      this.entries.delete(id); releaseChunk(this.world, id);
    }
    let triangles = 0, waterTriangles = 0;
    const actual: Record<string, Lod> = {};
    for (const c of this.world.chunks) {
      if (!visible.has(c.id)) continue;
      const lod = levels[c.id] ?? 0, meshData = chunkMesh(this.world, c, lod);
      let e = this.entries.get(c.id);
      if (!e) {
        const terrain = uploadMesh(this.scene, c.id, meshData);
        terrain.material = this.terrainMaterial; terrain.metadata = { chunkId: c.id }; terrain.receiveShadows = options.shadows;
        this.shadow?.addShadowCaster(terrain);
        const wm = chunkMesh(this.world, c, 0, true);
        const water = wm.indices.length ? uploadMesh(this.scene, `water-${c.id}`, wm) : null;
        if (water) { water.material = this.waterMaterial; water.isPickable = false; water.receiveShadows = options.shadows; }
        e = { terrain, water, lod, outline: this.outline(c), colorKey: "" };
        this.entries.set(c.id, e);
      } else if (e.lod !== lod) {
        this.shadow?.removeShadowCaster(e.terrain); e.terrain.dispose();
        e.terrain = uploadMesh(this.scene, c.id, meshData); e.terrain.material = this.terrainMaterial;
        e.terrain.metadata = { chunkId: c.id }; this.shadow?.addShadowCaster(e.terrain);
        e.lod = lod; e.colorKey = "";
      }
      const colorKey = `${options.colorMode}:${view.debug}:${lod}`;
      if (e.colorKey !== colorKey) { e.terrain.setVerticesData(VertexBuffer.ColorKind, this.colorMesh(meshData, lod, options.colorMode, view.debug)); e.colorKey = colorKey; }
      e.terrain.receiveShadows = options.shadows;
      e.water?.setEnabled(options.showWater && !options.wireframe);
      e.outline.setEnabled(view.grid || c.id === view.selected);
      e.outline.color = c.id === view.selected ? new Color3(1, 0.85, 0.38) : new Color3(0.72, 0.86, 0.85);
      e.outline.alpha = c.id === view.selected ? 1 : 0.7;
      triangles += meshData.indices.length / 3; waterTriangles += e.water?.getTotalIndices() ? e.water.getTotalIndices() / 3 : 0;
      actual[c.id] = lod;
    }
    this.terrainMaterial.wireframe = options.wireframe || view.debug === "resolution";
    return { loaded: this.entries.size, triangles, waterTriangles, lods: actual, buildMs: performance.now() - start };
  }

  dispose(): void {
    for (const e of this.entries.values()) { this.shadow?.removeShadowCaster(e.terrain); e.terrain.dispose(); e.water?.dispose(); e.outline.dispose(); }
    this.entries.clear(); this.colorFields.clear(); this.terrainMaterial.dispose(); this.waterMaterial.dispose();
  }
}