// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Step 2 — Select candidates (folds the mock's Classify step).
// A table of real scan candidates with a checkbox per row + select-all.
// Default = all selected. NO per-file Sorter, kind/signal columns, override
// dropdown, rule-promotion, or held/ambiguous taxonomy — none exist in the API.
// A low-confidence row gets a subtle running-toned confidence chip only.

import { StepMasthead } from './StepMasthead';
import { AdoptionReadingRail, RailBlock } from './AdoptionReadingRail';
import { MetaBadge } from '@/components/shell/atoms';
import { formatBytes, confidenceTone, type CandidateDto } from './types';

export function AdoptionSelectStep({
  candidates,
  selectedIds,
  onToggle,
  onToggleAll,
  onBack,
  onNext,
}: {
  candidates: CandidateDto[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (next: boolean) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const allSelected = candidates.length > 0 && selectedIds.size === candidates.length;
  const selectedCount = selectedIds.size;

  return (
    <div className="flex min-w-0 flex-1 gap-7">
      <div className="min-w-0 flex-1">
        <StepMasthead
          kw="STEP 2 · SELECT"
          title="Choose what to adopt."
          sub="Every folder the walk found. Untick anything you want to leave behind."
          right={
            <span className="font-mono text-[10px] text-fg-faint">
              {selectedCount} of {candidates.length} selected
            </span>
          }
        />

        {candidates.length === 0 ? (
          <div className="rounded-md border border-dashed border-hairline bg-surface-2 px-6 py-10 text-center font-serif text-[14px] italic text-fg-faint">
            The walk found no adoptable folders in this stash root.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
            <div className="grid grid-cols-[28px_1fr_90px_90px_minmax(120px,1fr)] items-center gap-3 bg-surface-2 px-4 py-2.5 font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint">
              <label className="flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onToggleAll(e.target.checked)}
                  aria-label="Select all folders"
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
              </label>
              <span>Folder</span>
              <span>Files</span>
              <span>Size</span>
              <span>Classification</span>
            </div>

            {candidates.map((c) => {
              const checked = selectedIds.has(c.id);
              const tone = confidenceTone(c.classification.confidence);
              return (
                <label
                  key={c.id}
                  className={`grid cursor-pointer grid-cols-[28px_1fr_90px_90px_minmax(120px,1fr)] items-center gap-3 border-t border-hairline px-4 py-3 transition-colors hover:bg-surface-hi ${
                    checked ? '' : 'opacity-60'
                  }`}
                >
                  <span className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(c.id)}
                      aria-label={`Select ${c.folderRelativePath}`}
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[11.5px] text-fg" title={c.folderRelativePath}>
                      {c.folderRelativePath || '/'}
                    </span>
                    {c.classification.title && (
                      <span className="block truncate font-serif text-[12px] italic text-fg-muted">
                        {c.classification.title}
                        {c.classification.creator ? ` · ${c.classification.creator}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] text-fg-muted">{c.fileCount}</span>
                  <span className="font-mono text-[11px] text-fg-muted">
                    {formatBytes(c.totalBytes)}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <MetaBadge tone={tone}>
                      conf {c.classification.confidence.toFixed(2)}
                    </MetaBadge>
                    {c.classification.providerHits.slice(0, 3).map((hit) => (
                      <MetaBadge key={hit} tone="neutral">
                        {hit}
                      </MetaBadge>
                    ))}
                    {!c.classification.title && c.classification.providerHits.length === 0 && (
                      <span className="font-mono text-[10.5px] text-fg-faint">—</span>
                    )}
                  </span>
                </label>
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
            ← Back to scan
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={selectedCount === 0}
            className="rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next: pick a template →
          </button>
        </div>
      </div>

      <AdoptionReadingRail>
        <RailBlock kw="ONE ROW PER FOLDER" title="Folders, not files.">
          The walk groups files into candidate models — usually one folder each. You choose which
          folders to adopt; the files inside come along with their folder.
        </RailBlock>
        <RailBlock kw="CONFIDENCE" title="How sure the classifier is.">
          A low-confidence chip means we could read little metadata from that folder. It is still
          fully adoptable — the score is a hint, not a gate.
        </RailBlock>
        <RailBlock kw="PROVIDER HITS" title="Where the metadata came from.">
          Badges show which sources contributed (a 3MF embed, a sidecar, a filename pattern). No
          hits just means a plain folder with no recognised metadata.
        </RailBlock>
      </AdoptionReadingRail>
    </div>
  );
}
