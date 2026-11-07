import { useEffect, useMemo, useRef, useState } from "react";
import type { TerrainData } from "../terrain/types";
import { cn } from "../utils/cn";

/** Row crossing the most water; middle row when dry. Mirrors terrain/debug.py. */
export function pickTransectRow(t: TerrainData): number {
  if (!t.water) return Math.floor(t.depth / 2);
  let best = Math.floor(t.depth / 2), bestCount = -1;
  for (let j = 0; j < t.depth; j++) {
    let c = 0;
    for (let i = 0; i < t.width; i++) c += t.water.mask[j * t.width + i];
    if (c > bestCount) { bestCount = c; best = j; }
  }
  return bestCount > 0 ? best : Math.floor(t.depth / 2);
}

interface Stats {
  row: number;
  min: number; max: number;
  surfaceMin: number; surfaceMax: number;
  hasWater: boolean;
  waterCells: number; lakeCells: number; riverCells: number; runs: number;
  bedMin: number; maxDepth: number; relief: number;
  maxStep: number; maxShoreStep: number; shoreCrossings: number[];
  continuous: boolean;
}

function computeStats(t: TerrainData, row: number): Stats {
  const { width: w, heights, water } = t;
  let min = Infinity, max = -Infinity, maxStep = 0;
  for (let i = 0; i < w; i++) {
    const v = heights[row * w + i];
    min = Math.min(min, v); max = Math.max(max, v);
    if (i > 0) maxStep = Math.max(maxStep, Math.abs(v - heights[row * w + i - 1]));
  }
  let waterCells = 0, lakeCells = 0, riverCells = 0, bedMin = Infinity, maxDepth = 0;
  let surfaceMin = Infinity, surfaceMax = -Infinity;
  const crossings: number[] = [];
  if (water) {
    for (let i = 0; i < w; i++) {
      const idx = row * w + i;
      if (!water.mask[idx]) continue;
      waterCells++;
      if (water.lake_mask[idx]) lakeCells++;
      if (water.river_mask[idx]) riverCells++;
      const surf = water.surface[idx];
      surfaceMin = Math.min(surfaceMin, surf); surfaceMax = Math.max(surfaceMax, surf);
      bedMin = Math.min(bedMin, heights[idx]);
      maxDepth = Math.max(maxDepth, water.depth[idx]);
    }
    for (let i = 1; i < w; i++) {
      if (!!water.mask[row * w + i] !== !!water.mask[row * w + i - 1]) crossings.push(i - 0.5);
    }
  }
  let maxShoreStep = 0;
  if (water) for (let i = 0; i < w; i++) {
    if (!water.mask[row * w + i]) continue;
    for (const nb of [i - 1, i + 1]) if (nb >= 0 && nb < w && !water.mask[row * w + nb]) {
      maxShoreStep = Math.max(maxShoreStep, Math.abs(heights[row * w + nb] - heights[row * w + i]));
    }
  }
  return {
    row, min, max,
    surfaceMin: waterCells ? surfaceMin : NaN, surfaceMax: waterCells ? surfaceMax : NaN,
    hasWater: waterCells > 0, waterCells, lakeCells, riverCells,
    runs: crossings.length / 2,
    bedMin: waterCells ? bedMin : NaN,
    maxDepth, relief: waterCells ? surfaceMax - bedMin : 0,
    maxStep, maxShoreStep, shoreCrossings: crossings,
    continuous: Number.isFinite(min) && maxStep <= t.settings.height_scale * 0.25,
  };
}

