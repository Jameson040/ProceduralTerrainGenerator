# Procedural Terrain Generator: Phase 3

The existing terrain application extended with finite worlds, independently loadable chunks,
conforming LOD, and versioned exports. Phase 1 formations and Phase 2 erosion, hydrology,
rivers, lakes and continuous underwater terrain are preserved.

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

The existing natural/elevation/slope/flow/erosion/drainage views, camera, water visibility,
cross-section and legacy terrain exports remain available.

## Why Boundaries Match

- The entire finite world is generated and processed once using global coordinates.
- Chunks own disjoint cell rectangles and copy shared edge samples from that source.
- Normals are computed globally, including the neighbours on both sides of future chunk edges.
- All LODs retain source-detail boundary rings, joined to coarser interiors with conforming transition triangles. **No skirts or hidden crack-covering geometry.**
- Adjacent LOD requests are balanced to at most 2:1. Distance hysteresis reduces repeated threshold switching.
- Wet terrain cells retain source topology at every LOD. Riverbeds cannot disappear below full-detail water.
- Water shoreline halos and normals are resolved globally, then split by cell ownership.

## Structure

```text
terrain/generator.py         Existing formation + erosion/hydrology pipeline
terrain/world.py             NumPy world views, shared normals, LOD, exports/imports
terrain/test_world.py        Python chunk topology and reconstruction tests
src/terrain/                Existing renderer-independent TypeScript processing
src/world/world.ts           Chunk views, indexed LOD, balancing, mesh cache
src/world/export.ts          Versioned chunk/world JSON and ZIP; reconstruction
src/world/validate.ts        Terrain and water seam inspection
src/viewer/chunkAdapter.ts   Numerical mesh to Babylon adapter
src/viewer/ChunkPanel.tsx    Chunk selection, preview, loading and export controls
tests/world.test.ts          Geometry and fresh Babylon scene tests
tests/world.browser.spec.ts  Real Chromium/WebGL import and interaction tests
artifacts/phase3/            Actual 16-chunk export, report and screenshots
PHASE_3_REPORT.md            Technical implementation report
```

Generator version: `0.4.0`. Processing settings: schema 3. World/chunk format: `1.0.0`.
Legacy terrain interchange format 1 still loads without regenerating its numerical data.

## Tests

```bash
python3 -m terrain.test_terrain
python3 -m terrain.test_world

mkdir -p .tmp
npx esbuild tests/world.test.ts --bundle --platform=node --format=esm --outfile=.tmp/world.test.mjs
node .tmp/world.test.mjs

npx playwright install --with-deps chromium
npx playwright test

npx tsc --noEmit
npm run build
```

Run the Node test before the browser tests: it creates the 16 independent files loaded from disk
in Chromium. Tests cover exact shared samples/normals, all permitted LOD pairs, edge incidence,
triangle winding/coverage, underwater ground, reconstruction, independent loading, and a fresh scene.

## Limits

- Chunk dimensions snap to the source grid; the UI reports effective dimensions and partial outer chunks.
- The finite source stays resident. Preview caps are 1.1 million source samples and 4096 chunks.
- Water and chunk perimeters stay detailed, so wet worlds have smaller LOD savings.
- LOD interiors switch with hysteresis, not temporal geomorphing. Whole-world erosion/drainage must not be independently rerun per chunk.
- Python and TypeScript erosion have different inherited update orders. Each backend is deterministic; exchange exported source datasets rather than mixing newly regenerated chunks between backends.
- Meshes use float32 global positions. Very large origins require a floating-origin consumer. Source generation and JSON serialization are still synchronous.

See [PHASE_3_REPORT.md](PHASE_3_REPORT.md) for algorithms, coordinate conventions, export structure,
performance observations, test evidence and full limitations.