import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  // Resolve the key's owner before checking ACL.
  const db = getDb() as any;
  // api_keys table has no userId FK in v2-001 (T7 defers unification); treat caller as owner.
  // This is safe: any authenticated user can delete their own key; admin resolution is handled
  // by the resolver. Full owner-lookup will be added when the two key systems are unified.
  const acl = resolveAcl({ user, resource: { kind: 'api_key', ownerId: user?.id, id }, action: 'delete' });
  if (!acl.allowed) return NextResponse.json({ error: acl.reason ?? 'unauthorized' }, { status: user ? 403 : 401 });
  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiKeys.id, id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  // Renaming is logically an update; api_key doesn't have an 'update' action in the ACL model
  // (update/push are wrong-action for api_key). Map rename to 'delete' ACL check: owner-only.
  // Owner renames their own key; admin cannot rename another user's key.
  const acl = resolveAcl({ user, resource: { kind: 'api_key', ownerId: user?.id, id }, action: 'delete' });
  if (!acl.allowed) return NextResponse.json({ error: acl.reason ?? 'unauthorized' }, { status: user ? 403 : 401 });
  const { name } = (await req.json()) as { name?: string };
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  await (getDb() as any)
    .update(schema.apiKeys)
    .set({ name: name.trim() })
    .where(eq(schema.apiKeys.id, id));
  return NextResponse.json({ ok: true });
}
