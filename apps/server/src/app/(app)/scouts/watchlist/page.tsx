'use client';
// Watchlist list page — SubscriptionsIndex + SubscriptionEmpty variants.
// Canvas: page-subscriptions.jsx line 22-67 (index) and 198-222 (empty).

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { EmptyHint } from '@/components/shell/atoms';
import { WatchlistTable } from '@/components/scouts/WatchlistTable';
import { WatchlistEmpty } from '@/components/scouts/WatchlistEmpty';

interface Subscription {
  id: string;
  kind: string;
  sourceAdapterId: string;
  parameters: {
    kind: string;
    creatorId?: string;
    tag?: string;
    query?: string;
    url?: string;
    folderId?: string;
  } | null;
  cadenceSeconds: number;
  active: boolean;
  lastFiredAt: string | null;
  errorStreak: number;
  createdAt: string;
  updatedAt: string;
}

export default function WatchlistPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['watchlist-subscriptions'],
    queryFn: async (): Promise<{ subscriptions: Subscription[] }> =>
      (await fetch('/api/v1/watchlist/subscriptions')).json(),
  });

  if (isError) return <EmptyHint>Failed to load watchlist.</EmptyHint>;

  const subscriptions = data?.subscriptions ?? [];

  return (
    <div>
      {/* Breadcrumb bar */}
      <div className="mb-2 flex items-baseline gap-3.5">
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Scouts › Watchlist
        </span>
        <span className="flex-1 border-b border-hairline" />
        <span className="font-mono text-[10px] text-fg-faint">
          {isLoading ? '…' : `${subscriptions.length} watches`}
        </span>
      </div>

      {/* Page header */}
      <div className="mb-[22px] flex items-end gap-4">
        <div className="flex-1">
          <h1 className="m-0 font-serif text-[48px] font-normal leading-none tracking-[-1.4px] text-fg">
            The Watchlist.
          </h1>
          <p className="mt-1.5 font-serif text-[16px] italic text-fg-muted">
            creators, collections, tags. We check; you don&apos;t have to.
          </p>
        </div>
        <Link
          href="/scouts/watchlist/new"
          className="rounded-md bg-accent px-3.5 py-2 font-sans text-[12.5px] font-semibold text-accent-ink"
        >
          + New watch
        </Link>
      </div>

      {isLoading && (
        <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>
      )}

      {!isLoading && subscriptions.length === 0 && <WatchlistEmpty />}

      {!isLoading && subscriptions.length > 0 && (
        <WatchlistTable subscriptions={subscriptions} />
      )}
    </div>
  );
}
