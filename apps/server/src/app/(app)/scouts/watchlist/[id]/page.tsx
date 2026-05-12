'use client';
// Watchlist detail page — SubscriptionDetail variant.
// Canvas: page-subscriptions.jsx line 124-173.

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyHint } from '@/components/shell/atoms';
import { WatchlistDetailHeader } from '@/components/scouts/WatchlistDetailHeader';
import { WatchlistStats } from '@/components/scouts/WatchlistStats';
import { WatchlistFireHistory } from '@/components/scouts/WatchlistFireHistory';

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
  defaultCollectionId: string | null;
  errorStreak: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function subscriptionLabel(sub: Subscription): string {
  const p = sub.parameters;
  if (!p) return sub.id.slice(0, 8);
  if ('creatorId' in p && p.creatorId) return p.creatorId;
  if ('tag' in p && p.tag) return `#${p.tag}`;
  if ('query' in p && p.query) return p.query;
  if ('url' in p && p.url) return p.url;
  if ('folderId' in p && p.folderId) return p.folderId;
  return sub.id.slice(0, 8);
}

export default function WatchlistDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['watchlist-subscription', id],
    queryFn: async (): Promise<{ subscription: Subscription }> =>
      (await fetch(`/api/v1/watchlist/subscriptions/${id}`)).json(),
  });

  if (isError) return <EmptyHint>Failed to load subscription.</EmptyHint>;

  if (isLoading) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-[1px] text-fg-faint">Loading…</p>
    );
  }

  const sub = data?.subscription;
  if (!sub) return <EmptyHint>Subscription not found.</EmptyHint>;

  const label = subscriptionLabel(sub);

  return (
    <div>
      <WatchlistDetailHeader
        id={sub.id}
        label={label}
        kind={sub.kind}
        active={sub.active}
      />
      <WatchlistStats
        firesCount={0}
        lastFiredAt={sub.lastFiredAt}
        cadenceSeconds={sub.cadenceSeconds}
        errorStreak={sub.errorStreak}
      />
      <WatchlistFireHistory subscriptionId={sub.id} />
    </div>
  );
}
