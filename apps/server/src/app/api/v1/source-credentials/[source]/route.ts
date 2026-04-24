import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { encrypt } from '@/crypto';
import { getAdapter } from '@/adapters';
import { getSessionOrNull, isValidApiKeyWithScope } from '@/auth/helpers';
import { resolveAcl } from '@/acl/resolver';

export async function POST(req: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  // Session-or-apikey: the extension submits cookies via API key; UI uses session.
  // API key access requires extension_pairing scope.
  const session = await getSessionOrNull(req);
  if (!session) {
    const keyResult = await isValidApiKeyWithScope(req, ['extension_pairing']);
    if (!keyResult.valid) {
      if (keyResult.reason === 'wrong-scope') {
        return NextResponse.json(
          { error: 'wrong-scope', expected: keyResult.expected, actual: keyResult.actual },
          { status: 403 },
        );
      }
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

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
  // API key access requires extension_pairing scope.
  const session = await getSessionOrNull(req);
  if (!session) {
    const keyResult = await isValidApiKeyWithScope(req, ['extension_pairing']);
    if (!keyResult.valid) {
      if (keyResult.reason === 'wrong-scope') {
        return NextResponse.json(
          { error: 'wrong-scope', expected: keyResult.expected, actual: keyResult.actual },
          { status: 403 },
        );
      }
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const rows = await (getDb() as any)
    .select({
      id: schema.sourceCredentials.id,
      label: schema.sourceCredentials.label,
      status: schema.sourceCredentials.status,
      lastUsedAt: schema.sourceCredentials.lastUsedAt,
    })
    .from(schema.sourceCredentials)
    .where(eq(schema.sourceCredentials.sourceId, source));
  return NextResponse.json({ credentials: rows });
}

export async function DELETE(req: Request, context: { params: Promise<{ source: string }> }) {
  const { source } = await context.params;
  const session = await getSessionOrNull(req);
  const user = session ? { id: session.user.id, role: session.user.role } : null;
  // Source credential delete maps to loot delete (credentials gate source access = loot pipeline).
  // Owner or admin. Credentials have no per-user owner in v2-001; treat caller as owner.
  const acl = resolveAcl({ user, resource: { kind: 'loot', ownerId: user?.id }, action: 'delete' });
  if (!acl.allowed) return NextResponse.json({ error: acl.reason ?? 'unauthorized' }, { status: user ? 403 : 401 });
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await (getDb() as any)
    .delete(schema.sourceCredentials)
    .where(and(eq(schema.sourceCredentials.sourceId, source), eq(schema.sourceCredentials.id, id)));
  return NextResponse.json({ ok: true });
}
