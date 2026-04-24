/**
 * Collection detail — V2-002-T12
 *
 * GET    — detail.
 * PATCH  — rename or change pathTemplate (DB only; file moves are T9's domain).
 * DELETE — requires empty collection OR ?cascade=true.
 */

import { NextResponse } from 'next/server';
import { eq, count } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';
import { logger } from '@/logger';

const PatchCollectionBody = z.object({
  name: z.string().min(1).max(200).optional(),
  pathTemplate: z.string().min(1).optional(),
}).refine((d) => d.name !== undefined || d.pathTemplate !== undefined, {
  message: 'At least one of name or pathTemplate must be provided',
});

function serializeCollection(r: Record<string, unknown>) {
  return {
    ...r,
    createdAt: r.createdAt instanceof Date ? (r.createdAt as Date).toISOString() : new Date(r.createdAt as number).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? (r.updatedAt as Date).toISOString() : new Date(r.updatedAt as number).toISOString(),
  };
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'collection', id }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });

  const db = getDb() as any;
  const rows = await db.select().from(schema.collections).where(eq(schema.collections.id, id)).limit(1);
  if (rows.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  return NextResponse.json(serializeCollection(rows[0]));
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;

  const db = getDb() as any;
  const existing = await db
    .select({ ownerId: schema.collections.ownerId })
    .from(schema.collections)
    .where(eq(schema.collections.id, id))
    .limit(1);
  if (existing.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const acl = resolveAcl({ user, resource: { kind: 'collection', id, ownerId: existing[0].ownerId }, action: 'update' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: user ? 403 : 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-body', issues: ['request body must be JSON'] }, { status: 400 });
  }

  const parsed = PatchCollectionBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-body', issues: parsed.error.issues }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.pathTemplate !== undefined) updates.pathTemplate = parsed.data.pathTemplate;

  try {
    await db.update(schema.collections).set(updates).where(eq(schema.collections.id, id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed')) {
      return NextResponse.json({ error: 'duplicate-name', reason: 'A collection with this name already exists for this user' }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;

  const db = getDb() as any;
  const existing = await db
    .select({ ownerId: schema.collections.ownerId })
    .from(schema.collections)
    .where(eq(schema.collections.id, id))
    .limit(1);
  if (existing.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const acl = resolveAcl({ user, resource: { kind: 'collection', id, ownerId: existing[0].ownerId }, action: 'delete' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: user ? 403 : 401 });

  const url = new URL(req.url);
  const cascade = url.searchParams.get('cascade') === 'true';

  if (!cascade) {
    // Check if collection has loot.
    const lootCount = await db.select({ value: count() }).from(schema.loot).where(eq(schema.loot.collectionId, id));
    const total = lootCount[0]?.value ?? 0;
    if (total > 0) {
      return NextResponse.json(
        { error: 'collection-not-empty', reason: `Collection contains ${total} loot item(s). Use ?cascade=true to force delete.` },
        { status: 409 },
      );
    }
  }

  logger.info({ id, cascade }, 'collections DELETE: deleting collection');
  await db.delete(schema.collections).where(eq(schema.collections.id, id));

  return NextResponse.json({ ok: true });
}
