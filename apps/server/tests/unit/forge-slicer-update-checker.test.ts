/**
 * Unit tests for V2-005c T_c5 — slicer update-availability checker.
 *
 * Splits coverage into two halves:
 *   - runUpdateCheckOnce: real DB (temp sqlite + migrations) + mocked HTTP,
 *     so we exercise the registry round-trip.
 *   - startSlicerUpdateChecker: fake-timer scheduler test using the injected
 *     `runner` seam — no DB or HTTP needed.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { getDb, resetDbCache, runMigrations } from '@/db/client';
import { forgeSlicerInstalls } from '@/db/schema.forge';
import type { HttpClient, ReleaseInfo, SlicerKind } from '@/forge/slicer/github-releases';
import { getInstall } from '@/forge/slicer/registry';
import {
  runUpdateCheckOnce,
  startSlicerUpdateChecker,
} from '@/forge/slicer/update-checker';

const DB_PATH = '/tmp/lootgoblin-forge-slicer-update-checker.db';
const DB_URL = `file:${DB_PATH}`;

const PRIOR_DISABLE = process.env.FORGE_DISABLE_SLICER_AUTOUPDATE;

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
  delete process.env.FORGE_DISABLE_SLICER_AUTOUPDATE;
  const db = getDb(DB_URL) as any;
  db.run(sql`DELETE FROM forge_slicer_installs`);
});

afterEach(() => {
  if (PRIOR_DISABLE === undefined) {
    delete process.env.FORGE_DISABLE_SLICER_AUTOUPDATE;
  } else {
    process.env.FORGE_DISABLE_SLICER_AUTOUPDATE = PRIOR_DISABLE;
  }
});

interface SeedRow {
  slicerKind: 'prusaslicer' | 'orcaslicer' | 'bambustudio';
  installedVersion?: string | null;
  installStatus?: 'downloading' | 'extracting' | 'verifying' | 'ready' | 'failed';
  availableVersion?: string | null;
  updateAvailable?: boolean;
  lastUpdateCheckAt?: Date | null;
}

function seed(row: SeedRow): string {
  const db = getDb(DB_URL) as any;
  const id = randomUUID();
  db.insert(forgeSlicerInstalls)
    .values({
      id,
      slicerKind: row.slicerKind,
      installedVersion: row.installedVersion ?? null,
      binaryPath: null,
      installRoot: null,
      installStatus: row.installStatus ?? 'ready',
      lastUpdateCheckAt: row.lastUpdateCheckAt ?? null,
      availableVersion: row.availableVersion ?? null,
      updateAvailable: row.updateAvailable ?? false,
      installedAt: null,
      sha256: null,
    })
    .run();
  return id;
}

/**
 * Build a HttpClient stub whose fetchJson returns canned `releases/latest`
 * payloads keyed by slicer kind, and fetchText hands back a SHA256SUMS line
 * matching the asset name. Throws if probed for an unconfigured kind.
 */
function makeStubHttp(opts: {
  versions: Partial<Record<SlicerKind, string | Error>>;
  recordCalls?: SlicerKind[];
}): HttpClient {
  const REPO_TO_KIND: Record<string, SlicerKind> = {
    'prusa3d/PrusaSlicer': 'prusaslicer',
    'SoftFever/OrcaSlicer': 'orcaslicer',
    'bambulab/BambuStudio': 'bambustudio',
  };

  return {
    fetchJson: async (url: string) => {
      // Match e.g. https://api.github.com/repos/prusa3d/PrusaSlicer/releases/latest
      const m = url.match(/repos\/([^/]+\/[^/]+)\/releases\/latest/);
      if (!m) throw new Error(`unexpected URL: ${url}`);
      const repo = m[1]!;
      const kind = REPO_TO_KIND[repo];
      if (!kind) throw new Error(`unknown repo: ${repo}`);
      if (opts.recordCalls) opts.recordCalls.push(kind);
      const v = opts.versions[kind];
      if (v === undefined) throw new Error(`no canned version for ${kind}`);
      if (v instanceof Error) throw v;
      return {
        tag_name: `version_${v}`,
        assets: [
          {
            name: `${kind}-${v}-linux-x64.AppImage`,
            browser_download_url: `https://example.invalid/${kind}-${v}.AppImage`,
            size: 1024,
          },
        ],
      };
    },
    fetchText: async () => '',
    fetchBytes: async () => new Uint8Array(),
  };
}

