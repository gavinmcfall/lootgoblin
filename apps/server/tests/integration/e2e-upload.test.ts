/**
 * V2-003-T10 — End-to-end Upload ingest
 *
 * The upload route at `/api/v1/loot/upload` runs the ingest pipeline INLINE
 * (no ingest_jobs queue) — different code path from URL-driven adapters that
 * use the worker. This file pins the spec invariant "happy path posts a
 * multipart upload and synchronously creates a Loot row + on-disk file".
 *
 * Note: comprehensive coverage of upload edge cases (size cap, ACL, filename
 * sanitization, multi-file dedup, malformed metadata) lives in the existing
 * `tests/integration/api/loot-upload.test.ts`. This file ONLY exercises the
 * full-chain happy path so the V2-003-T10 e2e matrix has explicit coverage
 * for the upload adapter alongside cults3d / sketchfab / gdrive.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  setupE2eDb,
  seedUser,
  seedStashRoot,
  seedCollection,
  actor,
  uid,
} from './_helpers/e2e';
import { getDb, schema } from '../../src/db/client';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

const mockAuthenticate = vi.fn();
vi.mock('../../src/auth/request-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

const DB_PATH = '/tmp/lootgoblin-e2e-upload.db';

beforeAll(async () => {
  await setupE2eDb(DB_PATH);
});

function makeUploadReq(metadata: Record<string, unknown>, files: Array<{ name: string; content: string | Buffer }>): Request {
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  for (const file of files) {
    const blob = new Blob([file.content as string], { type: 'application/octet-stream' });
    form.append('files', blob, file.name);
  }
  return new Request('http://local/api/v1/loot/upload', { method: 'POST', body: form });
}

describe('e2e — upload ingest (inline pipeline path)', () => {
  let userId: string;
  let collectionId: string;

  beforeEach(async () => {
    userId = await seedUser();
    const root = await seedStashRoot(userId);
    const col = await seedCollection(userId, root.id);
    collectionId = col.id;
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
  });

  it('happy path — multipart upload runs pipeline inline, returns 202 with placed Loot', async () => {
    const { POST } = await import('../../src/app/api/v1/loot/upload/route');

    // STL ASCII so sniffFormat detects 'stl'.
    const stlBody = `solid e2e-upload-${uid()}\nendsolid e2e-upload\n`;
    const res = await POST(
      makeUploadReq(
        {
          collectionId,
          title: 'E2E Upload Title',
          description: 'A direct upload',
          creator: 'Tester',
          license: 'CC-BY-4.0',
          tags: ['test', 'e2e'],
        },
        [{ name: 'model.stl', content: stlBody }],
      ) as never,
    );

    // Inline pipeline path: 202 Accepted with the IngestOutcome shape.
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('status');
    expect(json).toHaveProperty('jobId');
    expect(json.status).toBe('placed');
    expect(typeof json.lootId).toBe('string');

    const db = getDb() as ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
    const lootRows = await db
      .select()
      .from(schema.loot)
      .where(eq(schema.loot.id, json.lootId));
    expect(lootRows.length).toBe(1);
    expect(lootRows[0]!.title).toBe('E2E Upload Title');
    expect(lootRows[0]!.creator).toBe('Tester');
    expect(lootRows[0]!.license).toBe('CC-BY-4.0');

    const fileRows = await db
      .select()
      .from(schema.lootFiles)
      .where(eq(schema.lootFiles.lootId, json.lootId));
    expect(fileRows.length).toBe(1);
    expect(fileRows[0]!.format).toBe('stl');
    expect(fileRows[0]!.size).toBeGreaterThan(0);

    // Source attribution = 'upload' (lootSourceRecords).
    const srcRows = await db
      .select()
      .from(schema.lootSourceRecords)
      .where(eq(schema.lootSourceRecords.lootId, json.lootId));
    expect(srcRows.length).toBeGreaterThanOrEqual(1);
    expect(srcRows[0]!.sourceType).toBe('upload');
  });
});
