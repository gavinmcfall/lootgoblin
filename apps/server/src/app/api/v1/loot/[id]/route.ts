/**
 * Loot detail — V2-002-T12
 *
 * GET    — detail with lootFiles inline.
 * PATCH  — update title/creator/description/tags/license.
 * DELETE — cascade handles lootFiles (via FK cascade in schema).
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/db/client';
import { authenticateRequest, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { logger } from '@/logger';

const PatchLootBody = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  creator: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
}).refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: 'At least one field must be provided' },
);

function serializeLoot(r: Record<string, unknown>) {
  return {
    ...r,
    createdAt: r.createdAt instanceof Date ? (r.createdAt as Date).toISOString() : new Date(r.createdAt as number).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? (r.updatedAt as Date).toISOString() : new Date(r.updatedAt as number).toISOString(),
  };
}

function serializeFile(r: Record<string, unknown>) {
  return {
    ...r,
    createdAt: r.createdAt instanceof Date ? (r.createdAt as Date).toISOString() : new Date(r.createdAt as number).toISOString(),
  };
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') return unauthenticatedResponse(authOutcome);
  const user = authOutcome;

  const acl = resolveAcl({ user, resource: { kind: 'loot', id }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  const db = getDb() as any;
  const lootRows = await db.select().from(schema.loot).where(eq(schema.loot.id, id)).limit(1);
  if (lootRows.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const fileRows = await db.select().from(schema.lootFiles).where(eq(schema.lootFiles.lootId, id));

  return NextResponse.json({
    ...serializeLoot(lootRows[0]),
    files: fileRows.map(serializeFile),
  });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') return unauthenticatedResponse(authOutcome);
  const user = authOutcome;

  const db = getDb() as any;
  // Look up the collection owner to resolve ACL (loot doesn't carry ownerId directly;
  // ownership flows through the collection).
  const lootRows = await db
    .select({ collectionId: schema.loot.collectionId })
    .from(schema.loot)
    .where(eq(schema.loot.id, id))
    .limit(1);
  if (lootRows.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const collectionRows = await db
    .select({ ownerId: schema.collections.ownerId })
    .from(schema.collections)
    .where(eq(schema.collections.id, lootRows[0].collectionId))
    .limit(1);
  const ownerId = collectionRows[0]?.ownerId;

  const acl = resolveAcl({ user, resource: { kind: 'loot', id, ownerId }, action: 'update' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-body', issues: ['request body must be JSON'] }, { status: 400 });
  }

  const parsed = PatchLootBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-body', issues: parsed.error.issues }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.tags !== undefined) updates.tags = parsed.data.tags;
  if (parsed.data.creator !== undefined) updates.creator = parsed.data.creator;
  if (parsed.data.license !== undefined) updates.license = parsed.data.license;

  await db.update(schema.loot).set(updates).where(eq(schema.loot.id, id));

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') return unauthenticatedResponse(authOutcome);
  const user = authOutcome;

  const db = getDb() as any;
  const lootRows = await db
    .select({ collectionId: schema.loot.collectionId })
    .from(schema.loot)
    .where(eq(schema.loot.id, id))
    .limit(1);
  if (lootRows.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const collectionRows = await db
    .select({ ownerId: schema.collections.ownerId })
    .from(schema.collections)
    .where(eq(schema.collections.id, lootRows[0].collectionId))
    .limit(1);
  const ownerId = collectionRows[0]?.ownerId;

  const acl = resolveAcl({ user, resource: { kind: 'loot', id, ownerId }, action: 'delete' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  logger.info({ id }, 'loot DELETE: deleting loot (cascade removes files)');
  await db.delete(schema.loot).where(eq(schema.loot.id, id));

  return NextResponse.json({ ok: true });
}
