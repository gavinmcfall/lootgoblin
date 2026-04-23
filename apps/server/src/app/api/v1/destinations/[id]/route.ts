import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'collection', id }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });
  const [row] = await (getDb() as any).select().from(schema.destinations).where(eq(schema.destinations.id, id));
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ destination: row });
}

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  // Destinations don't carry an ownerId in v2-001; admin-or-self update will be
  // enforced properly once Destination carries ownerId (v2-002+). For now, any
  // authenticated user can update (single-library shape, no ownerId yet).
  const acl = resolveAcl({ user, resource: { kind: 'collection', id, ownerId: user?.id }, action: 'update' });
  if (!acl.allowed) return NextResponse.json({ error: acl.reason }, { status: user ? 403 : 401 });
  const body = (await req.json()) as Partial<{ name: string; config: unknown; packager: string; credentialId?: string }>;
  await (getDb() as any).update(schema.destinations).set({ ...body, updatedAt: new Date() }).where(eq(schema.destinations.id, id));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  // Same as PUT above: ownerId not yet tracked, treat caller as owner for v2-001.
  const acl = resolveAcl({ user, resource: { kind: 'collection', id, ownerId: user?.id }, action: 'delete' });
  if (!acl.allowed) return NextResponse.json({ error: acl.reason }, { status: user ? 403 : 401 });
  await (getDb() as any).delete(schema.destinations).where(eq(schema.destinations.id, id));
  return NextResponse.json({ ok: true });
}
