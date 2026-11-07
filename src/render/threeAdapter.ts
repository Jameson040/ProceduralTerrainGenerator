/**
 * Three.js adapter.
 *
 * Consumes the *same* renderer-independent terrain data as the Babylon adapter:
 * IndexedMesh geometry from `src/world/world.ts`, colours and material masks from
 * `src/world/shading.ts`, water colours from `src/terrain/waterVisual.ts`.
 * No generation, erosion, hydrology or carving is re-implemented here.
 *
 * Handedness: the canonical data uses Babylon's left-handed grid with clockwise
 * top faces. Three.js is right-handed with counter-clockwise front faces, so the
 * adapter reverses every triangle's winding (i0, i2, i1). Normals and positions
 * need no change: both engines are Y-up with metres.
 *
 * `THREE` is passed in by the caller, so this module has no runtime dependency on
 * three and never ends up in the Babylon bundle.
 */
import type { IndexedMesh, Lod, WorldData } from "../world/types";
import { chunkMesh } from "../world/world";
import { terrainVertexColors, waterVertexColors, type VisualSettings } from "../world/shading";
import { defaultVisualSettings } from "../terrain/visual";
import { defaultMaterialSettings, type MaterialSettings } from "../terrain/materials";
import { noiseRGBA } from "../viewer/proceduralTextures";
import { defaultWaterVisual, type WaterVisualSettings } from "../terrain/waterVisual";

/* Minimal structural types: satisfied by the real `three` module. */
interface BufferAttributeLike { itemSize: number; count: number; array: ArrayLike<number> }
interface DataTextureLike {
  wrapS: number; wrapT: number; minFilter: number; magFilter: number;
  colorSpace?: string; generateMipmaps?: boolean;
  needsUpdate?: boolean; dispose(): unknown;
}
interface BufferGeometryLike {
  setAttribute(name: string, attribute: BufferAttributeLike): unknown;
  setIndex(index: BufferAttributeLike | number[]): unknown;
  computeBoundingSphere(): unknown;
  boundingSphere: { radius: number } | null;
  dispose(): unknown;
}
export interface ThreeLike {
  BufferGeometry: new () => BufferGeometryLike;
  BufferAttribute: new (array: ArrayLike<number> & { length: number }, itemSize: number) => BufferAttributeLike;
  MeshStandardMaterial: new (params?: Record<string, unknown>) => {
    onBeforeCompile?: (shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> }) => void;
    dispose(): unknown;
    [k: string]: unknown;
  };
  FrontSide: number;
  DoubleSide: number;
  /** Optional: when present the terrain reuses the Babylon tileable noise bitmaps. */
  DataTexture?: new (
    data: Uint8Array, width: number, height: number, format: number, type: number,
  ) => DataTextureLike;
  RGBAFormat?: number;
  UnsignedByteType?: number;
  RepeatWrapping?: number;
  LinearFilter?: number;
  Group?: new () => { add(o: unknown): unknown };
  Mesh: new (geometry: BufferGeometryLike, material: unknown) => { position: { set(x: number, y: number, z: number): void }; receiveShadow: boolean; castShadow: boolean };
}

