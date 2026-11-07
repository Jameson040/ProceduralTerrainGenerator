import { useMemo } from "react";
import type { VisualSettings } from "../terrain/visual";
import { worldMaterialStats } from "../world/shading";
import type { WorldData } from "../world/types";
import { cn } from "../utils/cn";

const SWATCH: Record<string, string> = {
  sand: "bg-[#c8b68c]", gravel: "bg-[#8c8880]", grass: "bg-[#54782f]", dry_grass: "bg-[#8f8c4e]",
  soil: "bg-[#66513a]", rock: "bg-[#736e69]", snow: "bg-[#f2f3fa]",
};

function Row({ label, value, min, max, step, onChange, format }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="flex justify-between text-[11px] text-stone-400 mb-1">
        <span>{label}</span>
        <span className="tabular-nums text-stone-300">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full h-1.5 accent-emerald-500 cursor-pointer" />
    </label>
  );
}

/**
 * Material + water appearance controls. Nothing here regenerates the terrain:
 * weights are a derived field over the existing source grid, so dragging a
 * slider only re-samples colours (and, for rules, the material masks).
 */
export default function LookPanel({ visual, onChange, world }: {
  visual: VisualSettings; onChange: (v: VisualSettings) => void; world: WorldData | null;
}) {
  const setMaterial = (patch: Partial<VisualSettings["material"]>) =>
    onChange({ ...visual, material: { ...visual.material, ...patch } });
  const setWater = (patch: Partial<VisualSettings["water"]>) =>
    onChange({ ...visual, water: { ...visual.water, ...patch } });

  const stats = useMemo(() => {
    if (!world) return null;
    try { return worldMaterialStats(world, visual.material); } catch { return null; }
  }, [world, visual.material]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Texture quality">
        {([0, 1, 2] as const).map((q) => (
          <button key={q} onClick={() => setMaterial({ quality: q })}
            aria-pressed={visual.material.quality === q}
            className={cn("py-1 rounded border text-[11px]", visual.material.quality === q
              ? "bg-emerald-600/25 border-emerald-500/60 text-emerald-200"
              : "border-stone-700 text-stone-400 hover:border-stone-500")}>
            {q === 0 ? "Vertex" : q === 1 ? "Detail" : "Detail + macro"}
          </button>
        ))}
      </div>
      <Row label="Rock slope threshold" value={visual.material.rock_slope} min={0.1} max={0.6} step={0.01}
        onChange={(v) => setMaterial({ rock_slope: v })} format={(v) => `${(v * 100).toFixed(0)}%`} />
      <Row label="Snow line" value={visual.material.snow_line} min={0.5} max={1} step={0.01}
        onChange={(v) => setMaterial({ snow_line: v })} format={(v) => `${(v * 100).toFixed(0)}% elev`} />
      <Row label="Sand shore width" value={visual.material.sand_shore_m} min={0} max={14} step={0.5}
        onChange={(v) => setMaterial({ sand_shore_m: v })} format={(v) => `${v.toFixed(1)} m`} />
      <Row label="Dry soil bias" value={visual.material.soil_bias} min={0} max={1} step={0.01}
        onChange={(v) => setMaterial({ soil_bias: v })} format={(v) => `${(v * 100).toFixed(0)}%`} />
      <Row label="Variation" value={visual.material.variation} min={0} max={1} step={0.01}
        onChange={(v) => setMaterial({ variation: v })} format={(v) => `${(v * 100).toFixed(0)}%`} />
      <Row label="Texture scale" value={visual.material.texture_scale_m} min={2} max={40} step={1}
        onChange={(v) => setMaterial({ texture_scale_m: v })} format={(v) => `${v.toFixed(0)} m / tile`} />

      <div className="border-t border-stone-800 pt-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500 mb-2">Water</div>
        <Row label="Transparency" value={visual.water.opacity} min={0.25} max={1} step={0.01}
          onChange={(v) => setWater({ opacity: v })} format={(v) => `${(v * 100).toFixed(0)}% opaque`} />
        <Row label="Gloss / reflections" value={visual.water.gloss} min={0} max={1} step={0.01}
          onChange={(v) => setWater({ gloss: v })} format={(v) => `${(v * 100).toFixed(0)}%`} />
        <Row label="Surface motion" value={visual.water.motion} min={0} max={1} step={0.01}
          onChange={(v) => setWater({ motion: v })} format={(v) => (v === 0 ? "still" : `${(v * 100).toFixed(0)}%`)} />
        <Row label="Wave scale" value={visual.water.wave_scale_m} min={4} max={40} step={1}
          onChange={(v) => setWater({ wave_scale_m: v })} format={(v) => `${v.toFixed(0)} m`} />
        <Row label="Depth falloff" value={visual.water.depth_scale_m} min={0.5} max={6} step={0.1}
          onChange={(v) => setWater({ depth_scale_m: v })} format={(v) => `${v.toFixed(1)} m`} />
      </div>

      {stats && (
        <div data-testid="material-stats" className="border-t border-stone-800 pt-2 text-[10px] font-mono text-stone-400 leading-relaxed">
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {Object.entries(stats.fractions).map(([id, v]) => (
              <span key={id} className="inline-flex items-center gap-1">
                <span className={cn("inline-block h-2 w-2 rounded-sm", SWATCH[id] ?? "bg-stone-500")} />
                {id.replace("_", " ")} {(v * 100).toFixed(0)}%
              </span>
            ))}
          </div>
          <div className="mt-1">rock on steep {(stats.rock_on_steep * 100).toFixed(0)}% · max step {(stats.max_neighbour_jump * 100).toFixed(0)}%</div>
        </div>
      )}
    </div>
  );
}
