import { NextResponse } from 'next/server';
import { randomUUID, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { auth } from '@/auth';
import { getDb, schema } from '@/db/client';
import { pendingChallenges } from '../store';

export async function POST(req: Request) {
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { challengeId } = (await req.json()) as { challengeId: string };
  const entry = pendingChallenges.get(challengeId);
  if (!entry || entry.expires < Date.now()) return NextResponse.json({ error: 'expired' }, { status: 410 });
  const plaintext = `lg_${randomBytes(24).toString('base64url')}`;
  const id = randomUUID();
  await (getDb() as any).insert(schema.apiKeys).values({
    id,
    name: 'extension',
    scopes: 'items:write,credentials:write,site-configs:read',
    keyHash: await argon2.hash(plaintext),
  });
  entry.approvedKey = plaintext;
  return NextResponse.json({ ok: true });
}