/** Convert a canonical indexed mesh into a three BufferGeometry (CCW winding). */
export function createThreeGeometry(THREE: ThreeLike, mesh: IndexedMesh): BufferGeometryLike {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  // Normalised UVs for generic use, plus world-metre UVs identical in every chunk.
  geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  geometry.setAttribute("uv1", new THREE.BufferAttribute(mesh.world_uv, 2));
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    indices[i] = mesh.indices[i];
    indices[i + 1] = mesh.indices[i + 2]; // reverse for right-handed CCW front faces
    indices[i + 2] = mesh.indices[i + 1];
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Per-vertex RGB (three takes 3 floats for vertex colours). */
function colourAttribute(THREE: ThreeLike, rgba: Float32Array, alpha: boolean): BufferAttributeLike {
  if (alpha) return new THREE.BufferAttribute(rgba, 4);
  const rgb = new Float32Array((rgba.length / 4) * 3);
  for (let i = 0, v = 0; i < rgba.length; i += 4, v += 3) {
    rgb[v] = rgba[i]; rgb[v + 1] = rgba[i + 1]; rgb[v + 2] = rgba[i + 2];
  }
  return new THREE.BufferAttribute(rgb, 3);
}

/**
 * Terrain material: MeshStandardMaterial with vertex colours plus a triplanar
 * detail term injected in `onBeforeCompile`.
 *
 * The detail bitmaps are the *same* CPU-generated tileable noise the Babylon
 * plugin uses (`src/viewer/proceduralTextures.ts`), sampled in world space with
 * three projections weighted by the world normal. That is what makes the texture
 * chunk independent, LOD independent and unstretched on steep faces, and it keeps
 * both renderers showing an identical pattern instead of two lookalike shaders.
 * Without `DataTexture` (plain structural use) it falls back to hashed grain.
 */
export function createThreeTerrainMaterial(THREE: ThreeLike, settings: MaterialSettings = defaultMaterialSettings(), seed = 0) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.93, metalness: 0.0, side: THREE.DoubleSide, flatShading: false,
  });
  const quality = settings.quality;
  const detailScale = 1 / Math.max(0.5, settings.texture_scale_m);
  const strength = quality === 0 ? 0 : quality === 1 ? 0.6 : 1;
  const useTextures = Boolean(THREE.DataTexture && THREE.RGBAFormat !== undefined);
  const detail = useTextures ? makeNoiseTexture(THREE, 256, seed ^ 0x4f1b, 4) : null;
  const macro = useTextures && quality >= 2 ? makeNoiseTexture(THREE, 128, seed ^ 0x9a31, 3) : null;
  if (detail) (material as unknown as { userData: Record<string, unknown> }).userData.detail = detail;
  if (macro) (material as unknown as { userData: Record<string, unknown> }).userData.macro = macro;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailScale = { value: detailScale };
    shader.uniforms.uMacroScale = { value: 0.012 };
    shader.uniforms.uDetailStrength = { value: strength };
    shader.uniforms.uDetailTex = { value: detail };
    shader.uniforms.uMacroTex = { value: macro };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vWorldNormal;")
      .replace("#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWorldNormal = normalize(mat3(modelMatrix) * objectNormal);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vWorldNormal;\n" +
        "uniform float uDetailScale;\nuniform float uMacroScale;\nuniform float uDetailStrength;\n" +
        "uniform sampler2D uDetailTex;\nuniform sampler2D uMacroTex;")
      .replace("#include <color_fragment>", `#include <color_fragment>
      if (uDetailStrength > 0.001) {
        // One triplanar basis: identical weights to the Babylon plugin.
        vec3 w = pow(abs(normalize(vWorldNormal)), vec3(4.0));
        w /= max(1e-4, w.x + w.y + w.z);
        float d0 = texture2D(uDetailTex, vWorldPos.zy * uDetailScale).r;
        float d1 = texture2D(uDetailTex, vWorldPos.xz * uDetailScale).r;
        float d2 = texture2D(uDetailTex, vWorldPos.xy * uDetailScale).r;
        float det = d0 * w.x + d1 * w.y + d2 * w.z;
        float mac = texture2D(uMacroTex, vWorldPos.xz * uMacroScale).r;
        float shade = (0.78 + 0.44 * det) * (0.90 + 0.20 * mac);
        diffuseColor.rgb *= mix(1.0, shade, uDetailStrength);
      }`);
  };
  // Distinct programs per quality/seed, otherwise three reuses a stale shader.
  (material as unknown as { customProgramCacheKey: () => string }).customProgramCacheKey =
    () => `terrain-${quality}-${seed}-${detailScale.toFixed(4)}`;
  return material;
}

