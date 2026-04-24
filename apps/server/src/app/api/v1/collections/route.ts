/**
 * Collections — V2-002-T12
 *
 * GET  — list Collections (all authenticated users can read; admins see all, users see all per ADR-007).
 * POST — create a Collection.
 *
 * ADR-007: Collections are visible to all members of the instance regardless of owner;
 * only the owner (or admin) can mutate/delete.
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq, sql, count } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';

const CreateCollectionBody = z.object({
  name: z.string().min(1).max(200),
  pathTemplate: z.string().min(1),
  stashRootId: z.string().uuid(),
});

function serializeCollection(r: Record<string, unknown>) {
  return {
    ...r,
    createdAt: r.createdAt instanceof Date ? (r.createdAt as Date).toISOString() : new Date(r.createdAt as number).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? (r.updatedAt as Date).toISOString() : new Date(r.updatedAt as number).toISOString(),
  };
}

export async function GET(req: Request) {
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'collection' }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '25', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const db = getDb() as any;
  // All authenticated users see all collections (ADR-007 shared visibility).
  const rows = await db
    .select()
    .from(schema.collections)
    .limit(limit)
    .offset(offset);

  const totalRows = await db.select({ value: count() }).from(schema.collections);
  const total = totalRows[0]?.value ?? 0;

  return NextResponse.json({
    items: rows.map(serializeCollection),
    total,
    limit,
    offset,
  });
}

export async function POST(req: Request) {
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'collection' }, action: 'create' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-body', issues: ['request body must be JSON'] }, { status: 400 });
  }

  const parsed = CreateCollectionBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-body', issues: parsed.error.issues }, { status: 400 });
  }

  const { name, pathTemplate, stashRootId } = parsed.data;
  const db = getDb() as any;

  // Verify stash root exists.
  const rootRows = await db
    .select({ id: schema.stashRoots.id })
    .from(schema.stashRoots)
    .where(eq(schema.stashRoots.id, stashRootId))
    .limit(1);
  if (rootRows.length === 0) {
    return NextResponse.json({ error: 'stash-root-not-found', reason: 'stashRootId does not reference an existing stash root' }, { status: 422 });
  }

  const id = randomUUID();
  const now = new Date();

  try {
    await db.insert(schema.collections).values({
      id,
      ownerId: user!.id,
      name,
      pathTemplate,
      stashRootId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed')) {
      return NextResponse.json({ error: 'duplicate-name', reason: 'A collection with this name already exists for this user' }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json({
    id,
    ownerId: user!.id,
    name,
    pathTemplate,
    stashRootId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }, { status: 201 });
}
