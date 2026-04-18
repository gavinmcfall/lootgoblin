import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import { encrypt } from '../../src/crypto';
import { enqueueItem } from '../../src/workers/queue';
import { runOneItem } from '../../src/workers/worker';

const server = setupServer();
beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/lootgoblin-e2e-scrape.db';
  process.env.LOOTGOBLIN_SECRET = 'a'.repeat(32);
  resetDbCache();
  await runMigrations('file:/tmp/lootgoblin-e2e-scrape.db');
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => server.close());

describe('end-to-end scrape', () => {
  let libDir: string;
  let destId: string;
  let credId: string;

  beforeEach(async () => {
    libDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-lib-'));
    const db = getDb() as any;
    await db.delete(schema.itemEvents);
    await db.delete(schema.items);
    await db.delete(schema.destinations);
    await db.delete(schema.sourceCredentials);
    destId = randomUUID();
    credId = randomUUID();
    // Credential FIRST (destinations can reference credentials; items reference both)
    await db.insert(schema.sourceCredentials).values({
      id: credId, sourceId: 'makerworld', label: 'test',
      kind: 'cookie-jar',
      encryptedBlob: Buffer.from(encrypt(JSON.stringify({ cookies: [] }), process.env.LOOTGOBLIN_SECRET!)),
      status: 'active',
    });
    await db.insert(schema.destinations).values({
      id: destId, name: 'test', type: 'filesystem',
      config: { path: libDir, namingTemplate: '{designer}/{title}' },
      packager: 'manyfold-v0',
    });
    server.use(
      // Metadata
      http.get('https://makerworld.com/api/v1/design-service/design/2663598', () => HttpResponse.json({
        id: 2663598,
        slug: 'test',
        title: 'Test Model',
        summary: 'desc',
        coverUrl: 'https://cdn/cover.jpg',
        tags: ['bust'],
        license: 'standard',
        designCreator: { name: 'Bulka', handle: 'bulka', uid: 1, avatar: '' },
        categories: [],
        instances: [{ id: 1, profileId: 1, title: 'default', isDefault: true, needAms: false, hasZipStl: false, pictures: [], cover: '', materialCnt: 1, extention: {}, summary: '' }],
        defaultInstanceId: 1,
      })),
      // f3mf endpoint
      http.get(/\/api\/v1\/design-service\/instance\/\d+\/f3mf/, () => HttpResponse.json({
        name: 'model.3mf',
        url: 'https://cdn/file.3mf',
      })),
      // CDN file download
      http.get('https://cdn/file.3mf', () => HttpResponse.arrayBuffer(Buffer.from('3MF-BINARY'))),
    );
  });

  it('runs a queued item to completion with Manyfold output', async () => {
    const itemId = randomUUID();
    await enqueueItem({
      id: itemId, sourceId: 'makerworld', sourceItemId: '2663598',
      contentType: 'model-3d', sourceUrl: 'https://makerworld.com/models/2663598',
      destinationId: destId, credentialId: credId,
    });
    const result = await runOneItem();
    expect(result).toBe('done');
    const outDir = path.join(libDir, 'Bulka/Test Model');
    const files = await fs.readdir(outDir);
    expect(files).toContain('model.3mf');
    expect(files).toContain('datapackage.json');
    const pkg = JSON.parse(await fs.readFile(path.join(outDir, 'datapackage.json'), 'utf8'));
    expect(pkg.title).toBe('Test Model');
  });
});
