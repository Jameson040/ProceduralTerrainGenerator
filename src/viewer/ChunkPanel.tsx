import { useEffect, useState } from "react";
import type { ChunkLayout, ChunkViewOptions, WorldData, WorldViewStats } from "../world/types";
import type { SeamReport } from "../world/validate";
import { spacing } from "../world/world";
import { cn } from "../utils/cn";

interface Props {
  world: WorldData | null; layout: ChunkLayout; view: ChunkViewOptions; stats: WorldViewStats | null; report: SeamReport | null;
  onLayout: (layout: ChunkLayout) => void; onView: (view: ChunkViewOptions) => void; onFocus: () => void;
  onCheck: () => void; onExportChunk: () => void; onExportWorld: () => void; onImport: () => void; busy: boolean;
}

const smallButton = "rounded border border-stone-700 px-2 py-1.5 text-[11px] text-stone-300 hover:border-emerald-500/60 disabled:opacity-40 transition-colors";

export default function ChunkPanel(p: Props) {
  const { world, layout, view, stats } = p;
  const [draft, setDraft] = useState({ chunk_width: String(layout.chunk_width), chunk_depth: String(layout.chunk_depth) });
  useEffect(() => setDraft({ chunk_width: String(layout.chunk_width), chunk_depth: String(layout.chunk_depth) }), [layout]);
  const selected = world?.chunks.find(c => c.id === view.selected), sx = world ? spacing(world.terrain)[0] : 1, sz = world ? spacing(world.terrain)[1] : 1;
  const available = world?.available.has(view.selected), hidden = view.hidden.includes(view.selected);
  return <section className="border-b border-stone-800 pb-4 mb-4" aria-label="World chunks">
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-[10px] uppercase tracking-[0.18em] text-emerald-400">World chunks</h2>
      <span className="font-mono text-[10px] text-stone-400">{world ? `${world.columns} x ${world.rows}` : "..."}</span>
    </div>
    <div className="grid grid-cols-2 gap-2">
      {(["chunk_width", "chunk_depth"] as const).map((key, i) => <label key={key} className="text-[11px] text-stone-400">
        Chunk {i === 0 ? "width" : "depth"} (m)
        <input aria-label={i === 0 ? "Chunk width" : "Chunk depth"} type="number" min={1} step={16} value={draft[key]}
          disabled={!!world && world.available.size !== world.chunks.length}
          onChange={e => setDraft(v => ({ ...v, [key]: e.target.value }))}
          onBlur={() => { const value = Number(draft[key]); if (value > 0 && value !== layout[key]) p.onLayout({ ...layout, [key]: value }); }}
          className="w-full mt-1 rounded bg-stone-950 border border-stone-700 px-2 py-1.5 text-stone-200 outline-none focus:border-emerald-500" />
      </label>)}
    </div>
    {world && <>
      <p className="text-[10px] text-stone-500 mt-2 leading-relaxed">
        Source-aligned: {(world.chunk_cells[0] * sx).toFixed(1)} x {(world.chunk_cells[1] * sz).toFixed(1)} m.
        Last edge chunks may be smaller. Source processing runs once for the whole world.
      </p>
      <div className="max-h-44 overflow-auto mt-3 pr-0.5" aria-label="Chunk grid">
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${world.columns}, minmax(30px, 1fr))` }}>
          {world.chunks.map(c => {
            const l = stats?.lods[c.id], shown = l !== undefined, loaded = world.available.has(c.id);
            return <button key={c.id} title={`${c.id} | ${loaded ? shown ? `LOD ${l}` : "unloaded" : "not imported"}`}
              aria-label={`Select chunk ${c.coord[0]},${c.coord[1]}`} aria-pressed={view.selected === c.id}
              onClick={() => p.onView({ ...view, selected: c.id })}
              className={cn("h-9 rounded-sm border text-[10px] font-mono transition-colors", view.selected === c.id ? "border-amber-300 bg-amber-300/10 text-amber-100" : "border-stone-700 hover:border-stone-400",
                !loaded ? "opacity-30" : !shown ? "opacity-50 bg-stone-950" : l === 0 ? "bg-emerald-500/15 text-emerald-200" : l === 1 ? "bg-amber-500/10 text-amber-200" : "bg-violet-500/15 text-violet-200")}>
              {c.coord[0]},{c.coord[1]}<span className="block text-[8px] opacity-65 leading-none">{shown ? `L${l}` : loaded ? "hidden" : "missing"}</span>
            </button>;
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <label className="text-[10px] text-stone-400">Show
          <select aria-label="Visible chunks" value={view.scope} onChange={e => p.onView({ ...view, scope: e.target.value as ChunkViewOptions["scope"] })} className="w-full rounded mt-1 bg-stone-950 border border-stone-700 p-1.5 text-[11px] text-stone-200">
            <option value="world">Complete world</option><option value="neighbors">Selected + neighbors</option><option value="selected">Selected only</option>
          </select>
        </label>
        <label className="text-[10px] text-stone-400">Render LOD
          <select aria-label="Render LOD" value={view.lod} onChange={e => p.onView({ ...view, lod: e.target.value === "adaptive" ? "adaptive" : Number(e.target.value) as 0 | 1 | 2 })} className="w-full rounded mt-1 bg-stone-950 border border-stone-700 p-1.5 text-[11px] text-stone-200">
            <option value="adaptive">Adaptive (camera)</option><option value="0">High / L0 / 1x</option><option value="1">Medium / L1 / 2x</option><option value="2">Low / L2 / 4x</option>
          </select>
        </label>
      </div>
      <div className="flex gap-2 mt-2">
        <button className={cn(smallButton, view.grid && "!border-emerald-500/60 !text-emerald-300")} aria-pressed={view.grid} onClick={() => p.onView({ ...view, grid: !view.grid })}>Boundaries</button>
        <select aria-label="Chunk debug view" className="min-w-0 flex-1 rounded bg-stone-950 border border-stone-700 px-2 text-[11px] text-stone-300" value={view.debug} onChange={e => p.onView({ ...view, debug: e.target.value as ChunkViewOptions["debug"] })}>
          <option value="off">Natural / analysis</option><option value="lod">LOD colors</option><option value="resolution">Mesh resolution</option>
        </select>
      </div>
      {selected && <div className="my-3 text-[10px] leading-relaxed text-stone-400 font-mono">
        <div className="flex justify-between"><span>{selected.id}</span><span>{selected.rect[2] - selected.rect[0] + 1} x {selected.rect[3] - selected.rect[1] + 1} source vertices</span></div>
        <div>Origin X {(world.terrain.origin_x + selected.rect[0] * sx).toFixed(1)} / Z {(world.terrain.origin_z + selected.rect[1] * sz).toFixed(1)} m</div>
      </div>}
      <div className="grid grid-cols-2 gap-2">
        <button className={smallButton} disabled={!available} onClick={p.onFocus}>Frame selected</button>
        <button className={smallButton} disabled={!available} onClick={() => p.onView({ ...view, hidden: hidden ? view.hidden.filter(id => id !== view.selected) : [...view.hidden, view.selected] })}>{hidden ? "Load selected" : "Unload selected"}</button>
        <button className={smallButton} disabled={!available || p.busy} onClick={p.onExportChunk}>Export chunk JSON</button>
        <button className={smallButton} disabled={p.busy || world.available.size !== world.chunks.length} onClick={p.onExportWorld}>Export world ZIP</button>
        <button className={smallButton} onClick={p.onImport} disabled={p.busy}>Load ZIP / chunks</button>
        <button className={smallButton} onClick={p.onCheck} disabled={p.busy}>Inspect seams</button>
      </div>
      <p className="text-[10px] text-stone-500 mt-2">Each file includes source data, normals, UVs, separate water and all 3 LODs. No skirts. Import opens a fresh scene.</p>
      {stats && <div data-testid="world-stats" className="mt-3 border-t border-stone-800 pt-2 text-[10px] text-stone-400 font-mono">
        {stats.loaded} / {world.chunks.length} chunks on GPU · {(stats.triangles / 1000).toFixed(1)}k terrain triangles
        <div>{world.terrain.width} x {world.terrain.depth} source · {world.imported ? "exported data" : "generated world"}</div>
      </div>}
      {p.report && <div role="status" data-testid="seam-report" className={cn("mt-2 border-l-2 pl-2 text-[10px] leading-relaxed", p.report.pass ? "border-emerald-500 text-emerald-300" : "border-red-500 text-red-300")}>
        <strong>{p.report.pass ? "Shared boundaries verified" : "Boundary mismatch"}</strong>
        <div>{p.report.boundaries} edges · position error {p.report.maxPositionError} · normal error {p.report.maxNormalError}</div>
        <div>{p.report.waterVertices} shared water vertices · {p.report.riverCrossings} river / {p.report.lakeCrossings} lake crossings</div>
        {p.report.errors.slice(0, 2).map(e => <div key={e}>{e}</div>)}
      </div>}
    </>}
  </section>;
}