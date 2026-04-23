import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';

export async function GET(req: Request) {
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'collection' }, action: 'read' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });
  const rows = await (getDb() as any).select().from(schema.destinations);
  return NextResponse.json({ destinations: rows });
}

export async function POST(req: Request) {
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  const acl = resolveAcl({ user, resource: { kind: 'collection' }, action: 'create' });
  if (!acl.allowed) return NextResponse.json({ error: 'unauthorized' }, { status: user ? 403 : 401 });
  const body = (await req.json()) as {
    name: string;
    type: 'filesystem';
    config: { path: string; namingTemplate: string };
    packager: string;
    credentialId?: string;
  };
  const id = randomUUID();
  await (getDb() as any).insert(schema.destinations).values({ id, ...body });
  return NextResponse.json({ id });
}
