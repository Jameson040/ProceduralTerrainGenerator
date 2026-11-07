# Procedural Terrain Generator: Phase 4

The existing terrain application extended with a derived material system, world-space procedural
texturing, a depth-driven water look, richer versioned exports, and a second renderer adapter.
Phase 1 formations, Phase 2 erosion/hydrology/rivers/lakes and Phase 3 chunking, LOD, stitching
and imports are preserved.

Rivers are carved terrain, not painted water: every river channel is an incision of the source
heightfield with a real bed and sloping banks, and the water is separate geometry placed above it.
Materials are derived from that finished world (elevation, slope, orientation, flow, curvature,
river beds, wetness) and never modify it. One renderer-independent data set feeds Babylon.js and
Three.js, so the two adapters cannot drift apart.

## Run

```bash
npm install
npm run dev

python3 -m pip install numpy
python3 -m terrain.cli --seed 42 --resolution 129 --quality 1 \
  --width 1024 --depth 1024 --chunks --chunk-width 256 --chunk-depth 256 --out exports
```

The CLI writes `exports/world/world.json` and 16 individual JSONs in `exports/world/chunks/`.
Each contains numerical source data, global normals, three terrain LOD meshes, UVs, and
separate water geometry. Optional `--obj` retains the original terrain/water OBJ export.

## Using the Preview

1. Set world width/depth, origin and **Source resolution**, then generate the complete world.
2. Set chunk width/depth. This repartitions completed source data without rerunning erosion.
3. Select chunks in the grid or terrain viewport. Show the full world, neighbours, or selected only.
4. Choose camera-adaptive, High, Medium or Low render LOD. Source resolution is independent.
5. Toggle boundaries, LOD colors or mesh-resolution wireframe to inspect transitions.
6. Unload/load selected chunks independently. Only GPU meshes and chunk mesh caches are changed.
7. Export a standalone chunk JSON or a world ZIP containing a manifest and individual chunk files.
8. Load a ZIP or multiple chunk files. More files from the same world append neighbours. Import creates a fresh Babylon scene, with no generation or erosion rerun.
9. Use **Inspect seams** to check shared terrain and water positions/normals at balanced LODs.
10. Inspect the **River cross-sections** panel: perpendicular cuts through several rivers show the
    incised bed, the banks and the separate water surface, plus the spill/bed-slope audit.
11. Use the **Look** panel to change material quality (vertex colours only / triplanar detail /
    detail + macro), the snow line and rock-slope thresholds, water opacity, motion, lake/river
    colours and gloss. Changes are pure re-shading: nothing is regenerated.
12. Read the **material stats** readout to see the live distribution (fractions, plains/hills/
    mountains bands, rock-on-steep, grass-on-flat, transition percentiles).

The existing natural/elevation/slope/flow/erosion/drainage views, camera, water visibility,
cross-section and legacy terrain exports remain available.

## Why Boundaries Match

- The entire finite world is generated and processed once using global coordinates.
- Chunks own disjoint cell rectangles and copy shared edge samples from that source.
- Normals are computed globally, including the neighbours on both sides of future chunk edges.
- All LODs retain source-detail boundary rings, joined to coarser interiors with conforming transition triangles. **No skirts or hidden crack-covering geometry.**
- Adjacent LOD requests are balanced to at most 2:1. Distance hysteresis reduces repeated threshold switching.
- Wet terrain cells and every incised riverbed/bank cell retain source topology at every LOD.
  A coarse LOD cannot flatten a channel that full-detail water sits in.
- Water shoreline halos and normals are resolved globally, then split by cell ownership.

## Materials and Texturing

- The material field is computed **after** the world is complete, from elevation, height above the
  local water surface, slope, aspect, flow accumulation, curvature, the carved `river_bed` mask and
  a blurred waterline wetness field, plus two octaves of world-space fBm. Nothing is random and
  nothing is chunk-local.
- Seven channels ship by default: sand, gravel, grass, dry grass, soil, rock and snow. Each is a
  registry entry with an albedo, roughness and a `weight(ctx)` function; adding a biome material is
  a new entry, not a new pipeline. `MAX_MATERIALS` is 8 and the channel list travels in the export.
- Distribution follows the terrain: rock owns steep faces and crests, grass owns flat sheltered
  ground, gravel follows channels and outwash, sand hugs the shoreline, snow starts at the snow
  line and slides off steep faces. Transitions are blended weights, not bands; on the reference
  fixture the 95th percentile neighbour jump on dry ground is ~0.44 against a hard switch of 1.0.
