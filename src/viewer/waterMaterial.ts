/**
 * Babylon water layer.
 *
 * Water is its own mesh and its own material; nothing here touches terrain.
 * The shader is deliberately small: one lighting model, one procedural ripple
 * normal (two sines, no texture fetch), one Fresnel term against a sky gradient.
 * No refraction, no planar reflection, no screen-space work.
 *
 * The material is **single sided** (back faces culled) and the surface only
 * exists as a top face, so from underneath the world you see ground, never water.
 */
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Effect } from "@babylonjs/core/Materials/effect";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { WaterVisualSettings } from "../terrain/waterVisual";

const SHADER = "terrainWater";

Effect.ShadersStore[`${SHADER}VertexShader`] = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vWorld;
varying vec4 vColor;
void main(void) {
  vec4 wp = world * vec4(position, 1.0);
  vWorld = wp.xyz;
  // The tint/opacity come from the vertex colour: lake vs river, shallow vs deep.
  vColor = color;
  gl_Position = viewProjection * wp;
}
`;

Effect.ShadersStore[`${SHADER}FragmentShader`] = `
precision highp float;
varying vec3 vWorld;
varying vec4 vColor;
uniform vec3 cameraPosition;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 skyColor;
uniform vec3 groundColor;
uniform vec3 fogColor;
uniform float fogDensity;
uniform float waveScale;
uniform float waveAmount;
uniform float time;
uniform float gloss;

// Two crossing sine trains give a believable micro-ripple without a texture.
vec3 rippleNormal(vec3 p, float atten) {
  float s = 6.2831 / max(1.0, waveScale);
  float a = 0.10 * waveAmount * atten;
  vec3 n = vec3(0.0, 1.0, 0.0);
  n.x += a * cos(p.x * s + time * 1.7) + a * 0.6 * cos((p.x + p.z) * s * 1.7 - time * 2.3);
  n.z += a * cos(p.z * s * 0.8 - time * 1.3) + a * 0.5 * cos((p.z - p.x) * s * 1.4 + time * 1.9);
  return normalize(n);
}

void main(void) {
  float dist = length(cameraPosition - vWorld);
  // Fade the procedural ripple with distance: no shimmer aliasing far away.
  vec3 n = rippleNormal(vWorld, 1.0 / (1.0 + dist * 0.004));
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 sun = normalize(sunDirection);

  float facing = clamp(dot(n, v), 0.0, 1.0);
  float fresnel = pow(1.0 - facing, 4.0);

  // Sky light from above, ground bounce from below: cheap hemispheric term.
  // The vertex colour is the water body's scattering tint, not a diffuse albedo:
  // light it gently so deep water stays blue instead of going black.
  vec3 ambient = mix(groundColor, skyColor, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 base = vColor.rgb * (0.95 + 0.45 * max(dot(n, sun), 0.0)) + skyColor * 0.05;
  base *= 0.35 + 0.65 * clamp(dot(ambient, vec3(0.33)), 0.0, 1.0);
  vec3 reflection = skyColor * (0.35 + 0.65 * gloss) * fresnel * 2.4;

  vec3 h = normalize(sun + v);
  float spec = pow(max(dot(n, h), 0.0), 24.0 + gloss * 220.0);
  vec3 highlight = sunColor * spec * (0.30 + 0.85 * gloss);

  vec3 colorOut = base + reflection + highlight;

  float fog = 1.0 - exp(-pow(dist * fogDensity, 2.0));
  colorOut = mix(colorOut, fogColor, clamp(fog, 0.0, 1.0));

  float alpha = clamp(vColor.a + fresnel * 0.25 * gloss, 0.0, 1.0);
  gl_FragColor = vec4(colorOut, alpha);
}
`;

export interface WaterMaterialHandle {
  material: ShaderMaterial;
  setVisual(v: WaterVisualSettings): void;
  update(dt: number, camera?: Vector3): void;
  dispose(): void;
}

export function createWaterMaterial(scene: Scene, visual: WaterVisualSettings, opts: {
  sunDirection?: Vector3; sunColor?: Color3; skyColor?: Color3; groundColor?: Color3;
} = {}): WaterMaterialHandle {
  const material = new ShaderMaterial("water", scene, SHADER, {
    attributes: ["position", "uv", "color"],
    uniforms: ["world", "viewProjection", "cameraPosition", "sunDirection", "sunColor",
      "skyColor", "groundColor", "fogColor", "fogDensity", "waveScale", "waveAmount", "time", "gloss"],
    needAlphaBlending: true,
  });
  material.backFaceCulling = true;
  material.separateCullingPass = false;
  // Water is transparent but must not hide the bed from the depth buffer.
  material.disableDepthWrite = true;
  material.alphaMode = 2; // ALPHA_BLEND
  material.setVector3("sunDirection", opts.sunDirection ?? new Vector3(-0.6, -0.8, 0.45).normalize());
  material.setColor3("sunColor", opts.sunColor ?? new Color3(1.0, 0.96, 0.88));
  material.setColor3("skyColor", opts.skyColor ?? new Color3(0.55, 0.72, 0.92));
  material.setColor3("groundColor", opts.groundColor ?? new Color3(0.16, 0.15, 0.12));
  material.setColor3("fogColor", scene.fogColor);
  material.setFloat("fogDensity", scene.fogDensity);
  material.setFloat("time", 0);

  let settings = visual;
  let clock = 0;
  const apply = (v: WaterVisualSettings) => {
    settings = v;
    material.setFloat("waveScale", Math.max(1, v.wave_scale_m));
    material.setFloat("waveAmount", v.motion);
    material.setFloat("gloss", v.gloss);
    material.setFloat("fogDensity", scene.fogDensity);
    material.setColor3("fogColor", scene.fogColor);
  };
  apply(visual);

  return {
    material,
    setVisual: apply,
    update: (dt: number, camera?: Vector3) => {
      clock += dt * (0.4 + settings.motion);
      material.setFloat("time", clock);
      material.setFloat("fogDensity", scene.fogDensity);
      material.setVector3("cameraPosition", camera ?? scene.activeCamera?.globalPosition ?? Vector3.Zero());
    },
    dispose: () => material.dispose(),
  };
}