/** Tileable RGBA noise identical to the Babylon terrain plugin's bitmaps. */
function makeNoiseTexture(THREE: ThreeLike, size: number, seed: number, octaves: number) {
  const texture = new THREE.DataTexture!(
    noiseRGBA(size, seed, octaves), size, size, THREE.RGBAFormat!, THREE.UnsignedByteType!,
  );
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping!;
  texture.minFilter = texture.magFilter = THREE.LinearFilter!;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Water material: a standard PBR surface (so the environment map gives real
 * reflections and the sun gives a highlight) with a cheap two-wave normal
 * perturbation for subtle motion. Single sided and no depth writes, so looking
 * up from beneath the world can never show water.
 */
export function createThreeWaterMaterial(THREE: ThreeLike, visual: WaterVisualSettings = defaultWaterVisual()) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, transparent: true, opacity: 1, side: THREE.FrontSide,
    roughness: 0.34, metalness: 0.0, depthWrite: false, color: 0xffffff, envMapIntensity: 0.35,
  });
  const motion = Math.max(0, visual.motion);
  const wave = 1 / Math.max(1, visual.wave_scale_m);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uWaveScale = { value: wave };
    shader.uniforms.uMotion = { value: motion };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWaterPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWaterPos;\nuniform float uTime;\nuniform float uWaveScale;\nuniform float uMotion;")
      // Same split as the Babylon shader: the vertex colour is the water body's
      // scattering tint (lit gently, so deep water stays coloured), and a
      // separate Fresnel term adds the sky reflection and extra opacity.
      .replace("#include <opaque_fragment>", `
      {
        float facing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
        float fresnel = pow(1.0 - facing, 4.0);
        vec3 tint = diffuseColor.rgb;
        // Tint is lit gently (~0.5) so deep water stays coloured instead of
        // glowing, matching the Babylon water shader's ambient-scaled base.
        float up = clamp(dot(normalize(normal), vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
        outgoingLight = tint * (0.42 + 0.22 * up) + vec3(0.36, 0.53, 0.70) * fresnel * 0.9;
        diffuseColor.a = clamp(diffuseColor.a + fresnel * 0.18, 0.0, 1.0);
      }
      #include <opaque_fragment>`)
      // Two crossed waves bend the normal; no texture fetch, no extra pass.
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
      if (uMotion > 0.001) {
        vec2 p = vWaterPos.xz * uWaveScale;
        float t = uTime * 0.9;
        float dx = cos(p.x * 1.7 + t) * 0.55 + cos((p.x + p.y) * 0.9 - t * 1.3) * 0.45;
        float dz = cos(p.y * 1.3 - t * 0.8) * 0.55 + cos((p.x - p.y) * 1.1 + t * 1.1) * 0.45;
        normal = normalize(normal + vec3(dx, 0.0, dz) * 0.16 * uMotion);
      }`);
    (material as unknown as { userData: Record<string, unknown> }).userData.shader = shader;
  };
  (material as unknown as { customProgramCacheKey: () => string }).customProgramCacheKey =
    () => `water-${motion.toFixed(3)}-${visual.wave_scale_m.toFixed(2)}`;
  return material;
}

/** Advance the water animation. Cheap: one uniform per frame. */
export function updateThreeWater(material: unknown, seconds: number): void {
  const shader = (material as { userData?: { shader?: { uniforms: Record<string, { value: number }> } } })?.userData?.shader;
  if (shader?.uniforms?.uTime) shader.uniforms.uTime.value = seconds;
}

export interface ThreeChunk {
  terrain: { geometry: BufferGeometryLike; material: unknown; mesh?: unknown };
  water: { geometry: BufferGeometryLike; material: unknown; mesh?: unknown } | null;
}

/**
 * Build the geometry/material pair for one chunk.
 * Pass no `THREE` reference to get plain data back; pass it to get real objects.
 */
export function createThreeChunk(THREE: ThreeLike, world: WorldData, chunkId: string, lod: Lod = 0, visual?: VisualSettings): ThreeChunk {
  const look = visual ?? world.visual ?? defaultVisualSettings();
  const chunk = world.chunks.find(c => c.id === chunkId);
  if (!chunk) throw new Error(`Unknown chunk ${chunkId}`);
  const mesh = chunkMesh(world, chunk, lod);
  const geometry = createThreeGeometry(THREE, mesh);
  geometry.setAttribute("color", colourAttribute(THREE, terrainVertexColors(world, mesh, look.material), false));
  const waterMesh = chunkMesh(world, chunk, 0, true);
  let water: ThreeChunk["water"] = null;
  if (waterMesh.indices.length) {
    const waterGeometry = createThreeGeometry(THREE, waterMesh);
    waterGeometry.setAttribute("color", colourAttribute(THREE, waterVertexColors(world, waterMesh, look.water), true));
    water = { geometry: waterGeometry, material: createThreeWaterMaterial(THREE, look.water) };
  }
  return { terrain: { geometry, material: createThreeTerrainMaterial(THREE, look.material, world.terrain.settings.seed >>> 0) }, water };
}
