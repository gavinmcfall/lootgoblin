'use client';
// AmbiguousDetail — modal dialog for picking a source Loot from candidates.
// Full a11y: role=dialog, aria-modal, aria-labelledby, Escape handler,
// focus capture on open, focus restore on close, Tab focus trap.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EmptyHint } from '@/components/shell/atoms';
import { ConfidenceBar } from './ConfidenceBar';
import type { PairingCandidate } from './PairingAmbiguousRow';

// ---------------------------------------------------------------------------
// Candidate Loot DTO (from GET /api/v1/loot/:id)
// ---------------------------------------------------------------------------

interface LootDto {
  id: string;
  name: string;
  thumbnailUrl?: string | null;
}

async function fetchLoot(lootId: string): Promise<LootDto> {
  const res = await fetch(`/api/v1/loot/${lootId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // The loot endpoint returns { loot: LootDto }
  const json = (await res.json()) as { loot: LootDto };
  return json.loot;
}

// ---------------------------------------------------------------------------
// Focus trap helper — cycles Tab/Shift+Tab within the dialog.
// ---------------------------------------------------------------------------

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function trapFocus(container: HTMLElement, event: KeyboardEvent) {
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;

  if (event.key === 'Tab') {
    if (event.shiftKey) {
      if (document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CandidateRow — fetches and renders a single candidate.
// ---------------------------------------------------------------------------

function CandidateRow({
  candidate,
  rank,
  onPick,
  picking,
}: {
  candidate: PairingCandidate;
  rank: number;
  onPick: (lootId: string) => void;
  picking: string | null;
}) {
  const lootQ = useQuery({
    queryKey: ['loot', candidate.lootId],
    queryFn: () => fetchLoot(candidate.lootId),
    staleTime: 30_000,
  });

  const name = lootQ.data?.name ?? candidate.lootId.slice(0, 12) + '…';
  const isFirst = rank === 0;
  const isPicking = picking === candidate.lootId;

  return (
    <div
      className={`grid items-center gap-3.5 rounded border p-3 ${
        isFirst ? 'border-hairline-strong bg-surface-2' : 'border-hairline bg-surface'
      }`}
      style={{ gridTemplateColumns: '1fr auto 80px' }}
    >
      <div>
        <div className={`font-mono text-[12px] text-fg ${isFirst ? 'font-semibold' : 'font-normal'}`}>
          {isFirst && <span className="text-running mr-2">★</span>}
          {name}
        </div>
        {lootQ.isError && (
          <div className="mt-0.5 font-sans text-[10.5px] text-danger">Could not load details</div>
        )}
        {candidate.evidence && candidate.evidence.length > 0 && (
          <div className="mt-0.5 font-sans text-[10.5px] italic text-fg-faint">
            {candidate.evidence.slice(0, 2).join(' · ')}
          </div>
        )}
      </div>

      <ConfidenceBar confidence={candidate.confidence} width={80} />

      <button
        type="button"
        onClick={() => onPick(candidate.lootId)}
        disabled={picking !== null}
        className={`rounded px-3 py-1.5 font-sans text-[11.5px] font-medium transition-colors ${
          isFirst
            ? 'bg-accent text-accent-ink border-none hover:opacity-90'
            : 'bg-transparent text-fg-muted border border-hairline hover:border-hairline-strong'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {isPicking ? 'Picking…' : 'Pick'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AmbiguousDetail dialog
// ---------------------------------------------------------------------------

interface AmbiguousDetailProps {
  pendingPairingId: string;
  filename: string;
  confidence: number;
  candidates: PairingCandidate[];
  onClose: () => void;
  onResolved: () => void;
}

export function AmbiguousDetail({
  pendingPairingId,
  filename,
  confidence,
  candidates,
  onClose,
  onResolved,
}: AmbiguousDetailProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Capture the element that triggered the modal so we can restore focus.
  useEffect(() => {
    triggerRef.current = document.activeElement;
  }, []);

  // Focus first focusable element when dialog mounts.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const focusable = el.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus();
  }, []);

  // Escape handler + Tab trap.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (dialogRef.current) {
        trapFocus(dialogRef.current, event);
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Restore focus on unmount.
  useEffect(() => {
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement) {
        trigger.focus();
      }
    };
  }, []);

  async function handlePick(lootId: string) {
    setPicking(lootId);
    try {
      const res = await fetch(`/api/v1/forge/pending-pairings/${pendingPairingId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceLootId: lootId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'pending-pairing-already-resolved') {
          toast.info('Already resolved by another action');
        } else {
          toast.error('Failed to resolve pairing — try again');
        }
        setPicking(null);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['forge', 'pending-pairings'] });
      toast.success(`${filename} paired`);
      onResolved();
    } catch {
      toast.error('Network error — try again');
      setPicking(null);
    }
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ambiguous-detail-title"
        className="w-full max-w-[720px] mx-4 rounded-lg border border-hairline bg-surface shadow-lg overflow-hidden"
      >
        {/* Header */}
        <div className="border-b border-hairline bg-running-bg px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="w-[7px] h-[7px] rounded-full bg-running shrink-0" />
            <span className="font-mono text-[10.5px] uppercase tracking-[1.4px] text-running font-semibold">
              Ambiguous · {Math.round(confidence * 100)}% confidence
            </span>
          </div>
          <h2
            id="ambiguous-detail-title"
            className="mt-1 font-serif italic text-[22px] text-fg leading-tight m-0"
          >
            Which source is this from?
          </h2>
          <div className="mt-1 font-mono text-[11px] text-fg-muted">{filename}</div>
        </div>

        {/* Candidates list */}
        <div className="p-5">
          <div className="font-mono text-[9.5px] uppercase tracking-[1.2px] text-fg-faint mb-3">
            candidates
          </div>
          {candidates.length === 0 ? (
            <EmptyHint>No candidates available — use the unknown flow instead.</EmptyHint>
          ) : (
            <div className="flex flex-col gap-2">
              {candidates.map((c, i) => (
                <CandidateRow
                  key={c.lootId}
                  candidate={c}
                  rank={i}
                  onPick={handlePick}
                  picking={picking}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 border-t border-hairline bg-surface-2 px-5 py-3">
          {/* Skip closes the dialog without resolving. For an explicit skip/quarantine
              action see PairingUnknownRow. TODO(forge-skip-endpoint): backend has no
              POST /api/v1/forge/pending-pairings/[id]/skip yet. */}
          <button
            type="button"
            onClick={onClose}
            disabled={picking !== null}
            className="rounded border border-hairline bg-transparent px-4 py-1.5 font-sans text-[12px] text-fg-muted hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
