# Phase 3 Technical Report

## Scope

This extends the existing application, not its terrain-generation algorithms. Phase 1 sampling
and Phase 2 hydraulic/thermal erosion, drainage, channel carving and lakes still run in the
existing Python and TypeScript generators. Chunking starts only after the numerical world is complete.

New code lives in `terrain/world.py`, `src/world/`, and a thin Babylon adapter. The current camera,
lighting, visualization modes, cross-section and legacy exports remain available.

## Coordinates and Ownership

The source is one row-major heightfield with world origin and explicit X/Z sample spacing.
Rectangular dimensions are supported. Source resolution determines density along the shorter
axis. The longer axis gets a corresponding sample count and exact spacing so requested extents
are retained. Grid samples remain in global coordinates, including negative origins.

Chunk metre dimensions snap to integer source-cell counts. The last column/row can be partial.
Each descriptor records its ID, integer column/row, inclusive vertex rectangle and four neighbour
IDs. Chunks own disjoint cells. Only shared boundary vertices are duplicated in exports, not faces.

## Genuine LOD Stitching

LOD 0 uses every source cell; LOD 1 uses nominal interior stride 2; LOD 2 uses stride 4. No LOD
reruns erosion. Every mesh samples the same final heightfield, including riverbed incision.

Every LOD keeps a source-detail perimeter. It is actual terrain at its original elevations,
not a vertical skirt. Where a coarse cell meets this perimeter or a water-protected cell,
its polygon includes every finer edge vertex. A center fan triangulates this polygon.
Both sides therefore use identical edge segments, without T-junctions.

This pays a small O(perimeter) cost to make chunk files independently usable without many
neighbour-specific topology variants. A neighbour-balancing pass still limits adjacent interior
levels to a maximum 2:1 ratio. A 10% camera-distance hysteresis band reduces threshold thrashing.

Tests check every mesh, not just its appearance:

- Positive projected triangle areas and consistent winding.
- Exact projected source-cell coverage.
- Exactly two incident faces on every interior edge.
- Open edges only at the chunk perimeter, with one source-cell segment each.
- Unit upward normals and identical shared positions, normals and UVs.

There are no skirts, overlapping terrain shells, invisible terrain layers or crack-covering walls.

## Normal Continuity

Normals are computed once from the final world heightfield using metric central differences.
Derivatives include samples on both sides of future chunk edges. One-sided derivatives apply
only at the true outer world boundary.

All chunks and LODs copy this canonical field. Exported source includes those normals, so an
independently loaded chunk shades correctly without its neighbours. Transition centers sample
and normalize the same field. Consumers should retain exported normals, not independently
recalculate boundary normals from local triangles.

World-normalized UVs and a world-wide color field also avoid local texture/color resets.
Different LOD colors are an intentional debug overlay, not a lighting seam.

## Water Continuity

Drainage and lake surfaces come from the completed world. Chunk edges never influence river
routing or basin detection. The water shoreline extension and normals are resolved globally.
Each active water quad is emitted exactly once across the chunk set.

Water stays at source detail. All terrain cells touching it are protected from simplification.
Every cell the river carve actually incised is protected as well (`river_bed_mask`), so coarse
LOD cannot flatten a bed or its banks either. Transition fans join those cells to coarser dry
terrain, retaining real riverbeds under the water in numerical data, rendered meshes and exports.
Terrain and water remain independently visible and independently exportable.

## Riverbed Correction (generator 0.5.0)

The earlier river pass incised terrain, but the channel was not the thing carrying the water.
Measured on seed 42 at 129 x 129, **42% of river water edges stood above the neighbouring dry
ground** and the water surface was anchored at `pre-carve ground - 0.05 m`, so the river read as a
flat blue ribbon over an essentially unmodified hillside. The root causes were all inside the
incision step, not in the drainage graph:

1. **Water level was not contained.** The surface was the original ground elevation, so no bank
   could ever be above the waterline. Water was drawn wherever a parabola had nudged the ground.
2. **No bank ring.** The parabolic incision reached zero at its outer radius, so terrain stepped
   straight back to the untouched surface: no shoreline slope existed.
3. **Bed depth existed only at the vertex centre.** Off-centre channel cells were 0.4-0.9 m deep
   over an 8 m cell, and overlapping footprints produced a bumpy, partly dry floor.
4. **Width control was inert below ~18 m.** `max(1.15 * cell, width / 2)` clamped every river to
   roughly one cell, so `river width` barely changed the geometry.
5. **The wet mask came from a distance test**, not from the carved geometry, so wet cells and the
   real trench could disagree.

The correction replaces only that step (`terrain/rivers.py`, `src/terrain/rivers.ts`):

- Each channel cell gets a cross-section: wetted bed `depth` below the channel water surface
  (0.58 of centre depth at the waterline, full depth at the centre), a bank rising at
  `BANK_SLOPE = 0.70`, and a smoothstep merge to the untouched ground over the outer 38% of the
  footprint, so banks always close continuously.
