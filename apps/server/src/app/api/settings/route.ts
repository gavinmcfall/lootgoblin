import { NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/settings';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';

export async function GET(req: Request) {
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'instance_config' }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });
  return NextResponse.json({ key, value: await getSetting(key) });
}

export async function PUT(req: Request) {
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'instance_config' }, action: 'update' });
  if (!acl.allowed) return NextResponse.json({ error: acl.reason ?? 'unauthorized' }, { status: user ? 403 : 401 });
  const body = await req.json() as { key: string; value: unknown };
  if (!body?.key) return NextResponse.json({ error: 'key required' }, { status: 400 });
  await setSetting(body.key, body.value);
  return NextResponse.json({ ok: true });
}
