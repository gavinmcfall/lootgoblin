import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { getSessionOrNull } from '@/auth/helpers';

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // Session-only: assigning destinations is a UI-facing operation.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { destinationId, credentialId } = (await req.json()) as { destinationId?: string; credentialId?: string };
  await (getDb() as any).update(schema.items).set({ destinationId, credentialId, updatedAt: new Date() }).where(eq(schema.items.id, id));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // Session-only: deleting queue items is a UI-facing operation.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await (getDb() as any).delete(schema.items).where(eq(schema.items.id, id));
  return NextResponse.json({ ok: true });
}
