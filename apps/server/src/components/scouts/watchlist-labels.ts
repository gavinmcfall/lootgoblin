// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared label helpers for the watchlist UI. Single source of truth for:
//   - kind → display label (creator / tag / search / url / folder)
//   - cadence (seconds) → compact mono label (Xm / Xh / Xd)
//   - subscription → primary user-visible label from parameters
//
// Used by: WatchKindChip, WatchlistTable, WatchlistStats, watchlist/[id]/page.tsx.

export type WatchKind =
  | 'creator'
  | 'tag'
  | 'saved_search'
  | 'url_watch'
  | 'folder_watch';

export const KIND_LABEL: Record<WatchKind, string> = {
  creator: 'creator',
  tag: 'tag',
  saved_search: 'search',
  url_watch: 'url',
  folder_watch: 'folder',
};

/** Render-safe kind label — returns the raw kind string if it's unknown. */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as WatchKind] ?? kind;
}

/** Compact cadence label — 60s..7d range, rounded to nearest sensible unit. */
export function cadenceLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * Subscription shape (subset used for labelling) — kept loose so callers
 * can pass the full DTO without forcing a type re-export everywhere.
 */
export interface SubscriptionLike {
  id: string;
  parameters: {
    kind: string;
    creatorId?: string;
    tag?: string;
    query?: string;
    url?: string;
    folderId?: string;
  } | null;
}

/** Primary user-visible label drawn from the parameters discriminator. */
export function subscriptionLabel(sub: SubscriptionLike): string {
  const p = sub.parameters;
  if (!p) return sub.id.slice(0, 8);
  if ('creatorId' in p && p.creatorId) return p.creatorId;
  if ('tag' in p && p.tag) return `#${p.tag}`;
  if ('query' in p && p.query) return p.query;
  if ('url' in p && p.url) return p.url;
  if ('folderId' in p && p.folderId) return p.folderId;
  return sub.id.slice(0, 8);
}
