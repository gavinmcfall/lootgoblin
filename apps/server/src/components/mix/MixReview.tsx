'use client';
// MixReview — step 4 of the Guided Mix wizard. Ported from MixReviewApply in
// page-mix-manual.jsx. Shows the entered weights, the synthesized swatch, the
// REAL POST body trace, an optional colour-name input, and the register CTA.
//
// The page computes `draws` + `totalVolume` + `mixedHex` (mass-conservation
// invariant lives there) and passes them in; this component is presentational
// plus the colour-name field.

import type { MixRecipeDto, ScaledComponent } from './types';
import { scaleComponents } from './types';
import { DeviationPill, DeviationOnly, ProvenanceTag } from './bits';
import type { ComponentDraw } from './draws';

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

export function MixReview({
  recipe,
  batchSize,
  draws,
  totalVolume,
  mixedHex,
  colorName,
  onColorName,
  onBack,
  onRegister,
  isPending,
}: {
  recipe: MixRecipeDto;
  batchSize: number;
  draws: ComponentDraw[];
  totalVolume: number;
  mixedHex: string | null;
  colorName: string;
  onColorName: (v: string) => void;
  onBack: () => void;
  onRegister: () => void;
  isPending: boolean;
}) {
  const { scaled } = scaleComponents(recipe.components, batchSize);
  const totalTarget = scaled.reduce((s, c) => s + c.target, 0);
  const totalDev = totalVolume - totalTarget;
  const colorIncluded = mixedHex != null;

  return (
    <div className="grid overflow-hidden rounded-lg border border-hairline bg-surface lg:grid-cols-[1.4fr_1fr]">
      {/* LEFT — entered weights */}
      <div className="flex flex-col gap-4 overflow-auto border-hairline px-7 py-6 lg:border-r">
        <div>
          <div className="font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
            You&apos;re about to register
          </div>
          <div className="mt-1 font-serif text-[26px] italic leading-tight text-fg">
            one batch of {recipe.name}.
          </div>
          <div className="mt-1.5 font-sans text-[12.5px] text-fg-muted">
            Every component weighed by hand. Nothing has touched the materials ledger yet.
          </div>
        </div>

        {/* breakdown table */}
        <div className="overflow-hidden rounded-md border border-hairline">
          <div
            className="grid items-center gap-3.5 border-b border-hairline bg-surface-2 px-4 py-2.5 font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint"
            style={{ gridTemplateColumns: '18px 1.4fr 80px 80px 110px' }}
          >
            <span />
            <span>Source</span>
            <span className="text-right">Target</span>
            <span className="text-right">Entered</span>
            <span className="text-right">Deviation</span>
          </div>
          {scaled.map((c: ScaledComponent, i) => {
            const draw = draws[i]!;
            return (
              <div
                key={c.index}
                className={`grid items-center gap-3.5 px-4 py-3 ${
                  i < scaled.length - 1 ? 'border-b border-dashed border-hairline' : ''
                }`}
                style={{ gridTemplateColumns: '18px 1.4fr 80px 80px 110px' }}
              >
                <div
                  className="h-3.5 w-3.5 rounded border border-hairline"
                  style={{ background: RAMP[c.index % RAMP.length] }}
                />
                <div>
                  <div className="font-sans text-[13px] font-medium text-fg">
                    {draw.sourceLabel}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] tracking-[0.3px] text-fg-faint">
                    {draw.sourceMaterialId.slice(0, 8)} · <ProvenanceTag kind="entered" />
                  </div>
                </div>
                <div className="text-right font-mono text-[11.5px] tabular-nums text-fg-muted">
                  {c.target.toFixed(1)} g
                </div>
                <div className="text-right font-serif text-[19px] italic tabular-nums text-fg">
                  {draw.drawAmount.toFixed(1)}{' '}
                  <span className="font-mono text-[10px] not-italic text-fg-faint">g</span>
                </div>
                <div className="flex justify-end">
                  {c.tol != null ? (
                    <DeviationPill current={draw.drawAmount} target={c.target} tol={c.tol} />
                  ) : (
                    <DeviationOnly current={draw.drawAmount} target={c.target} />
                  )}
                </div>
              </div>
            );
          })}
          {/* total */}
          <div
            className="grid items-center gap-3.5 border-t border-hairline bg-surface-2 px-4 py-3"
            style={{ gridTemplateColumns: '18px 1.4fr 80px 80px 110px' }}
          >
            <span />
            <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint">
              Total mass
            </span>
            <span className="text-right font-mono text-[11.5px] text-fg-muted">
              {totalTarget.toFixed(1)} g
            </span>
            <span className="text-right font-serif text-[22px] italic tabular-nums text-fg">
              {totalVolume.toFixed(1)}{' '}
              <span className="font-mono text-[10px] not-italic text-fg-faint">g</span>
            </span>
            <span
              className={`text-right font-mono text-[11px] ${
                Math.abs(totalDev) < 0.5 ? 'text-success' : 'text-running'
              }`}
            >
              {totalDev >= 0 ? '+' : ''}
              {totalDev.toFixed(1)} g
            </span>
          </div>
        </div>

        {/* POST trace — the REAL values we're about to send */}
        <div className="whitespace-pre-wrap rounded-sm border border-hairline bg-surface-2 px-3.5 py-3 font-mono text-[10.5px] leading-relaxed tracking-[0.2px] text-fg-muted">
          <span className="text-fg-faint">POST /api/v1/materials/mix-batches</span>
          {'\n'}recipeId: <span className="text-fg">{recipe.id}</span>
          {'\n'}totalVolume: <span className="text-fg">{totalVolume.toFixed(1)}</span>
          {'\n'}perComponentDraws: <span className="text-fg">[{draws.length} entries]</span>
          {'\n'}
          <span className="text-fg-faint"> └ provenanceClass: &apos;entered&apos; (all)</span>
          {'\n'}colors:{' '}
          <span className="text-fg">{colorIncluded ? `[${mixedHex}]` : '(omitted)'}</span>
        </div>
      </div>

      {/* RIGHT — colour + commit */}
      <div className="flex flex-col gap-[18px] px-6 py-6">
        <div>
          <div className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
            Resulting batch
          </div>
          <div className="font-serif text-[19px] italic leading-tight text-fg">
            Mix-batch material, ready to file.
          </div>
        </div>

        {/* swatch */}
        <div className="flex items-center gap-3.5 rounded-md border border-hairline bg-surface-2 p-3.5">
          <div
            className="h-14 w-14 shrink-0 rounded-sm border border-hairline-strong"
            style={{ background: mixedHex ?? 'var(--surface-hi)' }}
          />
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[12.5px] font-medium text-fg">
              {colorIncluded ? 'Synthesised colour' : 'No colour synthesised'}
            </div>
            <div className="mt-0.5 font-mono text-[11px] tracking-[0.3px] text-fg-faint">
              {colorIncluded
                ? `${mixedHex} · weighted avg`
                : 'a source is missing a hex — colour omitted'}
            </div>
          </div>
        </div>

        {/* colour name */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="mix-color-name"
            className="font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint"
          >
            Colour name{' '}
            <span className="normal-case tracking-normal text-fg-ghost">(optional)</span>
          </label>
          <input
            id="mix-color-name"
            type="text"
            value={colorName}
            onChange={(e) => onColorName(e.target.value)}
            placeholder={recipe.name}
            className="rounded-md border border-hairline-strong bg-surface-2 px-3 py-2.5 font-sans text-[13px] text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="font-sans text-[11px] leading-snug text-fg-faint">
            {colorIncluded
              ? "We'll seed this from the recipe — override if your pour came out different."
              : 'Colour data is only saved when every source has a hex; the name is dropped otherwise.'}
          </div>
        </div>

        {/* pattern row (collapsed) */}
        <div className="flex items-center justify-between rounded-sm border border-dashed border-hairline bg-surface px-3 py-2.5 font-sans text-[12px] text-fg-muted">
          <span>
            <span className="text-fg">colorPattern</span> · solid
          </span>
          <span className="font-mono text-[10px] tracking-[0.5px] text-fg-faint">
            {colorIncluded ? 'included' : 'omitted'}
          </span>
        </div>

        {/* commit */}
        <div className="mt-auto flex flex-col gap-2">
          <button
            type="button"
            onClick={onRegister}
            disabled={isPending}
            className="rounded-md bg-accent px-3 py-3 font-sans text-[13.5px] font-semibold text-accent-ink shadow-sm disabled:opacity-50"
          >
            {isPending ? 'Registering…' : 'Register mix →'}
          </button>
          <button
            type="button"
            onClick={onBack}
            disabled={isPending}
            className="rounded-sm border border-hairline px-3 py-2 font-sans text-[12px] text-fg-muted hover:text-fg disabled:opacity-50"
          >
            ← Back to entries
          </button>
        </div>
      </div>
    </div>
  );
}
