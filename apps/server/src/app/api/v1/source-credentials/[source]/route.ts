import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { encrypt } from '@/crypto';
import { getAdapter } from '@/adapters';
import { getSessionOrNull, isValidApiKey } from '@/auth/helpers';

export async function POST(req: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  // Session-or-apikey: the extension submits cookies via API key; UI uses session.
  const session = await getSessionOrNull(req);
  const apiKeyValid = session ? false : await isValidApiKey(req);
  if (!session && !apiKeyValid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json() as { label?: string; cookies: unknown[] };
  const blob = JSON.stringify({ cookies: body.cookies });
  const adapter = getAdapter(source);
  const verify = await adapter.verifyCredential(blob);
  if (!verify.ok) return NextResponse.json({ error: 'credential verification failed' }, { status: 400 });

  const id = randomUUID();
  const label = body.label ?? verify.accountLabel ?? `cred-${id.slice(0, 6)}`;
  await (getDb() as any).insert(schema.sourceCredentials).values({
    id,
    sourceId: source,
    label,
    kind: 'cookie-jar',
    encryptedBlob: Buffer.from(encrypt(blob, process.env.LOOTGOBLIN_SECRET!)),
    status: 'active',
  });
  return NextResponse.json({ id, label });
}

export async function GET(req: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  // Session-or-apikey: extension reads credentials it uploaded via API key; UI uses session.
  const session = await getSessionOrNull(req);
  const apiKeyValid = session ? false : await isValidApiKey(req);
  if (!session && !apiKeyValid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await (getDb() as any)
    .select({ id: schema.sourceCredentials.id, label: schema.sourceCredentials.label, status: schema.sourceCredentials.status, lastUsedAt: schema.sourceCredentials.lastUsedAt })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, source));
  return NextResponse.json({ credentials: rows });
}

export async function DELETE(req: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  // Session-only: credential deletion is a UI admin action.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await (getDb() as any)
    .delete(schema.sourceCredentials)
    .where(and(eq(schema.sourceCredentials.sourceId, source), eq(schema.sourceCredentials.id, id)));
  return NextResponse.json({ ok: true });
}
