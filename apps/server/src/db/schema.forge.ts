/**
 * Forge pillar — V2-005a-T1
 *
 * Models the user's reachable printers + slicers, their ACLs, the Agents
 * that can reach them (central_worker on the lootgoblin instance + future
 * couriers), and the dispatch queue state machine.
 *
 * Locked architectural decisions:
 *  - SQLite-native atomic claim via `UPDATE ... WHERE id = ? AND status = 'claimable'`
 *    + check `changes === 1` (V2-003 ingest-worker pattern). The plan's
 *    PG-syntax `SELECT FOR UPDATE SKIP LOCKED` reference is aspirational;
 *    v2.0 ships SQLite-native semantics.
 *  - `reachable_via` is an m:n table (NOT a JSON array on printers). The
 *    claim-loop query needs to JOIN: "find dispatch jobs whose target
 *    printer's reachable_via includes the central agent". JSON array →
 *    app-layer filtering, slow. m:n table → indexed JOIN, fast.
 *  - target_kind/target_id is a poly-FK at the app layer (matches the
 *    Materials.product_id pattern from V2-007a). targetKind discriminates
 *    between `printers.id` and `forge_slicers.id`; no DB-level FK
 *    enforcement on target_id.
 *  - converted_file_id / sliced_file_id are FKs into loot_files (V2-002).
 *    Conversion + slicing produce derivative artifacts stored in the same
 *    loot_files table. Cascade: loot_files delete → SET NULL on dispatch_jobs
 *    so dispatch history is preserved when a derivative is GC'd.
 *  - No DB CHECK constraints for enums (project pattern; matches
 *    V2-001/V2-002/V2-003/V2-004/V2-007a). App-layer validates against
 *    TS unions.
 *  - Deleting an Agent SETs NULL on dispatch_jobs.claim_marker rather than
 *    cascading — losing dispatch history when a courier is decommissioned
 *    would erase audit trail.
 *
 * Naming notes:
 *  - `forge_slicers` (table) and `FORGE_SLICER_KINDS` / `FORGE_PRINTER_KINDS`
 *    (enums) are intentionally prefixed to disambiguate from
 *    `slicer_profiles` (V2-007a-T2 Grimoire — configuration) and the
 *    Grimoire-side `SLICER_KINDS` / `PRINTER_KINDS` enums (slicer software /
 *    printer model identifiers used by profiles). The Forge-side enums name
 *    runtime *transports / control protocols* (Klipper-via-Moonraker,
 *    Bambu-LAN, SDCP), which is a different concept.
 */

