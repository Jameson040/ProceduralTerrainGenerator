# Phase 4 Technical Report — Materials, Visual Quality and Production Readiness

## Scope

Phase 4 is an extension of the existing application, not a replacement. The generator, erosion,
drainage, lake detection, river carving, chunk meshing, LOD stitching and the existing preview
are unchanged. Everything added here is either **derived** from the completed source world
(materials, colours, water look) or **plumbing** (a second renderer adapter, richer exports,
tests). Re-running Phase 4 code never regenerates terrain: material evaluation is a pure function
of the heightfield, the canonical normals, the water field and the material settings.

New modules:

| Module | Language | Role |
| --- | --- | --- |
| `src/terrain/materials.ts` | TS | Material registry, rules, blended albedo field, statistics |
| `terrain/materials.py` | Python | Line-by-line mirror of the same registry and rules |
| `src/terrain/waterVisual.ts` | TS | Water appearance settings, depth-driven water colours |
| `src/terrain/visual.ts` | TS | `VisualSettings` = material settings + water settings |
| `src/world/shading.ts` | TS | Per-mesh vertex colours, material attribute pairs, world UVs |
| `src/viewer/terrainMaterial.ts` | TS | Babylon PBR + triplanar detail plugin |
| `src/viewer/waterMaterial.ts` | TS | Babylon water shader (separate rendering layer) |
| `src/viewer/proceduralTextures.ts` | TS | Tileable noise/normal bitmaps, generated once on the CPU |
| `src/render/threeAdapter.ts` | TS | Three.js adapter over the same world data |
| `src/viewer/LookPanel.tsx` | TSX | Quality / water / material controls in the preview |

## Material System

### Derived, not destructive

The material field is a set of weights per source sample, computed after the numerical world is
finished. Heights, normals, water masks and river beds are read-only inputs; a test asserts that
changing `snow_line` and `rock_slope` and recomputing leaves the heightfield and the water field
bit-identical.

### Inputs

Every rule reads the same normalised context (`MaterialSample`): `elevation`, `height_above_
water`, `slope` (1 − n.y), `aspect` (n.z), `flow` (log-normalised accumulation), `curvature`,
`river_bed` (from the Phase 3 carve mask), `wetness` (two-pass distance from the waterline with a
3×3 blur and an edge-clamped border — no fabricated dry border), `submerged`, and two octaves of
world-space fBm (`variation`, `detail`). Nothing is random and nothing is chunk-local.

### Registry

Seven channels, in a fixed order: `sand`, `gravel`, `grass`, `dry_grass`, `soil`, `rock`, `snow`.
Each definition carries a label, an sRGB albedo, roughness, specular level, and a `weight(ctx)`
function. The blended albedo is the weighted sum of the registry albedos, converted to linear
sRGB once, so both renderers and both exporters see identical colours.

Distribution is rule based and continuous:

- **Sand** hugs the shoreline (`height_above_water < sand_shore_m`, stronger when wet).
- **Gravel** follows flow accumulation and river beds, so channels and outwash read as coarse.
- **Grass / dry grass** split on `soil_bias`, wetness and height; grass wins on flat, sheltered
  ground.
- **Soil** appears on gentle, dry, mid-slope ground (exposed patches, not bands).
- **Rock** is driven by slope (`rock_slope`) and curvature, so cliffs and ridge crests are bare.
- **Snow** starts at `snow_line` (per-cell threshold, blended against slope so snow slides off
  steep faces) and thickens with elevation.

Measured on the retained fixture (seed 42, 129², defaults):

| Metric | Value |
| --- | --- |
| Fractions | sand 0.003 / gravel 0.230 / grass 0.434 / dry_grass 0.227 / soil 0.012 / rock 0.041 / snow 0.053 |
| Plains (slope < 0.16) | rock 0.005, grass 0.448 |
| Hills (0.16 – 0.40) | rock 0.157, grass 0.390 |
| Mountains (> 0.40) | rock 0.575, grass 0.033 |
| Rock coverage on steep faces (slope > 0.45) | 0.67 – 0.69 |
| Grass coverage on flat ground (slope < 0.15) | 0.45 – 0.46 |
| Neighbour jump p50 / p95 on dry ground | 0.035 – 0.048 / 0.355 – 0.445 |
| Dominant-class transition fraction | 0.089 – 0.114 |

The transition metric deliberately ignores edges that touch a wet cell: the waterline is a real
physical edge, not a colour band. Across four seeds (42/129², 99/96², 7/160², 1234/200²) the p95
stays under 0.45, which is well below a hard two-class switch (1.0).

### Extension points

Snow, sand and extra soil types are already registry entries, not special cases. A future biome
material only needs a new `MaterialDef` (or `registerMaterial` call) with a `weight` function; the
mesher, the exporters, both shaders and the debug map pick it up because the channel count travels
in the data (`MATERIAL_FORMAT_VERSION`, `MAX_MATERIALS = 8`). Adding a channel is a format bump, not
a code rewrite. There is no biome/vegetation system in this phase.

