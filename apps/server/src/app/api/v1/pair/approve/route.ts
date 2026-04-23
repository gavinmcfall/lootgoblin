import { NextResponse } from 'next/server';
import { randomUUID, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { getDb, schema } from '@/db/client';
import { pendingChallenges } from '../store';
import { getSessionOrNull } from '@/auth/helpers';
import { API_KEY_SCOPES } from '@/auth/scopes';

export async function POST(req: Request) {
  // Session-only: approving pairing requests is a UI admin action.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { challengeId } = (await req.json()) as { challengeId: string };
  const entry = pendingChallenges.get(challengeId);
  if (!entry || entry.expires < Date.now()) return NextResponse.json({ error: 'expired' }, { status: 410 });

  const scopeConfig = API_KEY_SCOPES.extension_pairing;
  const plaintext = `${scopeConfig.prefix}${randomBytes(24).toString('base64url')}`;
  const id = randomUUID();
  const expiresAt = scopeConfig.defaultExpirationDays !== null
    ? new Date(Date.now() + scopeConfig.defaultExpirationDays * 24 * 60 * 60 * 1000)
    : null;

  await (getDb() as any).insert(schema.apiKeys).values({
    id,
    name: 'extension',
    scope: 'extension_pairing',
    keyHash: await argon2.hash(plaintext),
    expiresAt,
  });
  entry.approvedKey = plaintext;
  return NextResponse.json({ ok: true });
}
