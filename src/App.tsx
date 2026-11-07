import { useCallback, useEffect, useRef, useState } from "react";
import TerrainViewer, { type ViewerOptions } from "./viewer/TerrainViewer";
import { generateTerrain } from "./terrain/generator";
import { defaultSettings, type TerrainData, type TerrainSettings } from "./terrain/types";
import { terrainToJSON, terrainFromJSON, heightsToRaw, downloadBlob } from "./terrain/io";
import CrossSection from "./viewer/CrossSection";
import { cn } from "./utils/cn";
import ChunkPanel from "./viewer/ChunkPanel";
import { balanceLods, createWorld } from "./world/world";
import { exportWorldZip, extractChunk, importWorldZip, loadChunkFiles, type ChunkFile } from "./world/export";
import { validateSeams, type SeamReport } from "./world/validate";
import type { ChunkLayout, ChunkViewOptions, Lod, WorldData, WorldViewStats } from "./world/types";

type NumKey = { [K in keyof TerrainSettings]: TerrainSettings[K] extends number ? K : never }[keyof TerrainSettings];

function Slider({ label, value, min, max, step, onChange, format }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="flex justify-between text-[11px] text-stone-400 mb-1">
        <span>{label}</span>
        <span className="tabular-nums text-stone-300">{format ? format(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 accent-emerald-500 cursor-pointer" />
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-stone-800 pt-3 mt-3 first:border-0 first:mt-0 first:pt-0">
      <h2 className="text-[10px] uppercase tracking-[0.18em] text-stone-500 mb-2.5">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)}
      className={cn("px-2.5 py-1.5 rounded text-xs border transition-colors",
        value ? "bg-emerald-600/20 border-emerald-500/60 text-emerald-200" : "bg-stone-800/60 border-stone-700 text-stone-400 hover:border-stone-500")}>
      {label}
    </button>
  );
}

