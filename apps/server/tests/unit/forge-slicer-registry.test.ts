/**
 * Unit tests for V2-005c T_c4 — slicer registry CRUD module.
 *
 * Covers: read (single + list), patch-status (with absent-row throw), and
 * remove (with installRoot fs cleanup, absent row, and null-installRoot
 * branches). Uses a temp sqlite file + per-test resetDbCache so the suite
 * doesn't share state with other forge-slicer-* tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { getDb, resetDbCache, runMigrations } from '@/db/client';
import { forgeSlicerInstalls } from '@/db/schema.forge';
import {
  getInstall,
  listInstalls,
  setInstallStatus,
  removeInstall,
} from '@/forge/slicer/registry';

const DB_PATH = '/tmp/lootgoblin-forge-slicer-registry.db';
const DB_URL = `file:${DB_PATH}`;

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  await runMigrations(DB_URL);
});

beforeEach(() => {
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  const db = getDb(DB_URL) as any;
  db.run(sql`DELETE FROM forge_slicer_installs`);
});


interface SeedRow {
  slicerKind: 'prusaslicer' | 'orcaslicer' | 'bambustudio';
  installedVersion?: string | null;
  binaryPath?: string | null;
  installRoot?: string | null;
  installStatus?: 'downloading' | 'extracting' | 'verifying' | 'ready' | 'failed';
  lastUpdateCheckAt?: Date | null;
  availableVersion?: string | null;
  updateAvailable?: boolean;
  installedAt?: Date | null;
  sha256?: string | null;
}

function seed(row: SeedRow): string {
  const db = getDb(DB_URL) as any;
  const id = randomUUID();
  db.insert(forgeSlicerInstalls)
    .values({
      id,
      slicerKind: row.slicerKind,
      installedVersion: row.installedVersion ?? null,
      binaryPath: row.binaryPath ?? null,
      installRoot: row.installRoot ?? null,
      installStatus: row.installStatus ?? 'downloading',
      lastUpdateCheckAt: row.lastUpdateCheckAt ?? null,
      availableVersion: row.availableVersion ?? null,
      updateAvailable: row.updateAvailable ?? false,
      installedAt: row.installedAt ?? null,
      sha256: row.sha256 ?? null,
    })
    .run();
  return id;
}

describe('getInstall', () => {
  it('returns null when no row exists for that kind', () => {
    const result = getInstall({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    expect(result).toBeNull();
  });

  it('returns the row after seeding', () => {
    const id = seed({
      slicerKind: 'prusaslicer',
      installedVersion: '2.7.4',
      installStatus: 'ready',
    });
    const result = getInstall({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    expect(result).not.toBeNull();
    expect(result?.id).toBe(id);
    expect(result?.slicerKind).toBe('prusaslicer');
    expect(result?.installedVersion).toBe('2.7.4');
    expect(result?.installStatus).toBe('ready');
    expect(result?.updateAvailable).toBe(false);
  });
});

describe('listInstalls', () => {
  it('returns rows ordered by slicer_kind ASC', () => {
    seed({ slicerKind: 'prusaslicer', installStatus: 'ready' });
    seed({ slicerKind: 'orcaslicer', installStatus: 'downloading' });
    seed({ slicerKind: 'bambustudio', installStatus: 'failed' });

    const rows = listInstalls({ dbUrl: DB_URL });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.slicerKind)).toEqual([
      'bambustudio',
      'orcaslicer',
      'prusaslicer',
    ]);
  });
});

describe('setInstallStatus', () => {
  it('updates the row and returns the post-update record', () => {
    seed({ slicerKind: 'prusaslicer', installStatus: 'downloading' });

    const updated = setInstallStatus({
      slicerKind: 'prusaslicer',
      patch: { installStatus: 'ready', installedVersion: '2.7.4' },
      dbUrl: DB_URL,
    });

    expect(updated.installStatus).toBe('ready');
    expect(updated.installedVersion).toBe('2.7.4');

    const refetched = getInstall({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    expect(refetched?.installStatus).toBe('ready');
    expect(refetched?.installedVersion).toBe('2.7.4');
  });

  it('persists update-checker fields (availableVersion + updateAvailable + lastUpdateCheckAt)', () => {
    seed({ slicerKind: 'orcaslicer', installStatus: 'ready', installedVersion: '2.0.0' });
    const checkedAt = new Date('2026-04-27T10:00:00Z');

    const updated = setInstallStatus({
      slicerKind: 'orcaslicer',
      patch: {
        availableVersion: '2.1.0',
        updateAvailable: true,
        lastUpdateCheckAt: checkedAt,
      },
      dbUrl: DB_URL,
    });

    expect(updated.availableVersion).toBe('2.1.0');
    expect(updated.updateAvailable).toBe(true);
    expect(updated.lastUpdateCheckAt?.getTime()).toBe(checkedAt.getTime());
    // Status untouched.
    expect(updated.installStatus).toBe('ready');
    expect(updated.installedVersion).toBe('2.0.0');
  });

  it('throws when no row exists for the given kind', () => {
    expect(() =>
      setInstallStatus({
        slicerKind: 'prusaslicer',
        patch: { installStatus: 'ready' },
        dbUrl: DB_URL,
      }),
    ).toThrow(/forge\.slicer\.registry: no install row for prusaslicer/);
  });
});

describe('removeInstall', () => {
  it('deletes the row and recursively rms install_root', async () => {
    const installRoot = mkdtempSync(path.join(tmpdir(), 'forge-slicer-rm-'));
    // Drop a sentinel file inside so we can prove the rm is recursive.
    await fsp.writeFile(path.join(installRoot, 'sentinel.txt'), 'present');

    seed({
      slicerKind: 'prusaslicer',
      installStatus: 'ready',
      installRoot,
      installedVersion: '2.7.4',
    });

    const result = await removeInstall({
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });

    expect(result.removed).toBe(true);
    expect(result.deletedRoot).toBe(installRoot);
    expect(existsSync(installRoot)).toBe(false);
    expect(getInstall({ slicerKind: 'prusaslicer', dbUrl: DB_URL })).toBeNull();
  });

  it('returns { removed: false, deletedRoot: null } when no row exists', async () => {
    const result = await removeInstall({
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });
    expect(result).toEqual({ removed: false, deletedRoot: null });
  });

  it('removes the row and returns deletedRoot=null when installRoot is null', async () => {
    seed({ slicerKind: 'prusaslicer', installStatus: 'failed', installRoot: null });

    const result = await removeInstall({
      slicerKind: 'prusaslicer',
      dbUrl: DB_URL,
    });

    expect(result.removed).toBe(true);
    expect(result.deletedRoot).toBeNull();
    expect(getInstall({ slicerKind: 'prusaslicer', dbUrl: DB_URL })).toBeNull();
  });
});

afterAll(() => {
  resetDbCache();
  // Best-effort sqlite cleanup so subsequent test runs start clean.
  try {
    rmSync(DB_PATH, { force: true });
  } catch {
    // ignore
  }
});
