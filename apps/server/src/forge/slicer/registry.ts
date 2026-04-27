/**
 * registry.ts — V2-005c T_c4
 *
 * Thin CRUD wrapper over the `forge_slicer_installs` table. Read +
 * patch-status + remove flows for downstream consumers:
 *
 *   - T_c5 update-checker  → setInstallStatus({ availableVersion, updateAvailable, lastUpdateCheckAt })
 *   - T_c6 HTTP API        → getInstall / listInstalls / removeInstall
 *   - T_c10 worker         → getInstall (resolve binary_path before slicing)
 *
 * Initial-row creation lives in installer.ts (T_c3) — this module only
 * UPDATEs/DELETEs existing rows. setInstallStatus throws if no row exists
 * for the given kind so callers don't silently bypass the install pipeline.
 *
 * removeInstall best-effort `fsp.rm`s the install_root then DELETEs the row.
 * If the rm fails we warn-log and proceed with the row delete — leaving the
 * row would mean the UI keeps showing a stale install for a dir we can't
 * touch, which is worse than orphaned bytes on disk.
 */

import * as fsp from 'node:fs/promises';

import { asc, eq } from 'drizzle-orm';

import { getServerDb } from '@/db/client';
import {
  forgeSlicerInstalls,
  type ForgeSlicerKindInstallable,
  type ForgeSlicerInstallStatus,
} from '@/db/schema.forge';
import { logger } from '@/logger';

export interface SlicerInstallRecord {
  id: string;
  slicerKind: ForgeSlicerKindInstallable;
  installedVersion: string | null;
  binaryPath: string | null;
  installRoot: string | null;
  installStatus: ForgeSlicerInstallStatus;
  lastUpdateCheckAt: Date | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  installedAt: Date | null;
  sha256: string | null;
}

type RegistryRow = typeof forgeSlicerInstalls.$inferSelect;

function rowToRecord(row: RegistryRow): SlicerInstallRecord {
  return {
    id: row.id,
    slicerKind: row.slicerKind as ForgeSlicerKindInstallable,
    installedVersion: row.installedVersion,
    binaryPath: row.binaryPath,
    installRoot: row.installRoot,
    installStatus: row.installStatus as ForgeSlicerInstallStatus,
    lastUpdateCheckAt: row.lastUpdateCheckAt,
    availableVersion: row.availableVersion,
    updateAvailable: row.updateAvailable,
    installedAt: row.installedAt,
    sha256: row.sha256,
  };
}

export function getInstall(opts: {
  slicerKind: ForgeSlicerKindInstallable;
  dbUrl?: string;
}): SlicerInstallRecord | null {
  const db = getServerDb(opts.dbUrl);
  const rows = db
    .select()
    .from(forgeSlicerInstalls)
    .where(eq(forgeSlicerInstalls.slicerKind, opts.slicerKind))
    .limit(1)
    .all();
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

export function listInstalls(opts?: { dbUrl?: string }): SlicerInstallRecord[] {
  const db = getServerDb(opts?.dbUrl);
  const rows = db
    .select()
    .from(forgeSlicerInstalls)
    .orderBy(asc(forgeSlicerInstalls.slicerKind))
    .all();
  return rows.map(rowToRecord);
}

export interface SetInstallStatusPatch {
  installStatus?: ForgeSlicerInstallStatus;
  installedVersion?: string | null;
  binaryPath?: string | null;
  installRoot?: string | null;
  lastUpdateCheckAt?: Date | null;
  availableVersion?: string | null;
  updateAvailable?: boolean;
  installedAt?: Date | null;
  sha256?: string | null;
}

export function setInstallStatus(opts: {
  slicerKind: ForgeSlicerKindInstallable;
  patch: SetInstallStatusPatch;
  dbUrl?: string;
}): SlicerInstallRecord {
  const db = getServerDb(opts.dbUrl);

  // Verify the row exists first so we can throw a meaningful error (UPDATE
  // affecting 0 rows would silently no-op otherwise).
  const existing = db
    .select()
    .from(forgeSlicerInstalls)
    .where(eq(forgeSlicerInstalls.slicerKind, opts.slicerKind))
    .limit(1)
    .all();
  if (existing.length === 0) {
    throw new Error(
      `forge.slicer.registry: no install row for ${opts.slicerKind}`,
    );
  }

  // Only patch the fields the caller actually supplied (undefined means
  // "leave alone"; explicit `null` means "clear column").
  const updates: Record<string, unknown> = {};
  if (opts.patch.installStatus !== undefined) updates.installStatus = opts.patch.installStatus;
  if (opts.patch.installedVersion !== undefined) updates.installedVersion = opts.patch.installedVersion;
  if (opts.patch.binaryPath !== undefined) updates.binaryPath = opts.patch.binaryPath;
  if (opts.patch.installRoot !== undefined) updates.installRoot = opts.patch.installRoot;
  if (opts.patch.lastUpdateCheckAt !== undefined) updates.lastUpdateCheckAt = opts.patch.lastUpdateCheckAt;
  if (opts.patch.availableVersion !== undefined) updates.availableVersion = opts.patch.availableVersion;
  if (opts.patch.updateAvailable !== undefined) updates.updateAvailable = opts.patch.updateAvailable;
  if (opts.patch.installedAt !== undefined) updates.installedAt = opts.patch.installedAt;
  if (opts.patch.sha256 !== undefined) updates.sha256 = opts.patch.sha256;

  if (Object.keys(updates).length > 0) {
    db.update(forgeSlicerInstalls)
      .set(updates)
      .where(eq(forgeSlicerInstalls.slicerKind, opts.slicerKind))
      .run();
  }

  const rows = db
    .select()
    .from(forgeSlicerInstalls)
    .where(eq(forgeSlicerInstalls.slicerKind, opts.slicerKind))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) {
    // Should be unreachable: existence checked above, no concurrent delete
    // possible since this module owns DELETE flows.
    throw new Error(
      `forge.slicer.registry: install row vanished post-update for ${opts.slicerKind}`,
    );
  }
  return rowToRecord(row);
}

export async function removeInstall(opts: {
  slicerKind: ForgeSlicerKindInstallable;
  dbUrl?: string;
}): Promise<{ removed: boolean; deletedRoot: string | null }> {
  const db = getServerDb(opts.dbUrl);
  const rows = db
    .select()
    .from(forgeSlicerInstalls)
    .where(eq(forgeSlicerInstalls.slicerKind, opts.slicerKind))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) {
    return { removed: false, deletedRoot: null };
  }

  const installRoot = row.installRoot;
  if (installRoot) {
    try {
      await fsp.rm(installRoot, { recursive: true, force: true });
    } catch (err) {
      // Don't block the row delete on a fs error — leaving the row would
      // make the UI keep advertising a stale install. Bytes-on-disk are a
      // smaller problem than DB/filesystem divergence.
      logger.warn(
        {
          slicerKind: opts.slicerKind,
          installRoot,
          err: err instanceof Error ? err.message : String(err),
        },
        'forge.slicer.registry: failed to rm install_root, deleting row anyway',
      );
    }
  }

  db.delete(forgeSlicerInstalls)
    .where(eq(forgeSlicerInstalls.slicerKind, opts.slicerKind))
    .run();

  return { removed: true, deletedRoot: installRoot };
}
