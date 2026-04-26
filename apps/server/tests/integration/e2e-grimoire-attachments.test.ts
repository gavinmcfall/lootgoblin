/**
 * End-to-end Grimoire attachments through the HTTP API — V2-007a-T15
 *
 * Drives the full chain: HTTP route → domain (T10/T11) → DB. Verifies the
 * Loot ↔ slicer-profile / print-setting linkage flows + cascade behaviours.
 *
 * Per-file SQLite path. No msw — domain is fully internal.
 *
 * Coverage:
 *   1. Profile + Setting + Attachment lifecycle: create profile → create
 *      setting → attach profile → attach setting → list shows both → delete
 *      one → list shows the remaining one.
 *   2. XOR violation at HTTP layer: both slicerProfileId AND printSettingId
 *      → 400 (invalid-body).
 *   3. Cascade on profile DELETE: attach to Loot → DELETE profile → GET
 *      attachments empty; DELETE response reports deletedAttachments.
 *   4. Cross-owner Loot attachment: User B's profile cannot attach to User
 *      A's Loot → 404 loot-not-found.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';

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

const DB_PATH = '/tmp/lootgoblin-e2e-grimoire-attachments.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
}
function actor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

beforeAll(async () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      await fsp.unlink(`${DB_PATH}${suffix}`);
    } catch {
      /* ignore */
    }
  }
  process.env.DATABASE_URL = DB_URL;
  resetDbCache();
  await runMigrations(DB_URL);
});

beforeEach(async () => {
  const dbc = db();
  await dbc.delete(schema.grimoireAttachments);
  await dbc.delete(schema.printSettings);
  await dbc.delete(schema.slicerProfiles);
  await dbc.delete(schema.loot);
  await dbc.delete(schema.collections);
  await dbc.delete(schema.stashRoots);
  mockAuthenticate.mockReset();
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: `E2E GA User ${id.slice(0, 8)}`,
    email: `${id}@e2e-ga.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(ownerId: string): Promise<string> {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-e2e-ga-stash-'));
  const stashRootId = uid();
  await db().insert(schema.stashRoots).values({
    id: stashRootId,
    ownerId,
    name: `Root-${stashRootId.slice(0, 8)}`,
    path: rootPath,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `Col-${collectionId.slice(0, 8)}`,
    pathTemplate: '{title}',
    stashRootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: `Loot ${lootId.slice(0, 8)}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return lootId;
}

function makePost(
  url: string,
  body: unknown,
): import('next/server').NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}
function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}
function makeDelete(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'DELETE' }) as unknown as import('next/server').NextRequest;
}

// ─── HTTP-level helpers ─────────────────────────────────────────────────────

async function postSlicerProfile(opts: { ownerId: string; name?: string }): Promise<string> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { POST } = await import('../../src/app/api/v1/grimoire/slicer-profiles/route');
  const res = await POST(
    makePost('http://local/api/v1/grimoire/slicer-profiles', {
      name: opts.name ?? 'Profile A',
      slicerKind: 'bambu-studio',
      printerKind: 'bambu-x1',
      materialKind: 'pla',
      settingsPayload: { layer_height: 0.2, infill: 15 },
    }),
  );
  expect(res.status).toBe(201);
  const j = (await res.json()) as { profile: { id: string } };
  return j.profile.id;
}

async function postPrintSetting(opts: { ownerId: string; name?: string }): Promise<string> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { POST } = await import('../../src/app/api/v1/grimoire/print-settings/route');
  const res = await POST(
    makePost('http://local/api/v1/grimoire/print-settings', {
      name: opts.name ?? 'Setting A',
      settingsPayload: { supports: false, brim: true },
    }),
  );
  expect(res.status).toBe(201);
  const j = (await res.json()) as { setting: { id: string } };
  return j.setting.id;
}