- The surface is anchored to the lowest ground of the **lateral** cross-section minus freeboard,
  then forced to descend at least 2 mm per D8 edge. Lateral anchoring keeps the notch shallow
  while guaranteeing higher ground beside the water; the descent keeps a river a continuous
  downhill course instead of disconnected puddles.
- Two constrained smoothing passes remove D8 stair steps; they may only lower a surface.
- The centre line is always wet with its bed strictly below the surface.
- A containment pass lowers (never raises) any surface still above neighbouring dry ground at
  confluences and cliffs, with the bed following it down. Cells that cannot keep 2 cm of depth
  stop being water there.
- Wet cells are derived from the carved bed (`bed < surface`), so the shoreline follows geometry.
- The carve lowers terrain only, is skipped inside lakes, and runs once on global source data,
  so lakes, erosion layers, chunk stitching and exports keep their previous behaviour.

Measured before -> after at 129 x 129 and 257 x 257, seeds 42 and 99: spill edges
496/1266/709/1405 -> **0**, water surface 0.4-1.2 m below the original ground -> 1.1-2.1 m (a real
notch), channel-graph continuity 100% -> 98.6-100%, channel bed slope median 0.11-1.14 ->
0.08-0.13, carved bed cells 1524/3312 -> 1184/3736. Lakes are bit-identical (mask and bed).

Validation is executable, not illustrative:

- `python -m terrain.cli --river-sections` prints ASCII perpendicular sections through several
  rivers plus `riverbed.*` statistics.
- `terrain/debug.py: river_sections / riverbed_report` and `src/terrain/riverAudit.ts` implement
  the same audit for tests and the **River cross-sections** panel in the app.
- Tests assert: zero spill edges; bed below every water surface; terrain present under all water;
  banked/enclosed cross-sections; bed slope percentiles; the carve is present in source heights
  (`h_carved < h_no_rivers`), rivers never raise terrain, lake masks/beds and erosion deltas are
  unchanged; chunk/`world.json` exports carry `river_bed_mask` and round-trip; every LOD keeps the
  exact carved height at every incised cell.

Screenshots under `artifacts/phase3/` (generated by the Playwright suite) predate this correction (the correction sandbox could not
download Chromium); rerun `npx playwright test` where a browser is available to refresh
`river-cross-sections.png` and `dry-riverbed.png`.

## Export Contract

The world ZIP/folder contains `world.json` plus `chunks/c_0_0.json` through `chunks/c_3_3.json`
for the reference 4 x 4 layout. It does not contain an enormous combined mesh.

The `terrain-world` manifest, schema `1.0.0`, records dimensions, origin, spacing, chunk layout,
relationships, seed/settings, processing metadata, coordinate conventions and relative filenames.
Each standalone `terrain-chunk` file includes:

- World identity, seed, configuration, chunk coordinates and neighbours.
- Full-resolution source heights and canonical normals.
- Water masks, surfaces, depths, lake/river classification and shoreline-halo normals.
- Available numerical analysis layers such as accumulation, direction and erosion.
- Indexed terrain meshes for LOD 0/1/2: positions, normals, UVs, indices and global grid samples.
- Separate full-detail water mesh.
- Source shape, interior/boundary stride and water-refinement metadata.

Positions are global `(X,Y,Z)` metres, Y-up. Indices use clockwise top-face winding in the
existing left-handed Babylon scene. A right-handed, counter-clockwise consumer must reverse
winding or apply a corresponding coordinate transform. UVs are world-normalized.

Float32 values are serialized without millimetre rounding and round-trip to identical float32
buffers. Normal zero components are canonical positive zero because JSON drops negative zero.
The world ID contains an FNV-1a source fingerprint for identity/error detection, not cryptographic
authentication. The complete-world loader verifies it.

Import reconstructs source arrays from chunk rectangles, rejecting conflicting shared samples,
invalid sizes/indices, mixed world headers, duplicates and incomplete world ZIPs. It does not
invoke generation or erosion. Individual files can be appended; complete-world export is disabled
until every source chunk is present. Python folders and browser archives share the schema, and
both cross-language loading directions were exercised. Legacy exports still load as source data.

## Preview and Caching

The existing interface now offers grid/terrain selection, neighbouring-chunk inspection,
camera or manual LOD, boundaries, mesh-resolution wireframe, LOD colors, and chunk/world IO.
Import remounts the viewport to create a new Babylon engine and scene.

Runtime chunk descriptors reference the shared source instead of duplicating it. Meshes are
cached per world/chunk/level. Only a changed terrain LOD is uploaded; water meshes remain loaded
across LOD changes. Unloading disposes terrain, water and debug GPU resources and evicts that
chunk's mesh cache. Reloading uses source data, never the formation/erosion pipeline.
An external engine can upload a standalone file's buffers without building a combined world.