import { sqliteTable, text, integer, blob, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { user } from './schema.auth';
import { loot, lootFiles } from './schema.stash';
import { slicerProfiles } from './schema.grimoire';

// ---------------------------------------------------------------------------
// Enum value lists (TS-side; no DB CHECK constraints per project pattern)
// ---------------------------------------------------------------------------

/**
 * Printer transport / control protocol. Distinct from Grimoire's PRINTER_KINDS
 * (which names *models*, e.g. `bambu-x1`).
 */
export const FORGE_PRINTER_KINDS = [
  'fdm_klipper', // Klipper firmware via Moonraker (Voron, V0, etc.)
  'fdm_bambu_lan', // Bambu Lab generic LAN-mode kind (legacy / unspecified model). Kept for
                   // backwards compatibility; per-model kinds below replace it for new printers.
  'resin_sdcp', // SDCP 3.0 protocol resin printers (Elegoo, Anycubic Photon, Phrozen)
  'fdm_octoprint', // OctoPrint-fronted printers (legacy fallback)
  // V2-005d-b: Per-model Bambu LAN kinds. Capabilities live in
  // src/forge/dispatch/bambu/types.ts BAMBU_MODEL_CAPABILITIES. All use the
  // Bambu LAN MQTT + FTPS transport; the kind drives capability/UI hints.
  // H2 series — multi-function (print + laser + cut + plot)
  'bambu_h2d',
  'bambu_h2d_pro',
  'bambu_h2c',
  'bambu_h2s',
  // X series
  'bambu_x2d',
  // P series
  'bambu_p2s',
  'bambu_p1s',
  'bambu_p1p',
  // A series
  'bambu_a1',
  'bambu_a1_mini',
  // X1 series — EOL 2026-03-31, still supported in homes
  'bambu_x1c',
  'bambu_x1e',
  'bambu_x1',
  // V2-005d-c: SDCP 3.0 per-model kinds (Elegoo). Capabilities live in
  // src/forge/dispatch/sdcp/types.ts SDCP_MODEL_CAPABILITIES. All use the
  // SDCP 3.0 transport; the kind drives capability/UI hints.
  'sdcp_elegoo_saturn_4',
  'sdcp_elegoo_saturn_4_ultra',
  'sdcp_elegoo_mars_5',
  'sdcp_elegoo_mars_5_ultra',
  'sdcp_elegoo_saturn_3_ultra',
  'sdcp_elegoo_mars_4_ultra',
  'sdcp_elegoo_saturn_2',
  'sdcp_elegoo_mars_3',
  // V2-005d-c: ChituBox legacy network per-model kinds (Phrozen + Uniformation
  // + legacy-firmware Elegoo). Capabilities live in
  // src/forge/dispatch/chitu-network/types.ts CHITU_NETWORK_MODEL_CAPABILITIES.
  'chitu_network_phrozen_sonic_mighty_8k',
  'chitu_network_phrozen_sonic_mega_8k',
  'chitu_network_phrozen_sonic_mini_8k',
  'chitu_network_uniformation_gktwo',
  'chitu_network_uniformation_gkone',
  'chitu_network_elegoo_mars_legacy',
  'chitu_network_elegoo_saturn_legacy',
  // V2-005d-c: FDM Klipper expansion — registered to the V2-005d-a Moonraker
  // handler in T_dc10. Mirrors `fdm_klipper` transport (gcode native).
  'fdm_klipper_phrozen_arco',
  'fdm_klipper_elegoo_centauri_carbon',
] as const;
export type ForgePrinterKind = (typeof FORGE_PRINTER_KINDS)[number];

/**
 * Slicer-runtime kinds. Distinct from Grimoire's SLICER_KINDS (which uses
 * `bambu-studio` / `orca-slicer` slug-style values for profile lookup);
 * Forge's runtime enum uses underscore-style identifiers because they're
 * runtime descriptors, not profile selectors.
 */
export const FORGE_SLICER_KINDS = [
  'bambu_studio',
  'orcaslicer',
  'chitubox',
  'lychee',
  'prusaslicer',
  'cura',
] as const;
export type ForgeSlicerKind = (typeof FORGE_SLICER_KINDS)[number];

/** How the lootgoblin agent invokes the slicer locally on the user's device. */
export const SLICER_INVOCATION_METHODS = [
  'url-scheme', // bambu-connect://, orcaslicer://
  'cli', // chitubox <file>
  'file-association', // OS xdg-open / open / ShellExecute
] as const;
export type SlicerInvocationMethod = (typeof SLICER_INVOCATION_METHODS)[number];

/** Permission levels for printer/slicer ACL rows. */
export const ACL_LEVELS = ['none', 'push', 'admin'] as const;
export type AclLevel = (typeof ACL_LEVELS)[number];

/**
 * Agent kinds. `central_worker` is the in-process worker that ships with the
 * lootgoblin server (one per instance). `courier` is a future per-LAN/per-
 * household relay (cf. project_architecture_pillars Courier deferral).
 */
export const AGENT_KINDS = ['central_worker', 'courier'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Discriminator for dispatch_jobs.target_id poly-FK. */
export const DISPATCH_TARGET_KINDS = ['printer', 'slicer'] as const;
export type DispatchTargetKind = (typeof DISPATCH_TARGET_KINDS)[number];

/**
 * dispatch_jobs.status state machine.
 *
 *   pending → converting? → slicing? → claimable → claimed → dispatched →
 *             completed | failed
 *
 *   ↑ conversion + slicing are conditional steps; jobs that don't need them
 *     transition straight to `claimable`.
 */
export const DISPATCH_JOB_STATUSES = [
  'pending', // job created, awaiting conversion (or going straight to claimable)
  'converting', // central worker performing format conversion
  'slicing', // local slicer producing gcode
  'claimable', // ready for an Agent to claim
  'claimed', // an Agent has the lock; executing
  'dispatched', // adapter has handed off to the printer/slicer
  'completed', // target reported success (or slicer-open confirmed)
  'failed', // target reported failure (or claim timeout)
] as const;
export type DispatchJobStatus = (typeof DISPATCH_JOB_STATUSES)[number];

/** Why a dispatch_job ended in `failed`. NULL on non-failed rows. */
export const DISPATCH_FAILURE_REASONS = [
  'unsupported-format',
  'conversion-failed',
  'slicing-failed',
  'unreachable',
  'auth-failed',
  'target-rejected', // target accepted us but reported failure mid-print
  'claim-timeout', // agent stalled
  'unknown',
] as const;
export type DispatchFailureReason = (typeof DISPATCH_FAILURE_REASONS)[number];

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

/**
 * An Agent is anything that can reach a printer/slicer on the user's behalf:
 * the in-process `central_worker` (one per lootgoblin instance) and future
 * `courier` relays.
 *
 * Agents are *not* owned by a user. They're instance-scoped: every user on
 * a given lootgoblin instance sees the same set of agents. Per-printer
 * authorization happens via printer_acls; reachability happens via
 * printer_reachable_via.
 */
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    /** App-layer validates against AGENT_KINDS. */
    kind: text('kind').notNull(),
    /**
     * Free-form ref to the credential row this agent uses to authenticate
     * back to the lootgoblin server (e.g. an api_keys.id with `courier_pairing`
     * scope). NULL for `central_worker` (auth via process identity).
     */
    pairCredentialRef: text('pair_credential_ref'),
    /** When the agent last reported in. NULL = never. */
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    /** Optional display string e.g. "On Gavin's home server". */
    reachableLanHint: text('reachable_lan_hint'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('agents_kind_idx').on(t.kind),
    index('agents_last_seen_idx').on(t.lastSeenAt),
  ],
);

// ---------------------------------------------------------------------------
// printers
// ---------------------------------------------------------------------------

/**
 * A user-owned printer. The `kind` discriminator selects which adapter the
 * dispatch worker uses; `connection_config` carries the kind-specific JSON.
 *
 * Reachability (which agents can talk to this printer) is the m:n
 * `printer_reachable_via` table — NOT a column here.
 */
export const printers = sqliteTable(
  'printers',
  {
    id: text('id').primaryKey(),
    /** FK → user.id. ON DELETE CASCADE — owner removal removes their printers. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** App-layer validates against FORGE_PRINTER_KINDS. */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /**
     * Per-kind connection config JSON, e.g.
     *   fdm_klipper:   { url: 'http://1.2.3.4:7125', apiKey: '...', trustedIp: false }
     *   fdm_bambu_lan: { ip: '1.2.3.4', accessCode: '...', serial: '...' }
     *   resin_sdcp:    { ip: '1.2.3.4' }
     */
    connectionConfig: text('connection_config', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    /** Last time the printer responded to a status query. NULL = never. */
    statusLastSeen: integer('status_last_seen', { mode: 'timestamp_ms' }),
    /** Soft-disable flag. The dispatch worker skips inactive printers. */
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /**
     * Optional Idempotency-Key (RFC 7240-style) supplied via header on POST.
     * Partial unique index on (owner_id, idempotency_key) WHERE NOT NULL —
     * see migration 0026.
     */
    idempotencyKey: text('idempotency_key'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('printers_owner_idx').on(t.ownerId),
    index('printers_owner_active_idx').on(t.ownerId, t.active),
    index('printers_kind_idx').on(t.kind),
  ],
);

// ---------------------------------------------------------------------------
// printer_reachable_via (m:n printers ↔ agents)
// ---------------------------------------------------------------------------

/**
 * Which agents can reach which printers. The claim loop joins this table:
 *
 *   SELECT j.* FROM dispatch_jobs j
 *   JOIN printer_reachable_via prv
 *     ON prv.printer_id = j.target_id AND j.target_kind = 'printer'
 *   WHERE prv.agent_id = ? AND j.status = 'claimable'
 *
 * No surrogate `id`; the (printer_id, agent_id) pair is the natural key.
 */
export const printerReachableVia = sqliteTable(
  'printer_reachable_via',
  {
    printerId: text('printer_id')
      .notNull()
      .references(() => printers.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
  },
  (t) => [
    /** Composite-uniqueness pair index (effective primary key). */
    index('printer_reachable_via_pk').on(t.printerId, t.agentId),
    /** "Find printers reachable by agent X" — claim-loop hot path. */
    index('printer_reachable_via_agent_idx').on(t.agentId),
  ],
);

// ---------------------------------------------------------------------------
// forge_slicers
// ---------------------------------------------------------------------------

/**
 * A user-owned slicer runtime — i.e. a slicer install on a known device that
 * lootgoblin can hand a model to. Distinct from `slicer_profiles` (V2-007a-T2),
 * which describes *configuration* for a slicer.
 *
 * `forge_` prefix is intentional: the name disambiguates the runtime entity
 * (where slicing happens) from the Grimoire's profile entity (how slicing
 * happens). They're related but distinct.
 */
export const forgeSlicers = sqliteTable(
  'forge_slicers',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** App-layer validates against FORGE_SLICER_KINDS. */
    kind: text('kind').notNull(),
    /** Where the slicer runs. Free-form; e.g. "Gavin's MacBook" or "voron-control-pi". */
    deviceId: text('device_id'),
    /** App-layer validates against SLICER_INVOCATION_METHODS. */
    invocationMethod: text('invocation_method').notNull(),
    name: text('name').notNull(),
    /**
     * Optional Idempotency-Key — see schema.forge `printers.idempotencyKey`
     * + migration 0026 for the partial unique index.
     */
    idempotencyKey: text('idempotency_key'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('forge_slicers_owner_idx').on(t.ownerId),
    index('forge_slicers_kind_idx').on(t.kind),
  ],
);

// ---------------------------------------------------------------------------
// printer_acls
// ---------------------------------------------------------------------------

/**
 * Per-printer permission grants. Owner has implicit `admin`; this table
 * records grants to *other* users on a multi-user instance.
 */
export const printerAcls = sqliteTable(
  'printer_acls',
  {
    id: text('id').primaryKey(),
    printerId: text('printer_id')
      .notNull()
      .references(() => printers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** App-layer validates against ACL_LEVELS. */
    level: text('level').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('printer_acls_printer_user_idx').on(t.printerId, t.userId),
    index('printer_acls_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// slicer_acls
// ---------------------------------------------------------------------------

/** Per-slicer permission grants. Symmetrical to printer_acls. */
export const slicerAcls = sqliteTable(
  'slicer_acls',
  {
    id: text('id').primaryKey(),
    slicerId: text('slicer_id')
      .notNull()
      .references(() => forgeSlicers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** App-layer validates against ACL_LEVELS. */
    level: text('level').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('slicer_acls_slicer_user_idx').on(t.slicerId, t.userId),
    index('slicer_acls_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// dispatch_jobs
// ---------------------------------------------------------------------------

/**
 * The Forge dispatch queue's state-machine row. One row per push-to-printer
 * or open-in-slicer operation.
 *
 * Claim semantics (SQLite-native, V2-003 ingest-worker pattern):
 *
 *   UPDATE dispatch_jobs
 *      SET status = 'claimed', claim_marker = ?, claimed_at = ?
 *    WHERE id = ? AND status = 'claimable';
 *
 *   -- check `changes === 1`. If 0, another agent won the race; skip.
 */
export const dispatchJobs = sqliteTable(
  'dispatch_jobs',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * The Loot being dispatched. CASCADE — if the loot is deleted, the
     * dispatch record goes with it.
     */
    lootId: text('loot_id')
      .notNull()
      .references(() => loot.id, { onDelete: 'cascade' }),
    /**
     * Discriminator for `target_id`. App-layer validates against
     * DISPATCH_TARGET_KINDS and ensures targetId resolves to the right table
     * (printers OR forge_slicers).
     */
    targetKind: text('target_kind').notNull(),
    /**
     * Poly-FK; app-layer-validated. References `printers.id` when targetKind
     * is `'printer'`, `forge_slicers.id` when targetKind is `'slicer'`. NOT
     * enforced at DB layer (mirrors the Materials.product_id pattern).
     */
    targetId: text('target_id').notNull(),
    /** App-layer validates against DISPATCH_JOB_STATUSES. */
    status: text('status').notNull(),
    /**
     * Conversion output, when format conversion was needed. Reuses the
     * loot_files table (the converted file is a derivative artifact). NULL
     * when no conversion was required.
     */
    convertedFileId: text('converted_file_id').references(() => lootFiles.id, {
      onDelete: 'set null',
    }),
    /**
     * Slicing output (gcode / sliced binary). NULL on slicer-target jobs that
     * just open the file in the slicer, or on printer jobs that haven't
     * sliced yet.
     */
    slicedFileId: text('sliced_file_id').references(() => lootFiles.id, {
      onDelete: 'set null',
    }),
    /**
     * Which Agent claimed the job. NULL until claimed. ON DELETE SET NULL —
     * decommissioning an agent doesn't yank dispatch history; it just
     * unclaims the row.
     */
    claimMarker: text('claim_marker').references(() => agents.id, {
      onDelete: 'set null',
    }),
    claimedAt: integer('claimed_at', { mode: 'timestamp_ms' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    /** App-layer validates against DISPATCH_FAILURE_REASONS. NULL on non-failed rows. */
    failureReason: text('failure_reason'),
    /** Human-readable detail for UI display. */
    failureDetails: text('failure_details'),
    /**
     * Optional Idempotency-Key — see schema.forge `printers.idempotencyKey`
     * + migration 0026 for the partial unique index.
     */
    idempotencyKey: text('idempotency_key'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /** Owner's job history. */
    index('dispatch_jobs_owner_idx').on(t.ownerId),
    /** Claim-loop hot path: find claimable jobs. */
    index('dispatch_jobs_status_idx').on(t.status),
    /** "Find claimed jobs by this agent" — stale-claim recovery. */
    index('dispatch_jobs_claim_marker_idx').on(t.claimMarker),
    /** Per-loot dispatch history. */
    index('dispatch_jobs_loot_idx').on(t.lootId),
    /** Per-target history (e.g. "all jobs sent to my X1C"). */
    index('dispatch_jobs_target_idx').on(t.targetKind, t.targetId),
  ],
);

// ---------------------------------------------------------------------------
// V2-005c: forge_artifacts — machine-facing intermediates (gcode, slice meta)
// ---------------------------------------------------------------------------

/**
 * Machine-facing artifacts produced as part of a dispatch job's lifecycle —
 * sliced gcode, slicer-emitted metadata, profile snapshots used for the slice.
 *
 * Distinct from `loot_files`: loot_files holds *user-facing* assets that
 * round-trip through the Stash. forge_artifacts hold byproducts that exist
 * only to feed downstream Forge stages (the printer, an audit trail of what
 * was sliced with which profile, etc.) and are tied to the dispatch job's
 * lifetime via CASCADE.
 */
export const FORGE_ARTIFACT_KINDS = ['gcode', 'slice_metadata', 'profile_snapshot'] as const;
export type ForgeArtifactKind = (typeof FORGE_ARTIFACT_KINDS)[number];

export const forgeArtifacts = sqliteTable(
  'forge_artifacts',
  {
    id: text('id').primaryKey(),
    dispatchJobId: text('dispatch_job_id')
      .notNull()
      .references(() => dispatchJobs.id, { onDelete: 'cascade' }),
    /** App-layer validates against FORGE_ARTIFACT_KINDS. */
    kind: text('kind').notNull(),
    storagePath: text('storage_path').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    mimeType: text('mime_type'),
    /** Free-form per-kind JSON blob (e.g. slicer settings hash, layer count). */
    metadataJson: text('metadata_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('forge_artifacts_dispatch_idx').on(t.dispatchJobId),
    index('forge_artifacts_kind_idx').on(t.kind),
  ],
);

// ---------------------------------------------------------------------------
// V2-005c: forge_slicer_installs — runtime-installed slicer binaries
// ---------------------------------------------------------------------------

/**
 * Tracks slicer binaries the central worker has downloaded + extracted at
 * runtime (PrusaSlicer / OrcaSlicer / Bambu Studio). One row per slicer kind
 * (UNIQUE on `slicer_kind`) — only one active install per kind.
 *
 * Distinct from `forge_slicers`: forge_slicers is "a slicer the user owns
 * somewhere they can hand a model to" (could be on the user's laptop via
 * url-scheme handoff). forge_slicer_installs is "a slicer binary the
 * lootgoblin server has installed locally and can invoke as a CLI".
 */
export const FORGE_SLICER_KINDS_INSTALLABLE = ['prusaslicer', 'orcaslicer', 'bambustudio'] as const;
export type ForgeSlicerKindInstallable = (typeof FORGE_SLICER_KINDS_INSTALLABLE)[number];

export const FORGE_SLICER_INSTALL_STATUSES = [
  'downloading',
  'extracting',
  'verifying',
  'ready',
  'failed',
] as const;
export type ForgeSlicerInstallStatus = (typeof FORGE_SLICER_INSTALL_STATUSES)[number];

export const forgeSlicerInstalls = sqliteTable('forge_slicer_installs', {
  id: text('id').primaryKey(),
  /**
   * App-layer validates against FORGE_SLICER_KINDS_INSTALLABLE. UNIQUE — one
   * install per kind. Re-installs upsert into the same row.
   */
  slicerKind: text('slicer_kind').notNull().unique(),
  /** Semver string of the currently-installed version, e.g. "2.9.1". NULL until first install completes. */
  installedVersion: text('installed_version'),
  /** Absolute path to the executable (e.g. /data/forge-tools/prusaslicer/2.9.1/prusa-slicer). */
  binaryPath: text('binary_path'),
  /** Root extraction directory (e.g. /data/forge-tools/prusaslicer/2.9.1). */
  installRoot: text('install_root'),
  /** App-layer validates against FORGE_SLICER_INSTALL_STATUSES. */
  installStatus: text('install_status').notNull(),
  /** Last time the update-availability checker queried GitHub Releases. */
  lastUpdateCheckAt: integer('last_update_check_at', { mode: 'timestamp_ms' }),
  /** Latest version observed upstream (may differ from installed_version). */
  availableVersion: text('available_version'),
  /** Convenience flag set by the update checker so the UI can dot the menu. */
  updateAvailable: integer('update_available', { mode: 'boolean' }).notNull().default(false),
  /** When the current install finished. NULL while in-progress / failed. */
  installedAt: integer('installed_at', { mode: 'timestamp_ms' }),
  /** SHA-256 of the downloaded archive (for integrity audit). */
  sha256: text('sha256'),
});

// ---------------------------------------------------------------------------
// V2-005c: forge_slicer_profile_materializations — Grimoire profile → on-disk
// ---------------------------------------------------------------------------

/**
 * Pairs a Grimoire `slicer_profiles` row with its on-disk slicer config file
 * for a specific installed slicer. The materializer (T_c7) writes the config
 * file to disk and records the source-profile hash; on subsequent slices the
 * worker compares the current Grimoire profile hash against
 * `source_profile_hash` and re-materializes if they drift.
 *
 * Composite unique on (slicer_profile_id, slicer_kind) — at most one
 * materialization row per (profile, slicer-kind) pair.
 */
export const forgeSlicerProfileMaterializations = sqliteTable(
  'forge_slicer_profile_materializations',
  {
    id: text('id').primaryKey(),
    slicerProfileId: text('slicer_profile_id')
      .notNull()
      .references(() => slicerProfiles.id, { onDelete: 'cascade' }),
    /** App-layer validates against FORGE_SLICER_KINDS_INSTALLABLE. */
    slicerKind: text('slicer_kind').notNull(),
    /** Absolute path to the materialized config file on disk. */
    configPath: text('config_path').notNull(),
    /** Hash of the Grimoire profile body at materialization time (for drift detection). */
    sourceProfileHash: text('source_profile_hash').notNull(),
    /** Set true when drift is detected. The materializer clears it on re-write. */
    syncRequired: integer('sync_required', { mode: 'boolean' }).notNull().default(false),
    materializedAt: integer('materialized_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('forge_profile_mat_profile_idx').on(t.slicerProfileId),
    uniqueIndex('forge_profile_mat_unique').on(t.slicerProfileId, t.slicerKind),
  ],
);

// ---------------------------------------------------------------------------
// V2-005d-a: forge_target_credentials — encrypted per-printer dispatcher creds
// ---------------------------------------------------------------------------

/**
 * Discriminator for `forge_target_credentials.kind`. Each kind names a
 * distinct on-disk plaintext shape that the V2-005d-{a,b,c,d} adapters
 * encrypt/decrypt via apps/server/src/crypto.ts:
 *
 *   moonraker_api_key  V2-005d-a — { apiKey: string }
 *   octoprint_api_key  V2-005d-d — { apiKey: string }
 *   bambu_lan          V2-005d-b — { accessCode: string, serial: string }
 *   sdcp_passcode      V2-005d-c — { passcode?: string }
 *
 * App-layer validates against this list (no DB CHECK constraint, project
 * pattern).
 */
export const FORGE_TARGET_CREDENTIAL_KINDS = [
  'moonraker_api_key',
  'octoprint_api_key',
  'bambu_lan',
  'sdcp_passcode',
] as const;
export type ForgeTargetCredentialKind = (typeof FORGE_TARGET_CREDENTIAL_KINDS)[number];

/**
 * Per-printer encrypted credential row used by the dispatch worker / target
 * adapters. One row per printer (UNIQUE on `printer_id`); CASCADE on the FK
 * means deleting a printer drops its credentials atomically.
 *
 * `encrypted_blob` stores the base64(nonce||ct||tag) envelope produced by
 * `apps/server/src/crypto.ts` `encrypt()`; T_da2 adds the CRUD layer that
 * encrypts on write and decrypts on read.
 */
export const forgeTargetCredentials = sqliteTable(
  'forge_target_credentials',
  {
    id: text('id').primaryKey(),
    printerId: text('printer_id')
      .notNull()
      .unique()
      .references(() => printers.id, { onDelete: 'cascade' }),
    /** App-layer validates against FORGE_TARGET_CREDENTIAL_KINDS. */
    kind: text('kind').notNull(),
    /** base64(nonce||ct||tag) from crypto.ts encrypt(). */
    encryptedBlob: blob('encrypted_blob').notNull(),
    label: text('label'),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
);
