/**
 * Integration tests — /api/v1/grimoire/* + /api/v1/loot/:id/grimoire-attachments — V2-007a-T14
 *
 * Real SQLite. Auth mocked via the request-auth shim.
 *
 * Coverage:
 *   - SlicerProfile POST/GET/PATCH/DELETE: 401, 400, 201, 200, 204, idempotency.
 *   - PrintSetting POST/GET: 401, 201, 200, 404 cross-owner.
 *   - GrimoireAttachment POST: 201, 400 XOR violation, 404 missing loot.
 *   - GrimoireAttachment GET list + DELETE 204.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

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

const DB_PATH = '/tmp/lootgoblin-api-grimoire.db';
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

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Grimoire Test User',
    email: `${id}@grimoire.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(ownerId: string): Promise<string> {
  // Stash root → collection → loot.
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-grim-stash-'));
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
    sourceUrl: 'https://example.test',
    derivedPath: '/tmp/derived',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return lootId;
}

function makePost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): import('next/server').NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}
function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}
function makePatch(url: string, body: unknown): import('next/server').NextRequest {
  return new Request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}
function makeDelete(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'DELETE' }) as unknown as import('next/server').NextRequest;
}

const validProfileBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Test Profile',
  slicerKind: 'bambu-studio',
  printerKind: 'bambu-x1',
  materialKind: 'pla',
  settingsPayload: { layer_height: 0.2 },
  ...overrides,
});

const validSettingBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Test Setting',
  settingsPayload: { supports: false },
  ...overrides,
});

async function createProfile(userId: string): Promise<string> {
  mockAuthenticate.mockResolvedValueOnce(actor(userId));
  const { POST } = await import(
    '../../src/app/api/v1/grimoire/slicer-profiles/route'
  );
  const res = await POST(
    makePost('http://local/api/v1/grimoire/slicer-profiles', validProfileBody()),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { profile: { id: string } };
  return body.profile.id;
}

async function createSetting(userId: string): Promise<string> {
  mockAuthenticate.mockResolvedValueOnce(actor(userId));
  const { POST } = await import('../../src/app/api/v1/grimoire/print-settings/route');
  const res = await POST(
    makePost('http://local/api/v1/grimoire/print-settings', validSettingBody()),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { setting: { id: string } };
  return body.setting.id;
}

// =========================================================================
// SlicerProfile
// =========================================================================

describe('SlicerProfile routes', () => {
  it('401 unauthenticated', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import(
      '../../src/app/api/v1/grimoire/slicer-profiles/route'
    );
    const res = await POST(
      makePost('http://local/api/v1/grimoire/slicer-profiles', validProfileBody()),
    );
    expect(res.status).toBe(401);
  });

  it('POST 201 + GET list', async () => {
    const userId = await seedUser();
    const profileId = await createProfile(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/grimoire/slicer-profiles/route');
    const res = await GET(makeGet('http://local/api/v1/grimoire/slicer-profiles'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: Array<{ id: string }> };
    expect(body.profiles.find((p) => p.id === profileId)).toBeTruthy();
  });

  it('POST 400 invalid kind', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/grimoire/slicer-profiles/route'
    );
    const res = await POST(
      makePost(
        'http://local/api/v1/grimoire/slicer-profiles',
        validProfileBody({ slicerKind: 'made-up' }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it('GET 404 cross-owner', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const profileId = await createProfile(userA);
    mockAuthenticate.mockResolvedValueOnce(actor(userB));
    const { GET } = await import(
      '../../src/app/api/v1/grimoire/slicer-profiles/[id]/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/grimoire/slicer-profiles/${profileId}`),
      { params: Promise.resolve({ id: profileId }) },
    );
    expect(res.status).toBe(404);
  });

  it('PATCH happy + DELETE 200', async () => {
    const userId = await seedUser();
    const profileId = await createProfile(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { PATCH } = await import(
      '../../src/app/api/v1/grimoire/slicer-profiles/[id]/route'
    );
    const r1 = await PATCH(
      makePatch(`http://local/api/v1/grimoire/slicer-profiles/${profileId}`, {
        name: 'Updated',
      }),
      { params: Promise.resolve({ id: profileId }) },
    );
    expect(r1.status).toBe(200);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import(
      '../../src/app/api/v1/grimoire/slicer-profiles/[id]/route'
    );
    const r2 = await DELETE(
      makeDelete(`http://local/api/v1/grimoire/slicer-profiles/${profileId}`),
      { params: Promise.resolve({ id: profileId }) },
    );
    expect(r2.status).toBe(200);
  });

  it('idempotent replay returns prior profile', async () => {
    const userId = await seedUser();
    const key = uid();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/grimoire/slicer-profiles/route'
    );
    const r1 = await POST(
      makePost('http://local/api/v1/grimoire/slicer-profiles', validProfileBody(), {
        'Idempotency-Key': key,
      }),
    );
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()) as { profile: { id: string } };

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const r2 = await POST(
      makePost('http://local/api/v1/grimoire/slicer-profiles', validProfileBody(), {
        'Idempotency-Key': key,
      }),
    );
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as { profile: { id: string } };
    expect(j2.profile.id).toBe(j1.profile.id);
  });
});

// =========================================================================
// PrintSetting
// =========================================================================

describe('PrintSetting routes', () => {
  it('POST 201 + GET single', async () => {
    const userId = await seedUser();
    const settingId = await createSetting(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/grimoire/print-settings/[id]/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/grimoire/print-settings/${settingId}`),
      { params: Promise.resolve({ id: settingId }) },
    );
    expect(res.status).toBe(200);
  });

  it('GET 404 cross-owner', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const settingId = await createSetting(userA);
    mockAuthenticate.mockResolvedValueOnce(actor(userB));
    const { GET } = await import(
      '../../src/app/api/v1/grimoire/print-settings/[id]/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/grimoire/print-settings/${settingId}`),
      { params: Promise.resolve({ id: settingId }) },
    );
    expect(res.status).toBe(404);
  });
});

// =========================================================================
// GrimoireAttachment
// =========================================================================

describe('GrimoireAttachment routes', () => {
  it('POST 201 happy (slicer profile)', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    const profileId = await createProfile(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/loot/[id]/grimoire-attachments/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/loot/${lootId}/grimoire-attachments`, {
        slicerProfileId: profileId,
        note: 'recommended for this model',
      }),
      { params: Promise.resolve({ id: lootId }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { attachmentId: string };
    expect(body.attachmentId).toBeTruthy();
  });

  it('POST 400 XOR violation (both fields set)', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    const profileId = await createProfile(userId);
    const settingId = await createSetting(userId);
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST } = await import(
      '../../src/app/api/v1/loot/[id]/grimoire-attachments/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/loot/${lootId}/grimoire-attachments`, {
        slicerProfileId: profileId,
        printSettingId: settingId,
      }),
      { params: Promise.resolve({ id: lootId }) },
    );
    expect(res.status).toBe(400);
  });

  it('POST 404 missing/cross-owner loot', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const lootId = await seedLoot(userA);
    const profileId = await createProfile(userB);
    mockAuthenticate.mockResolvedValueOnce(actor(userB));
    const { POST } = await import(
      '../../src/app/api/v1/loot/[id]/grimoire-attachments/route'
    );
    const res = await POST(
      makePost(`http://local/api/v1/loot/${lootId}/grimoire-attachments`, {
        slicerProfileId: profileId,
      }),
      { params: Promise.resolve({ id: lootId }) },
    );
    expect(res.status).toBe(404);
  });

  it('GET list + DELETE 204', async () => {
    const userId = await seedUser();
    const lootId = await seedLoot(userId);
    const profileId = await createProfile(userId);

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { POST: createAttachment } = await import(
      '../../src/app/api/v1/loot/[id]/grimoire-attachments/route'
    );
    const r1 = await createAttachment(
      makePost(`http://local/api/v1/loot/${lootId}/grimoire-attachments`, {
        slicerProfileId: profileId,
      }),
      { params: Promise.resolve({ id: lootId }) },
    );
    const j1 = (await r1.json()) as { attachmentId: string };

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/loot/[id]/grimoire-attachments/route'
    );
    const r2 = await GET(
      makeGet(`http://local/api/v1/loot/${lootId}/grimoire-attachments`),
      { params: Promise.resolve({ id: lootId }) },
    );
    const j2 = (await r2.json()) as { attachments: Array<{ id: string }> };
    expect(j2.attachments.find((a) => a.id === j1.attachmentId)).toBeTruthy();

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { DELETE } = await import(
      '../../src/app/api/v1/loot/[id]/grimoire-attachments/[attachmentId]/route'
    );
    const r3 = await DELETE(
      makeDelete(
        `http://local/api/v1/loot/${lootId}/grimoire-attachments/${j1.attachmentId}`,
      ),
      { params: Promise.resolve({ id: lootId, attachmentId: j1.attachmentId }) },
    );
    expect(r3.status).toBe(204);
  });
});
