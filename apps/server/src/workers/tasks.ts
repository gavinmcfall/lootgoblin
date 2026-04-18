import fs from 'node:fs/promises';
import path from 'node:path';
import { lt } from 'drizzle-orm';
import { getDb, schema } from '../db/client';
import { getSetting } from '../lib/settings';
import { logger } from '../logger';

export interface TaskSpec {
  id: string;
  label: string;
  intervalMs: number;
  enabledDefault: boolean;
  run: () => Promise<void>;
}

const STAGING_DIR = process.env.STAGING_DIR ?? '/config/staging';

export const tasks: TaskSpec[] = [
  {
    id: 'cleanup',
    label: 'Cleanup staging + old events',
    intervalMs: 24 * 60 * 60 * 1000,
    enabledDefault: true,
    async run() {
      const retentionDays = (await getSetting<number>('cleanup_retention_days')) ?? 90;
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
      await (getDb() as any).delete(schema.itemEvents).where(lt(schema.itemEvents.createdAt, cutoff));
      try {
        const dirs = await fs.readdir(STAGING_DIR);
        await Promise.all(dirs.map((d) => fs.rm(path.join(STAGING_DIR, d), { recursive: true, force: true })));
      } catch {
        /* staging dir may not exist */
      }
    },
  },
];

const lastRun = new Map<string, number>();

export function getLastRun(id: string): number | undefined {
  return lastRun.get(id);
}

export async function startScheduler(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    for (const t of tasks) {
      const enabled = (await getSetting<boolean>(`task_${t.id}_enabled`)) ?? t.enabledDefault;
      if (!enabled) continue;
      const last = lastRun.get(t.id) ?? 0;
      if (Date.now() - last < t.intervalMs) continue;
      try {
        await t.run();
        lastRun.set(t.id, Date.now());
        logger.info({ task: t.id }, 'scheduled task ran');
      } catch (err) {
        logger.error({ err, task: t.id }, 'scheduled task failed');
      }
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
