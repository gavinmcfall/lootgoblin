/**
 * Loot thumbnail serve — V2-002-T12
 *
 * GET — returns the PNG bytes if loot_thumbnails.status = 'ok'.
 *       Returns 404 with { error: 'no-thumbnail' } if not available.
 *
 * Sets Content-Type: image/png and Cache-Control: public, max-age=3600.
 * Reads file bytes synchronously at request time (thumbnails are small).
 */

import { NextResponse } from 'next/server';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { authenticateRequest } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { logger } from '@/logger';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: lootId } = await context.params;
  const user = await authenticateRequest(req);
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const acl = resolveAcl({ user, resource: { kind: 'loot', id: lootId }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  const db = getDb() as any;

  // Check loot exists.
  const lootRows = await db
    .select({ id: schema.loot.id, collectionId: schema.loot.collectionId })
    .from(schema.loot)
    .where(eq(schema.loot.id, lootId))
    .limit(1);
  if (lootRows.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  // Check thumbnail status.
  const thumbRows = db.all(
    sql`SELECT status, thumbnail_path FROM loot_thumbnails WHERE loot_id = ${lootId}`,
  ) as Array<{ status: string; thumbnail_path: string | null }>;

  const thumbRow = thumbRows[0];
  if (!thumbRow || thumbRow.status !== 'ok' || !thumbRow.thumbnail_path) {
    return NextResponse.json({ error: 'no-thumbnail' }, { status: 404 });
  }

  const thumbnailRelativePath = thumbRow.thumbnail_path;

  // Resolve stash root path: loot → collection → stashRoot.
  const collectionRows = await db
    .select({ stashRootId: schema.collections.stashRootId })
    .from(schema.collections)
    .where(eq(schema.collections.id, lootRows[0].collectionId))
    .limit(1);
  if (collectionRows.length === 0) {
    logger.warn({ lootId }, 'thumbnail GET: collection not found for loot');
    return NextResponse.json({ error: 'no-thumbnail' }, { status: 404 });
  }

  const rootRows = await db
    .select({ path: schema.stashRoots.path })
    .from(schema.stashRoots)
    .where(eq(schema.stashRoots.id, collectionRows[0].stashRootId))
    .limit(1);
  if (rootRows.length === 0) {
    logger.warn({ lootId }, 'thumbnail GET: stash root not found');
    return NextResponse.json({ error: 'no-thumbnail' }, { status: 404 });
  }

  const stashRootPath = rootRows[0].path;
  const absolutePath = path.isAbsolute(thumbnailRelativePath)
    ? thumbnailRelativePath
    : path.join(stashRootPath, thumbnailRelativePath);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absolutePath);
  } catch (err) {
    logger.warn({ lootId, absolutePath, err }, 'thumbnail GET: file not readable');
    return NextResponse.json({ error: 'no-thumbnail' }, { status: 404 });
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
