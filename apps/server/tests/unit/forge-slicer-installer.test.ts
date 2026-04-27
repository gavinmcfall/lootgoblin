/**
 * Unit tests for V2-005c T_c3 — slicer installer subsystem.
 *
 * Covers: probe-failure, AppImage happy path, sha256 mismatch, tar.gz path
 * (verifies tar invocation), and re-install idempotency (UNIQUE on
 * slicer_kind keeps a single row).
 *
 * Uses a temp dir for FORGE_TOOLS_ROOT so tests don't touch real /data and
 * a temp sqlite file so tests don't share state with other suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sql } from 'drizzle-orm';

import { getDb, resetDbCache, runMigrations } from '@/db/client';
import { installSlicer } from '@/forge/slicer/installer';
import type { HttpClient } from '@/forge/slicer/github-releases';
import type { RunCommand } from '@/forge/converter/run-command';

const DB_PATH = '/tmp/lootgoblin-forge-slicer-installer.db';
const DB_URL = `file:${DB_PATH}`;

let toolsRoot: string;

function nullRunCommand(): RunCommand {
  return async () => {
    throw new Error('runCommand not expected in this test');
  };
}

function makeJsonHttp(release: {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
  sumsBody?: string;
}): Pick<HttpClient, 'fetchJson' | 'fetchText'> {
  return {
    fetchJson: async () => ({ tag_name: release.tag_name, assets: release.assets }),
    fetchText: async () => release.sumsBody ?? '',
  };
}

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
  toolsRoot = mkdtempSync(path.join(tmpdir(), 'forge-tools-test-'));
  process.env.FORGE_TOOLS_ROOT = toolsRoot;
  // Wipe install rows between tests so each starts clean.
  const db = getDb(DB_URL) as any;
  db.run(sql`DELETE FROM forge_slicer_installs`);
});

afterAll(() => {
  delete process.env.FORGE_TOOLS_ROOT;
});

describe('installSlicer — AppImage happy path', () => {
  it('downloads, verifies sha256, copies to install root, and chmod +x', async () => {
    const payload = Buffer.from('FAKE-APPIMAGE-PAYLOAD-' + 'x'.repeat(256));
    const sha = createHash('sha256').update(payload).digest('hex');
    const assetName = 'PrusaSlicer-2.7.4-linux-x64.AppImage';

    const http: HttpClient = {
      ...makeJsonHttp({
        tag_name: 'version_2.7.4',
        assets: [
          {
            name: assetName,
            browser_download_url: 'https://gh/prusa.AppImage',
            size: payload.byteLength,
          },
          {
            name: 'SHA256SUMS',
            browser_download_url: 'https://gh/SHA256SUMS',
            size: 100,
          },
        ],
        sumsBody: `${sha}  ${assetName}\n`,
      }),
      fetchBytes: async () => new Uint8Array(payload),
    };

    const result = await installSlicer({
      slicerKind: 'prusaslicer',
      http,
      run: nullRunCommand(),
      dbUrl: DB_URL,
    });

    expect(result.installStatus).toBe('ready');
    expect(result.installedVersion).toBe('2.7.4');
    expect(result.sha256).toBe(sha);
    expect(result.binaryPath).toBe(
      path.join(toolsRoot, 'prusaslicer', '2.7.4', 'bin', 'prusaslicer.AppImage'),
    );
    expect(result.installRoot).toBe(path.join(toolsRoot, 'prusaslicer', '2.7.4'));

    // File exists and is executable.
    const stat = await fsp.stat(result.binaryPath!);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);

    // Tempfile cleaned up.
    const tmpDir = path.join(toolsRoot, '.tmp');
    if (existsSync(tmpDir)) {
      const remaining = await fsp.readdir(tmpDir);
      expect(remaining).toHaveLength(0);
    }
  });
});

describe('installSlicer — sha256 mismatch', () => {
  it('marks install_status=failed and surfaces failureReason', async () => {
    const payload = Buffer.from('REAL-PAYLOAD');
    const wrongSha = 'a'.repeat(64);
    const assetName = 'PrusaSlicer-2.7.4-linux-x64.AppImage';

    const http: HttpClient = {
      ...makeJsonHttp({
        tag_name: 'version_2.7.4',
        assets: [
          {
            name: assetName,
            browser_download_url: 'https://gh/prusa.AppImage',
            size: payload.byteLength,
          },
          {
            name: 'SHA256SUMS',
            browser_download_url: 'https://gh/SHA256SUMS',
            size: 100,
          },
        ],
        sumsBody: `${wrongSha}  ${assetName}\n`,
      }),
      fetchBytes: async () => new Uint8Array(payload),
    };

    const result = await installSlicer({
      slicerKind: 'prusaslicer',
      http,
      run: nullRunCommand(),
      dbUrl: DB_URL,
    });

    expect(result.installStatus).toBe('failed');
    expect(result.failureReason).toMatch(/sha256/i);
  });
});

describe('installSlicer — probe failure', () => {
  it('marks install_status=failed when http.fetchJson throws', async () => {
    const http: HttpClient = {
      fetchJson: async () => {
        throw new Error('HTTP 500 https://api.github.com/...');
      },
      fetchText: async () => '',
      fetchBytes: async () => {
        throw new Error('not used');
      },
    };

    const result = await installSlicer({
      slicerKind: 'orcaslicer',
      http,
      run: nullRunCommand(),
      dbUrl: DB_URL,
    });

    expect(result.installStatus).toBe('failed');
    expect(result.failureReason).toMatch(/probe-failed/);
  });
});

describe('installSlicer — tar.gz extract', () => {
  it('invokes RunCommand with tar -xzf <tmpfile> -C <installRoot>', async () => {
    const payload = Buffer.from('FAKE-TARBALL');
    const assetName = 'PrusaSlicer-2.8.0-linux-x86_64.tar.gz';

    const http: HttpClient = {
      ...makeJsonHttp({
        tag_name: 'version_2.8.0',
        assets: [
          {
            name: assetName,
            browser_download_url: 'https://gh/prusa.tar.gz',
            size: payload.byteLength,
          },
        ],
      }),
      fetchBytes: async () => new Uint8Array(payload),
    };

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run: RunCommand = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await installSlicer({
      slicerKind: 'prusaslicer',
      http,
      run,
      dbUrl: DB_URL,
    });

    expect(result.installStatus).toBe('ready');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('tar');
    expect(calls[0].args[0]).toBe('-xzf');
    expect(calls[0].args).toContain('-C');
    const dashCIdx = calls[0].args.indexOf('-C');
    expect(calls[0].args[dashCIdx + 1]).toBe(
      path.join(toolsRoot, 'prusaslicer', '2.8.0'),
    );
    // tar.gz binary path is a placeholder until T_c8.
    expect(result.binaryPath).toBe(
      path.join(toolsRoot, 'prusaslicer', '2.8.0', 'bin', 'prusaslicer'),
    );
  });
});

describe('installSlicer — re-install idempotency', () => {
  it('updates the existing row instead of inserting a duplicate', async () => {
    const payload = Buffer.from('PAYLOAD-FOR-REINSTALL');
    const sha = createHash('sha256').update(payload).digest('hex');
    const assetName = 'PrusaSlicer-2.7.4-linux-x64.AppImage';

    const http: HttpClient = {
      ...makeJsonHttp({
        tag_name: 'version_2.7.4',
        assets: [
          {
            name: assetName,
            browser_download_url: 'https://gh/prusa.AppImage',
            size: payload.byteLength,
          },
          {
            name: 'SHA256SUMS',
            browser_download_url: 'https://gh/SHA256SUMS',
            size: 100,
          },
        ],
        sumsBody: `${sha}  ${assetName}\n`,
      }),
      fetchBytes: async () => new Uint8Array(payload),
    };

    const first = await installSlicer({
      slicerKind: 'prusaslicer',
      http,
      run: nullRunCommand(),
      dbUrl: DB_URL,
    });
    const second = await installSlicer({
      slicerKind: 'prusaslicer',
      http,
      run: nullRunCommand(),
      dbUrl: DB_URL,
    });

    expect(first.installStatus).toBe('ready');
    expect(second.installStatus).toBe('ready');
    expect(second.id).toBe(first.id);

    const db = getDb(DB_URL) as any;
    const rows = db
      .all(sql`SELECT id FROM forge_slicer_installs WHERE slicer_kind = 'prusaslicer'`);
    expect(rows).toHaveLength(1);
  });
});

afterAll(() => {
  // Best-effort cleanup of temp tools roots created in beforeEach.
  try {
    if (toolsRoot && existsSync(toolsRoot)) rmSync(toolsRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
});
