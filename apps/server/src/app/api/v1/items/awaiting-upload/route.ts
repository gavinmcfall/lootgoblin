import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';

// Extension-facing endpoint. Auth via x-api-key header — no session required.
export async function GET(req: Request) {
  const apiKey = req.headers.get('x-api-key');
  if (!apiKey) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const source = url.searchParams.get('source');
  if (!source) return NextResponse.json({ error: 'source query param required' }, { status: 400 });

  const rows = await (getDb() as any)
    .select({
      id: schema.items.id,
      sourceId: schema.items.sourceId,
      sourceItemId: schema.items.sourceItemId,
      snapshot: schema.items.snapshot,
    })
    .from(schema.items)
    .where(and(eq(schema.items.sourceId, source), eq(schema.items.status, 'awaiting-upload')));

  const pending = rows.map((r: { id: string; sourceId: string; sourceItemId: string; snapshot: unknown }) => ({
    id: r.id,
    sourceItemId: r.sourceItemId,
    pendingFiles: (r.snapshot as { pendingUploads?: Array<{ url: string; name: string }> })?.pendingUploads ?? [],
  }));

  return NextResponse.json({ items: pending });
}
