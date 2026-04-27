/**
 * profile-materialization.ts — V2-005c T_c7
 *
 * Materializes Grimoire `slicer_profiles` rows (`settingsPayload` JSON) onto
 * disk as slicer-readable `.ini` config files, and detects drift between the
 * on-disk copy and the live Grimoire source.
 *
 * Output layout:
 *   <DATA_ROOT>/forge-slicer-configs/<profileId>/<slicerKind>.ini
 *
 * `DATA_ROOT` is read from `LOOTGOBLIN_DATA_ROOT`, defaulting to `/data`.
 * One row per (slicer_profile_id, slicer_kind) in
 * `forge_slicer_profile_materializations` (UNIQUE composite). FK-cascade on
 * `slicer_profiles.id` deletes orphan rows automatically.
 *
 * NOTE — STUB TRANSLATOR
 * ----------------------
 * Per-slicer config-format translation (PrusaSlicer / OrcaSlicer /
 * BambuStudio dialects) is intentionally deferred from V2-005c. The
 * `translateProfileToIni` helper here emits a flat `key = value` projection
 * of `settingsPayload`, recursing one level for nested objects with
 * `parent.child = value` keys. T_c8 (Prusa-fork SlicerAdapter) is the right
 * place to add per-fork translation: the adapter knows its own .ini schema.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';

import { getServerDb } from '@/db/client';
import {
  forgeSlicerProfileMaterializations,
  type ForgeSlicerKindInstallable,
} from '@/db/schema.forge';
import { slicerProfiles } from '@/db/schema.grimoire';
import { logger } from '@/logger';

const DEFAULT_DATA_ROOT = '/data';
const CONFIGS_SUBDIR = 'forge-slicer-configs';

export interface MaterializationRecord {
  id: string;
  slicerProfileId: string;
  slicerKind: ForgeSlicerKindInstallable;
  configPath: string;
  sourceProfileHash: string;
  syncRequired: boolean;
  materializedAt: Date;
}

/** Reads LOOTGOBLIN_DATA_ROOT env var; defaults to '/data'. */
function getDataRoot(): string {
  const v = process.env.LOOTGOBLIN_DATA_ROOT;
  return v && v.length > 0 ? v : DEFAULT_DATA_ROOT;
}

/** Compute the on-disk config path for a given (profile, slicer-kind) pair. */
function computeConfigPath(
  profileId: string,
  slicerKind: ForgeSlicerKindInstallable,
): string {
  return path.join(getDataRoot(), CONFIGS_SUBDIR, profileId, `${slicerKind}.ini`);
}

/** SHA-256 hex of the JSON-stringified settings payload. */
function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Stub translator. Flattens top-level + one nested level into `.ini`
 * `key = value` lines. Per-slicer dialects are T_c8 territory.
 */
function translateProfileToIni(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue === null || subValue === undefined) continue;
        lines.push(`${key}.${subKey} = ${formatIniValue(subValue)}`);
      }
    } else {
      lines.push(`${key} = ${formatIniValue(value)}`);
    }
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function formatIniValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function fetchProfile(
  db: ReturnType<typeof getServerDb>,
  profileId: string,
) {
  const rows = await db
    .select()
    .from(slicerProfiles)
    .where(eq(slicerProfiles.id, profileId));
  return rows[0] ?? null;
}

async function fetchMaterialization(
  db: ReturnType<typeof getServerDb>,
  profileId: string,
  slicerKind: ForgeSlicerKindInstallable,
): Promise<MaterializationRecord | null> {
  const rows = await db
    .select()
    .from(forgeSlicerProfileMaterializations)
    .where(
      and(
        eq(forgeSlicerProfileMaterializations.slicerProfileId, profileId),
        eq(forgeSlicerProfileMaterializations.slicerKind, slicerKind),
      ),
    );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    slicerProfileId: r.slicerProfileId,
    slicerKind: r.slicerKind as ForgeSlicerKindInstallable,
    configPath: r.configPath,
    sourceProfileHash: r.sourceProfileHash,
    syncRequired: r.syncRequired,
    materializedAt: r.materializedAt,
  };
}

