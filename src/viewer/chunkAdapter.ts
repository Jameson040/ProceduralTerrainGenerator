/** Thin Babylon adapter: it consumes numerical meshes, never generates terrain. */
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { chunkMesh, sampleField, releaseChunk, spacing } from "../world/world";
import type { ChunkDescriptor, ChunkViewOptions, IndexedMesh, Lod, WorldData, WorldViewStats } from "../world/types";
import { terrainColors, type ColorMode } from "./buildMeshes";
import { defaultVisualSettings, terrainVertexColors, waterVertexColors, type VisualSettings } from "../world/shading";
import { createTerrainMaterial, type TerrainMaterialHandle } from "./terrainMaterial";
import { createWaterMaterial, type WaterMaterialHandle } from "./waterMaterial";

export const LOD_COLORS = [[0.29, 0.78, 0.60], [0.90, 0.67, 0.31], [0.54, 0.51, 0.90]];

export function uploadMesh(scene: Scene, name: string, data: IndexedMesh, opts: { uv?: Float32Array; colors?: Float32Array; attribute?: boolean } = {}): Mesh {
  const mesh = new Mesh(name, scene), vd = new VertexData();
  vd.positions = data.positions; vd.normals = data.normals;
  vd.uvs = opts.uv ?? data.uvs; vd.indices = data.indices;
  // The terrain shader reads a custom `albedo` attribute (PBR has no vertex
  // colour support); water keeps the standard vertex colour buffer.
  if (opts.colors && !opts.attribute) vd.colors = opts.colors;
  vd.applyToMesh(mesh, false);
  if (opts.colors && opts.attribute) mesh.setVerticesData("albedo", opts.colors, false, 4);
  if (opts.colors) mesh.hasVertexAlpha = true;
  return mesh;
}

interface Entry {
  terrain: Mesh; water: Mesh | null; outline: LinesMesh; lod: Lod;
  colorKey: string; waterKey: string;
}

export interface AdapterOptions {
  /** Look settings; defaults to the world's own visual settings when omitted. */
  visual?: VisualSettings;
  colorMode: ColorMode;
  wireframe: boolean;
  showWater: boolean;
  shadows: boolean;
  /** Chunk debug visualisation from the chunk panel. */
  debug?: ChunkViewOptions["debug"];
}

export class ChunkScene {
  readonly entries = new Map<string, Entry>();
  /** Resolved look: explicit options, else the world's own settings, else defaults. */
  private look(options?: AdapterOptions): VisualSettings {
    return options?.visual ?? this.world.visual ?? defaultVisualSettings();
  }

  readonly terrain: TerrainMaterialHandle;
  readonly water: WaterMaterialHandle;
  private colorFields = new Map<ColorMode, Float32Array>();

  constructor(readonly scene: Scene, readonly world: WorldData, private shadow?: ShadowGenerator, visual?: VisualSettings) {
    const look = visual ?? { material: undefined as never, water: undefined as never };
    this.terrain = createTerrainMaterial(scene, {
      quality: look.material?.quality ?? 2,
      texture_scale_m: look.material?.texture_scale_m ?? 9,
      seed: world.terrain.settings.seed >>> 0,
    });
    this.water = createWaterMaterial(scene, look.water ?? ({} as never));
  }

  get terrainMaterial() { return this.terrain.material; }
  get waterMaterial() { return this.water.material; }

  /** Per-frame ripple animation for the water layer. */
  updateVisual(dt: number): void { this.water.update(dt, this.scene.activeCamera?.globalPosition); }

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

