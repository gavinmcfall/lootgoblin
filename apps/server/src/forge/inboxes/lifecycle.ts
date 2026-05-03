/**
 * V2-005e-T_e2: Forge inbox CRUD — pure DB operations.
 *
 * Watcher start/stop side effects are deliberately NOT here — those are
 * orchestrated by the HTTP route handlers + boot recovery in
 * instrumentation.ts. Keeping CRUD pure makes the unit-test path simple
 * (real SQLite, no chokidar) and lets tests assert side effects against
 * `forge/inboxes/ingest.ts` separately.
 */

import * as crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { getDb, schema } from '../../db/client';
import type { ForgeInboxRow, ForgeInboxCreate, ForgeInboxUpdate } from './types';

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function getDbHandle(dbUrl?: string): DB {
  return getDb(dbUrl) as DB;
}

export interface DbOpts {
  dbUrl?: string;
}

// ---------------------------------------------------------------------------
// createInbox
// ---------------------------------------------------------------------------

export interface CreateInboxArgs extends ForgeInboxCreate {
  ownerId: string;
  /** Optional — defaults to true. */
  active?: boolean;
}

/**
 * Insert a new forge_inboxes row. Returns the inserted row.
 */
export async function createInbox(
  args: CreateInboxArgs,
  opts: DbOpts = {},
): Promise<ForgeInboxRow> {
  const db = getDbHandle(opts.dbUrl);
  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(schema.forgeInboxes).values({
    id,
    ownerId: args.ownerId,
    name: args.name,
    path: args.path,
    defaultPrinterId: args.defaultPrinterId ?? null,
    active: args.active ?? true,
    notes: args.notes ?? null,
    createdAt: now,
  });

  const rows = await db
    .select()
    .from(schema.forgeInboxes)
    .where(eq(schema.forgeInboxes.id, id))
    .limit(1);
  // Insert succeeded above; row must exist.
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// getInbox
// ---------------------------------------------------------------------------

export async function getInbox(
  id: string,
  opts: DbOpts = {},
): Promise<ForgeInboxRow | null> {
  const db = getDbHandle(opts.dbUrl);
  const rows = await db
    .select()
    .from(schema.forgeInboxes)
    .where(eq(schema.forgeInboxes.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listInboxesForOwner
// ---------------------------------------------------------------------------

export async function listInboxesForOwner(
  ownerId: string,
  opts: DbOpts = {},
): Promise<ForgeInboxRow[]> {
  const db = getDbHandle(opts.dbUrl);
  return db
    .select()
    .from(schema.forgeInboxes)
    .where(eq(schema.forgeInboxes.ownerId, ownerId));
}

// ---------------------------------------------------------------------------
// listAllInboxes (admin)
// ---------------------------------------------------------------------------

export async function listAllInboxes(opts: DbOpts = {}): Promise<ForgeInboxRow[]> {
  const db = getDbHandle(opts.dbUrl);
  return db.select().from(schema.forgeInboxes);
}

// ---------------------------------------------------------------------------
// listActiveInboxes — boot recovery
// ---------------------------------------------------------------------------

/**
 * Return all rows where `active = true`. Boot recovery iterates this list and
 * starts a chokidar watcher per row.
 */
export async function listActiveInboxes(
  opts: DbOpts = {},
): Promise<ForgeInboxRow[]> {
  const db = getDbHandle(opts.dbUrl);
  return db
    .select()
    .from(schema.forgeInboxes)
    .where(eq(schema.forgeInboxes.active, true));
}

// ---------------------------------------------------------------------------
// updateInbox
// ---------------------------------------------------------------------------

/**
 * Patch a forge_inboxes row. Returns the updated row, or null if not found.
 * Watcher restarts on path/active changes are the route layer's job.
 */
export async function updateInbox(
  id: string,
  patch: ForgeInboxUpdate,
  opts: DbOpts = {},
): Promise<ForgeInboxRow | null> {
  const db = getDbHandle(opts.dbUrl);
  const existing = await getInbox(id, opts);
  if (!existing) return null;

  const fields: Partial<typeof schema.forgeInboxes.$inferInsert> = {};
  if (patch.name !== undefined) fields.name = patch.name;
  if (patch.path !== undefined) fields.path = patch.path;
  if (patch.active !== undefined) fields.active = patch.active;
  if (patch.defaultPrinterId !== undefined) {
    fields.defaultPrinterId = patch.defaultPrinterId; // null clears
  }
  if (patch.notes !== undefined) {
    fields.notes = patch.notes; // null clears
  }

  if (Object.keys(fields).length === 0) {
    return existing;
  }

  await db.update(schema.forgeInboxes).set(fields).where(eq(schema.forgeInboxes.id, id));

  return getInbox(id, opts);
}

// ---------------------------------------------------------------------------
// deleteInbox
// ---------------------------------------------------------------------------

/**
 * Delete a forge_inboxes row. Watcher teardown is the caller's job.
 * Returns true if a row was deleted.
 */
export async function deleteInbox(
  id: string,
  opts: DbOpts = {},
): Promise<boolean> {
  const db = getDbHandle(opts.dbUrl);
  const existing = await getInbox(id, opts);
  if (!existing) return false;
  await db.delete(schema.forgeInboxes).where(eq(schema.forgeInboxes.id, id));
  return true;
}

// ---------------------------------------------------------------------------
// getInboxForOwnerOrAdmin — convenience helper for routes
// ---------------------------------------------------------------------------

/**
 * Look up a row, scoping ownership for non-admin actors. Returns null when:
 *   - the row does not exist
 *   - the actor is not the owner AND is not an admin
 *
 * Routes that call this MUST treat null as 404 (id-leak prevention pattern
 * from `_shared.ts`).
 */
export async function getInboxForActor(args: {
  id: string;
  actorId: string;
  actorRole: 'admin' | 'user';
  dbUrl?: string;
}): Promise<ForgeInboxRow | null> {
  const db = getDbHandle(args.dbUrl);
  const conditions =
    args.actorRole === 'admin'
      ? [eq(schema.forgeInboxes.id, args.id)]
      : [
          eq(schema.forgeInboxes.id, args.id),
          eq(schema.forgeInboxes.ownerId, args.actorId),
        ];
  const rows = await db
    .select()
    .from(schema.forgeInboxes)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .limit(1);
  return rows[0] ?? null;
}
