// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared label helpers for Forge dispatch UI.
// Single source of truth across KanbanColumn, KanbanLiveCard, KanbanQueuedCard,
// KanbanFinishedRow, TimelineRow, and the /forge/dispatch page.

import { type Tone } from '@/components/shell/atoms';

// ---------------------------------------------------------------------------
// Status label
// ---------------------------------------------------------------------------

/** Human-readable label for a dispatch job status. */
export function dispatchStatusLabel(status: string): string {
  switch (status) {
    case 'pending':    return 'Pending';
    case 'converting': return 'Converting';
    case 'claimable': return 'Claimable';
    case 'claimed':   return 'Claimed';
    case 'slicing':   return 'Slicing';
    case 'dispatched': return 'Dispatched';
    case 'running':   return 'Running';
    case 'succeeded': return 'Succeeded';
    case 'failed':    return 'Failed';
    default:          return status;
  }
}

// ---------------------------------------------------------------------------
// Status tone — maps to the Tone type from atoms.
// Discipline: mirrors STATE_TONE precedent from forge-labels.ts.
//
// pending | converting | claimable | claimed → neutral (early-pipeline, no action yet)
// slicing | dispatched                       → running (transitional, in-flight)
// running                                    → running (actively executing)
// succeeded                                  → success (outcome)
// failed                                     → danger (outcome)
// ---------------------------------------------------------------------------

export const DISPATCH_STATUS_TONE: Record<string, Tone> = {
  pending:    'neutral',
  converting: 'neutral',
  claimable:  'neutral',
  claimed:    'neutral',
  slicing:    'running',
  dispatched: 'running',
  running:    'running',
  succeeded:  'success',
  failed:     'danger',
};

/** Semantic tone for the dispatch status MetaBadge. */
export function dispatchStatusTone(status: string): Tone {
  return DISPATCH_STATUS_TONE[status] ?? 'neutral';
}

// ---------------------------------------------------------------------------
// Column classifier — maps 9 statuses → 3 Kanban columns.
// ---------------------------------------------------------------------------

export type DispatchColumn = 'queued' | 'running' | 'done';

/**
 * Maps a dispatch job status to one of three Kanban column buckets.
 *
 * Queued column  = pre-running pipeline (pending → converting → claimable → claimed → slicing → dispatched)
 * Running column = actively executing (running)
 * Done column    = terminal states (succeeded | failed)
 */
export function dispatchStatusColumn(status: string): DispatchColumn {
  switch (status) {
    case 'pending':
    case 'converting':
    case 'claimable':
    case 'claimed':
    case 'slicing':
    case 'dispatched':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
    case 'failed':
      return 'done';
    default:
      return 'queued';
  }
}

// ---------------------------------------------------------------------------
// Time formatting helpers
// ---------------------------------------------------------------------------

/**
 * Returns a relative age string from an epoch-ms timestamp.
 * E.g. "2m ago", "1h ago", "just now".
 */
export function relativeAge(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/**
 * Converts a remaining-time duration in milliseconds to a human-readable
 * ETA string. E.g. 7500000 → "2h 5m".
 * Returns null if ms is null or ≤ 0.
 */
export function etaFromMs(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null;
  const totalMin = Math.floor(ms / 60_000);
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hr > 0) return `${hr}h ${min}m`;
  return `${min}m`;
}
