// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Step 3 — Template (the mock's Schema step, ONE take, not the A/B comparator).
// Renders one card per preview option with REAL predictedLootCount /
// collisionCount / incompatibleCount + up to 5 example resolved paths.
// A heuristic "Recommended" badge marks the UI-derived best pick (fewest
// collisions, then most predicted loot) — NOT a backend field.
// DROPPED: named template cards, verdict blurbs, file-tree comparator — fiction.

import { Loader2 } from 'lucide-react';
import { StepMasthead } from './StepMasthead';
import { AdoptionReadingRail, RailBlock } from './AdoptionReadingRail';
import { MetaBadge } from '@/components/shell/atoms';
import { recommendedTemplate, type TemplateOptionDto } from './types';

export function AdoptionTemplateStep({
  options,
  patternDetected,
  isLoading,
  error,
  chosenTemplate,
  onChoose,
  onBack,
  onNext,
}: {
  options: TemplateOptionDto[];
  patternDetected: boolean;
  isLoading: boolean;
  error: string | null;
  chosenTemplate: string | null;
  onChoose: (template: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const recommended = recommendedTemplate(options);

  return (
    <div className="flex min-w-0 flex-1 gap-7">
      <div className="min-w-0 flex-1">
        <StepMasthead
          kw="STEP 3 · TEMPLATE"
          title="Pick a shape."
          sub="Each option lays out the same folders differently. We previewed the real moves for you."
        />

        {!patternDetected && options.length > 0 && (
          <div className="mb-4 rounded-md border border-dashed border-hairline bg-surface-2 px-4 py-2.5 font-serif text-[12.5px] italic text-fg-muted">
            No clear folder pattern was detected, so these are starter templates rather than ones
            derived from your existing layout.
          </div>
        )}

        {error ? (
          <div className="rounded-md border border-danger bg-danger-bg px-4 py-3 font-serif text-[13px] text-danger">
            {error}
          </div>
        ) : isLoading ? (
          <div className="flex items-center gap-3 rounded-lg border border-hairline bg-surface px-5 py-8 font-serif text-[14px] italic text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin text-accent" strokeWidth={2} />
            Previewing how each template would resolve…
          </div>
        ) : options.length === 0 ? (
          <div className="rounded-md border border-dashed border-hairline bg-surface-2 px-6 py-10 text-center font-serif text-[14px] italic text-fg-faint">
            No template options were returned for this selection.
          </div>
        ) : (
          <div className="grid gap-3.5 md:grid-cols-2 lg:grid-cols-3">
            {options.map((opt) => {
              const isRec = opt.template === recommended;
              const isChosen = opt.template === chosenTemplate;
              return (
                <button
                  type="button"
                  key={opt.template}
                  onClick={() => onChoose(opt.template)}
                  className={`flex flex-col gap-3.5 rounded-lg border p-5 text-left transition-colors ${
                    isChosen
                      ? 'border-accent bg-accent-soft'
                      : isRec
                        ? 'border-accent-edge bg-surface hover:bg-surface-hi'
                        : 'border-hairline bg-surface hover:bg-surface-hi'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
                      Template
                    </span>
                    <span className="flex items-center gap-1.5">
                      {isRec && <MetaBadge tone="accent">Recommended</MetaBadge>}
                      {isChosen && <MetaBadge tone="success">Chosen</MetaBadge>}
                    </span>
                  </div>

                  <code className="block overflow-hidden text-ellipsis whitespace-nowrap rounded-sm border border-hairline bg-bg px-2.5 py-2 font-mono text-[10.5px] text-fg">
                    {opt.template}
                  </code>

                  <dl className="m-0 grid grid-cols-1 gap-1.5 font-mono text-[10.5px]">
                    <div className="flex justify-between border-b border-dashed border-hairline py-1">
                      <dt className="text-fg-faint">predicted loot</dt>
                      <dd className="m-0 text-fg">{opt.predictedLootCount}</dd>
                    </div>
                    <div className="flex justify-between border-b border-dashed border-hairline py-1">
                      <dt className="text-fg-faint">collisions</dt>
                      <dd className={`m-0 ${opt.collisionCount > 0 ? 'text-running' : 'text-fg'}`}>
                        {opt.collisionCount}
                      </dd>
                    </div>
                    <div className="flex justify-between border-b border-dashed border-hairline py-1">
                      <dt className="text-fg-faint">incompatible</dt>
                      <dd className={`m-0 ${opt.incompatibleCount > 0 ? 'text-running' : 'text-fg'}`}>
                        {opt.incompatibleCount}
                      </dd>
                    </div>
                  </dl>

                  {opt.examples.length > 0 && (
                    <div>
                      <div className="mb-1 font-mono text-[9px] uppercase tracking-[1.2px] text-fg-faint">
                        Example moves
                      </div>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {opt.examples.map((ex) => (
                          <li
                            key={ex.candidateId}
                            className="truncate font-mono text-[10px] text-fg-muted"
                            title={ex.resolvedPath}
                          >
                            → {ex.resolvedPath}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-md border border-hairline px-3.5 py-2 font-sans text-[12.5px] text-fg-muted hover:text-fg"
          >
            ← Back to select
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!chosenTemplate}
            className="rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next: review and apply →
          </button>
        </div>
      </div>

      <AdoptionReadingRail>
        <RailBlock kw="REAL PREVIEW" title="These numbers are dry-run.">
          Each card was computed by resolving your selected folders against that template — the
          counts and example paths are what would actually happen. Nothing is committed yet.
        </RailBlock>
        <RailBlock kw="COLLISIONS" title="Two folders, one destination.">
          A collision means a template would send two items to the same path. They are surfaced as a
          count here so you can pick a shape with fewer of them.
        </RailBlock>
        <RailBlock kw="RECOMMENDED" title="A simple heuristic.">
          We mark the option with the fewest collisions (then the most predicted loot) as
          Recommended. It is a UI hint, not a backend verdict — pick whichever fits your hoard.
        </RailBlock>
      </AdoptionReadingRail>
    </div>
  );
}
