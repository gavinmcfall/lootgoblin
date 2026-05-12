'use client';
// WatchlistTable — grid table for the subscriptions list page.
// Canvas variant: SubscriptionsIndex table section (page-subscriptions.jsx line 41-63).

import Link from 'next/link';
import { relativeAge } from '@/lib/time';
import { WatchKindChip } from './WatchKindChip';

interface Subscription {
  id: string;
  kind: string;
  sourceAdapterId: string;
  parameters: { kind: string; creatorId?: string; tag?: string; query?: string; url?: string; folderId?: string } | null;
  cadenceSeconds: number;
  active: boolean;
  lastFiredAt: string | null;
  errorStreak: number;
}

function cadenceLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
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

export function WatchlistTable({ subscriptions }: { subscriptions: Subscription[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
      {/* Header */}
      <div
        className="grid items-center gap-3.5 border-b border-hairline bg-surface-2 px-[18px] py-[10px] font-mono text-[9.5px] uppercase tracking-[0.6px] text-fg-faint"
        style={{ gridTemplateColumns: '90px 1.4fr 110px 90px 90px 100px 80px' }}
      >
        <span>Kind</span>
        <span>Label</span>
        <span>Site</span>
        <span>Cadence</span>
        <span className="text-right">Fires</span>
        <span>Last</span>
        <span className="text-right">Error</span>
      </div>
      {subscriptions.map((sub, idx) => {
        const isLast = idx === subscriptions.length - 1;
        return (
          <Link
            key={sub.id}
            href={`/scouts/watchlist/${sub.id}`}
            className={`grid items-center gap-3.5 px-[18px] py-[14px] text-[12.5px] transition-colors hover:bg-surface-hi ${!sub.active ? 'opacity-55' : ''} ${isLast ? '' : 'border-b border-dashed border-hairline'}`}
            style={{ gridTemplateColumns: '90px 1.4fr 110px 90px 90px 100px 80px' }}
          >
            <span>
              <WatchKindChip kind={sub.kind} />
            </span>
            <span className="font-medium text-fg">
              {subscriptionLabel(sub)}
              {!sub.active && (
                <span className="ml-2 font-serif italic text-[11.5px] text-fg-faint">· paused</span>
              )}
            </span>
            <span className="font-mono text-[10.5px] text-fg-muted">{sub.sourceAdapterId}</span>
            <span className="font-mono text-[10.5px] text-fg-muted">{cadenceLabel(sub.cadenceSeconds)}</span>
            <span className="text-right font-mono text-[11px] text-fg">—</span>
            <span className="font-mono text-[10.5px] text-fg-faint">
              {sub.lastFiredAt ? relativeAge(new Date(sub.lastFiredAt)) : '—'}
            </span>
            <span className="text-right">
              {sub.errorStreak > 0 ? (
                <span className="font-mono text-[10px] font-bold text-danger">{sub.errorStreak}</span>
              ) : (
                <span className="font-mono text-[10px] text-fg-faint">—</span>
              )}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
