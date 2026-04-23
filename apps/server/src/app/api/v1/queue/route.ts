import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db/client';
import { enqueueItem } from '@/workers/queue';
import { randomUUID } from 'node:crypto';
import { getSessionOrNull, isValidApiKeyWithScope } from '@/auth/helpers';

export async function POST(req: Request) {
  // Session-or-apikey: the extension submits items via API key; the UI uses session.
  // API key access requires extension_pairing scope.
  const session = await getSessionOrNull(req);
  if (!session) {
    const keyResult = await isValidApiKeyWithScope(req, ['extension_pairing']);
    if (!keyResult.valid) {
      if (keyResult.reason === 'wrong-scope') {
        return NextResponse.json(
          { error: 'wrong-scope', expected: keyResult.expected, actual: keyResult.actual },
          { status: 403 },
        );
      }
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const body = await req.json() as {
    sourceId: string;
    sourceItemId: string;
    sourceUrl: string;
    contentType: string;
    snapshot?: unknown;
    force?: boolean;
  };

  const db = getDb() as any;
  if (!body.force) {
    const existing = await db
      .select()
      .from(schema.items)
      .where(and(
        eq(schema.items.sourceId, body.sourceId),
        eq(schema.items.sourceItemId, body.sourceItemId),
        eq(schema.items.status, 'done'),
      ))
      .limit(1);
    if (existing.length > 0) {
      return NextResponse.json({
        duplicate: true,
        existingId: existing[0].id,
        outputPath: existing[0].outputPath,
      }, { status: 200 });
    }
  }

  const id = randomUUID();
  await enqueueItem({
    id,
    sourceId: body.sourceId,
    sourceItemId: body.sourceItemId,
    sourceUrl: body.sourceUrl,
    contentType: body.contentType,
    snapshot: body.snapshot,
  });
  return NextResponse.json({ id });
}

export async function GET(req: Request) {
  // Session-only: queue listing is a UI-facing operation.
  const session = await getSessionOrNull(req);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const db = getDb() as any;
  const rows = await db.select().from(schema.items).orderBy(desc(schema.items.createdAt)).limit(200);
  return NextResponse.json({ items: rows });
}