describe('runUpdateCheckOnce', () => {
  it('honors FORGE_DISABLE_SLICER_AUTOUPDATE=1 and never probes', async () => {
    process.env.FORGE_DISABLE_SLICER_AUTOUPDATE = '1';
    seed({
      slicerKind: 'prusaslicer',
      installStatus: 'ready',
      installedVersion: '2.7.4',
    });

    const calls: SlicerKind[] = [];
    const http: HttpClient = {
      fetchJson: async () => {
        calls.push('prusaslicer');
        throw new Error('should not be called');
      },
      fetchText: async () => '',
      fetchBytes: async () => new Uint8Array(),
    };

    const result = await runUpdateCheckOnce({ http, dbUrl: DB_URL });
    expect(result).toEqual({ checked: 0, updatesAvailable: 0, failures: 0 });
    expect(calls).toHaveLength(0);
  });

  it('skips non-ready installs', async () => {
    seed({
      slicerKind: 'prusaslicer',
      installStatus: 'ready',
      installedVersion: '2.7.4',
    });
    seed({
      slicerKind: 'orcaslicer',
      installStatus: 'downloading',
      installedVersion: null,
    });

    const recordCalls: SlicerKind[] = [];
    const http = makeStubHttp({
      versions: { prusaslicer: '2.8.0' },
      recordCalls,
    });

    const result = await runUpdateCheckOnce({ http, dbUrl: DB_URL });
    expect(result.checked).toBe(1);
    expect(recordCalls).toEqual(['prusaslicer']);

    const orca = getInstall({ slicerKind: 'orcaslicer', dbUrl: DB_URL });
    expect(orca?.lastUpdateCheckAt).toBeNull();
    expect(orca?.availableVersion).toBeNull();
    expect(orca?.updateAvailable).toBe(false);
  });

  it('sets updateAvailable=true when versions differ', async () => {
    seed({
      slicerKind: 'prusaslicer',
      installStatus: 'ready',
      installedVersion: '2.7.4',
    });
    const http = makeStubHttp({ versions: { prusaslicer: '2.8.0' } });

    const result = await runUpdateCheckOnce({ http, dbUrl: DB_URL });
    expect(result).toEqual({ checked: 1, updatesAvailable: 1, failures: 0 });

    const row = getInstall({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    expect(row?.availableVersion).toBe('2.8.0');
    expect(row?.updateAvailable).toBe(true);
    expect(row?.lastUpdateCheckAt).toBeInstanceOf(Date);
  });

  it('sets updateAvailable=false when versions match', async () => {
    seed({
      slicerKind: 'prusaslicer',
      installStatus: 'ready',
      installedVersion: '2.7.4',
    });
    const http = makeStubHttp({ versions: { prusaslicer: '2.7.4' } });

    const result = await runUpdateCheckOnce({ http, dbUrl: DB_URL });
    expect(result).toEqual({ checked: 1, updatesAvailable: 0, failures: 0 });

    const row = getInstall({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    expect(row?.availableVersion).toBe('2.7.4');
    expect(row?.updateAvailable).toBe(false);
    expect(row?.lastUpdateCheckAt).toBeInstanceOf(Date);
  });

  it('handles probe error: counts failure, leaves availableVersion alone, still bumps lastUpdateCheckAt', async () => {
    // Pre-existing availableVersion that should NOT be clobbered by a probe failure.
    seed({
      slicerKind: 'prusaslicer',
      installStatus: 'ready',
      installedVersion: '2.7.4',
      availableVersion: '2.7.5',
      updateAvailable: true,
    });
    seed({
      slicerKind: 'orcaslicer',
      installStatus: 'ready',
      installedVersion: '2.0.0',
    });

    const http = makeStubHttp({
      versions: {
        prusaslicer: new Error('boom: GitHub 503'),
        orcaslicer: '2.1.0',
      },
    });

    const result = await runUpdateCheckOnce({ http, dbUrl: DB_URL });
    expect(result.checked).toBe(2);
    expect(result.failures).toBe(1);
    expect(result.updatesAvailable).toBe(1); // only orca

    const prusa = getInstall({ slicerKind: 'prusaslicer', dbUrl: DB_URL });
    expect(prusa?.availableVersion).toBe('2.7.5'); // preserved
    expect(prusa?.updateAvailable).toBe(true); // preserved
    expect(prusa?.lastUpdateCheckAt).toBeInstanceOf(Date); // bumped

    const orca = getInstall({ slicerKind: 'orcaslicer', dbUrl: DB_URL });
    expect(orca?.availableVersion).toBe('2.1.0');
    expect(orca?.updateAvailable).toBe(true);
  });
});

describe('startSlicerUpdateChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules boot grace + periodic ticks and stop() halts further calls', async () => {
    let calls = 0;
    const runner = vi.fn(async () => {
      calls += 1;
      return { checked: 0, updatesAvailable: 0, failures: 0 };
    });

    const bootGraceMs = 30_000;
    const intervalMs = 60_000;

    const stop = startSlicerUpdateChecker({
      bootGraceMs,
      intervalMs,
      http: {
        fetchJson: async () => ({}),
        fetchText: async () => '',
        fetchBytes: async () => new Uint8Array(),
      },
      runner,
    });

    // Nothing yet — timers have not fired.
    expect(calls).toBe(0);

    // Boot grace: 1 call.
    await vi.advanceTimersByTimeAsync(bootGraceMs);
    expect(calls).toBe(1);

    // First interval: 2 calls total.
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(calls).toBe(2);

    // Two more intervals: 4 total.
    await vi.advanceTimersByTimeAsync(2 * intervalMs);
    expect(calls).toBe(4);

    // Stop and confirm no further ticks fire.
    stop();
    await vi.advanceTimersByTimeAsync(10 * intervalMs);
    expect(calls).toBe(4);
  });
});

afterAll(() => {
  resetDbCache();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore
    }
  }
});
