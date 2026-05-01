/**
 * Integration tests — V2-005f-T_dcf12 status routes.
 *
 *   GET /api/v1/forge/dispatch/:id/status
 *   GET /api/v1/forge/dispatch/:id/status/stream  (SSE)
 *
 * Real SQLite + auth shim. Bus is reset between tests so subscribers
 * don't bleed across cases.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';

import { runMigrations, getDb, schema, resetDbCache } from '../../src/db/client';
import {
  getDefaultStatusEventBus,
  resetDefaultStatusEventBus,
} from '../../src/forge/status/event-bus';
import type { StatusEvent } from '../../src/forge/status/types';

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

const DB_PATH = '/tmp/lootgoblin-forge-status-routes.db';
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
function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
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
  await db().delete(schema.dispatchStatusEvents);
  await db().delete(schema.dispatchJobs);
  await db().delete(schema.printers);
  await db().delete(schema.forgeSlicers);
  await db().delete(schema.lootFiles);
  await db().delete(schema.loot);
  await db().delete(schema.collections);
  await db().delete(schema.stashRoots);
  await db().delete(schema.user);
  mockAuthenticate.mockReset();
  resetDefaultStatusEventBus();
});

async function seedUser(): Promise<string> {
  const id = uid();
  await db().insert(schema.user).values({
    id,
    name: 'Status Routes Test User',
    email: `${id}@status-routes.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedLoot(ownerId: string): Promise<string> {
  const rootId = uid();
  await db().insert(schema.stashRoots).values({
    id: rootId,
    ownerId,
    name: 'root',
    path: '/tmp/x',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const collectionId = uid();
  await db().insert(schema.collections).values({
    id: collectionId,
    ownerId,
    name: `c-${collectionId.slice(0, 6)}`,
    pathTemplate: '{title|slug}',
    stashRootId: rootId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const lootId = uid();
  await db().insert(schema.loot).values({
    id: lootId,
    collectionId,
    title: 'a model',
    tags: [],
    fileMissing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return lootId;
}

async function seedPrinter(ownerId: string): Promise<string> {
  const id = uid();
  await db().insert(schema.printers).values({
    id,
    ownerId,
    kind: 'fdm_klipper',
    name: 'voron',
    connectionConfig: { url: 'http://1.2.3.4' },
    active: true,
    createdAt: new Date(),
  });
  return id;
}

async function seedDispatch(args: {
  ownerId: string;
  status?:
    | 'pending'
    | 'converting'
    | 'slicing'
    | 'claimable'
    | 'claimed'
    | 'dispatched'
    | 'completed'
    | 'failed';
  progressPct?: number;
  lastStatusAt?: Date;
}): Promise<string> {
  const lootId = await seedLoot(args.ownerId);
  const printerId = await seedPrinter(args.ownerId);
  const id = uid();
  await db().insert(schema.dispatchJobs).values({
    id,
    ownerId: args.ownerId,
    lootId,
    targetKind: 'printer',
    targetId: printerId,
    status: args.status ?? 'dispatched',
    progressPct: args.progressPct ?? null,
    lastStatusAt: args.lastStatusAt ?? null,
    createdAt: new Date(),
  });
  return id;
}

async function seedStatusEvent(args: {
  dispatchJobId: string;
  occurredAt: Date;
  kind?: string;
  data?: Record<string, unknown>;
}): Promise<string> {
  const id = uid();
  await db().insert(schema.dispatchStatusEvents).values({
    id,
    dispatchJobId: args.dispatchJobId,
    eventKind: args.kind ?? 'progress',
    eventData: JSON.stringify(args.data ?? { progressPct: 33 }),
    sourceProtocol: 'moonraker',
    occurredAt: args.occurredAt,
    ingestedAt: args.occurredAt,
  });
  return id;
}

// ===========================================================================
// GET /api/v1/forge/dispatch/:id/status
// ===========================================================================

describe('GET /api/v1/forge/dispatch/:id/status', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/route'
    );
    const res = await GET(
      makeGet('http://local/api/v1/forge/dispatch/x/status'),
      { params: Promise.resolve({ id: 'x' }) },
    );
    expect(res.status).toBe(401);
  });

  it('200 returns status payload with progress + last_status_at + events', async () => {
    const userId = await seedUser();
    const t = new Date('2025-06-01T00:00:05Z');
    const dispatchId = await seedDispatch({
      ownerId: userId,
      status: 'dispatched',
      progressPct: 42,
      lastStatusAt: t,
    });
    const e1 = await seedStatusEvent({
      dispatchJobId: dispatchId,
      occurredAt: new Date('2025-06-01T00:00:01Z'),
      kind: 'progress',
      data: { progressPct: 10 },
    });
    const e2 = await seedStatusEvent({
      dispatchJobId: dispatchId,
      occurredAt: new Date('2025-06-01T00:00:05Z'),
      kind: 'progress',
      data: { progressPct: 42 },
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/forge/dispatch/${dispatchId}/status`),
      { params: Promise.resolve({ id: dispatchId }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.dispatch_job_id).toBe(dispatchId);
    expect(json.status).toBe('dispatched');
    expect(json.progress_pct).toBe(42);
    expect(json.last_status_at).toBe(t.getTime());
    expect(json.events).toHaveLength(2);
    // DESC by occurred_at — newer event first.
    expect(json.events[0].id).toBe(e2);
    expect(json.events[1].id).toBe(e1);
    // event_data is parsed JSON, not a string.
    expect(json.events[0].event_data).toEqual({ progressPct: 42 });
    expect(json.events[0].source_protocol).toBe('moonraker');
  });

  it('200 with no events returns events: []', async () => {
    const userId = await seedUser();
    const dispatchId = await seedDispatch({ ownerId: userId });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/forge/dispatch/${dispatchId}/status`),
      { params: Promise.resolve({ id: dispatchId }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.events).toEqual([]);
    expect(json.progress_pct).toBeNull();
    expect(json.last_status_at).toBeNull();
  });

  it('200 caps event count at 50 (limit) and orders DESC', async () => {
    const userId = await seedUser();
    const dispatchId = await seedDispatch({ ownerId: userId });
    // Insert 60 events spaced 1s apart.
    for (let i = 0; i < 60; i++) {
      await seedStatusEvent({
        dispatchJobId: dispatchId,
        occurredAt: new Date(2_000_000_000_000 + i * 1000),
        data: { progressPct: i },
      });
    }
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/forge/dispatch/${dispatchId}/status`),
      { params: Promise.resolve({ id: dispatchId }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.events).toHaveLength(50);
    // First (newest) is index 59; last (oldest in window) is index 10.
    expect(json.events[0].event_data.progressPct).toBe(59);
    expect(json.events[49].event_data.progressPct).toBe(10);
    // Verify DESC ordering across the window.
    for (let i = 0; i + 1 < json.events.length; i++) {
      expect(json.events[i].occurred_at).toBeGreaterThanOrEqual(
        json.events[i + 1].occurred_at,
      );
    }
  });

  it('404 unknown id', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/route'
    );
    const res = await GET(
      makeGet('http://local/api/v1/forge/dispatch/no-such/status'),
      { params: Promise.resolve({ id: 'no-such' }) },
    );
    expect(res.status).toBe(404);
  });

  it('404 cross-owner (not 403)', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const aliceDispatch = await seedDispatch({ ownerId: aliceId });
    mockAuthenticate.mockResolvedValueOnce(actor(bobId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/forge/dispatch/${aliceDispatch}/status`),
      { params: Promise.resolve({ id: aliceDispatch }) },
    );
    expect(res.status).toBe(404);
  });

  it('200 admin sees cross-owner dispatch', async () => {
    const aliceId = await seedUser();
    const adminId = await seedUser();
    const aliceDispatch = await seedDispatch({ ownerId: aliceId });
    mockAuthenticate.mockResolvedValueOnce(actor(adminId, 'admin'));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/forge/dispatch/${aliceDispatch}/status`),
      { params: Promise.resolve({ id: aliceDispatch }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.dispatch_job_id).toBe(aliceDispatch);
  });
});

// ===========================================================================
// GET /api/v1/forge/dispatch/:id/status/stream  (SSE)
// ===========================================================================

/**
 * Read the next chunk(s) from an SSE response and decode UTF-8.
 * Doesn't consume the entire stream — callers loop until they have what
 * they need. Returns '' on close.
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { value, done } = await reader.read();
  if (done) return '';
  return new TextDecoder().decode(value);
}

/**
 * Parse SSE buffer text into a list of `{event, data}` records. Skips
 * comment lines (`:` prefix) and ignores partial trailing frames so the
 * caller can keep reading.
 */
