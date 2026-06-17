// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * dedup.ts — V2-005f-CF-5a T_a6
 *
 * Atomic upsert helper for the `dispatch_warnings` dedup table.
 *
 * Bambu HMS and similar subscribers can emit the same advisory warning on
 * every poll tick while a condition persists (e.g. material low, door open).
 * Writing a `dispatch_status_events` row per occurrence would flood the audit
 * table and the SSE bus. This helper keeps a one-row-per-(job, protocol,
 * errorCode) record in `dispatch_warnings`, bumping `count + last_seen_at` on
 * repeats.
 *
 * On the FIRST occurrence (`count === 1` after INSERT) the caller writes the
 * normal audit + SSE path. On repeats (`count > 1`) the caller skips both.
 *
 * Atomic guarantee: SQLite's `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * executes in a single statement. The returned `count` is the post-UPDATE
 * value (verified against better-sqlite3 + Drizzle: the RETURNING clause in
 * SQLite returns updated state, not original state). `count === 1` therefore
 * correctly identifies the first occurrence.
 *
 * Sync vs async: better-sqlite3 is synchronous. This function is declared
 * `async` so call sites can `await` it uniformly (and so future async
 * implementations — e.g. PG dialect — require no call-site changes).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { getServerDb, schema } from '@/db/client';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface DedupArgs {
  dispatchJobId: string;
  errorCode: string;
  protocol: string;
  severity: 'info' | 'warning' | 'error';
  message?: string;
  occurredAt: Date;
}

export interface DedupResult {
  /**
   * True when this is the FIRST occurrence of (dispatchJobId, protocol,
   * errorCode). The caller should write a `dispatch_status_events` row + emit
   * via the SSE bus. False on repeats — caller skips both.
   */
  isFirst: boolean;
  /** Row id of the (possibly newly inserted) `dispatch_warnings` row. */
  warningId: string;
}

/**
 * Atomically upsert a warning occurrence into `dispatch_warnings`.
 *
 * - INSERT on first occurrence: writes all columns, `count=1`.
 * - ON CONFLICT (dispatchJobId, protocol, errorCode): bumps `count` and
 *   updates `lastSeenAt`. `firstSeenAt` and `id` stay from the original row.
 *
 * Returns `{ isFirst: true }` when count comes back as 1 (INSERT path);
 * `{ isFirst: false }` otherwise (UPDATE path, count ≥ 2).
 */
export async function dedupAndPersistWarning(
  args: DedupArgs,
  opts?: { dbUrl?: string },
): Promise<DedupResult> {
  const db = getServerDb(opts?.dbUrl);
  const id = randomUUID();
  const now = args.occurredAt;

  const result = db
    .insert(schema.dispatchWarnings)
    .values({
      id,
      dispatchJobId: args.dispatchJobId,
      errorCode: args.errorCode,
      protocol: args.protocol,
      severity: args.severity,
      message: args.message ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
    })
    .onConflictDoUpdate({
      // 3-column key matching the T_a1 followup schema: (dispatchJobId, protocol, errorCode)
      target: [
        schema.dispatchWarnings.dispatchJobId,
        schema.dispatchWarnings.protocol,
        schema.dispatchWarnings.errorCode,
      ],
      set: {
        lastSeenAt: now,
        count: sql`${schema.dispatchWarnings.count} + 1`,
      },
    })
    .returning({
      id: schema.dispatchWarnings.id,
      count: schema.dispatchWarnings.count,
    })
    // RETURNING after ON CONFLICT DO UPDATE returns the EXISTING row's id
    // (not the locally generated `id` above). This is intentional —
    // `warningId` is the canonical dedup-row id callers expect, stable
    // across repeats.
    .all();

  const row = result[0]!;
  return { isFirst: row.count === 1, warningId: row.id };
}
