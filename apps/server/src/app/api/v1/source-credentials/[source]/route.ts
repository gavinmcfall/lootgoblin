import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { encrypt, decrypt } from '@/crypto';
import { getAdapter } from '@/adapters';
import { auth } from '@/auth';

export async function POST(req: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const apiKey = req.headers.get('x-api-key');
  if (!(await auth()) && !apiKey) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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

export async function GET(_req: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await (getDb() as any)
    .select({ id: schema.sourceCredentials.id, label: schema.sourceCredentials.label, status: schema.sourceCredentials.status, lastUsedAt: schema.sourceCredentials.lastUsedAt })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, source));
  return NextResponse.json({ credentials: rows });
}

export async function DELETE(req: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await (getDb() as any)
    .delete(schema.sourceCredentials)
    .where(and(eq(schema.sourceCredentials.sourceId, source), eq(schema.sourceCredentials.id, id)));
  return NextResponse.json({ ok: true });
}
