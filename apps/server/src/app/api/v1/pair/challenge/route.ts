import { NextResponse } from 'next/server';
import { randomInt, randomUUID } from 'node:crypto';
import { pendingChallenges } from '../store';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { browserFingerprint?: string };
  const code = `${randomInt(100, 999)}-${randomInt(100, 999)}`;
  const challengeId = randomUUID();
  pendingChallenges.set(challengeId, {
    code,
    expires: Date.now() + 90_000,
    browserFingerprint: body.browserFingerprint,
  });
  return NextResponse.json({ challengeId, code });
}
