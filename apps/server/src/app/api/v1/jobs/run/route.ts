import { NextResponse } from 'next/server';
import { getSessionOrNull } from '@/auth/helpers';

// Workers run continuously via startWorkers() at boot. This endpoint is a UI
// "Go" trigger that just returns ok — v1 does not selectively start specific items.
export async function POST(req: Request) {
  // Session-only: manual job trigger is a UI-facing action.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true });
}
