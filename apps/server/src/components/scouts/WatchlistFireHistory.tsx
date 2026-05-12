'use client';
// WatchlistFireHistory — fire-history list from /firings endpoint.
// Canvas variant: SubscriptionDetail fire history section (page-subscriptions.jsx line 156-172).
// Tone discipline: completed (items>0) → accent, completed (0 items) → fg-faint, failed → danger,
// queued/claimed/running → running tone class (text-running).

import { useQuery } from '@tanstack/react-query';
import { EmptyHint } from '@/components/shell/atoms';
import { relativeAge } from '@/lib/time';

interface Firing {
  id: string;
  subscriptionId: string;
  status: 'queued' | 'claimed' | 'running' | 'completed' | 'failed';
  itemsDiscovered: number;
  itemsEnqueued: number;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failureReason?: string;
  failureDetails?: string;
  createdAt: string;
}

function firingLabel(f: Firing): { text: string; className: string } {
  if (f.status === 'failed') {
    return { text: 'failed', className: 'text-danger' };
  }
  if (f.status === 'completed') {
    if (f.itemsEnqueued > 0) {
      return { text: `${f.itemsEnqueued} new`, className: 'text-accent' };
    }
    return { text: 'no new', className: 'text-fg-faint' };
  }
  // queued / claimed / running
  return { text: f.status, className: 'text-running' };
}

export function WatchlistFireHistory({ subscriptionId }: { subscriptionId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['watchlist-firings', subscriptionId],
    queryFn: async (): Promise<{ firings: Firing[] }> =>
      (await fetch(`/api/v1/watchlist/subscriptions/${subscriptionId}/firings?limit=20`)).json(),
  });

  if (isError) return <EmptyHint>Failed to load fire history.</EmptyHint>;

  const firings = data?.firings ?? [];

  return (
    <div className="rounded-lg border border-hairline bg-surface p-[18px]">
      {/* Section header */}
      <div className="mb-[14px] flex items-baseline gap-3">
        <span className="font-serif text-[19px] tracking-[-0.3px] text-fg">Fire history</span>
        <span className="font-mono text-[10px] text-fg-faint">last 20 firings</span>
        <span className="flex-1 border-b border-dashed border-hairline" />
      </div>

      {isLoading && <EmptyHint>Loading…</EmptyHint>}

      {!isLoading && firings.length === 0 && (
        <EmptyHint>No firings yet — this subscription has not run.</EmptyHint>
      )}

      {firings.map((f, idx) => {
        const isLast = idx === firings.length - 1;
        const { text, className } = firingLabel(f);
        return (
          <div
            key={f.id}
            className={`grid items-baseline gap-3.5 py-[10px] ${isLast ? '' : 'border-b border-dashed border-hairline'}`}
            style={{ gridTemplateColumns: '80px 70px 1fr' }}
          >
            <span className="font-mono text-[10.5px] text-fg-faint">
              {relativeAge(new Date(f.createdAt))}
            </span>
            <span className={`font-mono text-[10.5px] ${className}`}>{text}</span>
            <span className="font-mono text-[11px] text-fg-muted">
              {f.status === 'failed' && f.failureReason
                ? f.failureReason
                : f.itemsDiscovered > 0
                ? `${f.itemsDiscovered} discovered`
                : '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
