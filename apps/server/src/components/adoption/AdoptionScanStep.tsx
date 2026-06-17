// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Step 1 — Scan. Fires POST .../adoption/scan (synchronous; walks the disk).
// Honest loading state: a spinner + "walking…" copy. NO fabricated live
// counters / elapsed / dupes-orphans surprises — those are fiction in the mock.

import { Loader2, FolderSearch } from 'lucide-react';
import { StepMasthead } from './StepMasthead';
import { AdoptionReadingRail, RailBlock } from './AdoptionReadingRail';

export function AdoptionScanStep({
  rootName,
  onScan,
  isScanning,
  error,
}: {
  rootName: string;
  onScan: () => void;
  isScanning: boolean;
  error: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-1 gap-7">
      <div className="min-w-0 flex-1">
        <StepMasthead
          kw="STEP 1 · SCAN"
          title="Walk the disk."
          sub="A read-only pass over the folder — we just learn what lives there."
        />

        <div className="rounded-lg border border-hairline bg-surface p-8">
          {isScanning ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-accent" strokeWidth={1.5} />
              <div className="font-serif text-[20px] tracking-[-0.3px] text-fg">
                Walking {rootName}…
              </div>
              <p className="max-w-sm font-serif text-[13.5px] italic text-fg-muted">
                Listing files, grouping them into folders, and classifying what we find. Larger
                hoards take longer — this runs to completion before the next step.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <FolderSearch className="h-8 w-8 text-fg-faint" strokeWidth={1.5} />
              <div className="font-serif text-[20px] tracking-[-0.3px] text-fg">
                Ready to scan {rootName}.
              </div>
              <p className="max-w-sm font-serif text-[13.5px] italic text-fg-muted">
                We will read the folder top to bottom, group its files into candidate models, and
                classify each one. Nothing on disk changes.
              </p>
              <button
                type="button"
                onClick={onScan}
                className="mt-2 rounded-md bg-accent px-4 py-2.5 font-sans text-[13.5px] font-semibold text-accent-ink shadow-sm hover:opacity-90"
              >
                Start the walk
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-danger bg-danger-bg px-4 py-3 font-serif text-[13px] text-danger">
            {error}
          </div>
        )}
      </div>

      <AdoptionReadingRail>
        <RailBlock kw="WHAT HAPPENS" title="A read-only walk.">
          We list every file in the folder, group them into candidate models, and read whatever
          metadata we can (titles, creators, provider hits). Nothing on disk is moved or changed.
        </RailBlock>
        <RailBlock kw="SYNCHRONOUS" title="It runs to completion.">
          The scan finishes before you move on — there is no background job. A big folder can take a
          while; the spinner stays until the walk is done.
        </RailBlock>
        <RailBlock kw="NOTHING MOVES" title="Until you apply.">
          Scan, select, and template are all read-only. Files only move in the final apply step, and
          only for the folders you choose.
        </RailBlock>
      </AdoptionReadingRail>
    </div>
  );
}
