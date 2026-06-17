// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Watchlist detail page — SubscriptionDetail variant.
// Canvas: page-subscriptions.jsx line 124-173.

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyHint } from '@/components/shell/atoms';
import { WatchlistDetailHeader } from '@/components/scouts/WatchlistDetailHeader';
import { WatchlistStats } from '@/components/scouts/WatchlistStats';
import { WatchlistFireHistory } from '@/components/scouts/WatchlistFireHistory';
import { subscriptionLabel } from '@/components/scouts/watchlist-labels';

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

  if (isLoading) return <EmptyHint>Loading…</EmptyHint>;

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
        // TODO(watchlist-firesCount): backend DTO has no aggregate counter — either
        // fetch first page of /firings and pass `data?.firings?.length ?? 0` OR add
        // totalFirings to toSubscriptionDto. Current placeholder always shows 0.
        firesCount={0}
        lastFiredAt={sub.lastFiredAt}
        cadenceSeconds={sub.cadenceSeconds}
        errorStreak={sub.errorStreak}
      />
      <WatchlistFireHistory subscriptionId={sub.id} />
    </div>
  );
}
