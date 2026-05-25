'use client';
// MixManualEntry — step 3 of the Guided Mix wizard. Ported from
// MixManualEntry in page-mix-manual.jsx, wired to the mapped sources.
//
// One numeric input per component. Live ToleranceBand + DeviationPill ONLY
// when the component has a tolerance; deviation-only otherwise. Every row's
// provenance is `entered`. Advance enabled when all components have a number.

import type { MaterialDto, MixRecipeDto, ScaledComponent } from './types';
import { materialLabel, scaleComponents } from './types';
import { ToleranceBand, DeviationPill, DeviationOnly, ProvenanceTag } from './bits';

const RAMP = [
  '#8d8c8a',
  '#5a5957',
  '#b4b2af',
  '#3a3937',
  '#d0cdc9',
  '#6f6e6c',
  '#9e9c99',
  '#4a4947',
  '#c2bfbb',
  '#7e7d7a',
];

export function MixManualEntry({
  recipe,
  batchSize,
  mapping,
  sourceById,
  weights,
  onWeight,
  onBack,
  onNext,
}: {
  recipe: MixRecipeDto;
  batchSize: number;
  mapping: Record<number, string>;
  sourceById: Map<string, MaterialDto>;
  weights: Record<number, string>;
  onWeight: (componentIndex: number, value: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { scaled } = scaleComponents(recipe.components, batchSize);

  const numeric = (idx: number): number | null => {
    const raw = weights[idx];
    if (raw == null || raw.trim() === '') return null;
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : null;
  };

  const totalTarget = scaled.reduce((s, c) => s + c.target, 0);
  const totalEntered = scaled.reduce((s, c) => s + (numeric(c.index) ?? 0), 0);
  const totalDev = totalEntered - totalTarget;
  const filled = scaled.filter((c) => numeric(c.index) != null).length;
  const allFilled = filled === scaled.length;

  const totalDevClass =
    Math.abs(totalDev) > 3 ? 'text-danger' : Math.abs(totalDev) > 0.5 ? 'text-running' : 'text-success';

  return (
    <div className="grid overflow-hidden rounded-lg border border-hairline bg-surface lg:grid-cols-[1.55fr_1fr]">
      {/* LEFT — entry table */}
      <div className="flex flex-col gap-4 overflow-auto border-hairline px-7 py-6 lg:border-r">
        <div>
          <div className="font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
            Weigh each component on your scale.
          </div>
          <div className="mt-1 font-serif text-[21px] italic leading-tight text-fg">
            Type what your scale reads.
          </div>
        </div>

        {/* column headers */}
        <div
          className="grid items-center gap-4 border-b border-hairline pb-2 font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint"
          style={{ gridTemplateColumns: '18px 1.4fr 200px 1.1fr 120px' }}
        >
          <span />
          <span>Component</span>
          <span>Target ± tolerance</span>
          <span>Weighed</span>
          <span className="text-right">Status</span>
        </div>

        {/* rows */}
        {scaled.map((c: ScaledComponent) => {
          const v = numeric(c.index);
          const src = sourceById.get(mapping[c.index] ?? '');
          return (
            <div
              key={c.index}
              className="grid items-center gap-4 rounded-md px-3.5 py-3"
              style={{ gridTemplateColumns: '18px 1.4fr 200px 1.1fr 120px' }}
            >
              <div
                className="h-3.5 w-3.5 rounded border border-hairline"
                style={{ background: RAMP[c.index % RAMP.length] }}
              />
              <div>
                <div className="font-sans text-[13.5px] font-medium text-fg">
                  {src ? materialLabel(src) : c.ref}
                </div>
                <div className="mt-0.5 font-mono text-[10px] tracking-[0.2px] text-fg-faint">
                  {c.ref} · {Math.round(c.pct)}%
                </div>
              </div>
              <div className="flex items-center gap-3">
                {c.tol != null ? (
                  <ToleranceBand current={v} target={c.target} tol={c.tol} widthPx={130} />
                ) : (
                  <span className="h-[22px] w-[130px]" />
                )}
                <div className="whitespace-nowrap font-serif text-[15px] italic text-fg-muted">
                  {c.target.toFixed(1)}
                  <span className="ml-0.5 font-mono text-[10px] not-italic text-fg-faint">
                    {c.tol != null ? `± ${c.tol.toFixed(1)}g` : 'g'}
                  </span>
                </div>
              </div>
              {/* input */}
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline rounded-md border border-hairline-strong bg-surface-2 px-3 py-2 focus-within:ring-2 focus-within:ring-accent-edge">
                  <label htmlFor={`weight-${c.index}`} className="sr-only">
                    Weighed grams for {c.ref}
                  </label>
                  <input
                    id={`weight-${c.index}`}
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={weights[c.index] ?? ''}
                    onChange={(e) => onWeight(c.index, e.target.value)}
                    placeholder="0.0"
                    className="w-[68px] bg-transparent font-serif text-[22px] italic tabular-nums text-fg placeholder:text-fg-ghost focus:outline-none"
                  />
                  <span className="ml-1.5 font-sans text-[13px] text-fg-faint">g</span>
                </div>
                <ProvenanceTag kind="entered" />
              </div>
              <div className="flex justify-end">
                {c.tol != null ? (
                  <DeviationPill current={v} target={c.target} tol={c.tol} />
                ) : (
                  <DeviationOnly current={v} target={c.target} />
                )}
              </div>
            </div>
          );
        })}

        {/* helper note */}
        <div className="mt-auto rounded-sm border border-dashed border-hairline bg-surface-2 px-3.5 py-2.5 font-sans text-[11.5px] leading-relaxed text-fg-muted">
          <span className="font-semibold text-fg">Tip:</span> tare between pours so each row is
          an isolated read. Decimals welcome — we round to one decimal on save.
        </div>
      </div>

      {/* RIGHT — running total + commit */}
      <div className="flex flex-col gap-4 bg-bg p-6">
        <div>
          <div className="mb-2 font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
            running total
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-[56px] italic leading-none tabular-nums tracking-[-1px] text-fg">
              {totalEntered.toFixed(1)}
            </span>
            <span className="font-sans text-[18px] text-fg-faint">g</span>
          </div>
          <div className="mt-2 flex items-center gap-2 font-mono text-[11px] tracking-[0.3px] text-fg-muted">
            <span>target {totalTarget.toFixed(1)} g</span>
            <span className="text-fg-faint">·</span>
            <span className={totalDevClass}>
              {totalDev >= 0 ? '+' : ''}
              {totalDev.toFixed(1)} g
            </span>
          </div>
        </div>

        {/* progress */}
        <div>
          <div className="mb-2 font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
            progress
          </div>
          <div className="flex gap-1.5">
            {scaled.map((c) => {
              const done = numeric(c.index) != null;
              return (
                <div
                  key={c.index}
                  className={`h-1.5 flex-1 rounded-[3px] border border-hairline ${
                    done ? '' : 'bg-surface-2 opacity-50'
                  }`}
                  style={done ? { background: RAMP[c.index % RAMP.length] } : undefined}
                />
              );
            })}
          </div>
          <div className="mt-2 font-mono text-[10.5px] tracking-[0.2px] text-fg-faint">
            {filled}/{scaled.length} components ·{' '}
            {allFilled ? 'ready to review' : `${scaled.length - filled} to go`}
          </div>
        </div>

        {/* mini-summary */}
        <div className="flex flex-col gap-2 rounded-md border border-hairline bg-surface px-3.5 py-3">
          {scaled.map((c) => {
            const v = numeric(c.index);
            return (
              <div
                key={c.index}
                className="grid items-center gap-2.5"
                style={{ gridTemplateColumns: '12px 1fr auto' }}
              >
                <span
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ background: RAMP[c.index % RAMP.length] }}
                />
                <span className="truncate font-sans text-[11.5px] text-fg-muted">{c.ref}</span>
                <span
                  className={`font-mono text-[11px] tabular-nums ${
                    v != null ? 'text-fg' : 'text-fg-ghost'
                  }`}
                >
                  {v != null ? v.toFixed(1) : '—'} g
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-auto flex flex-col gap-2.5">
          <button
            type="button"
            onClick={onNext}
            disabled={!allFilled}
            className="rounded-md bg-accent px-3 py-3 font-sans text-[13.5px] font-semibold text-accent-ink disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-ghost"
          >
            Review →
          </button>
          <button
            type="button"
            onClick={onBack}
            className="rounded-sm px-3 py-2 font-sans text-[12px] text-fg-muted hover:text-fg"
          >
            ← Back to bottles
          </button>
        </div>
      </div>
    </div>
  );
}
