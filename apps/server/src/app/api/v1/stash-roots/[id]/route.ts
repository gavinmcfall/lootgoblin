/**
 * Stash Root detail — V2-002-T12
 *
 * GET    — detail.
 * PATCH  — rename.
 * DELETE — only if no Collections reference it (RESTRICT FK from schema).
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/db/client';
import { authenticateRequest } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { logger } from '@/logger';

const PatchStashRootBody = z.object({
  name: z.string().min(1).max(200),
});

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await authenticateRequest(req);
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const acl = resolveAcl({ user, resource: { kind: 'collection', id }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  const db = getDb() as any;
  const rows = await db.select().from(schema.stashRoots).where(eq(schema.stashRoots.id, id)).limit(1);
  if (rows.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const r = rows[0];
  return NextResponse.json({
    ...r,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : new Date(r.updatedAt).toISOString(),
  });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await authenticateRequest(req);
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const db = getDb() as any;
  const existing = await db.select({ ownerId: schema.stashRoots.ownerId }).from(schema.stashRoots).where(eq(schema.stashRoots.id, id)).limit(1);
  if (existing.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const acl = resolveAcl({ user, resource: { kind: 'collection', id, ownerId: existing[0].ownerId }, action: 'update' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-body', issues: ['request body must be JSON'] }, { status: 400 });
  }

  const parsed = PatchStashRootBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-body', issues: parsed.error.issues }, { status: 400 });
  }

  const now = new Date();
  await db.update(schema.stashRoots).set({ name: parsed.data.name, updatedAt: now }).where(eq(schema.stashRoots.id, id));

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await authenticateRequest(req);
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const db = getDb() as any;
  const existing = await db.select({ ownerId: schema.stashRoots.ownerId }).from(schema.stashRoots).where(eq(schema.stashRoots.id, id)).limit(1);
  if (existing.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const acl = resolveAcl({ user, resource: { kind: 'collection', id, ownerId: existing[0].ownerId }, action: 'delete' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  try {
    await db.delete(schema.stashRoots).where(eq(schema.stashRoots.id, id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // SQLite FK RESTRICT violation surfaces as FOREIGN KEY constraint failed
    if (message.includes('FOREIGN KEY constraint failed')) {
      logger.warn({ id, err }, 'stash-roots DELETE: FK restrict violated');
      return NextResponse.json(
        { error: 'constraint-violation', reason: 'Cannot delete stash root while Collections reference it' },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