- Texturing is triplanar in **world space**. Every vertex carries `world_uv` in metres
  (`origin + sample × spacing`), the same tileable noise bitmaps are shared by both renderers, and
  steep faces use their own projection axis, so patterns neither restart at chunk boundaries nor
  stretch on cliffs and are identical at every LOD.
- Quality levels: `0` vertex colours only, `1` triplanar detail, `2` detail + macro (default).

## Water Look

- Colour comes from the real carved depth, with separate shallow/deep pairs for lakes and rivers,
  so lake basins read deep and rivers read shallow and green.
- Opacity, gloss, motion and wave scale are settings. Reflections are Fresnel + sun specular (Babylon)
  or the scene environment map with the same Fresnel tint (Three.js). Motion is two crossed sine
  waves bending the normal - no extra pass, no displaced geometry.
- Water is still its own layer: it never modifies terrain, lakebeds and carved riverbeds stay
  visible when water is hidden, and the surface is never below the bed.
- **Containment**: water quads exist only over wet cells, the surface never dips below terrain, and
  both water materials cull their back faces. Looking at the world from underneath shows only land
  (measured `water = 0.000`, `land = 1.000` in both renderers).

## Why Rivers Have Riverbeds

Terrain is the foundational geometry and water never replaces it.

- Rivers are extracted from the strictly downhill D8 graph, then **incised into the source
  heightfield**. The carve lowers terrain only; it never raises a shelf or removes a face.
- Each channel cell gets an explicit cross-section: a wetted bed `depth` below a channel water
  surface, a bank rising at ~35°, and a merge back into the untouched terrain.
- The water surface is anchored to the lowest ground of the *lateral* cross-section minus
  freeboard, then forced to descend along every D8 edge. It is therefore a continuous downhill
  course enclosed by higher ground, not a flat ribbon at ground level.
- A containment pass lowers (never raises) any residual surface above neighbouring dry ground,
  so water cannot spill over unmodified landscape at confluences or cliffs.
- Width and depth vary with flow accumulation and with the `river width` / `river depth` settings.
- Water stays a separate surface (`water.surface`), assembled after the terrain carve; hiding
  water reveals the bed and banks.
- The carve happens once on global source data, so a channel crossing a chunk boundary continues
  exactly, and the incised `river_bed_mask` layer is exported with every chunk.

Debug a set of rivers with:

```bash
python3 -m terrain.cli --seed 42 --resolution 256 --river-sections --out exports
```

It prints ASCII perpendicular sections plus `riverbed.*` statistics (spill edges, bed-below-surface,
banked cross-sections, bed slope percentiles). The same audit runs in the browser panel and in the
test suites.

## Structure

```text
terrain/generator.py         Formation + erosion/hydrology/riverbed pipeline
terrain/rivers.py            D8 river course, cross-section incision, containment
terrain/debug.py             Lake/river cross-sections and riverbed audit
terrain/world.py             NumPy world views, shared normals, LOD, exports/imports
terrain/test_world.py        Python chunk topology, reconstruction and riverbed-LOD tests
src/terrain/                Renderer-independent TypeScript processing (mirrors terrain/)
src/terrain/rivers.ts        Same cross-section incision as terrain/rivers.py
src/terrain/riverAudit.ts    River cross-sections and riverbed audit for tests and UI
src/world/world.ts           Chunk views, indexed LOD, balancing, mesh cache
src/world/export.ts          Versioned chunk/world JSON and ZIP; reconstruction
src/world/validate.ts        Terrain and water seam inspection
src/terrain/materials.ts      Material registry, rules and blended albedo field
src/terrain/waterVisual.ts    Water appearance settings and depth-driven water colours
src/world/shading.ts          Vertex colours, material attributes, world UVs (shared by both renderers)
src/viewer/terrainMaterial.ts Babylon PBR + triplanar detail plugin
src/viewer/waterMaterial.ts   Babylon water shader (separate layer)
src/viewer/proceduralTextures.ts Tileable noise bitmaps, generated once on the CPU
src/render/threeAdapter.ts    Three.js adapter over the same world data
src/viewer/LookPanel.tsx      Quality / material / water controls
src/viewer/chunkAdapter.ts   Numerical mesh to Babylon adapter
src/viewer/ChunkPanel.tsx    Chunk selection, preview, loading and export controls
src/viewer/RiverSections.tsx Debug riverbed cross-sections in the settings panel
tests/world.test.ts          Geometry and fresh Babylon scene tests
tests/materials.test.ts      Materials, exports, LOD/seam parity and Three.js adapter tests
tests/browser/               Headless Babylon + Three.js render harnesses and screenshots
tests/*.browser.spec.ts      Real Chromium/WebGL import and interaction tests (one scenario per file)
terrain/materials.py         Python mirror of the material registry and statistics
terrain/test_materials.py    Python material, export and LOD/seam tests
artifacts/phase3/            Actual 16-chunk export, report and screenshots
artifacts/phase4/            Material/water screenshots, probe reports, 1.0.0 legacy fixtures
PHASE_3_REPORT.md            Phase 3 implementation report
PHASE_4_REPORT.md            Materials, rendering compatibility and export format 1.1.0
```

