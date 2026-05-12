'use client';
// ConsumptionLootEmbed — per-Loot consumption embed for Loot detail page.
// Canvas ref: ConsumptionLootEmbed (page-consumption.jsx line 383–412).
// Exported here; canvas-port #9 (Loot detail) imports and uses it.
// NOT wired to any route in this PR.

import { provenanceClassCssVar } from './reports-labels';

interface LootConsumptionRow {
  date: string;       // display string e.g. "Apr 18"
  material: string;   // material name e.g. "Iron Grey PLA Matte"
  massG: number;      // mass in grams
  provenance: 'measured' | 'estimated' | 'entered' | 'derived' | 'computed' | 'system';
}

interface Props {
  totalKg: number;
  printCount: number;
  avgGrams: number;
  rows: LootConsumptionRow[];
}

export function ConsumptionLootEmbed({ totalKg, printCount, avgGrams, rows }: Props) {
  return (
    <div className="w-full rounded-md border border-hairline bg-surface p-5">
      {/* Header */}
      <div className="mb-3.5 flex items-baseline gap-2.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[1.6px] text-accent">
          Consumption · this Loot
        </span>
        <span className="flex-1 border-b border-dashed border-hairline" />
        <span className="font-mono text-[9.5px] text-fg-faint">{printCount} prints</span>
      </div>

      {/* Totals */}
      <div className="mb-3.5 flex items-baseline gap-4">
        <span className="font-serif text-[36px] leading-none tracking-[-1px] text-fg">
          {totalKg.toFixed(2)}{' '}
          <span className="text-[16px] italic text-fg-muted">kg total</span>
        </span>
        <span className="ml-auto font-mono text-[10px] text-fg-muted">
          ~{Math.round(avgGrams)} g · avg per print
        </span>
      </div>

      {/* Row list */}
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div
            key={i}
            className="grid items-center gap-[10px] border-b border-dashed border-hairline py-1.5"
            style={{ gridTemplateColumns: '60px 1fr 70px 80px' }}
          >
            <span className="font-mono text-[10px] text-fg-faint">{r.date}</span>
            <span className="font-sans text-[12px] text-fg">{r.material}</span>
            <span className="text-right font-mono text-[11px] text-fg">{r.massG}g</span>
            <span
              className="text-right font-mono text-[9px] uppercase tracking-[0.4px]"
              style={{ color: provenanceClassCssVar(r.provenance) }}
            >
              {r.provenance}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
