/**
 * Stash search — V2-002-T12
 *
 * GET ?q=<query> — FTS5 full-text search across title, creator, description,
 *   tags, and file formats. Returns hydrated Loot rows.
 *
 * Pagination: ?limit= (default 25, cap 100) + ?offset= (default 0).
 *
 * The IndexerEngine is created lazily once per process and memoised in a
 * module-level variable. Next.js hot-reload in dev will recreate it on each
 * module load, which is acceptable.
 *
 * FTS5 MATCH syntax errors from malformed user input are caught internally
 * by IndexerEngine.search() and return an empty results array — callers do
 * NOT need to pre-sanitise the query.
 *
 * Response envelope: { items, total, limit, offset } — matches all other
 * list endpoints in /api/v1/*.
 */

import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { authenticateRequest } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { createIndexerEngine } from '@/stash/indexer';
import type { IndexerEngine } from '@/stash/indexer';

// Module-level singleton — memoised after first call.
let _engine: IndexerEngine | null = null;

function getIndexerEngine(): IndexerEngine {
  if (!_engine) {
    _engine = createIndexerEngine();
  }
  return _engine;
}

function serializeLoot(r: Record<string, unknown>) {
  return {
    ...r,
    createdAt: r.createdAt instanceof Date ? (r.createdAt as Date).toISOString() : new Date(r.createdAt as number).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? (r.updatedAt as Date).toISOString() : new Date(r.updatedAt as number).toISOString(),
  };
}

export async function GET(req: Request) {
  const user = await authenticateRequest(req);
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const acl = resolveAcl({ user, resource: { kind: 'loot' }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '25', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  if (!q.trim()) {
    return NextResponse.json({ items: [], total: 0, limit, offset });
  }

  const engine = getIndexerEngine();
  const lootIds = await engine.search(q, { limit, offset });

  if (lootIds.length === 0) {
    return NextResponse.json({ items: [], total: 0, limit, offset });
  }

  // Bulk hydrate loot rows from the returned IDs.
  const db = getDb() as any;
  const rows = await db.select().from(schema.loot).where(
    sql`id IN (${sql.join(lootIds.map((id) => sql`${id}`), sql`, `)})`,
  );

  // Preserve FTS rank order.
  const rowById = new Map(rows.map((r: Record<string, unknown>) => [r.id, r]));
  const ordered = lootIds.map((id) => rowById.get(id)).filter((r): r is Record<string, unknown> => r !== undefined);

  return NextResponse.json({
    items: ordered.map(serializeLoot),
    total: ordered.length,
    limit,
    offset,
  });
}
