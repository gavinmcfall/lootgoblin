import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (false) // TODO: auth pending V2-001-T2 return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const [row] = await (getDb() as any).select().from(schema.destinations).where(eq(schema.destinations.id, id));
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ destination: row });
}

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (false) // TODO: auth pending V2-001-T2 return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await req.json()) as Partial<{ name: string; config: unknown; packager: string; credentialId?: string }>;
  await (getDb() as any).update(schema.destinations).set({ ...body, updatedAt: new Date() }).where(eq(schema.destinations.id, id));
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (false) // TODO: auth pending V2-001-T2 return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await (getDb() as any).delete(schema.destinations).where(eq(schema.destinations.id, id));
  return NextResponse.json({ ok: true });
}
