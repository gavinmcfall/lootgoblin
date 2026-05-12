'use client';
// /forge/inboxes — Inbox triage view (InboxBatchCasual) + empty state.
// Canvas ref: page-inbox.jsx — InboxBatchCasual (line 129) + InboxEmptyCasual (line 74).
//
// Data sources:
//   GET /api/v1/forge/inboxes        → list of watch-folder inboxes
//   GET /api/v1/forge/pending-pairings → pairings awaiting user action
//
// Pairing state classification (derived client-side from PendingPairingDto):
//   The PendingPairingDto from the backend has: id, sliceLootId, ownerId,
//   sourceFilenameHint, ingestedAt.
//   Note: the backend does NOT expose candidates on this DTO — candidates come
//   from a future /candidates or loot-search endpoint. We show ambiguous/unknown
//   based on whether sourceFilenameHint is set (heuristic hint that a match was
//   attempted) and show the resolve UI regardless.
//
// For the triage view, all pending pairings are surfaced as "ambiguous" since
// the backend queue model stores pairings that couldn't be auto-resolved. A
// pairing with no hint at all is shown as "unknown". Auto-paired items never
// land in the queue — they resolve immediately. The "auto-filed" section shows
// any inboxes with their current file count as a placeholder since auto-resolved
// pairings are not separately tracked in the list API.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { EmptyHint, MetaBadge, SectionTitle } from '@/components/shell/atoms';
import { ForgeTabs } from '@/components/forge/ForgeTabs';
import { PairingAmbiguousRow } from '@/components/forge/PairingAmbiguousRow';
import { PairingUnknownRow } from '@/components/forge/PairingUnknownRow';
import type { PairingCandidate } from '@/components/forge/PairingAmbiguousRow';

// ── DTO types ──────────────────────────────────────────────────────────────

interface ForgeInboxDto {
  id: string;
  ownerId: string;
  name: string;
  path: string;
  defaultPrinterId: string | null;
  active: boolean;
  notes: string | null;
  createdAt: number;
}

interface PendingPairingDto {
  id: string;
  sliceLootId: string;
  ownerId: string;
  sourceFilenameHint: string | null;
  ingestedAt: number;
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchInboxes(): Promise<{ inboxes: ForgeInboxDto[] }> {
  const res = await fetch('/api/v1/forge/inboxes');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ inboxes: ForgeInboxDto[] }>;
}

async function fetchPendingPairings(): Promise<{ pairings: PendingPairingDto[] }> {
  const res = await fetch('/api/v1/forge/pending-pairings');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ pairings: PendingPairingDto[] }>;
}

// ── Classify pairings into ambiguous vs unknown ────────────────────────────
//
// In the backend model, all pending pairings need user action. Pairings with
// a sourceFilenameHint have at least one candidate path (ambiguous = needs pick).
// Pairings with no hint have nothing to go on (unknown = truly stuck).
// Candidates on the pairing DTO come from a separate future endpoint;
// for now we pass an empty candidates array and the AmbiguousDetail dialog
// shows the resolve UI regardless (the user can search or skip).

