import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { auth } from '@/auth';
import { getDb, schema } from '@/db/client';

export async function GET() {
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await (getDb() as any).select().from(schema.destinations);
  return NextResponse.json({ destinations: rows });
}

export async function POST(req: Request) {
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await req.json()) as {
    name: string;
    type: 'filesystem';
    config: { path: string; namingTemplate: string };
    packager: string;
    credentialId?: string;
  };
  const id = randomUUID();
  await (getDb() as any).insert(schema.destinations).values({ id, ...body });
  return NextResponse.json({ id });
}