## Procedural Texturing

- Each mesh vertex carries `world_uv` in **metres** (`origin + sample × spacing`). Both engines
  sample textures with that UV, so a pattern never restarts at a chunk or LOD boundary.
- Terrain detail is **triplanar**: three world-space projections of one tileable 256² noise bitmap,
  weighted by the world normal (`pow(|n|, 4)`), plus a 128² macro bitmap for large-scale mottling.
  Steep faces use the ZY/XY projections, so they are not stretched.
- The CPU tileable noise (`src/viewer/proceduralTextures.ts`) is shared: the Babylon plugin samples
  it through `RawTexture`, the Three.js adapter through `DataTexture`. There is one noise
  implementation, not two lookalikes.
- Quality levels gate cost, not correctness: `0` vertex colours only, `1` triplanar detail,
  `2` detail + macro (default).
- The blended albedo is also baked into export vertex colours (`u8-linear-v1`), so a consumer
  without shader control still gets the material distribution.

## Water Layer

Water remains separate geometry from the terrain in every stage: source data, meshes, exports and
the scene graph. No material code writes heights, and the water mesh is built from the protected
water cells only.

- **Colour comes from the carved depth** (`depth_scale_m`), blended between shallow and deep
  colours; lakes and rivers have their own shallow/deep pairs, so a river reads greener and
  shallower than a lake basin.
- **Opacity is configurable** (`opacity`, default 0.86) and multiplies a per-vertex alpha that
  fades at the shoreline halo.
- **Reflections**: Babylon uses a Fresnel term plus a sun specular driven by `gloss`; Three.js uses
  a physically based standard material against the scene environment with the same Fresnel tint.
- **Motion**: `motion` (default 0.35) drives cheap procedural ripples in world space (two crossed
  sine waves bending the normal); `0` gives a still surface. No render-to-texture, no geometry
  waves, no extra pass.
- **Containment**: the water surface is never below the bed (asserted over every wet cell), water
  quads are only emitted for wet cells, Babylon's water material culls back faces, and the Three
  water material is `FrontSide` with `depthWrite: false`. The `under-terrain` render view (camera
  below the heightfield looking up) measures `water = 0.000`, `land = 1.000` in both renderers —
  looking at the world from beneath shows only land.
- Lakes keep their lakebeds and rivers their carved beds: the depth used for colour *is* the
  distance from the water surface to the carved terrain.

## Export Format 1.1.0

`WORLD_VERSION = "1.1.0"`; `MATERIAL_FORMAT_VERSION = 1`. New fields, all additive:

- Manifest/header `render`: `{ material: MaterialSettings, water: WaterVisualSettings }`, so a
  consumer reproduces the look without guessing.
- Chunk `materials`: `{ format: "u8-linear-v1", version: 1, ids, weights, albedo }` with one
  8-bit weight per source sample per channel and three 8-bit albedo bytes, in the chunk's own
  source rectangle (row-major, channel-minor).
- Per-mesh `uv_world` (metres) and `colors` (`u8-linear-v1` RGBA), for terrain LOD 0/1/2 and for the
  separate water mesh.

Reconstruction was verified rather than assumed: the TypeScript suite loads a single chunk, the
complete set of 16 chunks and the complete ZIP, then compares indices, positions, normals, UVs,
world UVs and colours against the pre-export world. Indices are identical, positions/normals drift
by float32 serialisation only (0 here, tolerance 0.02), world UVs match exactly, and colours
differ by at most one quantisation step. `1.0.0` chunks still load: `uv_world` is synthesised from
positions and colours are recomputed from the material field (fixtures kept in
`artifacts/phase4/legacy-1.0.0/`).

## Renderer Compatibility

Both adapters consume `IndexedMesh` + `src/world/shading.ts`; neither re-implements generation,
erosion, hydrology, carving or meshing.

**Babylon** (`src/viewer/chunkAdapter.ts`): `PBRMaterial` with vertex albedo uploaded as a custom
`albedo` attribute, triplanar detail via a `MaterialPluginBase`, separate water meshes with the
custom water shader.

**Three.js** (`src/render/threeAdapter.ts`): `THREE` is passed in, so the module has no runtime
dependency on three and never enters the Babylon bundle.

| Canonical data | Three.js mapping |
| --- | --- |
| `positions`, `normals` (metres, Y-up) | `position`, `normal` attributes, unchanged |
| `uvs` (world-normalised, interchange) | `uv` |
| `world_uv` (metres) | `uv1`, sampled by the triplanar detail |
| vertex colours (linear RGBA) | `color` (3 floats terrain, 4 floats water for alpha) |
| clockwise top faces (Babylon LH) | index triples reversed `(i0, i2, i1)` for CCW front faces |
| material field | `MeshStandardMaterial` + `onBeforeCompile` detail term |
| water settings | `MeshStandardMaterial`, `transparent`, `FrontSide`, `depthWrite: false`, Fresnel + ripples |

