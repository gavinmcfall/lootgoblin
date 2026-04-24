import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';

// Mock auth helpers so the route sees a valid API-key auth without a real BetterAuth instance.
// T5: queue route uses isValidApiKeyWithScope; mock returns a valid extension_pairing result.
vi.mock('@/auth/helpers', () => ({
  getSessionOrNull: vi.fn().mockResolvedValue(null),
  isValidApiKey: vi.fn().mockResolvedValue(true),
  isValidApiKeyWithScope: vi.fn().mockResolvedValue({
    valid: true,
    scope: 'extension_pairing',
    keyId: 'test-key-id',
  }),
}));

// Provide a minimal NextResponse shim so next/server doesn't need to load
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { POST } from '../../src/app/api/v1/queue/route';

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/lootgoblin-dedup.db';
  resetDbCache();
  await runMigrations('file:/tmp/lootgoblin-dedup.db');
});

beforeEach(async () => {
  await (getDb() as any).delete(schema.itemEvents);
  await (getDb() as any).delete(schema.items);
});

function makeReq(body: unknown): Request {
  return new Request('http://local/api/v1/queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/queue dedup', () => {
  it('returns duplicate=true when prior done row exists and force is not set', async () => {
    const db = getDb() as any;
    const priorId = randomUUID();
    await db.insert(schema.items).values({
      id: priorId,
      sourceId: 'makerworld',
      sourceItemId: '123',
      contentType: 'model-3d',
      sourceUrl: 'https://makerworld.com/models/123',
      status: 'done',
      outputPath: '/library/x',
      retryCount: 0,
    });

    const res = await POST(makeReq({
      sourceId: 'makerworld', sourceItemId: '123', sourceUrl: 'https://x', contentType: 'model-3d',
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.duplicate).toBe(true);
    expect(json.existingId).toBe(priorId);
  });

  it('enqueues anyway when force is true', async () => {
    const db = getDb() as any;
    await db.insert(schema.items).values({
      id: randomUUID(),
      sourceId: 'makerworld',
      sourceItemId: '123',
      contentType: 'model-3d',
      sourceUrl: '',
      status: 'done',
      retryCount: 0,
    });

    const res = await POST(makeReq({
      sourceId: 'makerworld', sourceItemId: '123', sourceUrl: 'https://x', contentType: 'model-3d', force: true,
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.id).toBeDefined();
    expect(json.duplicate).toBeUndefined();
  });
});