async function attachToLootHttp(opts: {
  ownerId: string;
  lootId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { POST } = await import('../../src/app/api/v1/loot/[id]/grimoire-attachments/route');
  const res = await POST(
    makePost(`http://local/api/v1/loot/${opts.lootId}/grimoire-attachments`, opts.body),
    { params: Promise.resolve({ id: opts.lootId }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function listAttachmentsHttp(opts: {
  ownerId: string;
  lootId: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { GET } = await import('../../src/app/api/v1/loot/[id]/grimoire-attachments/route');
  const res = await GET(
    makeGet(`http://local/api/v1/loot/${opts.lootId}/grimoire-attachments`),
    { params: Promise.resolve({ id: opts.lootId }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function deleteAttachmentHttp(opts: {
  ownerId: string;
  lootId: string;
  attachmentId: string;
}): Promise<{ status: number }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { DELETE } = await import(
    '../../src/app/api/v1/loot/[id]/grimoire-attachments/[attachmentId]/route'
  );
  const res = await DELETE(
    makeDelete(
      `http://local/api/v1/loot/${opts.lootId}/grimoire-attachments/${opts.attachmentId}`,
    ),
    { params: Promise.resolve({ id: opts.lootId, attachmentId: opts.attachmentId }) },
  );
  return { status: res.status };
}

async function deleteSlicerProfileHttp(opts: {
  ownerId: string;
  id: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  mockAuthenticate.mockResolvedValueOnce(actor(opts.ownerId));
  const { DELETE } = await import('../../src/app/api/v1/grimoire/slicer-profiles/[id]/route');
  const res = await DELETE(
    makeDelete(`http://local/api/v1/grimoire/slicer-profiles/${opts.id}`),
    { params: Promise.resolve({ id: opts.id }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('E2E /api/v1/loot/:id/grimoire-attachments through HTTP', () => {
  it('full lifecycle: create profile + setting → attach profile → attach setting → list both → delete one → list one', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    const profileId = await postSlicerProfile({ ownerId: userId });
    const settingId = await postPrintSetting({ ownerId: userId });

    const attachP = await attachToLootHttp({
      ownerId: userId,
      lootId,
      body: { slicerProfileId: profileId, note: 'engineering preset' },
    });
    expect(attachP.status).toBe(201);
    const profileAttachmentId = attachP.json.attachmentId as string;

    const attachS = await attachToLootHttp({
      ownerId: userId,
      lootId,
      body: { printSettingId: settingId, note: 'no supports' },
    });
    expect(attachS.status).toBe(201);

    const list1 = await listAttachmentsHttp({ ownerId: userId, lootId });
    expect(list1.status).toBe(200);
    const attachments1 = list1.json.attachments as Array<{
      id: string;
      slicerProfileId: string | null;
      printSettingId: string | null;
    }>;
    expect(attachments1.length).toBe(2);
    expect(attachments1.find((a) => a.slicerProfileId === profileId)).toBeTruthy();
    expect(attachments1.find((a) => a.printSettingId === settingId)).toBeTruthy();

    // DELETE one — the profile attachment.
    const del = await deleteAttachmentHttp({
      ownerId: userId,
      lootId,
      attachmentId: profileAttachmentId,
    });
    expect(del.status).toBe(204);

    const list2 = await listAttachmentsHttp({ ownerId: userId, lootId });
    expect(list2.status).toBe(200);
    const attachments2 = list2.json.attachments as Array<{ printSettingId: string | null }>;
    expect(attachments2.length).toBe(1);
    expect(attachments2[0]!.printSettingId).toBe(settingId);
  });

  it('XOR violation at HTTP layer: both slicerProfileId AND printSettingId → 400 invalid-body', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    const profileId = await postSlicerProfile({ ownerId: userId });
    const settingId = await postPrintSetting({ ownerId: userId });

    const r = await attachToLootHttp({
      ownerId: userId,
      lootId,
      body: { slicerProfileId: profileId, printSettingId: settingId },
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid-body');

    // No attachment row was created.
    const rows = await db().select().from(schema.grimoireAttachments);
    expect(rows.length).toBe(0);
  });

  it('cascade through HTTP: DELETE profile → attachments empty + response reports deletedAttachments', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    const profileId = await postSlicerProfile({ ownerId: userId });

    const attach = await attachToLootHttp({
      ownerId: userId,
      lootId,
      body: { slicerProfileId: profileId },
    });
    expect(attach.status).toBe(201);

    // Sanity: 1 attachment exists.
    const before = await listAttachmentsHttp({ ownerId: userId, lootId });
    expect((before.json.attachments as unknown[]).length).toBe(1);

    // Delete the profile.
    const delProfile = await deleteSlicerProfileHttp({ ownerId: userId, id: profileId });
    expect(delProfile.status).toBe(200);
    expect(delProfile.json.deletedAttachments).toBe(1);

    // Attachment list is now empty for this loot (FK cascade).
    const after = await listAttachmentsHttp({ ownerId: userId, lootId });
    expect((after.json.attachments as unknown[]).length).toBe(0);

    // DB verification — no orphan row.
    const rows = await db().select().from(schema.grimoireAttachments);
    expect(rows.length).toBe(0);
  });

  it('cross-owner Loot attachment: User B’s profile attempting to attach to User A’s Loot → 404 loot-not-found', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const lootA = await seedLoot(userA);
    const profileB = await postSlicerProfile({ ownerId: userB });

    const r = await attachToLootHttp({
      ownerId: userB,
      lootId: lootA,
      body: { slicerProfileId: profileB },
    });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('loot-not-found');

    // No attachment row was created.
    const rows = await db()
      .select()
      .from(schema.grimoireAttachments)
      .where(eq(schema.grimoireAttachments.lootId, lootA));
    expect(rows.length).toBe(0);
  });
});
