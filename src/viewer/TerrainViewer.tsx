import { useEffect, useRef } from "react";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Materials/standardMaterial";
import type { ColorMode } from "./buildMeshes";
import type { ChunkViewOptions, Lod, WorldData, WorldViewStats } from "../world/types";
import type { VisualSettings } from "../world/shading";
import { balanceLods, distanceLods, spacing } from "../world/world";
import { ChunkScene } from "./chunkAdapter";

export interface ViewerOptions {
  colorMode: ColorMode;
  wireframe: boolean;
  showWater: boolean;
  shadows: boolean;
  /** Material rules + water look; changing them never regenerates terrain. */
  visual: VisualSettings;
}

interface Props {
  world: WorldData | null; options: ViewerOptions; chunks: ChunkViewOptions; focusToken: number;
  onStats: (stats: WorldViewStats) => void; onSelect: (id: string) => void;
}

interface SceneRefs {
  engine: Engine; scene: Scene; camera: ArcRotateCamera; shadowGen: ShadowGenerator;
  manager: ChunkScene | null;
}

export default function TerrainViewer({ world, options, chunks, focusToken, onStats, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const refs = useRef<SceneRefs | null>(null);
  const current = useRef({ options, chunks, onStats, onSelect });
  current.current = { options, chunks, onStats, onSelect };
  const signature = useRef("");
  const previousLods = useRef<Record<string, Lod>>({});
  const refresh = () => {
    const r = refs.current, props = current.current;
    if (!r?.manager) return;
    const w = r.manager.world;
    const requested = props.chunks.lod === "adaptive" ? distanceLods(w, r.camera.position.x, r.camera.position.z, undefined, undefined, previousLods.current)
      : Object.fromEntries(w.chunks.map(c => [c.id, props.chunks.lod as Lod]));
    const levels = balanceLods(w.chunks, requested);
    previousLods.current = levels;
    const sig = JSON.stringify([levels, props.options, props.chunks]);
    if (signature.current === sig) return;
    signature.current = sig;
    const stats = r.manager.update(props.chunks, levels, { ...props.options, debug: props.chunks.debug });
    r.shadowGen.getLight().shadowEnabled = props.options.shadows;
    props.onStats(stats);
    if (canvasRef.current) {
      canvasRef.current.dataset.chunks = String(stats.loaded);
      canvasRef.current.dataset.lods = JSON.stringify(stats.lods);
      canvasRef.current.dataset.worldId = w.id;
    }
  };

  // Scene setup (once)
  useEffect(() => {
    const canvas = canvasRef.current!;
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    canvas.dataset.sceneId = crypto.randomUUID();
    scene.clearColor = new Color4(0.55, 0.7, 0.9, 1);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = new Color3(0.6, 0.72, 0.88);
    scene.fogDensity = 0.00025;
    // Filmic tone mapping: snow and water highlights stay readable instead of clipping.
    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = 1; // ACES
    ip.exposure = 1.15;
    ip.contrast = 1.12;

    const camera = new ArcRotateCamera("cam", -Math.PI / 3, Math.PI / 3.2, 1500, new Vector3(0, 60, 0), scene);
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 40;
    camera.upperRadiusLimit = 6000;
    camera.upperBetaLimit = Math.PI / 2 - 0.02;
    camera.wheelPrecision = 1.5;
    camera.panningSensibility = 40;
    camera.minZ = 1;
    camera.maxZ = 20000;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.45;
    hemi.groundColor = new Color3(0.3, 0.3, 0.25);

    const sun = new DirectionalLight("sun", new Vector3(-0.6, -0.8, 0.45), scene);
    sun.position = new Vector3(900, 1200, -700);
    sun.intensity = 1.1;
    sun.autoUpdateExtends = true;

    const shadowGen = new ShadowGenerator(2048, sun);
    shadowGen.useBlurExponentialShadowMap = true;
    shadowGen.blurKernel = 16;
    shadowGen.bias = 0.002;
    shadowGen.normalBias = 0.5;
    shadowGen.darkness = 0.35;

    refs.current = { engine, scene, camera, shadowGen, manager: null };
    scene.onPointerObservable.add(info => {
      const id = info.pickInfo?.pickedMesh?.metadata?.chunkId;
      if (info.type === PointerEventTypes.POINTERPICK && typeof id === "string") current.current.onSelect(id);
    });
    let nextCheck = 0, lastFrame = performance.now();
    engine.runRenderLoop(() => {
      const now = performance.now(), dt = Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;
      refs.current?.manager?.updateVisual(dt);
      scene.render();
      if (now > nextCheck) { nextCheck = now + 250; refresh(); }
    });
    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas.parentElement!);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      refs.current?.manager?.dispose();
      scene.dispose();
      engine.dispose();
      refs.current = null;
    };
  }, []);

  // Replacing source data is the only operation that discards the whole cache.
  useEffect(() => {
    const r = refs.current;
    if (!r) return;
    r.manager?.dispose(); r.manager = null; signature.current = ""; previousLods.current = {};
    if (!world) return;
    r.manager = new ChunkScene(r.scene, world, r.shadowGen, current.current.options.visual ?? world.visual);
    const t = world.terrain, [sx, sz] = spacing(t);
    const extent = Math.max((t.width - 1) * sx, (t.depth - 1) * sz);
    r.camera.target = new Vector3(t.origin_x + (t.width - 1) * sx / 2, t.settings.height_scale * 0.3, t.origin_z + (t.depth - 1) * sz / 2);
    r.camera.alpha = -Math.PI / 3;
    r.camera.beta = Math.PI / 3.2;
    r.camera.radius = extent * 1.4;
    r.camera.upperRadiusLimit = extent * 6;
    r.camera.maxZ = extent * 12;
    r.scene.fogDensity = 0.26 / extent;
    // Resolve the new orbit pose before the first hysteresis-based LOD decision.
    r.camera.getViewMatrix(true);
    refresh();
  }, [world]);

  // Cheap option toggles
  useEffect(() => {
    refresh();
  }, [options, chunks]);

  useEffect(() => {
    const r = refs.current, c = world?.chunks.find(c => c.id === chunks.selected);
    if (!r || !world || !c || !focusToken) return;
    const t = world.terrain, [sx, sz] = spacing(t), [x0, z0, x1, z1] = c.rect;
    r.camera.setTarget(new Vector3(t.origin_x + (x0 + x1) * sx / 2, t.heights[Math.floor((z0 + z1) / 2) * t.width + Math.floor((x0 + x1) / 2)], t.origin_z + (z0 + z1) * sz / 2));
    r.camera.radius = Math.max((x1 - x0) * sx, (z1 - z0) * sz) * 2.2;
  }, [focusToken]);

  return <canvas ref={canvasRef} aria-label="Chunked terrain viewport" className="w-full h-full outline-none touch-none" />;
}
