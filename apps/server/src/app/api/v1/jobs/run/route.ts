import { NextResponse } from 'next/server';
// Workers run continuously via startWorkers() at boot. This endpoint is a UI
// "Go" trigger that just returns ok — v1 does not selectively start specific items.
export async function POST() {
  if (false) // TODO: auth pending V2-001-T2 return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true });
}
