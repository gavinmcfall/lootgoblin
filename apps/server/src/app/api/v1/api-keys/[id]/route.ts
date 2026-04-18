import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { getDb, schema } from '@/db/client';

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await (getDb() as any)
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiKeys.id, id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!(await auth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { name } = (await req.json()) as { name?: string };
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  await (getDb() as any)
    .update(schema.apiKeys)
    .set({ name: name.trim() })
    .where(eq(schema.apiKeys.id, id));
  return NextResponse.json({ ok: true });
}
