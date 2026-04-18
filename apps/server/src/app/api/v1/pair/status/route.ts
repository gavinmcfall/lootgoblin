import { NextResponse } from 'next/server';
import { _pending } from '../challenge/route';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const challengeId = url.searchParams.get('challengeId');
  if (!challengeId) return NextResponse.json({ error: 'challengeId required' }, { status: 400 });
  const entry = _pending.get(challengeId);
  if (!entry) return NextResponse.json({ status: 'unknown' });
  if (entry.expires < Date.now()) return NextResponse.json({ status: 'expired' });
  if (entry.approvedKey) {
    const key = entry.approvedKey;
    _pending.delete(challengeId);
    return NextResponse.json({ status: 'approved', key });
  }
  return NextResponse.json({ status: 'pending', code: entry.code });
}
