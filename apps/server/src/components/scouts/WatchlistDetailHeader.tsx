// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// WatchlistDetailHeader — title row with Fire-now / Pause|Resume / Unwatch actions.
// Canvas variant: SubscriptionDetail header section (page-subscriptions.jsx line 135-145).

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { WatchKindChip } from './WatchKindChip';

interface Props {
  id: string;
  label: string;
  kind: string;
  active: boolean;
}

export function WatchlistDetailHeader({ id, label, kind, active }: Props) {
  const router = useRouter();
  const qc = useQueryClient();

  async function fireNow() {
    const res = await fetch(`/api/v1/watchlist/subscriptions/${id}/fire-now`, {
      method: 'POST',
    });
    if (res.ok) {
      toast.success('Fired — check back shortly');
      await qc.invalidateQueries({ queryKey: ['watchlist-firings', id] });
    } else {
      const body = (await res.json()) as { reason?: string };
      toast.error(body.reason ?? 'Fire failed');
    }
  }

  async function togglePause() {
    const endpoint = active
      ? `/api/v1/watchlist/subscriptions/${id}/pause`
      : `/api/v1/watchlist/subscriptions/${id}/resume`;
    const res = await fetch(endpoint, { method: 'POST' });
    if (res.ok) {
      toast.success(active ? 'Paused' : 'Resumed');
      await qc.invalidateQueries({ queryKey: ['watchlist-subscription', id] });
    } else {
      toast.error(active ? 'Pause failed' : 'Resume failed');
    }
  }

  async function unwatch() {
    if (!confirm(`Remove watch for "${label}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/v1/watchlist/subscriptions/${id}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      toast.success('Watch removed');
      await qc.invalidateQueries({ queryKey: ['watchlist-subscriptions'] });
      router.push('/scouts/watchlist');
    } else {
      toast.error('Delete failed');
    }
  }

  return (
    <div className="mb-[22px]">
      {/* Breadcrumb */}
      <div className="mb-2 flex items-baseline gap-3.5">
        <span className="font-mono text-[10px] uppercase tracking-[1.6px] text-fg-faint">
          Scouts › Watchlist ›{' '}
          <span className="text-fg">{label}</span>
        </span>
        <span className="flex-1 border-b border-hairline" />
        <WatchKindChip kind={kind} />
      </div>
      {/* Title row */}
      <div className="flex items-end gap-4">
        <h1 className="m-0 flex-1 font-serif text-[44px] font-normal leading-none tracking-[-1.2px] text-fg">
          {label}
        </h1>
        <button
          type="button"
          onClick={fireNow}
          className="rounded-md border border-hairline px-3 py-[7px] font-mono text-[11px] text-fg-muted transition-colors hover:border-accent hover:text-accent"
        >
          Fire now
        </button>
        <button
          type="button"
          onClick={togglePause}
          className="rounded-md border border-hairline px-3 py-[7px] font-mono text-[11px] text-fg-muted transition-colors hover:border-accent hover:text-accent"
        >
          {active ? 'Pause' : 'Resume'}
        </button>
        <button
          type="button"
          onClick={unwatch}
          className="rounded-md border border-danger px-3 py-[7px] font-mono text-[11px] text-danger transition-colors hover:bg-danger-bg"
        >
          Unwatch
        </button>
      </div>
    </div>
  );
}
