/**
 * Stash Roots — V2-002-T12
 *
 * GET  — list stash roots visible to the authenticated user.
 *         Admins see all roots; regular users see only their own.
 * POST — create a new stash root (validates path exists + is writable).
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';
import { logger } from '@/logger';

const CreateStashRootBody = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1),
});

export async function GET(req: Request) {
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'collection' }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });

  const db = getDb() as any;
  let rows;
  if (user!.role === 'admin') {
    rows = await db.select().from(schema.stashRoots);
  } else {
    rows = await db.select().from(schema.stashRoots).where(eq(schema.stashRoots.ownerId, user!.id));
  }

  const items = rows.map((r: typeof rows[number]) => ({
    ...r,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : new Date(r.updatedAt).toISOString(),
  }));

  return NextResponse.json({ items, total: items.length, limit: items.length, offset: 0 });
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

  const parsed = CreateStashRootBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-body', issues: parsed.error.issues }, { status: 400 });
  }

  const { name, path: rootPath } = parsed.data;

  // Validate path exists and is writable.
  try {
    await fs.access(rootPath, fs.constants.F_OK | fs.constants.W_OK);
  } catch (err) {
    logger.warn({ path: rootPath, err }, 'stash-roots POST: path not accessible');
    return NextResponse.json(
      { error: 'path-not-accessible', reason: 'Path does not exist or is not writable' },
      { status: 422 },
    );
  }

  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: 'path-not-directory', reason: 'Path must be a directory' }, { status: 422 });
  }

  const id = randomUUID();
  const now = new Date();
  await (getDb() as any).insert(schema.stashRoots).values({
    id,
    ownerId: user!.id,
    name,
    path: rootPath,
    createdAt: now,
    updatedAt: now,
  });

  return NextResponse.json({
    id,
    ownerId: user!.id,
    name,
    path: rootPath,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }, { status: 201 });
}