Generator version: `0.5.0`. Processing settings: schema 3. World/chunk format: `1.1.0`
(material masks, world UVs and vertex colours added; `1.0.0` files still load). Material format `1`.
Legacy terrain interchange format 1 still loads without regenerating its numerical data.

## Tests

```bash
python3 -m terrain.test_terrain
python3 -m terrain.test_world
python3 -m terrain.test_materials

npm test                              # Node: chunk/geometry suite + materials/export/Three.js suite
npm run shots                         # headless Babylon + Three.js screenshots -> artifacts/phase4
npm run test:browser                  # Playwright (needs a downloadable Chromium)
npm run typecheck && npm run build

npx playwright install --with-deps chromium
npx playwright test

npx tsc --noEmit
npm run build
```

Run `tests/world.test.ts` before the browser tests: it recreates the 16 independent files loaded
from disk in Chromium.

Debug side by side:

```bash
python3 -m terrain.cli --seed 42 --resolution 129 --materials-report --out exports
node tests/browser/shots.mjs three-lake three-overview
``` Tests cover exact shared samples/normals, all permitted LOD pairs, edge incidence,
triangle winding/coverage, underwater ground, carved riverbeds at every LOD, the riverbed/bank
cross-section contract, reconstruction, independent loading, and a fresh scene.

The Playwright suite needs a downloadable Chromium; if the environment cannot fetch it, run the
Python suites plus `tests/world.test.ts` (NullEngine) instead and regenerate the browser
screenshots where a browser is available.

## Limits

- Chunk dimensions snap to the source grid; the UI reports effective dimensions and partial outer chunks.
- The finite source stays resident. Preview caps are 1.1 million source samples and 4096 chunks.
- Water and chunk perimeters stay detailed, so wet worlds have smaller LOD savings. Incised
  riverbeds and banks are protected too, so a world with many rivers keeps more LOD detail.
- A river narrower than one source cell is snapped to a one-cell-wide footprint; increase
  `river width` or source resolution for a visibly wider channel.
- Very steep reaches keep their water but the bed can step by more than a walkable grade
  (a waterfall). Roughly 98% of channel steps are gentler than 45 degrees.
- LOD interiors switch with hysteresis, not temporal geomorphing. Whole-world erosion/drainage must not be independently rerun per chunk.
- Python and TypeScript erosion have different inherited update orders. Each backend is deterministic; exchange exported source datasets rather than mixing newly regenerated chunks between backends.
- Meshes use float32 global positions. Very large origins require a floating-origin consumer. Source generation and JSON serialization are still synchronous.
- Materials are a smooth blend over source samples: no decals, strata or per-material normal maps, and exported vertex colours are quantised to 1/255.
- Snow is a shading rule, not accumulated volume, and water motion is a normal perturbation (no foam, spray or flow direction).
- Three.js water reflections need a scene environment map; without one it is a dark glossy surface with a sun highlight.
- The Three.js adapter is validated headlessly (SwiftShader) and by geometry parity tests, not by a physical-GPU benchmark.

See [PHASE_4_REPORT.md](PHASE_4_REPORT.md) for the material model, texturing rules, water look,
export format 1.1.0, renderer compatibility and validation results, and
[PHASE_3_REPORT.md](PHASE_3_REPORT.md) for chunking algorithms, coordinate conventions, export structure,
performance observations, test evidence and full limitations.
