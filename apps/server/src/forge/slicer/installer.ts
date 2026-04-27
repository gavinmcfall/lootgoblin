/**
 * installer.ts — V2-005c T_c3
 *
 * End-to-end slicer-install pipeline:
 *   probe → row=downloading → download → row=verifying → sha256-check
 *         → row=extracting → extract (AppImage chmod / tar -x) → row=ready
 *
 * Every external dependency is injected:
 *   - http : fetch wrapper from github-releases.ts (download bytes)
 *   - run  : RunCommand seam from converter/run-command.ts (tar -x)
 *
 * The installer keeps a single row per slicerKind (UNIQUE constraint on
 * `forge_slicer_installs.slicer_kind`); re-installs UPDATE the existing row
 * rather than inserting a new one. The schema has no `failure_reason`
 * column yet — failure detail surfaces on the returned object only
 * (`failureReason` field). Persisted state is just `install_status='failed'`.
 *
 * Temp files live under `<FORGE_TOOLS_ROOT>/.tmp/` and are removed on every
 * exit path via try/finally — cleanup must succeed even when the install
 * itself fails partway through.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { eq } from 'drizzle-orm';

import { getServerDb } from '@/db/client';
import {
  forgeSlicerInstalls,
  type ForgeSlicerKindInstallable,
  type ForgeSlicerInstallStatus,
} from '@/db/schema.forge';
import { logger } from '@/logger';

import {
  probeLatestRelease,
  type HttpClient,
  type ReleaseInfo,
} from './github-releases';
import {
  getBinaryPathForAsset,
  getForgeToolsRoot,
  getInstallRoot,
} from './binary-paths';

import type { RunCommand } from '../converter/run-command';

export interface InstallSlicerOptions {
  slicerKind: ForgeSlicerKindInstallable;
  http: HttpClient;
  run: RunCommand;
  /** Optional override (used by tests with a private sqlite file). */
  dbUrl?: string;
}

/**
 * Shape of a `forge_slicer_installs` row plus a non-persisted
 * `failureReason` field carrying the human-readable explanation when
 * `installStatus === 'failed'` (the schema has no failure_reason column).
 */
export interface InstallSlicerResult {
  id: string;
  slicerKind: string;
  installedVersion: string | null;
  binaryPath: string | null;
  installRoot: string | null;
  installStatus: ForgeSlicerInstallStatus;
  installedAt: Date | null;
  sha256: string | null;
  /** Non-persisted. Populated when installStatus === 'failed'. */
  failureReason?: string;
}

const TMP_SUBDIR = '.tmp';

export async function installSlicer(
  opts: InstallSlicerOptions,
): Promise<InstallSlicerResult> {
  const db = getServerDb(opts.dbUrl);

  // -- 1. Probe latest release ---------------------------------------------
  let release: ReleaseInfo;
  try {
    release = await probeLatestRelease({ slicerKind: opts.slicerKind, http: opts.http });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { slicerKind: opts.slicerKind, err: reason },
      'slicer install probe failed',
    );
    const row = await upsertInstallRow(db, opts.slicerKind, {
      installStatus: 'failed',
    });
    return { ...row, failureReason: `probe-failed: ${reason}` };
  }

  // -- 2. Mark downloading --------------------------------------------------
  await upsertInstallRow(db, opts.slicerKind, { installStatus: 'downloading' });

  const installRoot = getInstallRoot(opts.slicerKind, release.version);
  const tmpDir = path.join(getForgeToolsRoot(), TMP_SUBDIR);
  const tmpFile = path.join(tmpDir, `${randomUUID()}-${release.assetName}`);

  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // -- 3. Download ------------------------------------------------------
    const bytes = await opts.http.fetchBytes(release.assetUrl);
    await fsp.writeFile(tmpFile, bytes);

    // -- 4. Verify sha256 -------------------------------------------------
    await upsertInstallRow(db, opts.slicerKind, { installStatus: 'verifying' });
    const computed = createHash('sha256').update(bytes).digest('hex');
    if (release.sha256) {
      if (release.sha256.toLowerCase() !== computed.toLowerCase()) {
        const reason = `sha256 mismatch: expected ${release.sha256}, got ${computed}`;
        logger.warn(
          { slicerKind: opts.slicerKind, expected: release.sha256, got: computed },
          'slicer install sha256 mismatch',
        );
        const row = await upsertInstallRow(db, opts.slicerKind, {
          installStatus: 'failed',
        });
        return { ...row, failureReason: reason };
      }
    } else {
      // No SHA256SUMS file published upstream — Bambu Studio and others
      // sometimes ship without one. We fail open (proceed with install) but
      // emit a warn-log so the bypass is observable.
      logger.warn(
        { slicerKind: opts.slicerKind, version: release.version, assetUrl: release.assetUrl },
        'forge.slicer.install: sha256 verification skipped — upstream did not publish a SHA256SUMS file',
      );
    }

    // -- 5. Extract -------------------------------------------------------
    await upsertInstallRow(db, opts.slicerKind, { installStatus: 'extracting' });
    const binDir = path.join(installRoot, 'bin');
    await fsp.mkdir(binDir, { recursive: true });

    const lowerName = release.assetName.toLowerCase();
    let binaryPath: string;

    if (lowerName.endsWith('.appimage')) {
      binaryPath = getBinaryPathForAsset({
        installRoot,
        kind: opts.slicerKind,
        assetName: release.assetName,
      });
      await fsp.copyFile(tmpFile, binaryPath);
      await fsp.chmod(binaryPath, 0o755);
    } else if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tar.xz')) {
      const flag = lowerName.endsWith('.tar.gz') ? '-xzf' : '-xJf';
      // Trust assumption: tarballs come from official GitHub Releases of known
      // projects (PrusaSlicer/Orca/Bambu). We rely on upstream signing + sha256
      // verification (when SHA256SUMS is published — see warn-log earlier in
      // this function for the fallback). If we expand to user-supplied tarball
      // URLs, harden with --no-same-owner + path traversal guards.
      const tarResult = await opts.run('tar', [flag, tmpFile, '-C', installRoot]);
      if (tarResult.code !== 0) {
        const reason = `tar exit ${tarResult.code}: ${tarResult.stderr.trim() || '(no stderr)'}`;
        logger.warn(
          { slicerKind: opts.slicerKind, code: tarResult.code, stderr: tarResult.stderr },
          'slicer install tar extract failed',
        );
        const row = await upsertInstallRow(db, opts.slicerKind, {
          installStatus: 'failed',
        });
        return { ...row, failureReason: reason };
      }
      // TODO(T_c8): Once Prusa-fork SlicerAdapter lands, refine this to the
      // actual binary location inside the extracted tarball (currently
      // unknown — varies by fork). For now record the placeholder; T_c8
      // will overwrite binary_path when it knows the real layout.
      binaryPath = getBinaryPathForAsset({
        installRoot,
        kind: opts.slicerKind,
        assetName: release.assetName,
      });
    } else {
      const reason = `unknown asset type: ${release.assetName}`;
      logger.warn(
        { slicerKind: opts.slicerKind, assetName: release.assetName },
        'slicer install unknown asset type',
      );
      const row = await upsertInstallRow(db, opts.slicerKind, {
        installStatus: 'failed',
      });
      return { ...row, failureReason: reason };
    }

    // -- 6. Mark ready ----------------------------------------------------
    const finalRow = await upsertInstallRow(db, opts.slicerKind, {
      installStatus: 'ready',
      installedVersion: release.version,
      binaryPath,
      installRoot,
      installedAt: new Date(),
      sha256: computed,
    });
    return finalRow;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(
      { slicerKind: opts.slicerKind, err: reason },
      'slicer install failed',
    );
    const row = await upsertInstallRow(db, opts.slicerKind, {
      installStatus: 'failed',
    });
    return { ...row, failureReason: reason };
  } finally {
    try {
      await fsp.unlink(tmpFile);
    } catch {
      // Tempfile may not exist if download/write never reached it.
    }
  }
}