/**
 * Write a Grimoire profile to disk as a slicer config and upsert the
 * materialization-tracking row. Idempotent on the (profileId, slicerKind)
 * UNIQUE — re-calling rewrites the file and refreshes the row's hash +
 * materialized_at and clears syncRequired.
 */
export async function materializeProfile(opts: {
  profileId: string;
  slicerKind: ForgeSlicerKindInstallable;
  dbUrl?: string;
}): Promise<MaterializationRecord> {
  const db = getServerDb(opts.dbUrl);
  const profile = await fetchProfile(db, opts.profileId);
  if (!profile) {
    throw new Error(`forge.slicer.profile-mat: profile ${opts.profileId} not found`);
  }

  const hash = hashPayload(profile.settingsPayload);
  const configPath = computeConfigPath(opts.profileId, opts.slicerKind);
  const iniText = translateProfileToIni(
    profile.settingsPayload as Record<string, unknown>,
  );

  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, iniText);

  const now = new Date();
  await db
    .insert(forgeSlicerProfileMaterializations)
    .values({
      id: randomUUID(),
      slicerProfileId: opts.profileId,
      slicerKind: opts.slicerKind,
      configPath,
      sourceProfileHash: hash,
      syncRequired: false,
      materializedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        forgeSlicerProfileMaterializations.slicerProfileId,
        forgeSlicerProfileMaterializations.slicerKind,
      ],
      set: {
        configPath,
        sourceProfileHash: hash,
        syncRequired: false,
        materializedAt: now,
      },
    });

  const row = await fetchMaterialization(db, opts.profileId, opts.slicerKind);
  if (!row) {
    // Should be unreachable: we just upserted.
    throw new Error(
      `forge.slicer.profile-mat: failed to read back materialization for ${opts.profileId}/${opts.slicerKind}`,
    );
  }

  logger.info(
    {
      profileId: opts.profileId,
      slicerKind: opts.slicerKind,
      configPath,
      hash,
    },
    'forge.slicer.profile-materialized',
  );

  return row;
}

/**
 * Walk all materialization rows and flag any whose source profile's hash has
 * drifted from the recorded `source_profile_hash`. Sets `syncRequired=true`
 * on drift; never re-writes files (the next slice through
 * `getMaterializedConfigPath` does that).
 */
export async function detectDrift(opts?: {
  dbUrl?: string;
}): Promise<{ checked: number; driftedSet: number }> {
  const db = getServerDb(opts?.dbUrl);
  const rows = await db.select().from(forgeSlicerProfileMaterializations);

  let driftedSet = 0;
  for (const row of rows) {
    const profile = await fetchProfile(db, row.slicerProfileId);
    if (!profile) {
      // FK-cascade should have removed this. Skip defensively.
      continue;
    }
    const currentHash = hashPayload(profile.settingsPayload);
    if (currentHash !== row.sourceProfileHash && !row.syncRequired) {
      await db
        .update(forgeSlicerProfileMaterializations)
        .set({ syncRequired: true })
        .where(eq(forgeSlicerProfileMaterializations.id, row.id));
      driftedSet += 1;
      logger.info(
        {
          profileId: row.slicerProfileId,
          slicerKind: row.slicerKind,
          oldHash: row.sourceProfileHash,
          newHash: currentHash,
        },
        'forge.slicer.profile-drift-detected',
      );
    }
  }

  return { checked: rows.length, driftedSet };
}

/**
 * Resolve the on-disk config path for a (profile, slicerKind), materializing
 * (or re-materializing) as needed. Re-materializes when:
 *   - no row exists yet,
 *   - the row's `syncRequired === true`, or
 *   - the recorded config file is missing on disk.
 */
export async function getMaterializedConfigPath(opts: {
  profileId: string;
  slicerKind: ForgeSlicerKindInstallable;
  dbUrl?: string;
}): Promise<string> {
  const db = getServerDb(opts.dbUrl);
  const row = await fetchMaterialization(db, opts.profileId, opts.slicerKind);

  if (row && !row.syncRequired) {
    try {
      await fsp.access(row.configPath);
      return row.configPath;
    } catch {
      // File missing — fall through and re-materialize.
    }
  }

  const fresh = await materializeProfile({
    profileId: opts.profileId,
    slicerKind: opts.slicerKind,
    dbUrl: opts.dbUrl,
  });
  return fresh.configPath;
}
