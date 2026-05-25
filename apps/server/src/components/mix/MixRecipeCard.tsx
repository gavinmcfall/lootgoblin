'use client';
// MixRecipeCard — step 1 of the Guided Mix wizard. Ported from
// MixRecipeCardManual in page-mix-manual.jsx.
//
// Recipe components are abstract refs (no stored hex). The ingredient bar uses
// a deterministic neutral-grey ramp keyed by component index so the bar reads
// as a composition without inventing brand colours.

import type { MixRecipeDto, ScaledComponent } from './types';
import { rampColor, scaleComponents } from './types';

export function MixRecipeCard({
  recipe,
  batchSize,
  onBatchSize,
  onNext,
}: {
  recipe: MixRecipeDto;
  batchSize: number;
  onBatchSize: (v: number) => void;
  onNext: () => void;
}) {
  const { nominalTotal, scaled } = scaleComponents(recipe.components, batchSize);
  const totalTarget = scaled.reduce((s, c) => s + c.target, 0);

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface shadow-md">
      {/* Header */}
      <div className="border-b border-hairline bg-surface-2 px-[26px] pb-[18px] pt-[22px]">
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[1.6px] text-fg-faint">
          Guided mix · recipe
        </div>
        <div className="font-serif text-[30px] italic leading-[1.05] text-fg">
          {recipe.name}
        </div>
        {recipe.notes && (
          <div className="mt-1 font-sans text-[12.5px] text-fg-faint">{recipe.notes}</div>
        )}
      </div>

      {/* Ingredients */}
      <div className="px-[26px] py-5">
        <div className="mb-3.5 font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
          ingredients
        </div>
        {/* Composition bar */}
        <div className="mb-4 flex h-7 overflow-hidden rounded-sm border border-hairline">
          {scaled.map((c) => (
            <div
              key={c.index}
              className="flex items-center justify-center"
              style={{ flex: c.pct, background: rampColor(c.index) }}
            >
              {c.pct > 10 && (
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[1px] text-[#1a1a1a]">
                  {Math.round(c.pct)}%
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Per-component rows */}
        <div className="flex flex-col gap-2.5">
          {scaled.map((c: ScaledComponent) => (
            <div
              key={c.index}
              className="grid items-center gap-3"
              style={{ gridTemplateColumns: '16px 1fr auto auto' }}
            >
              <div
                className="h-3.5 w-3.5 rounded border border-hairline"
                style={{ background: rampColor(c.index) }}
              />
              <div className="font-sans text-[13px] font-medium text-fg">{c.ref}</div>
              <div className="font-mono text-[11px] tracking-[0.3px] text-fg-faint">
                {c.tol != null ? `± ${c.tol.toFixed(1)}g` : 'no tolerance'}
              </div>
              <div className="min-w-[60px] text-right font-serif text-[19px] italic text-fg">
                {c.target.toFixed(1)}
                <span className="ml-0.5 font-mono text-[12px] not-italic text-fg-faint">g</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Batch size */}
      <div className="flex items-center justify-between border-t border-hairline bg-surface-2 px-[26px] py-3.5">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint">
            batch size
          </div>
          <div className="mt-0.5 font-sans text-[11.5px] text-fg-muted">
            nominal {nominalTotal} g · scale {(batchSize / (nominalTotal || 1)).toFixed(2)}×
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="mix-batch-size" className="sr-only">
            Batch size in grams
          </label>
          <input
            id="mix-batch-size"
            type="number"
            min={0}
            step="any"
            value={Number.isFinite(batchSize) ? batchSize : ''}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              onBatchSize(Number.isFinite(v) && v > 0 ? v : 0);
            }}
            className="w-24 rounded-md border border-hairline-strong bg-bg px-2.5 py-2 text-right font-serif text-[18px] italic text-fg focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <span className="font-mono text-[12px] text-fg-faint">g target</span>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3.5 border-t border-hairline px-[26px] py-4">
        <span className="inline-block h-[7px] w-[7px] rounded-full bg-fg-faint" />
        <span className="font-mono text-[11px] tracking-[0.3px] text-fg-muted">
          no scale linked · <span className="text-fg">entering by hand</span>
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint">
            total {totalTarget.toFixed(1)} g
          </span>
          <button
            type="button"
            onClick={onNext}
            disabled={!(batchSize > 0)}
            className="rounded-md bg-accent px-[22px] py-2.5 font-sans text-[13px] font-semibold text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Map bottles →
          </button>
        </div>
      </div>
    </div>
  );
}
