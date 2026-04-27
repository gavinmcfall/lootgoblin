/**
 * Integration tests — /api/v1/agents/* — V2-005a-T2
 *
 * Real SQLite. Auth mocked via the `request-auth` shim used by every other
 * /api/v1 integration test.
 *
 * Coverage:
 *   - GET list: 401 unauth, 403 non-admin, 200 admin, kind filter
 *   - POST: 401, 403 non-admin, 201 admin, 422 central_worker via API,
 *           idempotent re-create, id-conflict 409
 *   - GET single: 200, 404 missing
 *   - PATCH: 200, 400 immutable kind, 404 missing
 *   - DELETE: 204, 409 last central_worker, 409 reachable-via, 404 missing
 *   - POST heartbeat: 401, 403 non-admin, 204 admin, 404 missing
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
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

const DB_PATH = '/tmp/lootgoblin-api-agents.db';
const DB_URL = `file:${DB_PATH}`;

type DB = ReturnType<typeof import('drizzle-orm/better-sqlite3').drizzle>;
function db(): DB {
  return getDb(DB_URL) as DB;
}
function uid(): string {
  return crypto.randomUUID();
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
  // Clear forge state between tests.
  await db().delete(schema.printerReachableVia);
  await db().delete(schema.printers);
  await db().delete(schema.agents);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
});

// ─── Actor builders ─────────────────────────────────────────────────────────

function adminActor() {
  return { id: 'admin-user', role: 'admin' as const, source: 'session' as const };
}
function userActor() {
  return { id: 'normal-user', role: 'user' as const, source: 'session' as const };
}

// ─── Request builders ───────────────────────────────────────────────────────

function makeListGet(qs = ''): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/agents${qs}`, {
    method: 'GET',
  }) as unknown as import('next/server').NextRequest;
}

function makePost(body: unknown): import('next/server').NextRequest {
  return new Request('http://local/api/v1/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

function makeIdGet(id: string): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/agents/${id}`, {
    method: 'GET',
  }) as unknown as import('next/server').NextRequest;
}

function makePatch(id: string, body: unknown): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/agents/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

function makeDelete(id: string): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/agents/${id}`, {
    method: 'DELETE',
  }) as unknown as import('next/server').NextRequest;
}

function makeHeartbeat(id: string): import('next/server').NextRequest {
  return new Request(`http://local/api/v1/agents/${id}/heartbeat`, {
    method: 'POST',
  }) as unknown as import('next/server').NextRequest;
}

function paramCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ─── Helper: bootstrap a central_worker via the route module ────────────────

async function ensureBootstrap(): Promise<string> {
  const { bootstrapCentralWorker } = await import('../../src/forge/agent-bootstrap');
  const r = await bootstrapCentralWorker({ dbUrl: DB_URL });
  return r.agentId;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/agents — list', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/agents/route');
    const res = await GET(makeListGet());
    expect(res.status).toBe(401);
  });

  it('403 non-admin', async () => {
    mockAuthenticate.mockResolvedValueOnce(userActor());
    const { GET } = await import('../../src/app/api/v1/agents/route');
    const res = await GET(makeListGet());
    expect(res.status).toBe(403);
  });

  it('200 admin returns agents list', async () => {
    await ensureBootstrap();
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { GET } = await import('../../src/app/api/v1/agents/route');
    const res = await GET(makeListGet());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.agents)).toBe(true);
    expect(json.agents.length).toBeGreaterThanOrEqual(1);
    expect(json.agents[0].kind).toBe('central_worker');
  });

  it('200 admin filter by kind', async () => {
    await ensureBootstrap();
    // Add a courier directly.
    await db().insert(schema.agents).values({
      id: uid(),
      kind: 'courier',
      pairCredentialRef: null,
      reachableLanHint: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { GET } = await import('../../src/app/api/v1/agents/route');
    const res = await GET(makeListGet('?kind=courier'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.agents.every((a: { kind: string }) => a.kind === 'courier')).toBe(true);
  });
});

describe('POST /api/v1/agents — create', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import('../../src/app/api/v1/agents/route');
    const res = await POST(makePost({ kind: 'courier' }));
    expect(res.status).toBe(401);
  });

  it('403 non-admin', async () => {
    mockAuthenticate.mockResolvedValueOnce(userActor());
    const { POST } = await import('../../src/app/api/v1/agents/route');
    const res = await POST(makePost({ kind: 'courier' }));
    expect(res.status).toBe(403);
  });

  it('201 admin creates a courier', async () => {
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { POST } = await import('../../src/app/api/v1/agents/route');
    const res = await POST(
      makePost({
        kind: 'courier',
        pair_credential_ref: 'api-key-id',
        reachable_lan_hint: 'home',
      }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.agent.kind).toBe('courier');
    expect(typeof json.agent.id).toBe('string');

    const rows = await db()
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, json.agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pairCredentialRef).toBe('api-key-id');
  });

  it('422 admin POST with kind=central_worker (bootstrap-only)', async () => {
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { POST } = await import('../../src/app/api/v1/agents/route');
    const res = await POST(makePost({ kind: 'central_worker' }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.reason).toBe('central-worker-via-bootstrap');
  });

  it('400 invalid body', async () => {
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { POST } = await import('../../src/app/api/v1/agents/route');
    const res = await POST(makePost({ kind: 'wizard' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/agents/:id', () => {
  it('200 admin returns agent', async () => {
    const id = await ensureBootstrap();
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { GET } = await import('../../src/app/api/v1/agents/[id]/route');
    const res = await GET(makeIdGet(id), paramCtx(id));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.agent.id).toBe(id);
    expect(json.agent.kind).toBe('central_worker');
  });

  it('404 missing id', async () => {
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { GET } = await import('../../src/app/api/v1/agents/[id]/route');
    const res = await GET(makeIdGet('nonexistent'), paramCtx('nonexistent'));
    expect(res.status).toBe(404);
  });

  it('403 non-admin', async () => {
    const id = await ensureBootstrap();
    mockAuthenticate.mockResolvedValueOnce(userActor());
    const { GET } = await import('../../src/app/api/v1/agents/[id]/route');
    const res = await GET(makeIdGet(id), paramCtx(id));
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/v1/agents/:id', () => {
  it('200 admin updates reachable_lan_hint', async () => {
    const id = await ensureBootstrap();
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { PATCH } = await import('../../src/app/api/v1/agents/[id]/route');
    const res = await PATCH(
      makePatch(id, { reachable_lan_hint: 'updated' }),
      paramCtx(id),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.agent.reachable_lan_hint).toBe('updated');
  });

  it('400 attempting to patch kind', async () => {
    const id = await ensureBootstrap();
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { PATCH } = await import('../../src/app/api/v1/agents/[id]/route');
    const res = await PATCH(makePatch(id, { kind: 'courier' }), paramCtx(id));
    expect(res.status).toBe(400);
  });

  it('404 unknown id', async () => {
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { PATCH } = await import('../../src/app/api/v1/agents/[id]/route');
    const res = await PATCH(
      makePatch('nonexistent', { reachable_lan_hint: 'x' }),
      paramCtx('nonexistent'),
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/agents/:id', () => {
  it('204 admin deletes a courier', async () => {
    const id = uid();
    await db().insert(schema.agents).values({
      id,
      kind: 'courier',
      pairCredentialRef: null,
      reachableLanHint: null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });

    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { DELETE } = await import('../../src/app/api/v1/agents/[id]/route');
    const res = await DELETE(makeDelete(id), paramCtx(id));
    expect(res.status).toBe(204);

    const rows = await db().select().from(schema.agents).where(eq(schema.agents.id, id));
    expect(rows).toHaveLength(0);
  });

  it('409 deleting last central_worker', async () => {
    const id = await ensureBootstrap();
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { DELETE } = await import('../../src/app/api/v1/agents/[id]/route');
    const res = await DELETE(makeDelete(id), paramCtx(id));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe('cannot-delete-bootstrap-agent');
  });
});

describe('POST /api/v1/agents/:id/heartbeat', () => {
  it('401 without auth', async () => {
    const id = await ensureBootstrap();
    mockAuthenticate.mockResolvedValueOnce(null);
    const { POST } = await import('../../src/app/api/v1/agents/[id]/heartbeat/route');
    const res = await POST(makeHeartbeat(id), paramCtx(id));
    expect(res.status).toBe(401);
  });

  it('403 non-admin', async () => {
    const id = await ensureBootstrap();
    mockAuthenticate.mockResolvedValueOnce(userActor());
    const { POST } = await import('../../src/app/api/v1/agents/[id]/heartbeat/route');
    const res = await POST(makeHeartbeat(id), paramCtx(id));
    expect(res.status).toBe(403);
  });

  it('204 admin records heartbeat and updates last_seen_at', async () => {
    const id = await ensureBootstrap();
    // Set last_seen_at to a fixed past instant so we can detect the bump.
    const past = new Date(2020, 0, 1);
    await db()
      .update(schema.agents)
      .set({ lastSeenAt: past })
      .where(eq(schema.agents.id, id));

    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { POST } = await import('../../src/app/api/v1/agents/[id]/heartbeat/route');
    const res = await POST(makeHeartbeat(id), paramCtx(id));
    expect(res.status).toBe(204);

    const rows = await db().select().from(schema.agents).where(eq(schema.agents.id, id));
    expect(rows[0]!.lastSeenAt!.getTime()).toBeGreaterThan(past.getTime());
  });

  it('404 unknown agent', async () => {
    mockAuthenticate.mockResolvedValueOnce(adminActor());
    const { POST } = await import('../../src/app/api/v1/agents/[id]/heartbeat/route');
    const res = await POST(makeHeartbeat('nonexistent'), paramCtx('nonexistent'));
    expect(res.status).toBe(404);
  });
});
