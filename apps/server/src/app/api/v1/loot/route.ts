/**
 * Loot — V2-002-T12
 *
 * GET  — list loot with optional ?collectionId= filter + pagination.
 * POST — create loot (used by T7/T8 internally; also exposed for API clients).
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq, count } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/db/client';
import { authenticateRequest, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';

const CreateLootBody = z.object({
  collectionId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  creator: z.string().optional().nullable(),
  license: z.string().optional().nullable(),
  sourceItemId: z.string().optional().nullable(),
});

function serializeLoot(r: Record<string, unknown>) {
  return {
    ...r,
    createdAt: r.createdAt instanceof Date ? (r.createdAt as Date).toISOString() : new Date(r.createdAt as number).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? (r.updatedAt as Date).toISOString() : new Date(r.updatedAt as number).toISOString(),
  };
}

export async function GET(req: Request) {
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') return unauthenticatedResponse(authOutcome);
  const user = authOutcome;

  const acl = resolveAcl({ user, resource: { kind: 'loot' }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  const url = new URL(req.url);
  const collectionId = url.searchParams.get('collectionId');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '25', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const db = getDb() as any;

  const baseQuery = collectionId
    ? db.select().from(schema.loot).where(eq(schema.loot.collectionId, collectionId))
    : db.select().from(schema.loot);

  const rows = await baseQuery.limit(limit).offset(offset);

  const countQuery = collectionId
    ? db.select({ value: count() }).from(schema.loot).where(eq(schema.loot.collectionId, collectionId))
    : db.select({ value: count() }).from(schema.loot);

  const totalRows = await countQuery;
  const total = totalRows[0]?.value ?? 0;

  return NextResponse.json({
    items: rows.map(serializeLoot),
    total,
    limit,
    offset,
  });
}

export async function POST(req: Request) {
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') return unauthenticatedResponse(authOutcome);
  const user = authOutcome;

  const acl = resolveAcl({ user, resource: { kind: 'loot' }, action: 'create' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-body', issues: ['request body must be JSON'] }, { status: 400 });
  }

  const parsed = CreateLootBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-body', issues: parsed.error.issues }, { status: 400 });
  }

  const { collectionId, title, description, tags, creator, license, sourceItemId } = parsed.data;
  const db = getDb() as any;

  // Verify collection exists.
  const collectionRows = await db
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
    .limit(1);
  if (collectionRows.length === 0) {
    return NextResponse.json({ error: 'collection-not-found', reason: 'collectionId does not reference an existing collection' }, { status: 422 });
  }

  const id = randomUUID();
  const now = new Date();

  await db.insert(schema.loot).values({
    id,
    collectionId,
    title,
    description: description ?? null,
    tags: tags ?? [],
    creator: creator ?? null,
    license: license ?? null,
    sourceItemId: sourceItemId ?? null,
    contentSummary: null,
    fileMissing: false,
    createdAt: now,
    updatedAt: now,
  });

  return NextResponse.json({
    id,
    collectionId,
    title,
    description: description ?? null,
    tags: tags ?? [],
    creator: creator ?? null,
    license: license ?? null,
    sourceItemId: sourceItemId ?? null,
    contentSummary: null,
    fileMissing: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }, { status: 201 });
}
