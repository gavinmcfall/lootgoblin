/**
 * LootFiles — V2-002-T12
 *
 * GET — list all files for a given Loot item.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';

function serializeFile(r: Record<string, unknown>) {
  return {
    ...r,
    createdAt: r.createdAt instanceof Date ? (r.createdAt as Date).toISOString() : new Date(r.createdAt as number).toISOString(),
  };
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: lootId } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'loot', id: lootId }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });

  const db = getDb() as any;

  // Verify loot exists.
  const lootRows = await db
    .select({ id: schema.loot.id })
    .from(schema.loot)
    .where(eq(schema.loot.id, lootId))
    .limit(1);
  if (lootRows.length === 0) return NextResponse.json({ error: 'not-found' }, { status: 404 });

  const files = await db.select().from(schema.lootFiles).where(eq(schema.lootFiles.lootId, lootId));

  return NextResponse.json({
    items: files.map(serializeFile),
    total: files.length,
    limit: files.length,
    offset: 0,
  });
}