export default function CrossSection({ terrain }: { terrain: TerrainData | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [auto, setAuto] = useState(true);
  const [rowSel, setRowSel] = useState(0);
  const autoRow = useMemo(() => (terrain ? pickTransectRow(terrain) : 0), [terrain]);
  const row = auto ? autoRow : Math.max(0, Math.min((terrain?.depth ?? 1) - 1, rowSel));
  const stats: Stats | null = useMemo(() => (terrain ? computeStats(terrain, row) : null), [terrain, row]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !terrain || !stats) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 560, H = 220;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const { width: w, heights, water } = terrain;
    const padL = 34, padR = 8, padT = 14, padB = 18;
    const iw = W - padL - padR, ih = H - padT - padB;

    let lo = stats.min, hi = stats.max;
    if (stats.hasWater) { lo = Math.min(lo, stats.surfaceMin); hi = Math.max(hi, stats.surfaceMax); }
    const pad = Math.max(2, (hi - lo) * 0.12);
    lo -= pad; hi += pad;
    const X = (i: number) => padL + (i / (w - 1)) * iw;
    const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * ih;

    ctx.fillStyle = "#0c0a09"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(255,255,255,0.45)"; ctx.font = "9px ui-monospace, monospace";
    for (let g = 0; g <= 4; g++) {
      const v = lo + ((hi - lo) * g) / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(`${v.toFixed(0)}m`, 2, y + 3);
    }

    const rowH = (i: number) => heights[stats.row * w + i];
    const under = (i: number) => !!water && !!water.mask[stats.row * w + i];
    const surfaceAt = (i: number) => water ? water.surface[stats.row * w + i] : 0;

    ctx.beginPath(); ctx.moveTo(X(0), Y(rowH(0)));
    for (let i = 1; i < w; i++) ctx.lineTo(X(i), Y(rowH(i)));
    ctx.lineTo(X(w - 1), padT + ih); ctx.lineTo(X(0), padT + ih); ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, "#78716c"); grad.addColorStop(0.55, "#57534e"); grad.addColorStop(1, "#292524");
    ctx.fillStyle = grad; ctx.fill();

    // Water is drawn from the per-cell surface to the continuous terrain bed.
    // This works for flat lakes and descending rivers alike.
    let i = 0;
    while (i < w) {
      if (!under(i)) { i++; continue; }
      let j = i;
      while (j + 1 < w && under(j + 1)) j++;
      ctx.beginPath();
      ctx.moveTo(X(i), Y(surfaceAt(i)));
      for (let k = i + 1; k <= j; k++) ctx.lineTo(X(k), Y(surfaceAt(k)));
      for (let k = j; k >= i; k--) ctx.lineTo(X(k), Y(rowH(k)));
      ctx.closePath();
      ctx.fillStyle = "rgba(56,189,248,0.48)"; ctx.fill();
      ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(X(i), Y(surfaceAt(i)));
      for (let k = i + 1; k <= j; k++) ctx.lineTo(X(k), Y(surfaceAt(k)));
      ctx.stroke();
      i = j + 1;
    }

    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? "#e7e5e4" : "#fbbf24";
      ctx.lineWidth = pass === 0 ? 1.4 : 2.2;
      ctx.beginPath(); let pen = false;
      for (let k = 0; k < w; k++) {
        const want = pass === 0 ? !under(k) : under(k);
        const x = X(k), y = Y(rowH(k));
        if (!want) { pen = false; continue; }
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (const c of stats.shoreCrossings) {
      const i0 = Math.max(0, Math.min(w - 1, Math.floor(c))), x = padL + (c / (w - 1)) * iw, y = Y(rowH(i0));
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#0c0a09"; ctx.fill(); ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText("0", padL, H - 4);
    ctx.fillText(`${((w - 1) * (terrain.spacing_x ?? terrain.cell_size)).toFixed(0)}m`, W - padR - 34, H - 4);
    ctx.fillText(`row ${stats.row} · z=${(terrain.origin_z + stats.row * (terrain.spacing_z ?? terrain.cell_size)).toFixed(0)}m`, padL + iw / 2 - 70, H - 4);
  }, [terrain, stats]);

  if (!terrain || !stats) return <p className="text-[11px] text-stone-500">Generate a terrain to inspect its cross-section.</p>;
  return (
    <div>
      <canvas ref={canvasRef} style={{ width: "100%", aspectRatio: "560 / 220" }} className="rounded border border-stone-800" />
      <div className="flex items-center gap-2 mt-2 text-[11px] text-stone-400">
        <button onClick={() => setAuto(true)} className={cn("px-2 py-0.5 rounded border", auto ? "border-emerald-500/60 text-emerald-200 bg-emerald-600/20" : "border-stone-700 hover:border-stone-500")}>Auto (water)</button>
        <input type="range" min={0} max={terrain.depth - 1} step={1} value={row}
          onChange={(e) => { setAuto(false); setRowSel(parseInt(e.target.value, 10)); }}
          className="flex-1 h-1 accent-emerald-500 cursor-pointer" />
        <span className="tabular-nums text-stone-300">row {row}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] tabular-nums">
        <span className="text-stone-500">shore <span className="text-stone-200">—</span></span>
        <span className="text-amber-300">━ bed {stats.hasWater ? `${stats.bedMin.toFixed(1)} m` : "—"}</span>
        <span className="text-sky-300">━ water surface {stats.hasWater ? `${stats.surfaceMin.toFixed(1)}–${stats.surfaceMax.toFixed(1)} m` : "off"}</span>
      </div>
      <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 mt-2 text-[11px] text-stone-400 tabular-nums">
        <span>water runs</span><span className="text-stone-200 text-right">{stats.hasWater ? `${stats.runs} · ${stats.waterCells} cells` : "dry transect"}</span>
        <span>lakes / rivers</span><span className="text-stone-200 text-right">{stats.lakeCells} / {stats.riverCells} cells</span>
        <span>max depth</span><span className="text-stone-200 text-right">{stats.hasWater ? `${stats.maxDepth.toFixed(1)} m` : "—"}</span>
        <span>max step / shore</span><span className="text-stone-200 text-right">{stats.maxStep.toFixed(1)} / {stats.maxShoreStep.toFixed(1)} m</span>
        <span>terrain faces</span><span className="text-stone-200 text-right">{terrain.width}×{terrain.depth} full grid</span>
      </div>
      <div className={cn("mt-2 text-[11px] rounded px-2 py-1.5 border",
        stats.continuous ? "border-emerald-500/40 bg-emerald-600/10 text-emerald-200" : "border-red-500/40 bg-red-600/10 text-red-200")}>
        {stats.continuous
          ? `✓ Continuous terrain beneath all ${stats.waterCells} submerged vertices; water is a separate mesh with its own surface elevations.`
          : `✗ Discontinuity detected on this transect (max step ${stats.maxStep.toFixed(1)} m).`}
      </div>
    </div>
  );
}
