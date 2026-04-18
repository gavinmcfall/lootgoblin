import { and, eq, asc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '../db/client';

export interface EnqueueInput {
  id: string;
  sourceId: string;
  sourceItemId: string;
  contentType: string;
  sourceUrl: string;
  snapshot?: unknown;
  destinationId?: string;
  credentialId?: string;
}

export async function enqueueItem(input: EnqueueInput): Promise<void> {
  const db = getDb() as any;
  await db.insert(schema.items).values({
    ...input,
    status: 'queued',
  });
  await db.insert(schema.itemEvents).values({
    id: randomUUID(),
    itemId: input.id,
    kind: 'status-change',
    message: 'queued',
  });
}

export async function leaseNextItem(): Promise<typeof schema.items.$inferSelect | null> {
  const db = getDb() as any;
  // better-sqlite3 is synchronous — transaction callbacks must NOT be async.
  return db.transaction((tx: any) => {
    const [next] = tx
      .select()
      .from(schema.items)
      .where(eq(schema.items.status, 'queued'))
      .orderBy(asc(schema.items.createdAt))
      .limit(1)
      .all();
    if (!next) return null;
    tx.update(schema.items)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(schema.items.id, next.id), eq(schema.items.status, 'queued')))
      .run();
    return { ...next, status: 'running' as const };
  });
}

export async function completeItem(id: string, outputPath: string): Promise<void> {
  const db = getDb() as any;
  await db.update(schema.items)
    .set({ status: 'done', outputPath, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.items.id, id));
  await db.insert(schema.itemEvents).values({ id: randomUUID(), itemId: id, kind: 'status-change', message: 'done' });
}

export async function failItem(id: string, reason: string, willRetry: boolean): Promise<void> {
  const db = getDb() as any;
  const [row] = await db.select().from(schema.items).where(eq(schema.items.id, id));
  const retryCount = (row?.retryCount ?? 0) + 1;
  await db.update(schema.items)
    .set({
      status: willRetry ? 'queued' : 'failed',
      lastError: reason,
      retryCount,
      updatedAt: new Date(),
    })
    .where(eq(schema.items.id, id));
  await db.insert(schema.itemEvents).values({
    id: randomUUID(),
    itemId: id,
    kind: 'error',
    message: reason,
    meta: { willRetry, retryCount },
  });
}

export async function resetRunningToQueued(): Promise<void> {
  const db = getDb() as any;
  await db.update(schema.items)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(eq(schema.items.status, 'running'));
}
