import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await context.params;
  const { destinationId, credentialId } = (await req.json()) as { destinationId?: string; credentialId?: string };
  await (getDb() as any).update(schema.items).set({ destinationId, credentialId, updatedAt: new Date() }).where(eq(schema.items.id, id));
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await context.params;
  await (getDb() as any).delete(schema.items).where(eq(schema.items.id, id));
  return NextResponse.json({ ok: true });
}
