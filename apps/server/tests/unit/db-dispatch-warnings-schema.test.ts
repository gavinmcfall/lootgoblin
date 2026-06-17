// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for V2-005f-CF-5a-T_a1 schema — dispatch_warnings table +
 * STATUS_EVENT_KINDS / DISPATCH_FAILURE_REASONS extensions.
 *
 *   - dispatch_warnings is the per-(dispatch_job, protocol, error_code) dedup
 *     table for repeating protocol warnings (e.g. Bambu HMS spam). One row per
 *     unique (dispatch_job_id, protocol, error_code) tuple; `count` +
 *     `last_seen_at` are updated on each repeated occurrence rather than
 *     inserting duplicate rows.
 *   - FK from dispatch_warnings.dispatch_job_id → dispatch_jobs.id is ON
 *     DELETE CASCADE: deleting a dispatch job drops its warning rows.
 *   - `idx_dispatch_warnings_unique` is a UNIQUE index on (dispatch_job_id,
 *     protocol, error_code) — this is the O(1) dedup key that T_a6's upsert
 *     logic uses. `protocol` is part of the key because numeric error-code
 *     spaces overlap across protocols (Bambu HMS vs SDCP ErrorStatusReason).
 *   - STATUS_EVENT_KINDS is extended from 8 to 11 values (add `cancelled`,
 *     `firmware_error`, `warning` before the transport pair).
 *   - DISPATCH_FAILURE_REASONS gains `cancelled` + `firmware-error`.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { runMigrations, resetDbCache, getDb } from '../../src/db/client';
import { STATUS_EVENT_KINDS, DISPATCH_FAILURE_REASONS } from '../../src/db/schema.forge';

const DB_PATH = '/tmp/lootgoblin-dispatch-warnings-schema.db';

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = `file:${DB_PATH}`;
  await runMigrations(`file:${DB_PATH}`);
});

describe('dispatch_warnings schema (T_a1)', () => {
  it('dispatch_warnings has 9 columns', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const cols = db.all(sql`PRAGMA table_info('dispatch_warnings')`) as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual([
      'id',
      'dispatch_job_id',
      'error_code',
      'protocol',
      'severity',
      'message',
      'first_seen_at',
      'last_seen_at',
      'count',
    ]);
  });

  it('FK on dispatch_job_id is CASCADE', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const fks = db.all(sql`PRAGMA foreign_key_list('dispatch_warnings')`) as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;
    const fk = fks.find((f) => f.from === 'dispatch_job_id');
    expect(fk).toBeDefined();
    expect(fk!.table).toBe('dispatch_jobs');
    expect(fk!.on_delete).toBe('CASCADE');
  });

  it('idx_dispatch_warnings_unique is a unique index on (dispatch_job_id, protocol, error_code)', () => {
    const db = getDb(`file:${DB_PATH}`) as any;
    const idxs = db.all(sql`PRAGMA index_list('dispatch_warnings')`) as Array<{
      name: string;
      unique: number;
    }>;
    const idx = idxs.find((i) => i.name === 'idx_dispatch_warnings_unique');
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(1);

    // Inspect column composition + order via PRAGMA index_info — the unique
    // key must be the 3-tuple (dispatch_job_id, protocol, error_code) in that
    // exact order so T_a6's ON CONFLICT clause can target it.
    const info = db.all(sql`PRAGMA index_info('idx_dispatch_warnings_unique')`) as Array<{
      seqno: number;
      cid: number;
      name: string;
    }>;
    const orderedNames = [...info]
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    expect(orderedNames).toEqual(['dispatch_job_id', 'protocol', 'error_code']);
  });

  it('STATUS_EVENT_KINDS extended to 11 values', () => {
    expect(STATUS_EVENT_KINDS).toEqual([
      'started',
      'progress',
      'paused',
      'resumed',
      'completed',
      'failed',
      'cancelled',
      'firmware_error',
      'warning',
      'reconnected',
      'unreachable',
    ]);
  });

  it('DISPATCH_FAILURE_REASONS includes cancelled + firmware-error', () => {
    expect(DISPATCH_FAILURE_REASONS).toContain('cancelled');
    expect(DISPATCH_FAILURE_REASONS).toContain('firmware-error');
  });
});
