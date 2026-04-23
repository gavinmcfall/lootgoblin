import { NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/settings';
import { getSessionOrNull } from '@/auth/helpers';

export async function GET(req: Request) {
  // Session-only: settings access is a UI admin operation.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });
  return NextResponse.json({ key, value: await getSetting(key) });
}

export async function PUT(req: Request) {
  // Session-only: settings mutation is a UI admin operation.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json() as { key: string; value: unknown };
  if (!body?.key) return NextResponse.json({ error: 'key required' }, { status: 400 });
  await setSetting(body.key, body.value);
  return NextResponse.json({ ok: true });
}
