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
import { eq, count } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@/db/client';
import { authenticateRequest, unauthenticatedResponse } from '@/auth/request-auth';
import { resolveAcl } from '@/acl/resolver';
import { logger } from '@/logger';

const CreateStashRootBody = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1),
});

export async function GET(req: Request) {
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') return unauthenticatedResponse(authOutcome);
  const user = authOutcome;

  const acl = resolveAcl({ user, resource: { kind: 'collection' }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '25', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const db = getDb() as any;

  // Admins see all roots; regular users see only their own.  Scope the COUNT
  // query the same way so `total` reflects what the caller would actually see
  // if they paginated through all pages.
  const baseSelect = user.role === 'admin'
    ? db.select().from(schema.stashRoots)
    : db.select().from(schema.stashRoots).where(eq(schema.stashRoots.ownerId, user.id));

  const rows = await baseSelect.limit(limit).offset(offset);

  const baseCount = user.role === 'admin'
    ? db.select({ value: count() }).from(schema.stashRoots)
    : db.select({ value: count() }).from(schema.stashRoots).where(eq(schema.stashRoots.ownerId, user.id));
  const totalRows = await baseCount;
  const total = totalRows[0]?.value ?? 0;

  const items = rows.map((r: typeof rows[number]) => ({
    ...r,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : new Date(r.updatedAt).toISOString(),
  }));

  return NextResponse.json({ items, total, limit, offset });
}

export async function POST(req: Request) {
  const authOutcome = await authenticateRequest(req);
  if (authOutcome === null || typeof authOutcome === 'symbol') return unauthenticatedResponse(authOutcome);
  const user = authOutcome;

  const acl = resolveAcl({ user, resource: { kind: 'collection' }, action: 'create' });
  if (!acl.allowed) return NextResponse.json({ error: 'forbidden', reason: acl.reason }, { status: 403 });

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

  // Validate path exists, is writable, and is a directory.  All three checks
  // go through ONE try/catch — `fs.stat` can throw on broken symlinks,
  // permission changes between `access` and `stat`, or other fs quirks; we
  // don't want those to surface as 500s.
  try {
    await fs.access(rootPath, fs.constants.F_OK | fs.constants.W_OK);
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      return NextResponse.json(
        { error: 'path-not-directory', reason: `Not a directory: ${rootPath}` },
        { status: 422 },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ path: rootPath, err }, 'stash-roots POST: path not accessible');
    return NextResponse.json(
      { error: 'path-not-accessible', reason: `Path not accessible: ${message}` },
      { status: 422 },
    );
  }

  const id = randomUUID();
  const now = new Date();
  await (getDb() as any).insert(schema.stashRoots).values({
    id,
    ownerId: user.id,
    name,
    path: rootPath,
    createdAt: now,
    updatedAt: now,
  });

  return NextResponse.json({
    id,
    ownerId: user.id,
    name,
    path: rootPath,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }, { status: 201 });
}
