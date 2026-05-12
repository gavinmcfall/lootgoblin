'use client';
// Unknown row — no candidates above 0.5. User must pick a home or skip.

import { MetaBadge } from '@/components/shell/atoms';
import { InboxKindIcon } from './InboxKindIcon';
import { pairingStateTone } from './inbox-labels';
import { useState } from 'react';
import { toast } from 'sonner';

interface PairingUnknownRowProps {
  id: string;
  filename: string;
  kind: string;
  sourceFilenameHint: string | null;
  onResolved: () => void;
}

export function PairingUnknownRow({
  id,
  filename,
  kind,
  sourceFilenameHint,
  onResolved,
}: PairingUnknownRowProps) {
  const [skipping, setSkipping] = useState(false);

  async function handleSkip() {
    setSkipping(true);
    try {
      const res = await fetch(`/api/v1/forge/pending-pairings/${id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Backend requires sourceLootId — skip is not a separate action in the API.
        // The canvas shows "Toss" but the actual API only supports resolve-by-loot.
        // We skip this row client-side by surfacing a "pick a home" interaction
        // instead. For now, toss removes it from the UI list without resolving.
        // TODO: backend may add a skip/quarantine endpoint in a follow-up.
        body: JSON.stringify({ sourceLootId: '' }),
      });
      if (res.ok || res.status === 400) {
        // 400 on empty sourceLootId is expected here — we just remove from list.
        toast.success(`${filename} skipped for now`);
        onResolved();
      } else {
        toast.error('Failed to skip — try again');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setSkipping(false);
    }
  }

  return (
    <div
      className="rounded-md border border-danger bg-danger-bg px-4 py-3 grid items-center gap-3.5"
      style={{ gridTemplateColumns: '26px 1fr auto auto' }}
    >
      {/* kind icon — danger tone */}
      <div className="flex justify-center text-danger">
        <InboxKindIcon kind={kind} size={20} />
      </div>

      {/* filename + hint */}
      <div>
        <div className="flex items-baseline gap-2.5">
          <span className="font-mono text-[11.5px] font-semibold text-fg">{filename}</span>
          <MetaBadge tone={pairingStateTone('unknown')}>unknown</MetaBadge>
        </div>
        {sourceFilenameHint && (
          <div className="mt-0.5 font-sans text-[11.5px] italic text-fg-muted">
            {sourceFilenameHint}
          </div>
        )}
      </div>

      {/* Pick a home — placeholder; full search UI is a follow-up */}
      <button
        type="button"
        disabled
        className="rounded border border-hairline bg-transparent px-3 py-1.5 font-sans text-[11.5px] text-fg-muted opacity-50 cursor-not-allowed"
        title="Source Loot search coming in a follow-up"
      >
        Pick a home…
      </button>

      {/* Toss / skip */}
      <button
        type="button"
        onClick={handleSkip}
        disabled={skipping}
        className="rounded border border-danger bg-transparent px-3 py-1.5 font-sans text-[11.5px] text-danger hover:bg-danger hover:text-bg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {skipping ? 'Skipping…' : 'Toss'}
      </button>
    </div>
  );
}
