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

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { user } from './schema.auth';
import { loot, lootFiles } from './schema.stash';

// ---------------------------------------------------------------------------
// Enum value lists (TS-side; no DB CHECK constraints per project pattern)
// ---------------------------------------------------------------------------

/**
 * Printer transport / control protocol. Distinct from Grimoire's PRINTER_KINDS
 * (which names *models*, e.g. `bambu-x1`).
 */
export const FORGE_PRINTER_KINDS = [
  'fdm_klipper', // Klipper firmware via Moonraker (Voron, V0, etc.)
  'fdm_bambu_lan', // Bambu Lab printers in LAN mode (X1C, P1S, etc.)
  'resin_sdcp', // SDCP 3.0 protocol resin printers (Elegoo, Anycubic Photon, Phrozen)
  'fdm_octoprint', // OctoPrint-fronted printers (legacy fallback)
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
