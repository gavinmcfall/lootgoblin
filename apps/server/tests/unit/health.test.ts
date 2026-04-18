import { describe, it, expect, beforeAll } from 'vitest';
import { GET } from '../../src/app/api/health/route';
import { runMigrations, resetDbCache } from '../../src/db/client';

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/lootgoblin-health.db';
  resetDbCache();
  await runMigrations('file:/tmp/lootgoblin-health.db');
});

describe('GET /api/health', () => {
  it('returns green when DB reachable and secret set', async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.checks.db).toBe('ok');
    expect(body.checks.secret).toBe('ok');
    expect(body.status).toBe('ok');
  });
});
