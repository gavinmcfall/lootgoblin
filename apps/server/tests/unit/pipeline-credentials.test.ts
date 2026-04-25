/**
 * Unit-ish integration tests for pipeline `onTokenRefreshed` persistence — V2-003-T9.
 *
 * The pipeline builds a FetchContext that includes an `onTokenRefreshed`
 * callback. When an adapter fires that callback, the new credential bag must
 * be encrypted and written back to the matching source_credentials row.
 *
 * These tests use real SQLite + a fake adapter that calls onTokenRefreshed
 * once before completing.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { runMigrations, resetDbCache, getDb, schema } from '../../src/db/client';
import { createIngestPipeline } from '../../src/scavengers/pipeline';
import { decrypt } from '../../src/crypto';
import type {
  ScavengerAdapter,
  ScavengerEvent,
  FetchContext,
  FetchTarget,
} from '../../src/scavengers/types';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-pipeline-creds.db';
const DB_URL = `file:${DB_PATH}`;
const TEST_SECRET = 'unit-test-secret-32-chars-minimum-len';

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;

function db(): DB {
  return getDb(DB_URL) as DB;
}

function uid(): string {
  return crypto.randomUUID();
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  resetDbCache();
  process.env.DATABASE_URL = DB_URL;
  process.env.LOOTGOBLIN_SECRET = TEST_SECRET;
  await runMigrations(DB_URL);
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Pipeline Cred Test',
    email: `${id}@cred.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedStashAndCollection(
  ownerId: string,
): Promise<{ collectionId: string; stashRootPath: string }> {
  const stashRootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-cred-stash-'));
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: 'Cred Stash Root',
    path: stashRootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `Cred Col ${collectionId.slice(0, 8)}`,
    pathTemplate: '{title}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { collectionId, stashRootPath };
}

async function seedSourceCredential(sourceId: string): Promise<string> {
  // Insert an initial encrypted blob containing { token: 'old' }.
  const id = uid();
  const initialBlob = Buffer.from('initial-encrypted-payload');
  await db().insert(schema.sourceCredentials).values({
    id,
    sourceId,
    label: `cred-${id.slice(0, 6)}`,
    kind: 'oauth-token',
    encryptedBlob: initialBlob,
    status: 'active',
  });
  return id;
}

/**
 * A fake adapter whose fetch() calls onTokenRefreshed once with a new
 * credential bag, writes one valid file, then completes.
 */
function makeRefreshingAdapter(
  sourceId: 'cults3d',
  refreshedBag: Record<string, unknown>,
): ScavengerAdapter {
  return {
    id: sourceId,
    supports() {
      return true;
    },
    async *fetch(ctx: FetchContext, _target: FetchTarget): AsyncIterable<ScavengerEvent> {
      // Fire the refresh callback first — same shape adapters use after a 401 retry.
      if (ctx.onTokenRefreshed) {
        await ctx.onTokenRefreshed(refreshedBag);
      }
      // Stage one valid STL so the pipeline reaches placement.
      const stagedPath = path.join(ctx.stagingDir, 'model.stl');
      await fsp.writeFile(stagedPath, 'solid x\nendsolid x');
      yield {
        kind: 'completed',
        item: {
          sourceId,
          sourceItemId: `it-${uid()}`,
          title: `Refreshed ${uid().slice(0, 6)}`,
          files: [
            {
              stagedPath,
              suggestedName: 'model.stl',
              size: 17,
              format: 'stl',
            },
          ],
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pipeline.onTokenRefreshed persistence', () => {
  it('persists refreshed credentials back to the matching source_credentials row', async () => {
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);
    const credId = await seedSourceCredential('cults3d');

    const refreshed = {
      kind: 'oauth',
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: Date.now() + 3_600_000,
    };

    const pipeline = createIngestPipeline({ ownerId: userId, collectionId, dbUrl: DB_URL });
    const adapter = makeRefreshingAdapter('cults3d', refreshed);

    const outcome = await pipeline.run({
      adapter,
      target: { kind: 'url', url: 'https://example.test/x' },
      credentials: {
        kind: 'oauth',
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
      },
    });

    expect(outcome.status).toBe('placed');

    // The credential row should now contain the refreshed encrypted bag.
    const rows = await db()
      .select({
        encryptedBlob: schema.sourceCredentials.encryptedBlob,
        lastUsedAt: schema.sourceCredentials.lastUsedAt,
      })
      .from(schema.sourceCredentials)
      .where(eq(schema.sourceCredentials.id, credId));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    // Blob should be a Buffer/Uint8Array; decrypt it back and compare to refreshed.
    const buf = Buffer.from(row.encryptedBlob as Uint8Array);
    const decoded = decrypt(buf.toString('utf8'), TEST_SECRET);
    expect(JSON.parse(decoded)).toEqual(refreshed);
    expect(row.lastUsedAt).toBeInstanceOf(Date);
  });

  it('logs and skips when no source_credentials row exists for the sourceId', async () => {
    // Use a different sourceId that has no credential row.
    const userId = await seedUser();
    const { collectionId } = await seedStashAndCollection(userId);

    // sanity: confirm there is no credential row for sketchfab.
    const before = await db()
      .select({ id: schema.sourceCredentials.id })
      .from(schema.sourceCredentials)
      .where(eq(schema.sourceCredentials.sourceId, 'sketchfab'));
    expect(before.length).toBe(0);

    const refreshed = { kind: 'oauth', accessToken: 'tok', refreshToken: 'r', expiresAt: 1 };

    const pipeline = createIngestPipeline({ ownerId: userId, collectionId, dbUrl: DB_URL });
    // Adapter id must be a real SourceId; reuse the cults3d shape but cast to
    // sketchfab so the persistence lookup misses (no row seeded for sketchfab).
    const adapter = makeRefreshingAdapter('cults3d', refreshed);
    (adapter as { id: string }).id = 'sketchfab';

    // Should still return placed — the missing row is non-fatal.
    const outcome = await pipeline.run({
      adapter,
      target: { kind: 'url', url: 'https://example.test/missing' },
    });
    expect(outcome.status).toBe('placed');

    // Still no credential row for sketchfab afterwards.
    const after = await db()
      .select({ id: schema.sourceCredentials.id })
      .from(schema.sourceCredentials)
      .where(eq(schema.sourceCredentials.sourceId, 'sketchfab'));
    expect(after.length).toBe(0);
  });
});
