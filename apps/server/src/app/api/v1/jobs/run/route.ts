import { NextResponse } from 'next/server';
import { auth } from '@/auth';
// Workers run continuously via startWorkers() at boot. This endpoint is a UI
// "Go" trigger that just returns ok — v1 does not selectively start specific items.
export async function POST() {
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true });
}
