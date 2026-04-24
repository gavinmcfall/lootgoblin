import { NextResponse } from 'next/server';
import { pendingChallenges } from '../store';
import { getSessionOrNull } from '@/auth/helpers';

export async function GET(req: Request) {
  // Session-only: listing pending pairing challenges is a UI admin action.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const now = Date.now();
  const list = [...pendingChallenges.entries()]
    .filter(([, v]) => !v.approvedKey && v.expires > now)
    .map(([challengeId, v]) => ({ challengeId, code: v.code, expiresAt: v.expires, browserFingerprint: v.browserFingerprint }));
  return NextResponse.json({ pending: list });
}
