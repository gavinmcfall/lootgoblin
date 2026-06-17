// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Ambiguous row — 2+ candidates in 0.5–0.85 range. Clicking opens
// AmbiguousDetail dialog where the user picks a candidate.

import { MetaBadge } from '@/components/shell/atoms';
import { InboxKindIcon } from './InboxKindIcon';
import { ConfidenceBar } from './ConfidenceBar';
import { AmbiguousDetail } from './AmbiguousDetail';
import { pairingStateTone } from './inbox-labels';
import { useState } from 'react';

export interface PairingCandidate {
  lootId: string;
  confidence: number;
  evidence?: string[];
}

interface PairingAmbiguousRowProps {
  id: string;
  filename: string;
  kind: string;
  confidence: number;
  sourceFilenameHint: string | null;
  candidates: PairingCandidate[];
  onResolved: () => void;
}

export function PairingAmbiguousRow({
  id,
  filename,
  kind,
  confidence,
  sourceFilenameHint,
  candidates,
  onResolved,
}: PairingAmbiguousRowProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Row */}
      <div className="rounded-md border border-running bg-running-bg px-4 py-3.5 flex flex-col gap-3">
        <div className="grid items-start gap-3.5" style={{ gridTemplateColumns: '26px 1fr auto' }}>
          {/* kind icon — running tone */}
          <div className="flex justify-center mt-0.5 text-running">
            <InboxKindIcon kind={kind} size={22} />
          </div>

          {/* filename + why hint */}
          <div>
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-[12px] font-semibold text-fg">{filename}</span>
              <MetaBadge tone={pairingStateTone('ambiguous')}>ambiguous</MetaBadge>
            </div>
            {sourceFilenameHint && (
              <div className="mt-1 font-sans text-[12px] italic text-fg-muted">
                {sourceFilenameHint}
              </div>
            )}
          </div>

          {/* meta + confidence */}
          <div className="flex flex-col items-end gap-1">
            <ConfidenceBar confidence={confidence} width={60} />
            <span className="font-mono text-[10px] text-fg-faint">
              {candidates.length} candidate{candidates.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        {/* Resolve CTA */}
        <div className="flex justify-end pl-10">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded border border-running bg-transparent px-3 py-1.5 font-sans text-[11.5px] font-semibold text-running hover:bg-running hover:text-bg transition-colors"
          >
            Resolve…
          </button>
        </div>
      </div>

      {/* Modal */}
      {open && (
        <AmbiguousDetail
          pendingPairingId={id}
          filename={filename}
          confidence={confidence}
          candidates={candidates}
          onClose={() => setOpen(false)}
          onResolved={() => {
            setOpen(false);
            onResolved();
          }}
        />
      )}
    </>
  );
}
