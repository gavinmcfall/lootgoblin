// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// /ledger — the event-stream viewer.
//
// Visual language ported from planning/design-system/lib/page-receipts.jsx
// (serif italic mastheads, mono columns, hairline rules) but the design's
// receipts-and-money framing is fiction — the real backend is a generic
// event log with no cost data, no power, no amortisation. So we drop the
// dollar copy entirely and surface what's actually there: who did what,
// to which subject, when, and with what payload.

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { EmptyHint } from '@/components/shell/atoms';
import { LedgerFilters } from '@/components/ledger/LedgerFilters';
import { LedgerTable } from '@/components/ledger/LedgerTable';
import {
  EMPTY_FILTERS,
  type LedgerEventDto,
  type LedgerFilterState,
  type LedgerListResponseDto,
} from '@/components/ledger/types';

/** Page size sent to GET /api/v1/ledger (server max is 200; 50 is the default). */
const PAGE_LIMIT = 50;

/**
 * Build the query string the server expects. Date inputs (YYYY-MM-DD) are
 * widened to ISO Z timestamps at day boundaries; everything else is passed
 * through verbatim. Empty strings are dropped.
 *
 * `occurred_before` becomes the END of that local day so the bound is
 * inclusive — passing `2026-06-03` matches events up to and including the
 * 3rd.
 */
function buildQuery(filters: LedgerFilterState, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.subject_type) params.set('subject_type', filters.subject_type);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.actor_user_id) params.set('actor_user_id', filters.actor_user_id);
  if (filters.occurred_after) {
    const d = new Date(`${filters.occurred_after}T00:00:00`);
    if (!Number.isNaN(d.getTime())) params.set('occurred_after', d.toISOString());
  }
  if (filters.occurred_before) {
    const d = new Date(`${filters.occurred_before}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + 1); // make the bound inclusive of the picked day
      params.set('occurred_before', d.toISOString());
    }
  }
  params.set('limit', String(PAGE_LIMIT));
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

async function fetchPage(
  filters: LedgerFilterState,
  cursor: string | undefined,
): Promise<LedgerListResponseDto> {
  const qs = buildQuery(filters, cursor);
  const res = await fetch(`/api/v1/ledger?${qs}`);
  if (!res.ok) {
    throw new Error(`Failed to load ledger (${res.status})`);
  }
  return res.json();
}

export default function LedgerPage() {
  const [filters, setFilters] = useState<LedgerFilterState>(EMPTY_FILTERS);

  // Debounce typing-heavy fields so we don't refetch on every keystroke.
  const [debouncedFilters, setDebouncedFilters] = useState<LedgerFilterState>(EMPTY_FILTERS);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilters(filters), 250);
    return () => clearTimeout(t);
  }, [filters]);

  const query = useInfiniteQuery({
    queryKey: ['ledger', debouncedFilters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPage(debouncedFilters, pageParam as string | undefined),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 10_000,
  });

  // Surface fetch errors as a toast (one-shot per error identity).
  useEffect(() => {
    if (query.isError) {
      const msg = query.error instanceof Error ? query.error.message : 'Failed to load ledger';
      toast.error(msg);
    }
  }, [query.isError, query.error]);

  const events: LedgerEventDto[] = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.items),
    [query.data],
  );

  const hasMore = Boolean(query.hasNextPage);
  // Drive the empty-state copy off the LIVE filter state — otherwise clearing
  // briefly keeps showing "filters active" copy until the 250ms debounce settles.
  const filtersActive = Object.values(filters).some((v) => v !== '');

  return (
    <div className="flex flex-col gap-7">
      {/* Masthead — honest copy, no receipts/money framing. */}
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[1.6px] text-fg-faint">
            ledger · system events
          </span>
          <div className="flex-1 border-b border-dashed border-hairline" />
          <span className="font-mono text-[10px] text-fg-muted">
            newest first · cursor paginated
          </span>
        </div>
        <h1 className="m-0 font-serif text-[44px] font-normal leading-[1.02] tracking-[-1.1px] text-fg">
          <span className="italic">Lately.</span>
        </h1>
        <p className="m-0 max-w-[640px] font-serif text-[14.5px] italic text-fg-muted">
          Every move the goblin made — mixes, adoptions, dispatches, status transitions —
          recorded as it happened. Filter by subject or kind, follow a row through to its
          payload.
        </p>
      </header>

      <LedgerFilters
        value={filters}
        onChange={setFilters}
        onClear={() => setFilters(EMPTY_FILTERS)}
      />

      {/* Body */}
      {query.isLoading ? (
        <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>
      ) : events.length === 0 ? (
        <EmptyHint>
          {filtersActive
            ? 'No events match these filters. Loosen them, or clear and start over.'
            : 'The ledger is quiet. Events will appear here as the goblin works.'}
        </EmptyHint>
      ) : (
        <>
          <LedgerTable events={events} />

          <div
            className="flex items-center justify-center pt-2"
            aria-live="polite"
            aria-busy={query.isFetchingNextPage}
          >
            {hasMore ? (
              <button
                type="button"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
                className="rounded-sm border border-hairline bg-surface px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[1px] text-fg-muted hover:border-accent-edge hover:text-accent disabled:opacity-60"
              >
                {query.isFetchingNextPage ? 'loading…' : 'load more'}
              </button>
            ) : (
              <span className="font-serif text-[12.5px] italic text-fg-faint">
                — end of ledger —
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