The adapter also computes a bounding sphere for culling and sets a `customProgramCacheKey` so
quality/motion variants do not share a stale program. A test asserts that every triangle is
counter-clockwise from above after the winding swap (2048 of 2048 up-facing, 0 reversed) and that
the `uv1`/`color` buffers match the canonical data byte for byte.

## Performance

Materials cost one pass over the source grid, cached by the settings key (`ensureMaterials`), so
changing water or camera settings never recomputes them. Draw calls stay at one mesh per chunk plus
one per wet chunk; the water mesh is skipped entirely for dry chunks. Detail textures are generated
once per material instance, not per chunk. No material is duplicated per chunk.

Observed in this sandbox (Single-shot Node runs, seed 42, 129², 16 chunks):

| Operation | Result |
| --- | --- |
| Full Phase 4 test suite (materials, exports, adapter parity) | ~3.5 s |
| Material masks per chunk | 7,623 bytes (33 × 33 × 7) |
| Shared boundary vertices compared across chunk edges | 396 |
| Water vertices validated against the wet layer | 5,275 |
| Complete world ZIP (1.1.0, colours + world UVs + masks) | 4.18 MB (was 3.83 MB at 1.0.0) |
| Babylon scene: 16 chunks, mixed LOD, shadows | renders in the harness without errors |
| Headless render sweep (11 Babylon views + 7 Three.js views + 2D map) | 19 views, 0 page errors |
| Production build (`npm run build`) | 2.59 MB single HTML, 630 kB gzip; `three` is *not* in the bundle |

## Validation

`python3 -m terrain.test_materials` (16 tests) and `tests/materials.test.ts` (bundled with esbuild)
cover the acceptance list:

| Phase 4 requirement | Where it is checked |
| --- | --- |
| Transitions across plains / hills / mountains | `material_stats` bands + jump percentiles, both languages |
| Rock on steep slopes | `rock_on_steep` and slope-bucket means |
| Texture continuity across chunk boundaries | shared boundary vertices: identical world UVs and colours |
| Material consistency across LOD | same source sample → same mask/albedo at LOD 0/1/2 |
| Water over real lakebeds/riverbeds | water depth vs carved heights; water vertex legality |
| No water visible from beneath | `under-terrain` / `three-under` probes: water 0.000, land 1.000 |
| Babylon rendering | headless harness screenshots + 0 shader/page errors |
| Three.js rendering | `three.html` harness screenshots + geometry parity test |
| Chunk export | single-chunk round trip (indices, buffers, colours) |
| World export + reconstruction | 16-chunk and ZIP round trip, source fingerprint check |
| Previous phases intact | `terrain.test_terrain`, `terrain.test_world`, `tests/world.test.ts`, Playwright suite (3 files, all passing) |

The Playwright suite was split into one scenario per spec file (`chunk-import`, `world-export-import`,
`world-repartition`). The bundled headless Chromium runs `--single-process`, which quits the browser
as soon as the last page closes; that killed the shared browser between tests and produced a
five-minute "timeout while setting up page". The config now drops `--single-process`/`--no-zygote`
for the test runner, so each file gets a healthy browser: `3 passed (6.4m)`.

Render evidence is in `artifacts/phase4/`: `materials-overview`, `materials-cliff`,
`materials-vertex-only`, `water-lake`, `water-river`, `water-still`, `water-coverage`,
`under-terrain`, `chunk-seam`, `lod-consistency`, `material-map`, and the matching Three.js set
`three-overview`, `three-cliff`, `three-lake`, `three-river`, `three-under`, `three-seam`,
`three-lod-consistency`. `render-report.json` records the probe numbers and any page errors.

## Known Limitations

- Materials are a smooth field over source samples; there are no decals, rock strata or
  per-material normal maps. Detail comes from one shared tileable noise set, not from unique
  textures per material.
- Snow does not accumulate on real geometry (no volumetric or thickness simulation) and does not
  drift seasonally.
- Vertex colours are quantised to 1/255 in exports. Reconstructed views can differ from the live
  field by one step.
- Water motion is a normal perturbation, not a displaced surface, so it has no foam, spray or
  flow-mapped current direction; rivers share the lake ripple model with different colours.
- Reflections in Three.js rely on the scene environment map supplied by the host; without one, water
  is a dark, glossy surface with a sun highlight only.
- Material evaluation is CPU and synchronous. Very large worlds pay a one-off pass proportional to
  sample count when settings change (cached otherwise).
- The Three.js adapter is exercised headlessly with SwiftShader; no physical-GPU frame-rate
  benchmark of either adapter was performed.
- `MAX_MATERIALS` is 8: adding a ninth channel requires a format version bump and re-export.
