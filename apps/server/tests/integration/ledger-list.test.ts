/**
 * Integration tests — GET /api/v1/ledger — Ledger HTTP Layer T2
 *
 * Real SQLite. Auth mocked via the request-auth shim.
 *
 * Coverage:
 *   1.  Admin lists all events — DESC by ingestedAt.
 *   2.  Non-admin sees only events on their owned materials (subject-owner ACL).
 *   3.  Non-admin: events on another user's material are filtered out.
 *   4.  Non-admin: events with unknown subjectType are filtered out.
 *   5.  Filter ?subject_type= narrows the set.
 *   6.  Filter ?subject_id= narrows the set.
 *   7.  Filter ?kind= narrows the set.
 *   8.  Filter ?actor_user_id= narrows the set.
 *   9.  Time range ?occurred_after= / ?occurred_before= narrows.
 *   10. Time range ?ingested_after= / ?ingested_before= narrows.
 *   11. Cursor pagination: 100 events, limit=20, 5 pages, no overlap, no gap.
 *   12. Cursor codec helpers: encode / decode round-trip.
 *   13. Invalid query (malformed date) → 400.
 *   14. Unauthenticated → 401.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
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

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const DB_PATH = '/tmp/lootgoblin-ledger-list.db';
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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Ledger List Test User',
    email: `${id}@ledger-list.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedMaterial(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.materials).values({
    id,
    ownerId,
    kind: 'filament',
    colors: ['#FF0000'],
    colorPattern: 'solid',
    initialAmount: 1000,
    remainingAmount: 1000,
    unit: 'g',
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLedgerEvent(opts: {
  subjectType?: string;
  subjectId?: string;
  kind?: string;
  actorUserId?: string | null;
  ingestedAt?: Date;
  occurredAt?: Date | null;
  payload?: string | null;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.ledgerEvents).values({
    id,
    kind: opts.kind ?? 'test.event',
    actorUserId: opts.actorUserId !== undefined ? opts.actorUserId : null,
    subjectType: opts.subjectType ?? 'material',
    subjectId: opts.subjectId ?? uid(),
    relatedResources: null,
    payload: opts.payload !== undefined ? opts.payload : null,
    provenanceClass: null,
    occurredAt: opts.occurredAt !== undefined ? opts.occurredAt : null,
    ingestedAt: opts.ingestedAt ?? new Date(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function makeGet(url: string): Request {
  return new Request(url, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/ledger — 401 unauthenticated', () => {
  it('returns 401 for unauthenticated callers', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/ledger — admin sees all events', () => {
  it('admin lists all events in DESC ingestedAt order', async () => {
    const adminId = await seedUser();
    const userA = await seedUser();
    const userB = await seedUser();
    const matA = await seedMaterial(userA);
    const matB = await seedMaterial(userB);

    const now = Date.now();
    // Seed events with different ingestedAt to test ordering
    const evA = await seedLedgerEvent({
      subjectType: 'material', subjectId: matA,
      ingestedAt: new Date(now - 2000),
    });
    const evB = await seedLedgerEvent({
      subjectType: 'material', subjectId: matB,
      ingestedAt: new Date(now - 1000),
    });
    const evC = await seedLedgerEvent({
      subjectType: 'material', subjectId: matA,
      ingestedAt: new Date(now),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger?limit=200'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { items: Array<{ id: string; ingestedAt: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(evA);
    expect(ids).toContain(evB);
    expect(ids).toContain(evC);

    // Verify DESC order: evC (most recent) should appear before evA (oldest)
    const posC = ids.indexOf(evC);
    const posA = ids.indexOf(evA);
    expect(posC).toBeLessThan(posA);
  });
});

describe('GET /api/v1/ledger — non-admin ACL (subject-owner)', () => {
  it('non-admin sees events on their own material', async () => {
    const userId = await seedUser();
    const myMat = await seedMaterial(userId);
    const myEv = await seedLedgerEvent({ subjectType: 'material', subjectId: myMat });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain(myEv);
  });

  it('non-admin: events on another user material are filtered out', async () => {
    const userId = await seedUser();
    const otherUser = await seedUser();
    const otherMat = await seedMaterial(otherUser);
    const otherEv = await seedLedgerEvent({ subjectType: 'material', subjectId: otherMat });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).not.toContain(otherEv);
  });

  it('non-admin: events with unknown subjectType are filtered out', async () => {
    const userId = await seedUser();
    const sysEv = await seedLedgerEvent({
      subjectType: 'system_event',
      subjectId: uid(),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).not.toContain(sysEv);
  });
});

describe('GET /api/v1/ledger — filters', () => {
  it('?subject_type= narrows the result set', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const mat = await seedMaterial(userId);

    const matEv = await seedLedgerEvent({
      subjectType: 'material', subjectId: mat, kind: 'filter.test.subjecttype',
    });
    const collId = uid();
    const collEv = await seedLedgerEvent({
      subjectType: 'collection', subjectId: collId, kind: 'filter.test.subjecttype',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger?subject_type=material&kind=filter.test.subjecttype'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; subjectType: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(matEv);
    expect(ids).not.toContain(collEv);
    for (const item of body.items) {
      expect(item.subjectType).toBe('material');
    }
  });

  it('?subject_id= narrows the result set', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const matA = await seedMaterial(userId);
    const matB = await seedMaterial(userId);

    const evA = await seedLedgerEvent({ subjectType: 'material', subjectId: matA, kind: 'filter.test.subjectid' });
    const evB = await seedLedgerEvent({ subjectType: 'material', subjectId: matB, kind: 'filter.test.subjectid' });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet(`http://local/api/v1/ledger?subject_id=${matA}&kind=filter.test.subjectid`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(evA);
    expect(ids).not.toContain(evB);
  });

  it('?kind= narrows the result set', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const mat = await seedMaterial(userId);

    const evKindA = await seedLedgerEvent({ subjectType: 'material', subjectId: mat, kind: 'filter.test.kind-alpha' });
    const evKindB = await seedLedgerEvent({ subjectType: 'material', subjectId: mat, kind: 'filter.test.kind-beta' });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger?kind=filter.test.kind-alpha'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; kind: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(evKindA);
    expect(ids).not.toContain(evKindB);
    for (const item of body.items) {
      expect(item.kind).toBe('filter.test.kind-alpha');
    }
  });

  it('?actor_user_id= narrows the result set', async () => {
    const adminId = await seedUser();
    const actorA = await seedUser();
    const actorB = await seedUser();
    const mat = await seedMaterial(adminId);

    const evA = await seedLedgerEvent({
      subjectType: 'material', subjectId: mat,
      kind: 'filter.test.actor',
      actorUserId: actorA,
    });
    const evB = await seedLedgerEvent({
      subjectType: 'material', subjectId: mat,
      kind: 'filter.test.actor',
      actorUserId: actorB,
    });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet(`http://local/api/v1/ledger?actor_user_id=${actorA}&kind=filter.test.actor`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(evA);
    expect(ids).not.toContain(evB);
  });

  it('?occurred_after= and ?occurred_before= narrow by occurredAt', async () => {
    const adminId = await seedUser();
    const mat = await seedMaterial(adminId);
    const base = new Date('2025-01-01T00:00:00.000Z');
    const before = new Date('2025-01-01T00:00:30.000Z');
    const during = new Date('2025-01-01T01:00:00.000Z');
    const after = new Date('2025-01-01T01:59:30.000Z');

    const evBefore = await seedLedgerEvent({
      subjectType: 'material', subjectId: mat,
      kind: 'filter.test.occurred',
      occurredAt: before,
    });
    const evDuring = await seedLedgerEvent({
      subjectType: 'material', subjectId: mat,
      kind: 'filter.test.occurred',
      occurredAt: during,
    });
    const evAfter = await seedLedgerEvent({
      subjectType: 'material', subjectId: mat,
      kind: 'filter.test.occurred',
      occurredAt: after,
    });

    const afterParam = '2025-01-01T00:01:00.000Z';
    const beforeParam = '2025-01-01T01:59:00.000Z';

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet(
      `http://local/api/v1/ledger?occurred_after=${afterParam}&occurred_before=${beforeParam}&kind=filter.test.occurred`,
    ));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(evDuring);
    expect(ids).not.toContain(evBefore);
    expect(ids).not.toContain(evAfter);
  });

  it('?ingested_after= and ?ingested_before= narrow by ingestedAt', async () => {
    const adminId = await seedUser();
    const mat = await seedMaterial(adminId);

    const beforeTs = new Date('2024-06-01T00:00:30.000Z');
    const duringTs = new Date('2024-06-01T01:00:00.000Z');
    const afterTs = new Date('2024-06-01T01:59:30.000Z');

    const evBefore = await seedLedgerEvent({
      subjectType: 'material', subjectId: mat,
      kind: 'filter.test.ingested',
      ingestedAt: beforeTs,
    });
    const evDuring = await seedLedgerEvent({
      subjectType: 'material', subjectId: mat,
      kind: 'filter.test.ingested',
      ingestedAt: duringTs,
    });
    const evAfter = await seedLedgerEvent({
      subjectType: 'material', subjectId: mat,
      kind: 'filter.test.ingested',
      ingestedAt: afterTs,
    });

    const afterParam = '2024-06-01T00:01:00.000Z';
    const beforeParam = '2024-06-01T01:59:00.000Z';

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet(
      `http://local/api/v1/ledger?ingested_after=${afterParam}&ingested_before=${beforeParam}&kind=filter.test.ingested`,
    ));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(evDuring);
    expect(ids).not.toContain(evBefore);
    expect(ids).not.toContain(evAfter);
  });
});

describe('GET /api/v1/ledger — cursor pagination', () => {
  it('100 events, limit=20 → 5 pages, no overlap, no gap', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const mat = await seedMaterial(userId);

    // Seed 100 events with distinct ingestedAt timestamps.
    const now = Date.now();
    const allEventIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = await seedLedgerEvent({
        subjectType: 'material',
        subjectId: mat,
        kind: 'pagination.test.cursor',
        ingestedAt: new Date(now - (100 - i) * 1000), // oldest → newest
      });
      allEventIds.push(id);
    }

    const seenIds = new Set<string>();
    let cursor: string | null = null;
    const { GET } = await import('../../src/app/api/v1/ledger/route');

    for (let page = 0; page < 5; page++) {
      const url = `http://local/api/v1/ledger?limit=20&kind=pagination.test.cursor${cursor ? `&cursor=${cursor}` : ''}`;
      mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
      const res = await GET(makeGet(url));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null };

      expect(body.items).toHaveLength(20);

      // No overlap — none of the ids on this page were seen before
      for (const item of body.items) {
        expect(seenIds.has(item.id)).toBe(false);
        seenIds.add(item.id);
      }

      if (page < 4) {
        expect(body.nextCursor).toBeTruthy();
        cursor = body.nextCursor;
      } else {
        // Last page — no more events of this kind, so nextCursor may be null
        // (it's null when no further items exist)
        cursor = body.nextCursor;
      }
    }

    // No gap: all 100 event IDs were seen exactly once
    expect(seenIds.size).toBe(100);
    for (const id of allEventIds) {
      expect(seenIds.has(id)).toBe(true);
    }
  });
});

describe('GET /api/v1/ledger — cursor codec', () => {
  it('encodeCursor / decodeCursor round-trip', async () => {
    // Import the codec helpers directly from the route module
    const routeModule = await import('../../src/app/api/v1/ledger/route');
    // @ts-expect-error - codec helpers are exported for testing
    const { encodeCursor, decodeCursor } = routeModule;

    const ts = new Date('2025-06-01T12:00:00.000Z');
    const id = 'abc-def-123';
    const encoded = encodeCursor(ts, id);
    expect(typeof encoded).toBe('string');

    const decoded = decodeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.ingestedAt.getTime()).toBe(ts.getTime());
    expect(decoded!.id).toBe(id);
  });

  it('decodeCursor returns null for garbage input', async () => {
    const routeModule = await import('../../src/app/api/v1/ledger/route');
    // @ts-expect-error
    const { decodeCursor } = routeModule;

    expect(decodeCursor('not-base64!!!!')).toBeNull();
    expect(decodeCursor('dGhpcyBoYXMgbm8gcGlwZQ==')).toBeNull(); // 'this has no pipe'
    expect(decodeCursor('')).toBeNull();
  });
});

describe('GET /api/v1/ledger — invalid query → 400', () => {
  it('malformed occurred_after returns 400', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger?occurred_after=not-a-date'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid-query');
  });

  it('malformed ingested_before returns 400', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger?ingested_before=2025-13-99'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid-query');
  });
});

describe('GET /api/v1/ledger — DTO shape', () => {
  it('response items have the expected LedgerEventDto fields', async () => {
    const adminId = await seedUser();
    const mat = await seedMaterial(adminId);
    const ev = await seedLedgerEvent({
      subjectType: 'material',
      subjectId: mat,
      kind: 'dto.shape.test',
      actorUserId: adminId,
      payload: JSON.stringify({ foo: 'bar' }),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(makeGet('http://local/api/v1/ledger?kind=dto.shape.test'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        kind: string;
        actorUserId: string | null;
        subjectType: string;
        subjectId: string;
        relatedResources: unknown;
        payload: unknown;
        provenanceClass: string | null;
        occurredAt: string | null;
        ingestedAt: string;
      }>;
      nextCursor: string | null;
    };

    const item = body.items.find((i) => i.id === ev);
    expect(item).toBeDefined();
    expect(item!.kind).toBe('dto.shape.test');
    expect(item!.actorUserId).toBe(adminId);
    expect(item!.subjectType).toBe('material');
    expect(item!.subjectId).toBe(mat);
    expect(item!.payload).toEqual({ foo: 'bar' });  // parsed, not raw string
    expect(item!.provenanceClass).toBeNull();
    expect(item!.occurredAt).toBeNull();
    expect(() => new Date(item!.ingestedAt)).not.toThrow();
    expect(typeof body.nextCursor === 'string' || body.nextCursor === null).toBe(true);
  });
});