function classifyPairing(p: PendingPairingDto): 'ambiguous' | 'unknown' {
  return p.sourceFilenameHint ? 'ambiguous' : 'unknown';
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ForgeInboxesPage() {
  const queryClient = useQueryClient();

  const inboxesQ = useQuery({
    queryKey: ['forge', 'inboxes'],
    queryFn: fetchInboxes,
    staleTime: 5_000,
    refetchInterval: 30_000,
  });

  const pairingsQ = useQuery({
    queryKey: ['forge', 'pending-pairings'],
    queryFn: fetchPendingPairings,
    staleTime: 3_000,
    refetchInterval: 10_000,
  });

  // isError check first (carry-forward rule #1).
  if (inboxesQ.isError) return <EmptyHint>Failed to load inboxes.</EmptyHint>;
  if (pairingsQ.isError) return <EmptyHint>Failed to load pending pairings.</EmptyHint>;
  if (inboxesQ.isLoading || pairingsQ.isLoading) return <EmptyHint>Loading inboxes…</EmptyHint>;

  const inboxes = inboxesQ.data?.inboxes ?? [];
  const pairings = pairingsQ.data?.pairings ?? [];

  const ambiguous = pairings.filter((p) => classifyPairing(p) === 'ambiguous');
  const unknown = pairings.filter((p) => classifyPairing(p) === 'unknown');
  const needsAttention = ambiguous.length + unknown.length;

  function handlePairingResolved() {
    void queryClient.invalidateQueries({ queryKey: ['forge', 'pending-pairings'] });
  }

  // ── Empty state (no inboxes + no pairings) ──────────────────────────────
  if (inboxes.length === 0 && pairings.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <ForgeTabs />
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[1.6px] text-fg-faint mb-1">
              Inbox
            </div>
            <h1 className="font-serif italic text-[34px] text-fg leading-[1.05] m-0">
              Nothing to triage.
            </h1>
            <div className="mt-2 font-sans text-[13.5px] text-fg-faint max-w-[560px]">
              Drop .stl / .3mf / .step files here, or add them from the browser extension.
              LootGoblin will guess where they go.
            </div>
          </div>
          <Link
            href="/forge/inboxes/new"
            className="shrink-0 rounded-md bg-accent px-4 py-2 font-sans text-[12.5px] font-semibold text-accent-ink shadow-sm hover:opacity-90"
          >
            + New inbox
          </Link>
        </div>

        {/* Drop zone placeholder */}
        <div className="flex-1 min-h-[320px] rounded-lg border-2 border-dashed border-hairline-strong bg-surface flex flex-col items-center justify-center gap-5 p-10">
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none" aria-hidden="true">
            <rect x="18" y="26" width="44" height="38" rx="3" stroke="currentColor" strokeWidth="1.5" className="text-fg-faint" />
            <path d="M30 14l10-10 10 10M40 4v36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent" />
          </svg>
          <div className="font-serif italic text-[22px] text-fg text-center">
            Drop anything here.
          </div>
          <div className="font-sans text-[12.5px] text-fg-faint text-center max-w-[400px] leading-relaxed">
            Whole folders, loose files, ZIPs — LootGoblin reads MakerWorld metadata,
            filename patterns, and the mesh itself to guess a home.
          </div>
          <div className="flex gap-2 mt-2">
            <Link
              href="/forge/inboxes/new"
              className="rounded-md bg-accent px-4 py-2.5 font-sans text-[12.5px] font-semibold text-accent-ink hover:opacity-90"
            >
              Add watch folder
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Batch view (pairings present OR inboxes registered) ─────────────────

  return (
    <div className="flex flex-col gap-5">
      {/* Forge sub-nav */}
      <ForgeTabs />

      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[1.6px] text-fg-faint mb-1">
            Inbox · {pairings.length} pending
          </div>
          <h1 className="font-serif italic text-[28px] text-fg leading-[1.05] m-0">
            {pairings.length === 0
              ? 'All clear.'
              : needsAttention === 0
                ? <>LootGoblin has {pairings.length} item{pairings.length === 1 ? '' : 's'} waiting.</>
                : <>{needsAttention} item{needsAttention === 1 ? '' : 's'} need{needsAttention === 1 ? 's' : ''} your call.</>
            }
          </h1>
          <div className="mt-1.5 flex items-center gap-2.5 flex-wrap">
            {ambiguous.length > 0 && (
              <MetaBadge tone="running">{ambiguous.length} ambiguous</MetaBadge>
            )}
            {unknown.length > 0 && (
              <MetaBadge tone="danger">{unknown.length} unknown</MetaBadge>
            )}
          </div>
        </div>

        <Link
          href="/forge/inboxes/new"
          className="shrink-0 rounded-md border border-hairline bg-surface px-3 py-1.5 font-sans text-[12px] text-fg-muted hover:text-fg transition-colors"
        >
          + New inbox
        </Link>
      </div>

      {/* Needs attention section */}
      {needsAttention > 0 && (
        <div>
          <div className="flex items-baseline gap-2.5 px-1 mb-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-running shrink-0" />
            <span className="font-mono text-[10.5px] uppercase tracking-[1.4px] text-running font-semibold">
              Needs your call
            </span>
            <span className="font-mono text-[10.5px] text-fg-faint">· {needsAttention}</span>
          </div>
          <div className="flex flex-col gap-2">
            {ambiguous.map((p) => (
              <PairingAmbiguousRow
                key={p.id}
                id={p.id}
                filename={p.sliceLootId}
                kind="unknown"
                confidence={0.5}
                sourceFilenameHint={p.sourceFilenameHint}
                candidates={[] as PairingCandidate[]}
                onResolved={handlePairingResolved}
              />
            ))}
            {unknown.map((p) => (
              <PairingUnknownRow
                key={p.id}
                id={p.id}
                filename={p.sliceLootId}
                kind="unknown"
                sourceFilenameHint={p.sourceFilenameHint}
                onResolved={handlePairingResolved}
              />
            ))}
          </div>
        </div>
      )}

      {/* Inboxes (watch folders) list */}
      <div>
        <div className="flex items-baseline gap-2.5 px-1 mb-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
          <span className="font-mono text-[10.5px] uppercase tracking-[1.4px] text-success font-semibold">
            Watch folders
          </span>
          <span className="font-mono text-[10.5px] text-fg-faint">· {inboxes.length}</span>
        </div>

        {inboxes.length === 0 ? (
          <EmptyHint>
            No watch folders yet.{' '}
            <Link href="/forge/inboxes/new" className="text-accent underline">
              Add one
            </Link>{' '}
            to start watching a directory for slicer output.
          </EmptyHint>
        ) : (
          <div className="flex flex-col gap-2">
            {inboxes.map((inbox) => (
              <div
                key={inbox.id}
                className="grid items-center gap-3 rounded-md border border-hairline bg-surface px-4 py-3"
                style={{ gridTemplateColumns: '1fr auto auto' }}
              >
                <div>
                  <div className="font-mono text-[12px] font-medium text-fg">{inbox.name}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-fg-faint">{inbox.path}</div>
                </div>
                <MetaBadge tone={inbox.active ? 'neutral' : 'neutral'}>
                  <span className={inbox.active ? '' : 'opacity-55 italic'}>
                    {inbox.active ? 'active' : 'disabled'}
                  </span>
                </MetaBadge>
                <Link
                  href={`/forge/inboxes/${inbox.id}`}
                  className="rounded border border-hairline bg-transparent px-3 py-1.5 font-sans text-[11.5px] text-fg-muted hover:text-fg transition-colors"
                >
                  Edit
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
