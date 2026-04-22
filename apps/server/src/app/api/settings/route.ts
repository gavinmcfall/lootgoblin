import { NextResponse } from 'next/server';
import { getSetting, setSetting } from '@/lib/settings';

export async function GET(req: Request) {
  const session = null; // TODO: auth pending V2-001-T2
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });
  return NextResponse.json({ key, value: await getSetting(key) });
}

export async function PUT(req: Request) {
  const session = null; // TODO: auth pending V2-001-T2
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json() as { key: string; value: unknown };
  if (!body?.key) return NextResponse.json({ error: 'key required' }, { status: 400 });
  await setSetting(body.key, body.value);
  return NextResponse.json({ ok: true });
}
