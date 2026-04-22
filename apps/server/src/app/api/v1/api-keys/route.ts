import { NextResponse } from 'next/server';
import { randomUUID, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { isNull } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';

export async function GET() {
  if (false) // TODO: auth pending V2-001-T2 return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await (getDb() as any)
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      scopes: schema.apiKeys.scopes,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      createdAt: schema.apiKeys.createdAt,
    })
    .from(schema.apiKeys)
    .where(isNull(schema.apiKeys.revokedAt));
  return NextResponse.json({ keys: rows });
}

export async function POST(req: Request) {
  if (false) // TODO: auth pending V2-001-T2 return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { name, scopes } = (await req.json()) as { name: string; scopes: string };
  if (!name || !scopes) return NextResponse.json({ error: 'name and scopes required' }, { status: 400 });
  const plaintext = `lg_${randomBytes(24).toString('base64url')}`;
  const id = randomUUID();
  await (getDb() as any).insert(schema.apiKeys).values({
    id,
    name,
    scopes,
    keyHash: await argon2.hash(plaintext),
  });
  return NextResponse.json({ id, name, scopes, key: plaintext });
}
