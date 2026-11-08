/**
 * Babylon terrain material: PBR base + a triplanar procedural detail plugin.
 *
 * Why PBR + plugin instead of a full custom shader: the material keeps Babylon's
 * shadows, fog, tonemapping and light management for free, and the plugin only
 * injects a handful of texture-fetch lines. The injected code samples a
 * tileable noise texture **in world space** with three projections weighted by
 * the world normal, which is what removes stretching on steep faces and keeps
 * the pattern continuous across chunks and LODs.
 *
 * Quality levels (VisualSettings.material.quality):
 *   0  vertex colours only  - no texture fetches, the cheapest option
 *   1  triplanar detail     - one tileable noise map, 3 taps
 *   2  detail + macro       - adds a second, larger-scale tap (default)
 *
 * The material is double sided on purpose: the heightfield is a closed sheet, so
 * looking at the world from below shows the underside of the ground (land), never
 * the separate water layer, which culls its back faces.
 */
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Material } from "@babylonjs/core/Materials/material";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Scene } from "@babylonjs/core/scene";
import { noiseRGBA } from "./proceduralTextures";

export interface TerrainLook {
  quality: 0 | 1 | 2;
  /** Metres per detail tile. */
  texture_scale_m: number;
  seed: number;
}

const VERTEX_DECL = "varying vec3 vTriPosW;\nvarying vec3 vTriNrmW;\nvarying vec4 vTriAlbedo;\n";
// Plugin samplers are bound by bindForSubMesh but must be declared here.
const FRAGMENT_DECL = VERTEX_DECL + "uniform sampler2D triDetailTex;\nuniform sampler2D triMacroTex;\n";
const ATTRIBUTE = "albedo";

class TriplanarDetailPlugin extends MaterialPluginBase {
  detailScale = 0.1;
  macroScale = 0.012;
  strength = 1;
  detailTexture: RawTexture | null = null;
  macroTexture: RawTexture | null = null;

  constructor(material: Material) {
    super(material, "TriplanarDetail", 200, { TRI_DETAIL: false, TRI_MACRO: false });
    this._enable(true);
  }

  override getClassName(): string { return "TriplanarDetailPlugin"; }

  override getSamplers(samplers: string[]): void {
    samplers.push("triDetailTex", "triMacroTex");
  }

  /**
   * PBRMaterial has no VERTEXCOLOR support, so the blended material albedo
   * travels in its own vertex attribute and is applied here.
   */
  override getAttributes(attributes: string[]): void {
    attributes.push(ATTRIBUTE);
  }

  override getUniforms() {
    return { ubo: [
      { name: "triDetailScale", size: 1, type: "float" },
      { name: "triMacroScale", size: 1, type: "float" },
      { name: "triStrength", size: 1, type: "float" },
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat("triDetailScale", this.detailScale);
    uniformBuffer.updateFloat("triMacroScale", this.macroScale);
    uniformBuffer.updateFloat("triStrength", this.strength);
    // Plugin samplers are bound by the plugin itself.
    if (this.detailTexture) uniformBuffer.setTexture("triDetailTex", this.detailTexture);
    if (this.macroTexture) uniformBuffer.setTexture("triMacroTex", this.macroTexture);
  }

  override getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: VERTEX_DECL + "attribute vec4 albedo;\n",
        // World-space position and normal: the projection basis of the detail.
        CUSTOM_VERTEX_UPDATE_WORLDPOS:
          "vTriPosW = (world * vec4(position, 1.0)).xyz;\n" +
          "vTriNrmW = normalize((world * vec4(normal, 0.0)).xyz);\n" +
          "vTriAlbedo = albedo;\n",
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: FRAGMENT_DECL,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
        surfaceAlbedo.rgb *= vTriAlbedo.rgb;
        float triStrengthV = triStrength;
        if (triStrengthV > 0.001) {
          vec3 triW = pow(abs(normalize(vTriNrmW)), vec3(4.0));
          triW /= max(1e-4, triW.x + triW.y + triW.z);
          float d0 = texture2D(triDetailTex, vTriPosW.zy * triDetailScale).r;
          float d1 = texture2D(triDetailTex, vTriPosW.xz * triDetailScale).r;
          float d2 = texture2D(triDetailTex, vTriPosW.xy * triDetailScale).r;
          float detail = d0 * triW.x + d1 * triW.y + d2 * triW.z;
          float macro = texture2D(triMacroTex, vTriPosW.xz * triMacroScale).r;
          float shade = (0.78 + 0.44 * detail) * (0.90 + 0.20 * macro);
          surfaceAlbedo.rgb *= mix(1.0, shade, triStrengthV);
        }
      `,
    };
  }
}

export interface TerrainMaterialHandle {
  material: PBRMaterial;
  pluginAttached: boolean;
  setLook(look: TerrainLook): void;
  dispose(): void;
}

export function createTerrainMaterial(scene: Scene, look: TerrainLook): TerrainMaterialHandle {
  const material = new PBRMaterial("terrainPBR", scene);
  material.albedoColor = new Color3(1, 1, 1);
  material.metallic = 0;
  material.roughness = 0.92;
  material.specularIntensity = 0.35;
  material.usePhysicalLightFalloff = false;
  material.environmentIntensity = 0.35;
  // Land is a closed sheet: render both sides so the world has real ground
  // underneath the camera as well, and flip the lighting on back faces.
  material.backFaceCulling = false;
  material.twoSidedLighting = true;
  material.transparencyMode = null;

  const detail = new RawTexture(noiseRGBA(256, look.seed ^ 0x4f1b, 4), 256, 256,
    Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  detail.wrapU = detail.wrapV = Texture.WRAP_ADDRESSMODE;
  detail.anisotropicFilteringLevel = 4;
  const macro = new RawTexture(noiseRGBA(128, look.seed ^ 0x9a31, 3), 128, 128,
    Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  macro.wrapU = macro.wrapV = Texture.WRAP_ADDRESSMODE;

  let plugin: TriplanarDetailPlugin | null = null;
  try {
    plugin = new TriplanarDetailPlugin(material);
    plugin.detailTexture = detail;
    plugin.macroTexture = macro;
  } catch {
    // A plugin failure must never cost the user the terrain: fall back to the
    // flat vertex-colour look, which needs no extra shader code.
    plugin = null;
  }

  const apply = (l: TerrainLook) => {
    const scale = Math.max(0.5, l.texture_scale_m);
    if (plugin) {
      plugin.detailScale = 1 / scale;
      plugin.macroScale = 1 / (scale * 9);
      plugin.strength = l.quality === 0 ? 0 : l.quality === 1 ? 0.7 : 1;
      plugin.markAllDefinesAsDirty();
      material.markAsDirty(0);
    }
    material.roughness = l.quality >= 2 ? 0.9 : 0.95;
  };
  apply(look);

  return {
    material,
    pluginAttached: plugin !== null,
    setLook: apply,
    dispose: () => { detail.dispose(); macro.dispose(); plugin?.dispose(); material.dispose(); },
  };
}
