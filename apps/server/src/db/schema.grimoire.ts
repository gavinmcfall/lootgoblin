/**
 * Grimoire pillar — V2-007a-T2
 *
 * Knowledge tables: slicer profiles, per-model print settings, and the m:n
 * attachments that link them to Loot entries.
 *
 * v2-007a scope: schema + manual JSON entry. Native-format slicer config
 * import (Bambu Studio, OrcaSlicer, PrusaSlicer) is a separate future
 * feature — the `opaqueUnsupported` flag anticipates that path: future
 * import paths may store unrecognized fields as opaque JSON with that flag
 * set. v2-007a entries always have opaqueUnsupported=false.
 *
 * Forge integration (V2-005): when V2-005 dispatches a print job that
 * requires slicing, it resolves a SlicerProfile from the Loot's
 * GrimoireAttachment and passes the settingsPayload to the slicer runner.
 * v2-007a defines the data; V2-005 will consume it.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { user } from './schema.auth';
import { loot } from './schema.stash';

// ---------------------------------------------------------------------------
// Enum value lists (TS-side; no DB CHECK constraints per project pattern)
// ---------------------------------------------------------------------------

/**
 * Slicer software kinds. Add new values here as native-format import is added
 * (separate future feature).
 */
export const SLICER_KINDS = [
  'bambu-studio',
  'orca-slicer',
  'prusa-slicer',
  'cura',
  'chitubox', // resin
  'lychee', // resin
  'other',
] as const;
export type SlicerKind = (typeof SLICER_KINDS)[number];

/** Printer kinds. Free-form for v2; v2-005 may promote to a real entity. */
export const PRINTER_KINDS = [
  'fdm', // generic FDM
  'sla', // generic SLA / MSLA / DLP
  'bambu-x1',
  'bambu-p1',
  'bambu-a1',
  'prusa-mk3s',
  'prusa-mk4',
  'prusa-xl',
  'voron-2.4',
  'voron-trident',
  'elegoo-mars',
  'elegoo-saturn',
  'anycubic-photon',
  'other',
] as const;
export type PrinterKind = (typeof PRINTER_KINDS)[number];

/** Material kind targeted by a profile. Mirrors materials.kind possibilities + 'any'. */
export const PROFILE_MATERIAL_KINDS = [
  'pla',
  'petg',
  'abs',
  'asa',
  'tpu',
  'pc',
  'nylon',
  'pa-cf',
  'standard-resin',
  'tough-resin',
  'flexible-resin',
  'water-washable-resin',
  'dental-resin',
  'any', // generic profile not material-specific
  'other',
] as const;
export type ProfileMaterialKind = (typeof PROFILE_MATERIAL_KINDS)[number];

// ---------------------------------------------------------------------------
// slicer_profiles
// ---------------------------------------------------------------------------

/**
 * A reusable slicer configuration. e.g. "Bambu Lab X1C — PETG-CF — Engineering
 * profile". The settingsPayload JSON shape is slicer-specific (each slicer's
 * config schema); for v2-007a manual entry, users supply a JSON object whose
 * shape is opaque to lootgoblin (we don't validate the slicer-internal field
 * names). Future native-format import will normalize known slicers' fields.
 */
