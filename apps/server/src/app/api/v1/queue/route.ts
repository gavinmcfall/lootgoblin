import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { desc } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { enqueueItem } from '@/workers/queue';
import { randomUUID } from 'node:crypto';

export async function POST(req: Request) {
  const session = await auth();
  const apiKey = req.headers.get('x-api-key');
  if (!session && !apiKey) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json() as { sourceId: string; sourceItemId: string; sourceUrl: string; contentType: string; snapshot?: unknown };
  const id = randomUUID();
  await enqueueItem({ id, ...body });
  return NextResponse.json({ id });
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const db = getDb() as any;
  const rows = await db.select().from(schema.items).orderBy(desc(schema.items.createdAt)).limit(200);
  return NextResponse.json({ items: rows });
}
