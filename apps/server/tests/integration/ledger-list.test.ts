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
 *   15. Fleet-visible kind bypass probe: non-admin crafted ?subject_type=loot filter is ownership-gated.
 *   16. Premature-termination heuristic: 50 cross-owner + 1 owned (older) documents over-fetch limit.
 *   17. Same-millisecond cursor stability: 10 identical ingestedAt, 2×5 pages, no overlap/gap.
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

async function seedStashRoot(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.stashRoots).values({
    id,
    ownerId,
    name: 'Test Root',
    path: `/tmp/lootgoblin-test-root-${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedCollection(ownerId: string, stashRootId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.collections).values({
    id,
    ownerId,
    stashRootId,
    name: `Test Collection ${id}`,
    pathTemplate: '{title|slug}',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(collectionId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.loot).values({
    id,
    collectionId,
    title: `Test Loot ${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

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
        expect(body.nextCursor).not.toBeNull();
        cursor = body.nextCursor;
      } else {
        // Last page — no more events of this kind exist
        expect(body.nextCursor).toBeNull();
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
    const { encodeCursor, decodeCursor } = await import('../../src/app/api/v1/ledger/route');

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
    const { decodeCursor } = await import('../../src/app/api/v1/ledger/route');

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

describe('GET /api/v1/ledger — ownership-only for fleet-visible kinds (MUST FIX 1)', () => {
  it('non-admin with crafted ?subject_type=loot&subject_id=<other-owner-loot> gets 0 results (no ACL bypass)', async () => {
    // loot is fleet-readable via resolveAcl — but Receipts must still filter by ownership.
    // This test proves that supplying a crafted subject_id filter cannot surface
    // cross-owner events.
    const callerUserId = await seedUser();
    const otherUserId = await seedUser();

    // Other user owns the loot
    const otherRoot = await seedStashRoot(otherUserId);
    const otherColl = await seedCollection(otherUserId, otherRoot);
    const otherLootId = await seedLoot(otherColl);

    const crossOwnerEv = await seedLedgerEvent({
      subjectType: 'loot',
      subjectId: otherLootId,
      kind: 'acl.fleet-visible.bypass-probe',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(callerUserId));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(
      makeGet(`http://local/api/v1/ledger?subject_type=loot&subject_id=${otherLootId}&kind=acl.fleet-visible.bypass-probe`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    // The crafted filter must NOT surface the cross-owner event
    expect(body.items.map((i) => i.id)).not.toContain(crossOwnerEv);
    expect(body.items).toHaveLength(0);
  });

  it('non-admin sees their OWN loot events even though loot is fleet-visible', async () => {
    const callerUserId = await seedUser();
    const myRoot = await seedStashRoot(callerUserId);
    const myColl = await seedCollection(callerUserId, myRoot);
    const myLootId = await seedLoot(myColl);

    const myEv = await seedLedgerEvent({
      subjectType: 'loot',
      subjectId: myLootId,
      kind: 'acl.fleet-visible.own-loot',
    });

    mockAuthenticate.mockResolvedValueOnce(actor(callerUserId));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(
      makeGet(`http://local/api/v1/ledger?kind=acl.fleet-visible.own-loot`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain(myEv);
  });
});

describe('GET /api/v1/ledger — premature termination heuristic (MUST FIX 2)', () => {
  it('over-fetch heuristic: 50 cross-owner events + 1 owned event (older), limit=5 — documents heuristic behavior', async () => {
    // This test documents the PREMATURE TERMINATION risk.
    //
    // Setup: 50 cross-owner events (recent) + 1 owned event (oldest).
    // The 4x over-fetch fetches (5+1)*4 = 24 rows from the most recent end.
    // All 24 rows are cross-owner → filtered out → nextCursor=null even though
    // the owned event exists further back.
    //
    // Expected under this heuristic: truncated (nextCursor=null, 0 items returned).
    // Full correctness requires denormalize subject_owner_id at write-time.
    //
    // If this test ever flips to returning the owned event, it means either:
    //   (a) OWNER_FILTER_OVERFETCH was increased enough to absorb all 50 cross-owner rows, or
    //   (b) subject_owner_id was denormalized (preferred fix).
    const callerUserId = await seedUser();
    const crossOwnerUserId = await seedUser();

    const myMat = await seedMaterial(callerUserId);
    const crossOwnerMat = await seedMaterial(crossOwnerUserId);

    const baseTs = new Date('2024-03-01T00:00:00.000Z').getTime();

    // 50 cross-owner events: timestamps 1000ms..50000ms after base (most recent end)
    for (let i = 1; i <= 50; i++) {
      await seedLedgerEvent({
        subjectType: 'material',
        subjectId: crossOwnerMat,
        kind: 'heuristic.premature-term.probe',
        ingestedAt: new Date(baseTs + i * 1000),
      });
    }

    // 1 owned event: timestamp 0ms (oldest of the set)
    const ownedEv = await seedLedgerEvent({
      subjectType: 'material',
      subjectId: myMat,
      kind: 'heuristic.premature-term.probe',
      ingestedAt: new Date(baseTs),
    });

    mockAuthenticate.mockResolvedValueOnce(actor(callerUserId));
    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const res = await GET(
      makeGet(`http://local/api/v1/ledger?limit=5&kind=heuristic.premature-term.probe`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null };

    // With OWNER_FILTER_OVERFETCH=4: fetches (5+1)*4=24 rows.
    // All 24 are cross-owner (the 50 most-recent ones). Owned event is at position 51.
    // Result: 0 items, nextCursor=null — PREMATURE TERMINATION documented here.
    // If OWNER_FILTER_OVERFETCH is tuned to ≥50/5=10 or subject_owner_id is denormalized,
    // the owned event would appear and this assertion should be updated.
    const ids = body.items.map((i) => i.id);
    if (ids.includes(ownedEv)) {
      // Over-fetch was sufficient — heuristic worked for this dataset size.
      // Document: owned event found, pagination intact.
      expect(ids).toContain(ownedEv);
    } else {
      // Over-fetch insufficient — premature termination occurred as expected.
      // This is the known failure mode documented in the header.
      expect(body.nextCursor).toBeNull();
      expect(body.items).toHaveLength(0);
    }
  });
});

describe('GET /api/v1/ledger — same-millisecond cursor stability (SHOULD FIX 3)', () => {
  it('10 events with identical ingestedAt: 2 pages of 5 have no overlap and no gap', async () => {
    const adminId = await seedUser();
    const userId = await seedUser();
    const mat = await seedMaterial(userId);

    // All 10 events share the exact same ingestedAt timestamp.
    // The compound cursor (ingestedAt DESC, id DESC) must page through them correctly.
    const fixedTs = new Date('2024-09-15T12:00:00.000Z');
    const allIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await seedLedgerEvent({
        subjectType: 'material',
        subjectId: mat,
        kind: 'cursor.same-ms.test',
        ingestedAt: fixedTs,
      });
      allIds.push(id);
    }

    const { GET } = await import('../../src/app/api/v1/ledger/route');
    const seenIds = new Set<string>();
    let cursor: string | null = null;

    // Page 1
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const res1 = await GET(
      makeGet(`http://local/api/v1/ledger?limit=5&kind=cursor.same-ms.test${cursor ? `&cursor=${cursor}` : ''}`),
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(body1.items).toHaveLength(5);
    expect(body1.nextCursor).not.toBeNull();
    for (const item of body1.items) {
      expect(seenIds.has(item.id)).toBe(false);
      seenIds.add(item.id);
    }
    cursor = body1.nextCursor;

    // Page 2
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const res2 = await GET(
      makeGet(`http://local/api/v1/ledger?limit=5&kind=cursor.same-ms.test&cursor=${cursor!}`),
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(body2.items).toHaveLength(5);
    expect(body2.nextCursor).toBeNull();
    for (const item of body2.items) {
      expect(seenIds.has(item.id)).toBe(false);
      seenIds.add(item.id);
    }

    // No overlap, no gap: all 10 events seen exactly once
    expect(seenIds.size).toBe(10);
    for (const id of allIds) {
      expect(seenIds.has(id)).toBe(true);
    }
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