export default function App() {
  const [settings, setSettings] = useState<TerrainSettings>(() => ({ ...defaultSettings(), resolution: 257 }));
  const [terrain, setTerrain] = useState<TerrainData | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewerOptions>({ colorMode: "natural", wireframe: false, showWater: true, shadows: true });
  const [panelOpen, setPanelOpen] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const worldFileRef = useRef<HTMLInputElement>(null);
  const [world, setWorld] = useState<WorldData | null>(null);
  const [layout, setLayout] = useState<ChunkLayout>({ chunk_width: 256, chunk_depth: 256 });
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const [chunkView, setChunkView] = useState<ChunkViewOptions>({ selected: "c_0_0", scope: "world", lod: "adaptive", grid: true, debug: "off", hidden: [] });
  const [worldStats, setWorldStats] = useState<WorldViewStats | null>(null);
  const [seamReport, setSeamReport] = useState<SeamReport | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [sceneKey, setSceneKey] = useState(0);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);

  const set = <K extends keyof TerrainSettings>(k: K, v: TerrainSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));
  const num = (k: NumKey) => (v: number) => set(k, v);

  const generate = useCallback((s: TerrainSettings) => {
    const sequence = ++generation.current;
    setBusy(true);
    // let the UI paint the busy state before the synchronous generation
    setTimeout(() => {
      if (sequence !== generation.current) return;
      try {
        const t = generateTerrain(s), w = createWorld(t, layoutRef.current);
        setTerrain(t); setWorld(w); setSeamReport(null); setNotice("");
        setChunkView(v => ({ ...v, hidden: [], selected: w.chunks[0].id }));
      } catch (e) { setNotice(e instanceof Error ? e.message : "World generation failed."); }
      finally { setBusy(false); }
    }, 20);
  }, []);

  useEffect(() => { generate(settings); /* initial */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const randomSeed = () => {
    const s = { ...settings, seed: Math.floor(Math.random() * 1_000_000) };
    setSettings(s); generate(s);
  };

  const onImport = async (file: File) => {
    try {
      const t = terrainFromJSON(await file.text()), w = createWorld(t, layoutRef.current);
      setTerrain(t); setSettings(t.settings); setWorld(w); setSceneKey(k => k + 1); setSeamReport(null);
      setChunkView(v => ({ ...v, hidden: [], selected: w.chunks[0].id }));
      setNotice("Terrain file loaded. Source data was not regenerated.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Invalid terrain file."); }
  };

  const withTask = async (task: () => void | Promise<void>) => {
    setBusy(true); await new Promise(resolve => setTimeout(resolve, 40));
    try { await task(); } catch (e) { setNotice(e instanceof Error ? e.message : "Operation failed."); }
    finally { setBusy(false); }
  };
  const importChunks = (files: File[]) => withTask(async () => {
    let w: WorldData;
    if (files.length === 1 && files[0].name.endsWith(".zip")) w = importWorldZip(new Uint8Array(await files[0].arrayBuffer()));
    else {
      let packets = await Promise.all(files.map(async f => JSON.parse(await f.text()) as ChunkFile));
      // Independently imported neighbours can be added to the current dataset.
      // Existing numerical source and meshes are reused; no generation is called.
      if (world?.imported && packets.every(p => p.world?.id === world.id)) {
        const replacements = new Set(packets.map(p => p.chunk.id));
        packets = [...world.chunks.filter(c => world.available.has(c.id) && !replacements.has(c.id)).map(c => extractChunk(world, c)), ...packets];
      }
      w = loadChunkFiles(packets);
    }
    ++generation.current;
    setWorld(w); setTerrain(w.terrain); setSettings(w.terrain.settings); setLayout(w.layout); setSeamReport(null);
    setChunkView(v => ({ ...v, scope: "world", selected: [...w.available][0], hidden: [] }));
    setSceneKey(k => k + 1); setFocusToken(0);
    setNotice(`${w.available.size} / ${w.chunks.length} individual chunk files loaded into a fresh Babylon scene. No generation or erosion rerun.`);
  });
  const changeLayout = (next: ChunkLayout) => {
    try {
      if (terrain) { const w = createWorld(terrain, next); w.imported = world?.imported ?? false; setWorld(w); setChunkView(v => ({ ...v, selected: w.chunks[0].id, hidden: [] })); }
      setLayout(next); setSeamReport(null);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Invalid chunk dimensions."); }
  };

  const dirty = terrain ? JSON.stringify(terrain.settings) !== JSON.stringify(settings) : false;
  const meta = terrain?.metadata;

  return (
    <div className="h-screen w-screen bg-stone-950 text-stone-200 flex overflow-hidden font-sans">
      {/* Viewport */}
      <div className="relative flex-1 min-w-0">
        <TerrainViewer key={sceneKey} world={world} options={view} chunks={chunkView} focusToken={focusToken}
          onStats={setWorldStats} onSelect={id => setChunkView(v => ({ ...v, selected: id }))} />

        {/* Top bar */}
        <div className="absolute top-0 left-0 right-0 p-3 flex flex-wrap gap-2 items-start justify-between pointer-events-none">
          <div className="pointer-events-auto bg-stone-950/70 backdrop-blur rounded-lg px-3 py-2 border border-stone-800">
            <div className="text-sm font-semibold tracking-tight">Procedural Terrain Generator <span className="text-stone-500 font-normal">Phase 3</span></div>
            <div className="text-[11px] text-stone-500">Drag to orbit · Scroll to zoom · Right-drag / Ctrl-drag to pan</div>
          </div>
          <div className="pointer-events-auto flex flex-wrap gap-1.5 bg-stone-950/70 backdrop-blur rounded-lg p-1.5 border border-stone-800">
            {(["natural", "elevation", "slope", "flow", "erosion", "drainage"] as const).map((m) => (
              <button key={m} onClick={() => setView((v) => ({ ...v, colorMode: m }))}
                title={m === "flow" ? "Flow accumulation" : m === "erosion" ? "Erosion / deposition intensity" : m === "drainage" ? "D8 drainage direction" : undefined}
                className={cn("px-2 py-1 rounded text-[11px] capitalize", view.colorMode === m ? "bg-stone-200 text-stone-900" : "text-stone-400 hover:text-stone-100")}>{m}</button>
            ))}
            <span className="w-px bg-stone-800 mx-0.5" />
            <Toggle label="Wireframe" value={view.wireframe} onChange={(v) => setView((o) => ({ ...o, wireframe: v }))} />
            <Toggle label="Water" value={view.showWater} onChange={(v) => setView((o) => ({ ...o, showWater: v }))} />
            <Toggle label="Shadows" value={view.shadows} onChange={(v) => setView((o) => ({ ...o, shadows: v }))} />
            <button onClick={() => setPanelOpen((p) => !p)} className="ml-1 px-2.5 py-1 rounded text-xs text-stone-400 hover:text-stone-100 border border-stone-700">
              {panelOpen ? "Hide panel" : "Settings"}
            </button>
          </div>
        </div>

        {/* Terrain and hydrology debug legends */}
        {meta && view.colorMode !== "natural" && view.colorMode !== "slope" && (
          <div className="absolute bottom-3 left-3 bg-stone-950/70 backdrop-blur rounded-lg px-3 py-2 border border-stone-800 text-[11px]">
            {view.colorMode === "elevation" && <>
              <div className="h-2 w-44 rounded" style={{ background: "linear-gradient(90deg,#1a409a,#338c4d,#8cb34d,#d9a64d,#994d33,#fff)" }} />
              <div className="flex justify-between text-stone-400 mt-1"><span>{meta.min_height.toFixed(0)} m</span><span>{meta.max_height.toFixed(0)} m</span></div>
            </>}
            {view.colorMode === "flow" && <>
              <div className="text-stone-300 mb-1">Flow accumulation (log)</div>
              <div className="h-2 w-44 rounded" style={{ background: "linear-gradient(90deg,#0a1733,#057f9f,#d9d138,#f2701a,#fff0e5)" }} />
              <div className="flex justify-between text-stone-400 mt-1"><span>headwater</span><span>trunk</span></div>
            </>}
            {view.colorMode === "erosion" && <>
              <div className="text-stone-300 mb-1">Erosion / deposition</div>
              <div className="h-2 w-44 rounded" style={{ background: "linear-gradient(90deg,#157fe8,#25282e,#f2a82e)" }} />
              <div className="flex justify-between text-stone-400 mt-1"><span>cut</span><span>deposit</span></div>
            </>}
            {view.colorMode === "drainage" && <>
              <div className="text-stone-300 mb-1">D8 drainage direction</div>
              <div className="h-2 w-44 rounded" style={{ background: "linear-gradient(90deg,#f25c5c,#e8d44d,#49d17a,#3fc6d9,#5f7bed,#d155da,#f25c5c)" }} />
              <div className="flex justify-between text-stone-400 mt-1"><span>direction hue</span><span>sink = red</span></div>
            </>}
          </div>
        )}

        {/* Metadata */}
        {meta && (
          <details className="absolute bottom-3 right-3 bg-stone-950/80 backdrop-blur rounded-lg px-3 py-2 border border-stone-800 text-[11px] text-stone-400 tabular-nums">
            <summary className="cursor-pointer text-stone-300">World diagnostics · {worldStats?.loaded ?? 0} chunks · {((worldStats?.triangles ?? 0) / 1000).toFixed(1)}k triangles</summary>
            <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 mt-2">
            <span>seed</span><span className="text-stone-200 text-right">{meta.seed}</span>
            <span>grid</span><span className="text-stone-200 text-right">{meta.grid[0]} × {meta.grid[1]}</span>
            <span>cell size</span><span className="text-stone-200 text-right">{meta.cell_size.toFixed(2)} m</span>
            <span>height range</span><span className="text-stone-200 text-right">{meta.min_height.toFixed(1)} – {meta.max_height.toFixed(1)} m</span>
            <span>water cells</span><span className="text-stone-200 text-right">{meta.water_cells}{terrain?.water ? ` @ ${terrain.water.level.toFixed(1)} m` : ""}</span>
            {typeof meta.lakebed_min === "number" && (
              <>
                <span>lakebed</span><span className="text-stone-200 text-right">{Number(meta.lakebed_min).toFixed(1)} – {Number(meta.lakebed_max).toFixed(1)} m</span>
                <span>max depth</span><span className="text-stone-200 text-right">{Number(meta.max_water_depth).toFixed(1)} m</span>
              </>
            )}
            <span>erosion</span><span className="text-stone-200 text-right">q{String(meta.erosion_quality)} · mean {Number(meta.erosion_mean_abs_m ?? 0).toFixed(2)} m</span>
            <span>rivers</span><span className="text-stone-200 text-right">{Number(meta.river_count ?? 0)} · {Number(meta.river_cells ?? 0)} cells</span>
            <span>lakes</span><span className="text-stone-200 text-right">{Number(meta.lake_count ?? 0)} · {Number(meta.lake_cells ?? 0)} cells</span>
            <span>watersheds</span><span className="text-stone-200 text-right">{Number(meta.watershed_count ?? 0)} · max flow {Number(meta.max_flow_accumulation ?? 0)}</span>
            <span>generated in</span><span className="text-stone-200 text-right">{meta.generation_time_ms} ms</span>
            <span>source</span><span className="text-stone-200 text-right">{meta.source} · gen {meta.generator_version}</span>
            </div>
          </details>
        )}

        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-stone-950/40 backdrop-blur-[2px]">
            <div className="flex items-center gap-3 bg-stone-900 border border-stone-700 rounded-lg px-4 py-3 text-sm">
              <span className="h-3 w-3 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" /> Processing world data...
            </div>
          </div>
        )}
      </div>

      {/* Settings panel */}
      <aside className={cn("shrink-0 bg-stone-900 border-l border-stone-800 overflow-y-auto transition-all", panelOpen ? "w-80" : "w-0 border-0")}>
        <div className="w-80 p-4 text-sm">
          <ChunkPanel world={world} layout={layout} view={chunkView} stats={worldStats} report={seamReport}
            onLayout={changeLayout} onView={setChunkView} onFocus={() => setFocusToken(n => n + 1)} busy={busy}
            onExportChunk={() => withTask(() => {
              if (!world) return;
              const c = world.chunks.find(c => c.id === chunkView.selected)!;
              downloadBlob(new Blob([JSON.stringify(extractChunk(world, c))], { type: "application/json" }), `${c.id}.json`);
              setNotice(`${c.id} exported with full-resolution source, 3 terrain LODs and separate water geometry.`);
            })}
            onExportWorld={() => withTask(() => {
              if (!world) return;
              const zip = exportWorldZip(world);
              downloadBlob(new Blob([new Uint8Array(zip).buffer], { type: "application/zip" }), `${world.id}.zip`);
              setNotice(`Exported ${world.chunks.length} independent chunk files and world.json. ${(zip.byteLength / 1048576).toFixed(1)} MB ZIP.`);
            })}
            onImport={() => worldFileRef.current?.click()}
            onCheck={() => withTask(() => {
              if (!world) return;
              const levels = balanceLods(world.chunks, Object.fromEntries(world.chunks.map(c => [c.id, worldStats?.lods[c.id] ?? 0])) as Record<string, Lod>);
              setSeamReport(validateSeams(world, levels));
            })} />
          <input data-testid="world-import" ref={worldFileRef} type="file" multiple accept=".zip,.json" className="hidden"
            onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) importChunks(files); e.target.value = ""; }} />
          {notice && <div role="status" data-testid="world-notice" className="mb-4 text-[11px] leading-relaxed border-l-2 border-emerald-500 pl-2 text-stone-300">{notice}</div>}
          <Section title="Seed">
            <div className="flex gap-2">
              <input type="number" value={settings.seed} onChange={(e) => set("seed", parseInt(e.target.value || "0", 10))}
                className="flex-1 bg-stone-950 border border-stone-700 rounded px-2 py-1.5 text-sm tabular-nums focus:border-emerald-500 outline-none" />
              <button onClick={randomSeed} className="px-3 py-1.5 rounded border border-stone-700 text-xs hover:border-stone-500">Random</button>
            </div>
            <button onClick={() => generate(settings)} disabled={busy}
              className={cn("w-full py-2 rounded font-medium text-sm transition-colors",
                dirty ? "bg-emerald-500 text-stone-950 hover:bg-emerald-400" : "bg-stone-700 text-stone-200 hover:bg-stone-600", busy && "opacity-50")}>
              {dirty ? "Generate world (changes pending)" : "Regenerate complete world"}
            </button>
          </Section>

          <Section title="World">
            <div className="grid grid-cols-2 gap-2">
              {(["world_width", "world_depth", "origin_x", "origin_z"] as const).map((key, i) => <label key={key} className="text-[11px] text-stone-400">
                {["World width (m)", "World depth (m)", "Origin X (m)", "Origin Z (m)"][i]}
                <input aria-label={["World width", "World depth", "World origin X", "World origin Z"][i]} type="number" step="any" value={settings[key]}
                  onChange={e => set(key, Number(e.target.value))} className="w-full mt-1 rounded bg-stone-950 border border-stone-700 px-2 py-1.5 text-stone-200 outline-none focus:border-emerald-500" />
              </label>)}
            </div>
            <label className="block text-[11px] text-stone-400">Source resolution (shorter axis)
              <select aria-label="Source resolution" value={settings.resolution} onChange={e => set("resolution", Number(e.target.value))} className="mt-1 w-full bg-stone-950 border border-stone-700 rounded p-1.5 text-stone-200">
                {[65, 129, 257, 513, ...( [65, 129, 257, 513].includes(settings.resolution) ? [] : [settings.resolution])].map(r => <option key={r} value={r}>{r} vertices / {r - 1} cells</option>)}
              </select>
            </label>
            <Slider label="Elevation range" value={settings.height_scale} min={40} max={400} step={10} onChange={num("height_scale")} format={(v) => `${v} m`} />
            <Slider label="Landscape feature size" value={1 / settings.base_frequency} min={150} max={1200} step={10}
              onChange={(v) => set("base_frequency", 1 / v)} format={(v) => `${v.toFixed(0)} m`} />
          </Section>

          <Section title="Landforms">
            <Slider label="Mountain coverage" value={settings.mountain_amount} min={0} max={1} step={0.01} onChange={num("mountain_amount")} />
            <Slider label="Mountain frequency" value={settings.mountain_frequency} min={0.5} max={1.8} step={0.05} onChange={num("mountain_frequency")} format={(v) => `${v.toFixed(2)}×`} />
            <Slider label="Mountain height" value={settings.mountain_height} min={0} max={1.6} step={0.05} onChange={num("mountain_height")} format={(v) => `${v.toFixed(2)}×`} />
            <Slider label="Mountain sharpness" value={settings.mountain_sharpness} min={0.8} max={2.5} step={0.05} onChange={num("mountain_sharpness")} />
            <Slider label="Hill intensity" value={settings.hill_amount} min={0} max={1} step={0.01} onChange={num("hill_amount")} />
            <Slider label="Valleys" value={settings.valley_depth} min={0} max={1} step={0.01} onChange={num("valley_depth")} />
            <Slider label="Cliffs" value={settings.cliff_amount} min={0} max={1} step={0.01} onChange={num("cliff_amount")} />
            <Slider label="Domain warp" value={settings.warp_strength} min={0} max={200} step={5} onChange={num("warp_strength")} format={(v) => `${v} m`} />
            <Slider label="Terrain roughness" value={settings.terrain_roughness} min={0} max={1.2} step={0.05} onChange={num("terrain_roughness")} />
            <Slider label="Terrain detail scale" value={settings.detail_scale} min={24} max={120} step={2} onChange={num("detail_scale")} format={(v) => `${v.toFixed(0)} m`} />
          </Section>

          <Section title="Erosion & hydrology">
            <div className="grid grid-cols-3 gap-1">
              {([0, 1, 2] as const).map((q) => (
                <button key={q} onClick={() => set("erosion_quality", q)}
                  className={cn("py-1 rounded border text-[11px]", settings.erosion_quality === q ? "bg-emerald-600/25 border-emerald-500/60 text-emerald-200" : "border-stone-700 text-stone-400 hover:border-stone-500")}>
                  {q === 0 ? "Off" : q === 1 ? "Fast" : "High"}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Toggle label="Hydraulic" value={settings.hydraulic_enabled} onChange={(v) => set("hydraulic_enabled", v)} />
              <Toggle label="Thermal" value={settings.thermal_enabled} onChange={(v) => set("thermal_enabled", v)} />
              <Toggle label="Rivers" value={settings.rivers_enabled} onChange={(v) => set("rivers_enabled", v)} />
            </div>
            <Slider label="Hydraulic strength" value={settings.hydraulic_strength} min={0} max={1.5} step={0.05} onChange={num("hydraulic_strength")} />
            <Slider label="Talus angle" value={settings.thermal_talus} min={12} max={60} step={1} onChange={num("thermal_talus")} format={(v) => `${v.toFixed(0)}°`} />
            <Slider label="River density" value={settings.river_density} min={0} max={1} step={0.05} onChange={num("river_density")} />
            <Slider label="River width" value={settings.river_width} min={3} max={24} step={1} onChange={num("river_width")} format={(v) => `${v.toFixed(0)} m`} />
            <Slider label="River depth" value={settings.river_depth} min={0.3} max={5} step={0.1} onChange={num("river_depth")} format={(v) => `${v.toFixed(1)} m`} />
            <p className="text-[11px] text-stone-500 leading-relaxed">
              Quality controls simulation cost, not mesh resolution. Rivers follow strictly downhill drainage and are carved into continuous terrain beneath a separate water surface.
            </p>
          </Section>

          <Section title="Water">
            <Toggle label={settings.water_enabled ? "Lakes enabled" : "Lakes disabled"} value={settings.water_enabled} onChange={(v) => set("water_enabled", v)} />
            <Toggle label="Highland basin lakes" value={settings.basin_lakes_enabled} onChange={(v) => set("basin_lakes_enabled", v)} />
            <Slider label="Minimum lake depth" value={settings.min_lake_depth} min={0.3} max={6} step={0.1} onChange={num("min_lake_depth")} format={(v) => `${v.toFixed(1)} m`} />
            <Slider label="Water level" value={settings.water_level} min={0.05} max={0.6} step={0.01} onChange={num("water_level")}
              format={(v) => `${(v * settings.height_scale).toFixed(0)} m`} />
            <Slider label="Shore softness" value={settings.shore_softness} min={0} max={1} step={0.05} onChange={num("shore_softness")} />
            <p className="text-[11px] text-stone-500 leading-relaxed">
              Lakes are bowls in the terrain filled by a separate water surface. The ground stays continuous
              underneath — hide Water in the top bar to walk the lakebed visually.
            </p>
          </Section>

          <Section title="Lakebed cross-section">
            {world && world.available.size !== world.chunks.length
              ? <p className="text-xs text-stone-500">Import the remaining chunks to inspect a world-wide cross-section.</p>
              : <CrossSection terrain={terrain} />}
          </Section>

          <Section title="Export / Import">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button disabled={!terrain || !!world && world.available.size !== world.chunks.length} onClick={() => terrain && downloadBlob(new Blob([terrainToJSON(terrain)], { type: "application/json" }), `terrain_${terrain.settings.seed}.json`)}
                className="py-1.5 rounded border border-stone-700 hover:border-stone-500 disabled:opacity-40">Terrain JSON</button>
              <button disabled={!terrain || !!world && world.available.size !== world.chunks.length} onClick={() => terrain && downloadBlob(heightsToRaw(terrain), `heights_${terrain.settings.seed}_${terrain.width}x${terrain.depth}.f32`)}
                className="py-1.5 rounded border border-stone-700 hover:border-stone-500 disabled:opacity-40">Heightmap .f32</button>
              <button disabled={!terrain} onClick={() => terrain && downloadBlob(new Blob([JSON.stringify({ settings: terrain.settings, metadata: terrain.metadata }, null, 2)], { type: "application/json" }), `settings_${terrain.settings.seed}.json`)}
                className="py-1.5 rounded border border-stone-700 hover:border-stone-500 disabled:opacity-40">Settings + meta</button>
              <button onClick={() => fileRef.current?.click()} className="py-1.5 rounded border border-stone-700 hover:border-stone-500">Load JSON…</button>
              <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; }} />
            </div>
            <p className="text-[11px] text-stone-500 leading-relaxed">
              JSON files are interchangeable with the Python core (<code className="text-stone-400">python -m terrain.cli --seed {settings.seed}</code>). Geometry is rebuilt from the heightfield by any renderer.
            </p>
          </Section>
        </div>
      </aside>
    </div>
  );
}
