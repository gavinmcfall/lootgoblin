import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { enqueueItem, leaseNextItem, completeItem, failItem } from '../../src/workers/queue';

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/lootgoblin-queue.db';
  resetDbCache();
  await runMigrations('file:/tmp/lootgoblin-queue.db');
});

beforeEach(async () => {
  await (getDb() as any).delete(schema.items);
});

describe('queue', () => {
  it('enqueue then lease returns that item', async () => {
    const id = randomUUID();
    await enqueueItem({ id, sourceId: 'makerworld', sourceItemId: '123', contentType: 'model-3d', sourceUrl: 'https://makerworld.com/123' });
    const leased = await leaseNextItem();
    expect(leased?.id).toBe(id);
    expect(leased?.status).toBe('running');
  });

  it('leaseNext returns null when empty', async () => {
    expect(await leaseNextItem()).toBeNull();
  });

  it('complete transitions to done', async () => {
    const id = randomUUID();
    await enqueueItem({ id, sourceId: 'makerworld', sourceItemId: '123', contentType: 'model-3d', sourceUrl: '' });
    await leaseNextItem();
    await completeItem(id, '/tmp/out');
    const [row] = await (getDb() as any).select().from(schema.items);
    expect(row.status).toBe('done');
    expect(row.outputPath).toBe('/tmp/out');
  });

  it('fail with willRetry increments retryCount and requeues', async () => {
    const id = randomUUID();
    await enqueueItem({ id, sourceId: 'makerworld', sourceItemId: '123', contentType: 'model-3d', sourceUrl: '' });
    await leaseNextItem();
    await failItem(id, 'network', true);
    const [row] = await (getDb() as any).select().from(schema.items);
    expect(row.status).toBe('queued'); // will retry
    expect(row.retryCount).toBe(1);
  });

  it('fail without willRetry marks failed', async () => {
    const id = randomUUID();
    await enqueueItem({ id, sourceId: 'makerworld', sourceItemId: '123', contentType: 'model-3d', sourceUrl: '' });
    await leaseNextItem();
    await failItem(id, 'forbidden', false);
    const [row] = await (getDb() as any).select().from(schema.items);
    expect(row.status).toBe('failed');
  });
});
