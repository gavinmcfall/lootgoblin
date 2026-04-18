import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client';
import { leaseNextItem, completeItem, failItem, resetRunningToQueued } from './queue';
import { getAdapter } from '../adapters';
import { getPackager } from '../packagers';
import { getWriter } from '../destinations';
import { decrypt } from '../crypto';
import { ensureEmptyStagingDir } from '../destinations/filesystem/atomic';
import { classifyError, nextRetryDelayMs, defaultRetryPolicy } from './retry';
import { RateLimiter } from './rate-limit';
import { logger } from '../logger';
import { emit } from '../lib/sse';

const limiters = new Map<string, RateLimiter>();
function limiterFor(sourceId: string): RateLimiter {
  let rl = limiters.get(sourceId);
  if (!rl) {
    rl = new RateLimiter({ tokensPerSec: 0.5, bucketSize: 1 });
    limiters.set(sourceId, rl);
  }
  return rl;
}

export async function runOneItem(): Promise<'done' | 'failed' | 'idle'> {
  const item = await leaseNextItem();
  if (!item) return 'idle';

  const db = getDb() as any;
  const log = logger.child({ itemId: item.id, sourceId: item.sourceId });
  const staging = path.join(process.env.STAGING_DIR ?? os.tmpdir(), `lg-${item.id}`);

  try {
    await ensureEmptyStagingDir(staging);

    if (!item.credentialId) throw new Error('No credential assigned');
    const [cred] = await db.select().from(schema.sourceCredentials).where(eq(schema.sourceCredentials.id, item.credentialId));
    if (!cred) throw new Error('Credential not found');
    const blob = decrypt(Buffer.from(cred.encryptedBlob as Buffer).toString(), process.env.LOOTGOBLIN_SECRET!);

    const adapter = getAdapter(item.sourceId);
    await limiterFor(item.sourceId).take();
    const fetched = await adapter.fetch(item.sourceItemId, blob);

    const packager = getPackager('manyfold-v0');
    await packager.package(staging, fetched);

    if (!item.destinationId) throw new Error('No destination assigned');
    const [dest] = await db.select().from(schema.destinations).where(eq(schema.destinations.id, item.destinationId));
    if (!dest) throw new Error('Destination not found');

    const writer = getWriter(dest.type);
    const { outputPath } = await writer.write(staging, dest as any, { item: fetched });
    await completeItem(item.id, outputPath);
    emit('item-updated', { id: item.id, status: 'done', outputPath });
    log.info({ outputPath }, 'item completed');
    return 'done';
  } catch (err) {
    const { retryable, reason } = classifyError(err);
    const nextDelay = retryable ? nextRetryDelayMs(defaultRetryPolicy, item.retryCount) : null;
    await failItem(item.id, `${reason}: ${(err as Error).message}`, nextDelay !== null);
    emit('item-updated', { id: item.id, status: nextDelay !== null ? 'queued' : 'failed', error: reason });
    log.error({ err, retryable, nextDelay }, 'item failed');
    return 'failed';
  }
}

export async function runWorkerLoop(signal: AbortSignal): Promise<void> {
  await resetRunningToQueued();
  while (!signal.aborted) {
    const outcome = await runOneItem();
    if (outcome === 'idle') await new Promise((r) => setTimeout(r, 1000));
  }
}
