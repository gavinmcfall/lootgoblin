// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// Watchlist create page — SubscriptionCreate variant.
// Canvas: page-subscriptions.jsx line 69-122.
// Note: dry-fire preview omitted — see WatchlistCreateForm.tsx.

import { SectionTitle } from '@/components/shell/atoms';
import { WatchlistCreateForm } from '@/components/scouts/WatchlistCreateForm';

export default function WatchlistNewPage() {
  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
        Scouts › Watchlist › New
      </div>
      <SectionTitle>New watch</SectionTitle>
      <p className="max-w-2xl font-serif text-[14px] italic text-fg-muted">
        Choose a kind, fill in the identifier, pick a cadence and a landing collection.
      </p>
      <WatchlistCreateForm />
    </div>
  );
}
