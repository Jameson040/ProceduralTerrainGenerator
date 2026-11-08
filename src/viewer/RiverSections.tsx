import { useEffect, useMemo, useRef } from "react";
import type { TerrainData } from "../terrain/types";
import { auditRiverbeds, riverSections, type RiverSection } from "../terrain/riverAudit";
import { cn } from "../utils/cn";

/**
 * Debug cross-sections through several rivers.
 *
 * Each panel cuts a perpendicular section through a different river and draws
 * the REAL heightfield: terrain profile, carved bed, the separate water surface
 * and the bank slopes. This is the visual counterpart of
 * `python -m terrain.cli --river-sections`.
 */
function SectionCanvas({ section, scale }: { section: RiverSection; scale: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 260, H = 96;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const values = [...section.heights, ...section.surface.filter((v): v is number => v !== null)];
    const lo = Math.min(...values), hi = Math.max(...values);
    const pad = Math.max(1, (hi - lo) * 0.15);
    const min = lo - pad, max = hi + pad;
    const padL = 4, padR = 4, padT = 6, padB = 6;
    const iw = W - padL - padR, ih = H - padT - padB;
    const X = (i: number) => padL + (i / Math.max(1, section.heights.length - 1)) * iw;
    const Y = (v: number) => padT + (1 - (v - min) / (max - min)) * ih;

    ctx.fillStyle = "#0c0a09";
    ctx.fillRect(0, 0, W, H);

    // Reference line: the original (pre-river) ground would be higher, so the
    // fill below shows the carved channel with water inside it.
    ctx.beginPath();
    ctx.moveTo(X(0), Y(section.heights[0]));
    for (let i = 1; i < section.heights.length; i++) ctx.lineTo(X(i), Y(section.heights[i]));
    ctx.lineTo(X(section.heights.length - 1), H - padB);
    ctx.lineTo(X(0), H - padB);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
    grad.addColorStop(0, "#78716c");
    grad.addColorStop(0.6, "#57534e");
    grad.addColorStop(1, "#292524");
    ctx.fillStyle = grad;
    ctx.fill();

    // Water: per-cell surface down to the carved bed (a separate geometry).
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < section.heights.length; i++) {
      const surface = section.surface[i];
      if (surface === null) { started = false; continue; }
      if (!started) {
        ctx.moveTo(X(i), Y(section.heights[i]));
        ctx.lineTo(X(i), Y(surface));
        started = true;
      } else {
        ctx.lineTo(X(i), Y(surface));
      }
    }
    if (started) {
      for (let i = section.heights.length - 1; i >= 0; i--) {
        const surface = section.surface[i];
        if (surface === null) continue;
        ctx.lineTo(X(i), Y(section.heights[i]));
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(56,189,248,0.55)";
      ctx.fill();
    }

    // Terrain outline.
    ctx.beginPath();
    ctx.moveTo(X(0), Y(section.heights[0]));
    for (let i = 1; i < section.heights.length; i++) ctx.lineTo(X(i), Y(section.heights[i]));
    ctx.strokeStyle = "#e7e5e4";
    ctx.lineWidth = 1.3;
    ctx.stroke();

    // Carved bed cells.
    if (section.heights.length < 24) {
      for (let i = 0; i < section.heights.length; i++) {
        if (!section.carved[i]) continue;
        ctx.beginPath();
        ctx.arc(X(i), Y(section.heights[i]), 2.1, 0, Math.PI * 2);
        ctx.fillStyle = section.wet[i] ? "#fbbf24" : "#a8a29e";
        ctx.fill();
      }
    }
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "8px ui-monospace, monospace";
    ctx.fillText(`${scale.toFixed(1)} m/cell`, 5, H - 2);
  }, [section, scale]);

  return (
    <div className="rounded border border-stone-800 bg-stone-950/60 p-1.5">
      <div className="flex items-baseline justify-between text-[10px] text-stone-400">
        <span className="text-stone-300">
          #{section.index + 1} · cell {section.cell[0]},{section.cell[1]}
        </span>
        <span className="tabular-nums">
          bed {section.bed.toFixed(1)} m · {section.wetCells} wet
        </span>
      </div>
      <canvas ref={ref} data-testid={`river-section-${section.index}`}
        data-enclosed={section.waterEnclosed ? "1" : "0"}
        data-bed-below-surface={section.bedBelowSurface ? "1" : "0"}
        style={{ width: "100%", aspectRatio: "260 / 96" }} />
      <div className="text-[10px] text-stone-500 tabular-nums">
        banks {section.bankSlopeLeft.toFixed(2)} / {section.bankSlopeRight.toFixed(2)} slope
        {section.waterSurface !== null && <> · water {section.waterSurface.toFixed(1)} m</>}
      </div>
    </div>
  );
}

export default function RiverSections({ terrain }: { terrain: TerrainData | null }) {
  const sections = useMemo(() => (terrain ? riverSections(terrain, 3) : []), [terrain]);
  const report = useMemo(() => (terrain ? auditRiverbeds(terrain) : null), [terrain]);
  if (!terrain || !sections.length || !report) {
    return <p className="text-[11px] text-stone-500">Generate a terrain with rivers to inspect riverbed cross-sections.</p>;
  }
  const healthy = report.waterSpillEdges === 0 && report.bedBelowWaterSurface
    && report.sectionsAllEnclosed && report.waterHasTerrainBeneath;
  return (
    <div className="space-y-1.5">
      {sections.map(section => (
        <SectionCanvas key={`${section.cell[0]}:${section.cell[1]}`} section={section} scale={terrain.cell_size} />
      ))}
      <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[11px] text-stone-400 tabular-nums">
        <span>riverbed</span>
        <span className="text-stone-200 text-right">{report.carvedBedCells} carved cells</span>
        <span>water edges</span>
        <span className="text-stone-200 text-right">{report.waterEdgePairs} checked</span>
        <span>spills</span>
        <span className="text-stone-200 text-right">{report.waterSpillEdges}</span>
        <span>bed slope</span>
        <span className="text-stone-200 text-right">
          median {report.bedSlopeMedian.toFixed(2)} · p95 {report.bedSlopeP95.toFixed(2)}
        </span>
        <span>walkable bed</span>
        <span className="text-stone-200 text-right">{(report.walkableBedFraction * 100).toFixed(0)}%</span>
      </div>
      <div data-testid="riverbed-report" data-spill-edges={report.waterSpillEdges}
        data-carved-cells={report.carvedBedCells}
        className={cn("text-[11px] rounded px-2 py-1.5 border",
        healthy ? "border-emerald-500/40 bg-emerald-600/10 text-emerald-200"
          : "border-red-500/40 bg-red-600/10 text-red-200")}>
        {healthy
          ? "✓ Terrain is incised under every river: water sits in a banked channel, never on top of the landscape."
          : `✗ Riverbed contract failed (${report.waterSpillEdges} spill edges).`}
      </div>
    </div>
  );
}