export const slicerProfiles = sqliteTable(
  'slicer_profiles',
  {
    id: text('id').primaryKey(),

    /** Owner. Cascade on user delete. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    /** Friendly name. e.g. "X1C • PETG-CF • Engineering 0.2mm". */
    name: text('name').notNull(),

    /** Slicer software. App-layer validates against SLICER_KINDS. */
    slicerKind: text('slicer_kind').notNull(),

    /** Printer model. App-layer validates against PRINTER_KINDS. */
    printerKind: text('printer_kind').notNull(),

    /** Targeted material. App-layer validates against PROFILE_MATERIAL_KINDS. */
    materialKind: text('material_kind').notNull(),

    /**
     * Slicer-specific settings JSON. Shape is opaque to lootgoblin in v2-007a.
     * Examples:
     *   Bambu Studio: { "layer_height":0.2, "infill_density":15, ... }
     *   OrcaSlicer: similar field set
     * Future native-format import will normalize these per slicer.
     */
    settingsPayload: text('settings_payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),

    /**
     * True when the profile was imported from a native format that contains
     * fields lootgoblin doesn't yet recognize. v2-007a manual entries always
     * have this false (the user typed the JSON; nothing's "unsupported").
     * Future native-format import sets true when it encounters fields outside
     * the known schema.
     */
    opaqueUnsupported: integer('opaque_unsupported', { mode: 'boolean' })
      .notNull()
      .default(false),

    /** Free-form notes. Optional. */
    notes: text('notes'),

    /** Idempotency-Key on POST /api/v1/grimoire/slicer-profiles (V2-007a-T14). */
    idempotencyKey: text('idempotency_key'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** List user's profiles. */
    index('slicer_profiles_owner_idx').on(t.ownerId),
    /** Filter by printer (e.g. "all my X1C profiles"). */
    index('slicer_profiles_owner_printer_idx').on(t.ownerId, t.printerKind),
    /** Filter by slicer-kind (rare but cheap). */
    index('slicer_profiles_slicer_kind_idx').on(t.slicerKind),
  ],
);

// ---------------------------------------------------------------------------
// print_settings
// ---------------------------------------------------------------------------

/**
 * Per-model print setting overrides. Different from a SlicerProfile in that
 * a SlicerProfile is a reusable starting point (per printer × material), and
 * a PrintSetting is overrides for a specific Loot ("this dragon prints with
 * supports off and 3mm brim").
 *
 * The settingsPayload JSON is a sparse override: only the fields the user
 * wants to change from the resolved profile defaults. v2-005 Forge merges
 * profile + setting at dispatch time.
 */
export const printSettings = sqliteTable(
  'print_settings',
  {
    id: text('id').primaryKey(),

    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    /** Friendly name. e.g. "Dragon — supports off, 3mm brim". */
    name: text('name').notNull(),

    /** Sparse override JSON. Shape opaque to lootgoblin in v2-007a. */
    settingsPayload: text('settings_payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),

    notes: text('notes'),

    /** Idempotency-Key on POST /api/v1/grimoire/print-settings (V2-007a-T14). */
    idempotencyKey: text('idempotency_key'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('print_settings_owner_idx').on(t.ownerId)],
);

// ---------------------------------------------------------------------------
// grimoire_attachments
// ---------------------------------------------------------------------------

/**
 * Many-to-many link between Loot and (SlicerProfile XOR PrintSetting).
 *
 * Exactly one of slicerProfileId / printSettingId must be set per row
 * (validated at app layer; no DB CHECK constraint per project pattern).
 *
 * A Loot may have multiple attachments — e.g. one SlicerProfile attached
 * (the recommended print profile) AND one PrintSetting attached (per-model
 * tweaks). At dispatch time V2-005 Forge resolves the active set.
 *
 * Cascade: deleting the loot, profile, or setting removes the attachment.
 */
export const grimoireAttachments = sqliteTable(
  'grimoire_attachments',
  {
    id: text('id').primaryKey(),

    /** Loot row this attachment links. ON DELETE CASCADE. */
    lootId: text('loot_id')
      .notNull()
      .references(() => loot.id, { onDelete: 'cascade' }),

    /** Optional FK — exactly one of these two must be set per row. */
    slicerProfileId: text('slicer_profile_id').references(() => slicerProfiles.id, {
      onDelete: 'cascade',
    }),

    printSettingId: text('print_setting_id').references(() => printSettings.id, {
      onDelete: 'cascade',
    }),

    /** Free-form note explaining why this attachment exists. Optional. */
    note: text('note'),

    /** Owner of the attachment (almost always == owner of the loot/profile/setting). */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    attachedAt: integer('attached_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** List a Loot's attachments. */
    index('grimoire_attachments_loot_idx').on(t.lootId),
    /** Reverse lookup: which Loots use this profile? */
    index('grimoire_attachments_profile_idx').on(t.slicerProfileId),
    /** Reverse lookup: which Loots use this setting? */
    index('grimoire_attachments_setting_idx').on(t.printSettingId),
    /** Per-owner listing for admin/diagnostics. */
    index('grimoire_attachments_owner_idx').on(t.ownerId),
  ],
);
