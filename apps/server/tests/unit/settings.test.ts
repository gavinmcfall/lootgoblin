import { describe, it, expect, beforeAll } from 'vitest';
import { getSetting, setSetting } from '../../src/lib/settings';
import { runMigrations, resetDbCache } from '../../src/db/client';

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/lootgoblin-settings.db';
  resetDbCache();
  await runMigrations('file:/tmp/lootgoblin-settings.db');
});

describe('settings', () => {
  it('returns undefined for missing key', async () => {
    expect(await getSetting('missing')).toBeUndefined();
  });
  it('sets and retrieves a value', async () => {
    await setSetting('worker_concurrency', 4);
    expect(await getSetting<number>('worker_concurrency')).toBe(4);
  });
  it('updates existing', async () => {
    await setSetting('worker_concurrency', 4);
    await setSetting('worker_concurrency', 8);
    expect(await getSetting<number>('worker_concurrency')).toBe(8);
  });
});