function parseSseFrames(buf: string): Array<{ event: string; data: string }> {
  const frames: Array<{ event: string; data: string }> = [];
  for (const block of buf.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    let event = 'message';
    const dataLines: string[] = [];
    let isComment = false;
    for (const line of lines) {
      if (line.startsWith(':')) {
        isComment = true;
        continue;
      }
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
    }
    if (isComment && dataLines.length === 0) continue;
    frames.push({ event, data: dataLines.join('\n') });
  }
  return frames;
}

describe('GET /api/v1/forge/dispatch/:id/status/stream', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/stream/route'
    );
    const res = await GET(
      makeGet('http://local/api/v1/forge/dispatch/x/status/stream'),
      { params: Promise.resolve({ id: 'x' }) },
    );
    expect(res.status).toBe(401);
  });

  it('404 unknown id', async () => {
    const userId = await seedUser();
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/stream/route'
    );
    const res = await GET(
      makeGet('http://local/api/v1/forge/dispatch/no-such/status/stream'),
      { params: Promise.resolve({ id: 'no-such' }) },
    );
    expect(res.status).toBe(404);
  });

  it('404 cross-owner (not 403)', async () => {
    const aliceId = await seedUser();
    const bobId = await seedUser();
    const aliceDispatch = await seedDispatch({ ownerId: aliceId });
    mockAuthenticate.mockResolvedValueOnce(actor(bobId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/stream/route'
    );
    const res = await GET(
      makeGet(
        `http://local/api/v1/forge/dispatch/${aliceDispatch}/status/stream`,
      ),
      { params: Promise.resolve({ id: aliceDispatch }) },
    );
    expect(res.status).toBe(404);
  });

  it('streams bus events as SSE frames and closes on terminal event', async () => {
    const userId = await seedUser();
    const dispatchId = await seedDispatch({
      ownerId: userId,
      status: 'dispatched',
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/stream/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/forge/dispatch/${dispatchId}/status/stream`),
      { params: Promise.resolve({ id: dispatchId }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();

    // Bus is the same singleton the route subscribed to. Drive a progress
    // event then a terminal completed event.
    const bus = getDefaultStatusEventBus();
    const progressEvent: StatusEvent = {
      kind: 'progress',
      remoteJobRef: 'r-1',
      progressPct: 50,
      rawPayload: { foo: 'bar' },
      occurredAt: new Date('2025-07-01T00:00:00Z'),
    };
    const completedEvent: StatusEvent = {
      kind: 'completed',
      remoteJobRef: 'r-1',
      progressPct: 100,
      rawPayload: {},
      occurredAt: new Date('2025-07-01T00:01:00Z'),
    };
    bus.emit(dispatchId, progressEvent);
    bus.emit(dispatchId, completedEvent);

    // Read until the stream closes.
    let buf = '';
    while (true) {
      const chunk = await readChunk(reader);
      if (chunk === '') break;
      buf += chunk;
    }
    const frames = parseSseFrames(buf);
    // Two status frames. Heartbeat comments are filtered out.
    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBe('status');
    const data0 = JSON.parse(frames[0].data);
    expect(data0.kind).toBe('progress');
    expect(data0.progressPct).toBe(50);

    expect(frames[1].event).toBe('status');
    const data1 = JSON.parse(frames[1].data);
    expect(data1.kind).toBe('completed');
    expect(data1.progressPct).toBe(100);
  });

  it('does not deliver events for a different dispatchJobId', async () => {
    const userId = await seedUser();
    const dispatchA = await seedDispatch({ ownerId: userId });
    const dispatchB = await seedDispatch({ ownerId: userId });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/stream/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/forge/dispatch/${dispatchA}/status/stream`),
      { params: Promise.resolve({ id: dispatchA }) },
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const bus = getDefaultStatusEventBus();

    // Wrong-dispatch event must not be delivered.
    bus.emit(dispatchB, {
      kind: 'progress',
      remoteJobRef: 'rb',
      progressPct: 25,
      rawPayload: {},
      occurredAt: new Date(),
    });
    // Correct-dispatch terminal event flushes + closes.
    bus.emit(dispatchA, {
      kind: 'completed',
      remoteJobRef: 'ra',
      progressPct: 100,
      rawPayload: {},
      occurredAt: new Date(),
    });

    let buf = '';
    while (true) {
      const chunk = await readChunk(reader);
      if (chunk === '') break;
      buf += chunk;
    }
    const frames = parseSseFrames(buf);
    expect(frames).toHaveLength(1);
    const data = JSON.parse(frames[0].data);
    expect(data.kind).toBe('completed');
    expect(data.remoteJobRef).toBe('ra');
  });

  it('already-terminal dispatch returns one-shot terminal frame and closes', async () => {
    const userId = await seedUser();
    const dispatchId = await seedDispatch({
      ownerId: userId,
      status: 'completed',
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/stream/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/forge/dispatch/${dispatchId}/status/stream`),
      { params: Promise.resolve({ id: dispatchId }) },
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    let buf = '';
    while (true) {
      const chunk = await readChunk(reader);
      if (chunk === '') break;
      buf += chunk;
    }
    const frames = parseSseFrames(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('status');
    const data = JSON.parse(frames[0].data);
    expect(data.terminal).toBe(true);
    expect(data.kind).toBe('completed');
  });

  it('already-failed dispatch returns one-shot terminal frame', async () => {
    const userId = await seedUser();
    const dispatchId = await seedDispatch({
      ownerId: userId,
      status: 'failed',
    });
    mockAuthenticate.mockResolvedValueOnce(actor(userId));
    const { GET } = await import(
      '../../src/app/api/v1/forge/dispatch/[id]/status/stream/route'
    );
    const res = await GET(
      makeGet(`http://local/api/v1/forge/dispatch/${dispatchId}/status/stream`),
      { params: Promise.resolve({ id: dispatchId }) },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let buf = '';
    while (true) {
      const chunk = await readChunk(reader);
      if (chunk === '') break;
      buf += chunk;
    }
    const frames = parseSseFrames(buf);
    expect(frames).toHaveLength(1);
    const data = JSON.parse(frames[0].data);
    expect(data.terminal).toBe(true);
    expect(data.kind).toBe('failed');
  });
});
