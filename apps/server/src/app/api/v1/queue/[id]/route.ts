import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  // loot update: owner or admin. Items have no ownerId in v2-001; treat caller as owner.
  const acl = resolveAcl({ user, resource: { kind: 'loot', id, ownerId: user?.id }, action: 'update' });
  if (!acl.allowed) return NextResponse.json({ error: acl.reason ?? 'unauthorized' }, { status: user ? 403 : 401 });
  const { destinationId, credentialId } = (await req.json()) as { destinationId?: string; credentialId?: string };
  await (getDb() as any).update(schema.items).set({ destinationId, credentialId, updatedAt: new Date() }).where(eq(schema.items.id, id));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'loot', id, ownerId: user?.id }, action: 'delete' });
  if (!acl.allowed) return NextResponse.json({ error: acl.reason ?? 'unauthorized' }, { status: user ? 403 : 401 });
  await (getDb() as any).delete(schema.items).where(eq(schema.items.id, id));
  return NextResponse.json({ ok: true });
}
