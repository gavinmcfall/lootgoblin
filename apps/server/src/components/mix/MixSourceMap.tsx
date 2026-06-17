// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// MixSourceMap — step 2 of the Guided Mix wizard (NEW; the design lacks this).
// For each recipe component the user maps one of their OWNED, ACTIVE inventory
// materials. `materialProductRef` is only a hint label — there is no stored
// mapping, so the user picks explicitly. Advancing is blocked until every
// component is mapped.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyHint } from '@/components/shell/atoms';
import type { MaterialDto, MixRecipeDto, ScaledComponent } from './types';
import { fetchAllMaterials, materialLabel, rampColor, scaleComponents } from './types';

export function MixSourceMap({
  recipe,
  batchSize,
  mapping,
  onMap,
  onBack,
  onNext,
}: {
  recipe: MixRecipeDto;
  batchSize: number;
  mapping: Record<number, string>;
  onMap: (componentIndex: number, material: MaterialDto | null) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  // Fetch resins + filaments separately, then merge. Both are valid mix
  // sources; we group them so the picker shows everything the user owns.
  // Each fetch pages through nextCursor until exhausted so a user with >50
  // active bottles of a kind isn't silently truncated.
  const resinQ = useQuery({
    queryKey: ['materials', 'resin', 'all'],
    queryFn: () => fetchAllMaterials('resin'),
  });
  const filamentQ = useQuery({
    queryKey: ['materials', 'filament', 'all'],
    queryFn: () => fetchAllMaterials('filament'),
  });

  const owned = useMemo<MaterialDto[]>(() => {
    const all = [...(resinQ.data ?? []), ...(filamentQ.data ?? [])];
    // Only active materials can be drawn from.
    return all.filter((m) => m.active);
  }, [resinQ.data, filamentQ.data]);

  const byId = useMemo(() => {
    const map = new Map<string, MaterialDto>();
    for (const m of owned) map.set(m.id, m);
    return map;
  }, [owned]);

  const { scaled } = scaleComponents(recipe.components, batchSize);
  const allMapped = scaled.every((c) => !!mapping[c.index]);

  const isLoading = resinQ.isLoading || filamentQ.isLoading;
  const isError = resinQ.isError || filamentQ.isError;

  if (isError) return <EmptyHint>Failed to load your inventory.</EmptyHint>;
  if (isLoading) return <EmptyHint>Loading your inventory…</EmptyHint>;

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
      <div className="border-b border-hairline px-[28px] py-[22px]">
        <div className="font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
          Map each component to a bottle you own
        </div>
        <div className="mt-1 font-serif text-[21px] italic leading-tight text-fg">
          Which of your bottles fills each slot?
        </div>
        <div className="mt-1.5 font-sans text-[12.5px] text-fg-muted">
          The recipe lists abstract components — pick the actual inventory you&apos;ll pour from.
        </div>
      </div>

      {owned.length === 0 ? (
        <div className="p-[28px]">
          <EmptyHint>
            No active resin or filament in your inventory to map. Add materials first.
          </EmptyHint>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-[28px] py-5">
          {scaled.map((c: ScaledComponent) => {
            const selectedId = mapping[c.index] ?? '';
            const selected = selectedId ? byId.get(selectedId) : undefined;
            const insufficient =
              selected != null && selected.remainingAmount < c.target;
            return (
              <div
                key={c.index}
                className="grid items-center gap-4 rounded-md border border-hairline bg-surface-2 px-4 py-3"
                style={{ gridTemplateColumns: '16px 1.1fr 1.4fr auto' }}
              >
                <div
                  className="h-3.5 w-3.5 rounded border border-hairline"
                  style={{ background: rampColor(c.index) }}
                />
                <div>
                  <div className="font-sans text-[13px] font-medium text-fg">{c.ref}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-fg-faint">
                    target {c.target.toFixed(1)} g
                  </div>
                </div>
                <div>
                  <label htmlFor={`map-${c.index}`} className="sr-only">
                    Inventory bottle for {c.ref}
                  </label>
                  <select
                    id={`map-${c.index}`}
                    value={selectedId}
                    onChange={(e) =>
                      onMap(c.index, e.target.value ? (byId.get(e.target.value) ?? null) : null)
                    }
                    className="w-full rounded-sm border border-hairline bg-bg px-2.5 py-2 font-sans text-[13px] text-fg focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="">— pick a bottle —</option>
                    {owned.map((m) => (
                      <option key={m.id} value={m.id}>
                        {materialLabel(m)} — {m.remainingAmount} {m.unit}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-[110px] text-right">
                  {selected ? (
                    // Low/insufficient stock is steady-state, not a transition:
                    // emphasize the number on the muted base rather than using
                    // the `running` transition tone (semantic-tone discipline).
                    <span className="font-mono text-[11px] text-fg-muted">
                      <span className={insufficient ? 'text-fg' : undefined}>
                        {selected.remainingAmount} {selected.unit}
                      </span>{' '}
                      left{insufficient && ' · low'}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-fg-ghost">unmapped</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-hairline bg-surface-2 px-[28px] py-4">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-hairline px-4 py-2 font-sans text-[12.5px] text-fg-muted hover:text-fg"
        >
          ← Back to recipe
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!allMapped}
          className="rounded-md bg-accent px-[22px] py-2.5 font-sans text-[13px] font-semibold text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          Enter weights →
        </button>
      </div>
    </div>
  );
}