interface RowPatch {
  installStatus: ForgeSlicerInstallStatus;
  installedVersion?: string | null;
  binaryPath?: string | null;
  installRoot?: string | null;
  installedAt?: Date | null;
  sha256?: string | null;
}

/**
 * Insert-or-update the single forge_slicer_installs row for this slicerKind
 * (UNIQUE constraint on slicer_kind). Returns the post-write row.
 *
 * Patch fields default to "leave existing value alone" — only the columns
 * supplied in `patch` are written. `installStatus` is required because
 * every transition through the pipeline records a new status.
 */
async function upsertInstallRow(
  db: ReturnType<typeof getServerDb>,
  slicerKind: ForgeSlicerKindInstallable,
  patch: RowPatch,
): Promise<InstallSlicerResult> {
  // Atomic upsert via INSERT ... ON CONFLICT DO UPDATE. The UNIQUE constraint
  // on slicer_kind makes this race-safe (vs the previous select-then-write
  // pattern which had a window where two callers could both decide to
  // INSERT). Only patched fields land in `set` so unspecified columns keep
  // their existing values on update.
  const updates: Record<string, unknown> = { installStatus: patch.installStatus };
  if (patch.installedVersion !== undefined) updates.installedVersion = patch.installedVersion;
  if (patch.binaryPath !== undefined) updates.binaryPath = patch.binaryPath;
  if (patch.installRoot !== undefined) updates.installRoot = patch.installRoot;
  if (patch.installedAt !== undefined) updates.installedAt = patch.installedAt;
  if (patch.sha256 !== undefined) updates.sha256 = patch.sha256;

  await db
    .insert(forgeSlicerInstalls)
    .values({
      id: randomUUID(),
      slicerKind,
      installStatus: patch.installStatus,
      installedVersion: patch.installedVersion ?? null,
      binaryPath: patch.binaryPath ?? null,
      installRoot: patch.installRoot ?? null,
      installedAt: patch.installedAt ?? null,
      sha256: patch.sha256 ?? null,
    })
    .onConflictDoUpdate({
      target: forgeSlicerInstalls.slicerKind,
      set: updates,
    });

  const rows = await db
    .select()
    .from(forgeSlicerInstalls)
    .where(eq(forgeSlicerInstalls.slicerKind, slicerKind))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // Should be unreachable: we just upserted above.
    throw new Error(`forge_slicer_installs row missing post-write for ${slicerKind}`);
  }

  return {
    id: row.id,
    slicerKind: row.slicerKind,
    installedVersion: row.installedVersion,
    binaryPath: row.binaryPath,
    installRoot: row.installRoot,
    installStatus: row.installStatus as ForgeSlicerInstallStatus,
    installedAt: row.installedAt,
    sha256: row.sha256,
  };
}
