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
