import { NextResponse } from 'next/server';
import { pendingChallenges } from '../store';

export async function GET() {
  // TODO: auth integration pending V2-001-T2 (BetterAuth install)
  // Session validation will be added in the auth plugin.
  const now = Date.now();
  const list = [...pendingChallenges.entries()]
    .filter(([, v]) => !v.approvedKey && v.expires > now)
    .map(([challengeId, v]) => ({ challengeId, code: v.code, expiresAt: v.expires, browserFingerprint: v.browserFingerprint }));
  return NextResponse.json({ pending: list });
}