  private colorMesh(data: IndexedMesh, lod: Lod, options: AdapterOptions): Float32Array {
    const count = data.positions.length / 3, colors = new Float32Array(count * 4), t = this.world.terrain;
    const look = this.look(options);
    if (options.colorMode === "natural" && look.material) {
      // Blended material albedo, sampled from the world-wide material field.
      return terrainVertexColors(this.world, data, look.material);
    }
    const debug = options.debug ?? "off";
    let field = this.colorFields.get(options.colorMode);
    if (!field) { field = terrainColors(t, options.colorMode, this.world.normals); this.colorFields.set(options.colorMode, field); }
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) colors[i * 4 + c] = debug !== "off" ? LOD_COLORS[lod][c]
        : sampleField(field, t.width, t.depth, data.samples[i * 2], data.samples[i * 2 + 1], 4, c);
      colors[i * 4 + 3] = 1;
    }
    return colors;
  }

  update(view: ChunkViewOptions, levels: Record<string, Lod>, options: AdapterOptions): WorldViewStats {
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
    const material = this.terrain.material, waterMaterial = this.water.material;
    for (const c of this.world.chunks) {
      if (!visible.has(c.id)) continue;
      const lod = levels[c.id] ?? 0, meshData = chunkMesh(this.world, c, lod);
      let e = this.entries.get(c.id);
      if (!e) {
        const colors = this.colorMesh(meshData, lod, options);
        const terrainMesh = uploadMesh(this.scene, c.id, meshData, { colors, attribute: true });
        terrainMesh.material = material; terrainMesh.metadata = { chunkId: c.id };
        terrainMesh.receiveShadows = options.shadows;
        this.shadow?.addShadowCaster(terrainMesh);
        const wm = chunkMesh(this.world, c, 0, true);
        const water = wm.indices.length ? uploadMesh(this.scene, `water-${c.id}`, wm, {
          uv: wm.world_uv, colors: waterVertexColors(this.world, wm, this.look(options).water),
        }) : null;
        if (water) {
          water.material = waterMaterial; water.isPickable = false;
          water.receiveShadows = options.shadows; water.hasVertexAlpha = true;
          water.metadata = { chunkId: c.id, layer: "water" };
        }
        e = { terrain: terrainMesh, water, lod, outline: this.outline(c), colorKey: "", waterKey: "" };
        this.entries.set(c.id, e);
      } else if (e.lod !== lod) {
        this.shadow?.removeShadowCaster(e.terrain); e.terrain.dispose();
        e.terrain = uploadMesh(this.scene, c.id, meshData, { colors: this.colorMesh(meshData, lod, options), attribute: true });
        e.terrain.material = material; e.terrain.metadata = { chunkId: c.id };
        this.shadow?.addShadowCaster(e.terrain);
        e.lod = lod; e.colorKey = "";
      }
      const colorKey = `${options.colorMode}:${view.debug}:${lod}:${JSON.stringify(this.look(options).material)}`;
      if (e.colorKey !== colorKey) {
        e.terrain.setVerticesData("albedo", this.colorMesh(meshData, lod, options), false, 4);
        e.colorKey = colorKey;
      }
      const waterKey = JSON.stringify(this.look(options).water);
      if (e.water && e.waterKey !== waterKey) {
        const wm = chunkMesh(this.world, c, 0, true);
        e.water.setVerticesData(VertexBuffer.ColorKind, waterVertexColors(this.world, wm, this.look(options).water), false, 4);
        e.waterKey = waterKey;
      }
      e.terrain.receiveShadows = options.shadows;
      e.water?.setEnabled(options.showWater && !options.wireframe);
      e.outline.setEnabled(view.grid || c.id === view.selected);
      e.outline.color = c.id === view.selected ? new Color3(1, 0.85, 0.38) : new Color3(0.72, 0.86, 0.85);
      e.outline.alpha = c.id === view.selected ? 1 : 0.7;
      triangles += meshData.indices.length / 3;
      waterTriangles += e.water?.getTotalIndices() ? e.water.getTotalIndices() / 3 : 0;
      actual[c.id] = lod;
    }
    this.terrain.material.wireframe = options.wireframe || view.debug === "resolution";
    return { loaded: this.entries.size, triangles, waterTriangles, lods: actual, buildMs: performance.now() - start };
  }

  dispose(): void {
    for (const e of this.entries.values()) { this.shadow?.removeShadowCaster(e.terrain); e.terrain.dispose(); e.water?.dispose(); e.outline.dispose(); }
    this.entries.clear(); this.colorFields.clear(); this.terrain.dispose(); this.water.dispose();
  }
}
