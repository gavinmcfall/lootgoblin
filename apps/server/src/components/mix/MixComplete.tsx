// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// MixComplete — step 5 of the Guided Mix wizard. Ported from MixCompleteManual
// in page-mix-manual.jsx, with the design's fictional lines degraded to real
// backend data:
//   - DROP "12 queued prints will use this mix" (no such backend data).
//   - Per-source deduction is REAL: we re-fetch the mapped sources and show
//     each one's NEW remainingAmount, with a 'low' flag when <20%.

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { MaterialDto, MixRecipeDto } from './types';
import { rampColor } from './types';
import type { ComponentDraw } from './draws';
import { ProvenanceTag } from './bits';

export function MixComplete({
  recipe,
  draws,
  totalVolume,
  mixBatchMaterialId,
  sourceIds,
  onReset,
}: {
  recipe: MixRecipeDto;
  draws: ComponentDraw[];
  totalVolume: number;
  mixBatchMaterialId: string;
  sourceIds: string[];
  onReset: () => void;
}) {
  // Re-fetch the mapped sources to surface their NEW remainingAmount after the
  // atomic draw. One GET per distinct source id; bounded by component count.
  const uniqueIds = Array.from(new Set(sourceIds));
  const sourcesQ = useQuery({
    queryKey: ['mix-deductions', mixBatchMaterialId, ...uniqueIds],
    queryFn: async (): Promise<Record<string, MaterialDto>> => {
      const out: Record<string, MaterialDto> = {};
      await Promise.all(
        uniqueIds.map(async (id) => {
          const res = await fetch(`/api/v1/materials/${id}`);
          if (res.ok) {
            const body = (await res.json()) as { material?: MaterialDto };
            if (body.material) out[id] = body.material;
          }
        }),
      );
      return out;
    },
    enabled: uniqueIds.length > 0,
  });
  const fresh = sourcesQ.data ?? {};

  return (
    <div className="mx-auto max-w-[680px] overflow-hidden rounded-lg border border-hairline bg-surface shadow-md">
      {/* success band */}
      <div className="border-b border-hairline bg-surface-2 px-8 pb-6 pt-8 text-center">
        <div className="mb-3.5 inline-flex h-[52px] w-[52px] items-center justify-center rounded-full border-[1.5px] border-accent">
          <svg width="26" height="26" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <path
              d="M6 14l5 5 11-12"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="font-serif text-[30px] italic leading-[1.05] text-fg">
          Mix registered.
        </div>
        <div className="mt-1.5 font-sans text-[13.5px] text-fg-muted">
          {recipe.name} · {totalVolume.toFixed(1)} g · {draws.length} components, hand-weighed.
        </div>
        <div className="mt-2.5 inline-flex items-center gap-2 rounded-full border border-hairline bg-bg px-2.5 py-1">
          <ProvenanceTag kind="entered" size="md" />
          <span className="font-sans text-[11px] text-fg-muted">· no scale linked at the time</span>
        </div>
      </div>

      {/* what's in the vessel */}
      <div className="border-b border-hairline px-7 py-5">
        <div className="mb-2.5 font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
          what&apos;s in the vessel
        </div>
        {draws.map((d, i) => (
          <div
            key={`${d.sourceMaterialId}-${i}`}
            className="grid items-center gap-3 py-1.5"
            style={{ gridTemplateColumns: '14px 1fr auto' }}
          >
            <div
              className="h-3 w-3 rounded-[3px] border border-hairline"
              style={{ background: rampColor(i) }}
            />
            <span className="font-sans text-[12.5px] text-fg">{d.sourceLabel}</span>
            <span className="min-w-[56px] text-right font-serif text-[17px] italic text-fg">
              {d.drawAmount.toFixed(1)} g
            </span>
          </div>
        ))}
      </div>

      {/* per-source deductions (real) */}
      <div className="border-b border-hairline px-7 py-4">
        <div className="mb-2 font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
          bottles deducted
        </div>
        {sourcesQ.isLoading ? (
          <div className="font-sans text-[12px] text-fg-faint">Refreshing stock levels…</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {uniqueIds.map((id) => {
              const m = fresh[id];
              if (!m) {
                return (
                  <div key={id} className="font-sans text-[12px] text-fg-faint">
                    → {id.slice(0, 8)} · stock unavailable
                  </div>
                );
              }
              const pct = m.initialAmount > 0 ? m.remainingAmount / m.initialAmount : 1;
              const low = pct < 0.2;
              const label = [m.brand, m.subtype, m.colorName].filter(Boolean).join(' ') || id.slice(0, 8);
              // Low stock is steady-state, not a transition — emphasize the
              // number on the muted base and keep the "low" annotation muted
              // (semantic-tone discipline; `running` is for transitions only,
              // `danger` is wrong since restocking is self-service).
              return (
                <div key={id} className="font-sans text-[12px] text-fg-muted">
                  → <span className="text-fg">{label}</span> now{' '}
                  <span className="text-fg">
                    {m.remainingAmount} {m.unit}
                  </span>
                  {low && (
                    <span className="text-fg-muted"> — low ({Math.round(pct * 100)}%)</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* actions */}
      <div className="flex justify-end gap-2.5 bg-surface-2 px-7 py-4">
        <button
          type="button"
          onClick={onReset}
          className="rounded-sm border border-hairline bg-transparent px-3.5 py-2 font-sans text-[12.5px] text-fg-muted hover:text-fg"
        >
          Back to recipes
        </button>
        <Link
          href={`/materials/${mixBatchMaterialId}`}
          className="rounded-sm border border-hairline-strong bg-transparent px-3.5 py-2 font-sans text-[12.5px] text-fg"
        >
          Open in Materials
        </Link>
        <Link
          href="/forge/dispatch"
          className="rounded-sm bg-accent px-[18px] py-2 font-sans text-[12.5px] font-semibold text-accent-ink"
        >
          Queue print →
        </Link>
      </div>
    </div>
  );
}
