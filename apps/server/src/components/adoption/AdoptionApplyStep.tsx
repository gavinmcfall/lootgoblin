'use client';
// Step 4 — Apply (the mock's Dry-run + Apply collapsed).
// Shows the chosen template's REAL preview summary as the final "here is what
// will happen", a required Collection name, and a mode selector
// (copy-then-cleanup default vs in-place). Fires POST .../adoption/apply.
// Synchronous apply → quiet "applying…" state (NO live tail / phase bars /
// hardlink timings — fiction). On success renders the ApplyReportDto, with
// errors[] as the honest "stuck items" panel.

import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { StepMasthead } from './StepMasthead';
import { AdoptionReadingRail, RailBlock } from './AdoptionReadingRail';
import { MetaBadge } from '@/components/shell/atoms';
import type { AdoptionMode, ApplyReportDto, TemplateOptionDto } from './types';

function ModeOption({
  value,
  current,
  onSelect,
  title,
  blurb,
}: {
  value: AdoptionMode;
  current: AdoptionMode;
  onSelect: (m: AdoptionMode) => void;
  title: string;
  blurb: string;
}) {
  const active = value === current;
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-md border p-3.5 transition-colors ${
        active ? 'border-accent-edge bg-accent-soft' : 'border-hairline bg-surface hover:bg-surface-hi'
      }`}
    >
      <input
        type="radio"
        name="adoption-mode"
        value={value}
        checked={active}
        onChange={() => onSelect(value)}
        className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
      />
      <span className="min-w-0">
        <span className={`block text-[13px] font-semibold ${active ? 'text-fg' : 'text-fg-muted'}`}>
          {title}
        </span>
        <span className="mt-0.5 block font-serif text-[12px] italic leading-snug text-fg-muted">
          {blurb}
        </span>
      </span>
    </label>
  );
}

export function AdoptionApplyStep({
  chosenOption,
  selectedCount,
  collectionName,
  onCollectionName,
  mode,
  onMode,
  onApply,
  isApplying,
  error,
  report,
  onBack,
}: {
  chosenOption: TemplateOptionDto | null;
  selectedCount: number;
  collectionName: string;
  onCollectionName: (v: string) => void;
  mode: AdoptionMode;
  onMode: (m: AdoptionMode) => void;
  onApply: () => void;
  isApplying: boolean;
  error: string | null;
  report: ApplyReportDto | null;
  onBack: () => void;
}) {
  // ── Success: render the report ─────────────────────────────────────────────
  if (report) {
    return (
      <div className="flex min-w-0 flex-1 gap-7">
        <div className="min-w-0 flex-1">
          <StepMasthead
            kw="STEP 4 · APPLIED"
            title="Adopted."
            sub="The collection is created and your selected folders are now Loot."
          />

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-success bg-success-bg p-4">
              <div className="font-mono text-[9px] uppercase tracking-[1.4px] text-success">
                Adopted
              </div>
              <div className="mt-1 font-serif text-[30px] leading-none tracking-[-0.6px] text-fg">
                {report.adoptedCount}
              </div>
            </div>
            <div className="rounded-lg border border-hairline bg-surface p-4">
              <div className="font-mono text-[9px] uppercase tracking-[1.4px] text-fg-faint">
                Skipped
              </div>
              <div className="mt-1 font-serif text-[30px] leading-none tracking-[-0.6px] text-fg">
                {report.skippedCount}
              </div>
            </div>
            <div
              className={`rounded-lg border p-4 ${report.errors.length > 0 ? 'border-danger bg-danger-bg' : 'border-hairline bg-surface'}`}
            >
              <div
                className={`font-mono text-[9px] uppercase tracking-[1.4px] ${report.errors.length > 0 ? 'text-danger' : 'text-fg-faint'}`}
              >
                Stuck
              </div>
              <div className="mt-1 font-serif text-[30px] leading-none tracking-[-0.6px] text-fg">
                {report.errors.length}
              </div>
            </div>
          </div>

          {report.errors.length > 0 && (
            <div className="mt-5 overflow-hidden rounded-lg border border-danger/40 bg-surface">
              <div className="flex items-center justify-between border-b border-hairline bg-surface-2 px-4 py-2.5">
                <span className="font-serif text-[15px] tracking-[-0.3px] text-fg">Stuck items</span>
                <MetaBadge tone="danger">{report.errors.length}</MetaBadge>
              </div>
              <ul className="m-0 list-none p-0">
                {report.errors.map((e, i) => (
                  <li
                    key={`${e.candidateId}-${i}`}
                    className="border-t border-dashed border-hairline px-4 py-3 first:border-t-0"
                  >
                    <div className="font-mono text-[11px] text-fg">{e.candidateId}</div>
                    <div className="mt-1 font-serif text-[12.5px] italic text-fg-muted">
                      {e.reason}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-6 flex items-center gap-3">
            <Link
              href="/stash"
              className="rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink shadow-sm hover:opacity-90"
            >
              Open the Stash →
            </Link>
            <Link
              href="/hoard"
              className="rounded-md border border-hairline px-3.5 py-2 font-sans text-[12.5px] text-fg-muted hover:text-fg"
            >
              Back to Hoard
            </Link>
          </div>
        </div>

        <AdoptionReadingRail>
          <RailBlock kw="WHAT IS NEW" title="A collection of Loot.">
            Your selected folders are now Loot rows inside a new collection. Open the Stash to see
            them alongside the adoption event in your ledger.
          </RailBlock>
          <RailBlock kw="STUCK ITEMS" title="Honest, after the fact.">
            Anything that could not be adopted is listed above with its real reason. The rest still
            went through — adoption does not roll back on a single failure.
          </RailBlock>
          <RailBlock kw="SKIPPED" title="Expected, not errors.">
            Skipped folders had nothing adoptable (missing fields, a collision). They are counted
            separately from stuck items, which are genuine failures.
          </RailBlock>
        </AdoptionReadingRail>
      </div>
    );
  }

  // ── Pre-apply: review + form ───────────────────────────────────────────────
  const canApply = collectionName.trim().length > 0 && selectedCount > 0 && !isApplying;

  return (
    <div className="flex min-w-0 flex-1 gap-7">
      <div className="min-w-0 flex-1">
        <StepMasthead
          kw="STEP 4 · APPLY"
          title="Here is what will happen."
          sub="Review the plan, name the collection, and choose how the files move."
        />

        {chosenOption && (
          <div className="mb-5 rounded-lg border border-hairline bg-surface p-5">
            <code className="block overflow-hidden text-ellipsis whitespace-nowrap rounded-sm border border-hairline bg-bg px-2.5 py-2 font-mono text-[10.5px] text-fg">
              {chosenOption.template}
            </code>
            <div className="mt-3 grid grid-cols-3 gap-3 font-mono text-[11px]">
              <div>
                <div className="text-fg-faint">predicted loot</div>
                <div className="mt-0.5 font-serif text-[22px] tracking-[-0.4px] text-fg">
                  {chosenOption.predictedLootCount}
                </div>
              </div>
              <div>
                <div className="text-fg-faint">collisions</div>
                <div
                  className={`mt-0.5 font-serif text-[22px] tracking-[-0.4px] ${chosenOption.collisionCount > 0 ? 'text-running' : 'text-fg'}`}
                >
                  {chosenOption.collisionCount}
                </div>
              </div>
              <div>
                <div className="text-fg-faint">incompatible</div>
                <div
                  className={`mt-0.5 font-serif text-[22px] tracking-[-0.4px] ${chosenOption.incompatibleCount > 0 ? 'text-running' : 'text-fg'}`}
                >
                  {chosenOption.incompatibleCount}
                </div>
              </div>
            </div>
            {chosenOption.examples.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-[1.2px] text-fg-faint">
                  Example moves
                </div>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {chosenOption.examples.map((ex) => (
                    <li
                      key={ex.candidateId}
                      className="truncate font-mono text-[10.5px] text-fg-muted"
                      title={ex.resolvedPath}
                    >
                      → {ex.resolvedPath}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="mb-5">
          <label
            htmlFor="adoption-collection-name"
            className="mb-1.5 block font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint"
          >
            Collection name
          </label>
          <input
            id="adoption-collection-name"
            type="text"
            value={collectionName}
            maxLength={200}
            onChange={(e) => onCollectionName(e.target.value)}
            className="w-full rounded-md border border-hairline bg-surface px-3 py-2 font-sans text-[14px] text-fg outline-none focus:border-accent-edge"
            placeholder="Name this collection"
          />
        </div>

        <div className="mb-6">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[1.2px] text-fg-faint">
            How to move the files
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <ModeOption
              value="copy-then-cleanup"
              current={mode}
              onSelect={onMode}
              title="Copy, verify, then clean up"
              blurb="Copies to the destination, verifies each file, then removes the originals. Safest."
            />
            <ModeOption
              value="in-place"
              current={mode}
              onSelect={onMode}
              title="Adopt in place"
              blurb="Registers the files where they already live. Fastest, but the stash root layout stays as-is."
            />
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-danger bg-danger-bg px-4 py-3 font-serif text-[13px] text-danger">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            disabled={isApplying}
            className="rounded-md border border-hairline px-3.5 py-2 font-sans text-[12.5px] text-fg-muted hover:text-fg disabled:opacity-40"
          >
            ← Back to template
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={!canApply}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2.5 font-sans text-[13.5px] font-semibold text-accent-ink shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isApplying && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />}
            {isApplying ? 'Adopting…' : `Adopt ${selectedCount} folder${selectedCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      <AdoptionReadingRail>
        <RailBlock kw="ONE SHOT" title="Apply runs synchronously.">
          The adoption happens in a single request and finishes before this page updates. There is
          no live tail to watch — the result arrives all at once.
        </RailBlock>
        <RailBlock kw="COPY-THEN-CLEANUP" title="The safe default.">
          Files are copied to the destination and verified before the originals are removed. If
          anything fails mid-way, your source files are still intact.
        </RailBlock>
        <RailBlock kw="ONE TIME" title="The proposal is consumed.">
          Applying uses up this proposal. If you need to adopt again, start a fresh scan from the
          stash root.
        </RailBlock>
      </AdoptionReadingRail>
    </div>
  );
}
