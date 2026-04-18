import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { _pending } from '../challenge/route';

export async function GET() {
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const now = Date.now();
  const list = [..._pending.entries()]
    .filter(([, v]) => !v.approvedKey && v.expires > now)
    .map(([challengeId, v]) => ({ challengeId, code: v.code, expiresAt: v.expires, browserFingerprint: v.browserFingerprint }));
  return NextResponse.json({ pending: list });
}
