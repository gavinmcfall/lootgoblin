import { NextResponse } from 'next/server';
import { randomInt, randomUUID } from 'node:crypto';

interface Pending {
  code: string;
  expires: number;
  approvedKey?: string;
  browserFingerprint?: string;
}

// In-memory store — v1 single-instance. Scale-out would need a pair_challenges table.
export const _pending = new Map<string, Pending>();

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { browserFingerprint?: string };
  const code = `${randomInt(100, 999)}-${randomInt(100, 999)}`;
  const challengeId = randomUUID();
  _pending.set(challengeId, {
    code,
    expires: Date.now() + 90_000,
    browserFingerprint: body.browserFingerprint,
  });
  return NextResponse.json({ challengeId, code });
}