## Verified 4 x 4 Result

Retained fixture: seed 42, 1024 x 1024 metres, 129 x 129 source vertices, Fast erosion,
256 x 256 metre chunks. Files and screenshots are in `artifacts/phase3/`.

| Check | Result |
| --- | --- |
| Individual chunk files written | 16 |
| Shared internal boundaries | 24 |
| Maximum position / normal error | 0 / 0 |
| River / lake boundary crossings | 16 / 10 |
| Reconstructed heights, normals and water | Exact float32 equality |
| Reconstructed geometry | Exact at each LOD |
| Adjacent LOD combinations | All allowed pairs tested |
| Interior open edges, T-junctions, degenerate faces | None |
| Underwater samples retained at every LOD | All |
| Incised riverbed/bank samples retained at every LOD | All (16 crossings) |
| River water edges above neighbouring ground | 0 of 496-1405 (was 42%) |
| Banked, enclosed river cross-sections | 5 / 5 |
| Water faces lost or duplicated | None |
| Deterministic repeats | Passed within each existing backend |
| Fresh Babylon NullEngine using exports only | Passed |
| Fresh Chromium/WebGL scene loading 16 files from disk | Passed |
| Near high, intermediate medium, far low simultaneously | Passed |
| Standalone load, append neighbour, unload/reload, ZIP restore | Passed |
| Skirts | None |

Screenshots include the generated world, reloaded mixed LOD, LOD colors, stitched wireframe,
exposed underwater ground, and a boundary close-up. Geometry tests check every shared boundary;
screenshots alone are not treated as proof of stitching.

Final verification passed the existing terrain/hydrology regression suite, six Python world
tests, the Node geometry/reconstruction test, TypeScript typechecking, and `npm run build`. The
browser tests also verify that repartitioning and render LOD changes retain the same
processed-source fingerprint.

`artifacts/phase3/` was regenerated with generator `0.5.0` from the Node geometry test, and
`artifacts/phase3-python/` from `terrain.cli --chunks` at the same settings; both now carry
`river_bed_mask` and the carve metadata in every chunk. `out/` is deliberately untouched: it is
the Phase 1 legacy interchange sample (`0.1.1`, settings schema 1) used to prove old exports still
load, and it is not produced by the current pipeline.

## Performance Observations

One sandbox Node benchmark, seed 42, Fast processing, 16 chunks:

| Source | Generation | World setup | L0/L1/L2 build | L0/L1/L2 triangles | Mesh cache | ZIP export |
| --- | --- | --- | --- | --- | --- | --- |
| 129 x 129 | 313 ms | 31 ms | 41/17/12 ms | 32768/21074/19442 | 2.66 MiB | 360 ms; 3.83 MiB |
| 257 x 257 | 649 ms | 48 ms | 71/42/18 ms | 131072/66978/53750 | 8.93 MiB | 1026 ms; 12.61 MiB |

The reference mixed plan used 20,420 terrain triangles. Measurements are observations, not
device guarantees. Browser checks used software WebGL; a physical game-GPU frame-rate benchmark
was not performed. Erosion/hydrology costs are paid only for source generation, not LOD changes.

## Known Limitations

- Finite source data is resident. Preview limits are 1.1 million source samples and 4096 chunks; no streaming or out-of-core erosion is implemented.
- Chunk metre sizes snap to source cells, within half a cell of the request. Actual sizes and partial edges are exposed.
- LOD interiors switch discretely with hysteresis, not temporal geomorphing. Interior detail can pop; pinned edges and outer silhouettes do not.
- Full-detail shorelines/perimeters reduce savings in water-heavy or tiny chunks. Water LOD is intentionally omitted to preserve small rivers, and incised riverbeds/banks are pinned at source detail too.
- A river narrower than a source cell is snapped to a one-cell footprint. Increase `river width` or source resolution for a visibly wider channel.
- Steep D8 reaches keep their water but their bed can exceed a walkable grade: about 98-99% of channel steps are gentler than 45 degrees, and the rest are waterfalls rather than missing geometry.
- Nonlocal erosion/drainage cannot reproduce an extracted chunk by processing it alone. Extract from the common completed world.
- The inherited Python batched erosion and TypeScript sequential erosion are individually deterministic but not bit-identical. Exchange exported datasets; do not mix independently regenerated chunks between backends.
- Existing physical erosion uses nominal near-square spacing. Exact per-axis geometry/normals are supported; a fully anisotropic physical solver was not introduced.
- Float32 global geometry eventually loses precision at extremely large absolute origins. Use modest origins or a consumer floating-origin adapter.
- Source generation and JSON serialization remain synchronous. Large exports can pause after the busy indicator paints; worker/binary streaming optimizations remain future work.

No new biomes, snow/sand systems, editing, volumetric terrain or infinite streaming were added.