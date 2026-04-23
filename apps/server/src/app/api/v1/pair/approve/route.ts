import { NextResponse } from 'next/server';
import { randomUUID, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { getDb, schema } from '@/db/client';
import { pendingChallenges } from '../store';
import { getSessionOrNull } from '@/auth/helpers';

export async function POST(req: Request) {
  // Session-only: approving pairing requests is a UI admin action.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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
