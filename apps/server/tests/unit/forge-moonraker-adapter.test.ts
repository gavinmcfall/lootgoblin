/**
 * Unit tests — Moonraker dispatcher adapter — V2-005d-a T_da5
 *
 * Covers all 12 cases from the task spec:
 *   1.  201 success with result.item.path → remoteFilename = path
 *   2.  201 success with empty body → remoteFilename = basename(storagePath)
 *   3.  401 → auth-failed (with body excerpt)
 *   4.  403 → auth-failed
 *   5.  400 → rejected
 *   6.  500 → unknown
 *   7.  ECONNREFUSED → unreachable
 *   8.  AbortError / timeout → timeout
 *   9.  no creds + requiresAuth=true → no-credentials, no fetch call
 *   10. no creds + requiresAuth=false → success without X-Api-Key
 *   11. invalid connection-config → unknown
 *   12. credential payload wrong shape + requiresAuth=true → auth-failed
 *
 * Patterns used:
 *  - vi.fn() for ctx.http.fetch (matches cults3d-adapter.test.ts).
 *  - Real on-disk artifact written to a per-test tmpdir (the adapter does
 *    fsp.readFile against ctx.artifact.storagePath; mocking node:fs across
 *    workers is fragile).
 *  - touchLastUsed injected as vi.fn() so we can assert call shape without
 *    hitting the DB.
 *  - Pino silent logger so log lines don't pollute test output.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

import {
  MOONRAKER_KIND,
  createMoonrakerHandler,
} from '@/forge/dispatch/moonraker/adapter';
import type { DispatchContext } from '@/forge/dispatch/handler';
import type { DecryptedCredential } from '@/forge/dispatch/credentials';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' });

let tmpRoot: string;
let artifactPath: string;
const ARTIFACT_BYTES = Buffer.from('G28 ; home all axes\nG1 X10 Y10 F3000\n');

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-moonraker-adapter-'));
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  // Fresh artifact file per test so tests can't pollute each other.
  artifactPath = path.join(tmpRoot, `${randomUUID()}.gcode`);
  await fsp.writeFile(artifactPath, ARTIFACT_BYTES);
});

afterEach(async () => {
  await fsp.rm(artifactPath, { force: true }).catch(() => {});
});

interface CtxOverrides {
  connectionConfig?: Record<string, unknown>;
  credential?: DecryptedCredential | null;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

function makeCtx(overrides: CtxOverrides = {}): {
  ctx: DispatchContext;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const fetchMock = vi.fn(
    overrides.fetchImpl ??
      (async () => new Response(JSON.stringify({}), { status: 201 })),
  );
  const ctx: DispatchContext = {
    job: { id: randomUUID(), ownerId: randomUUID(), targetId: randomUUID() },
    printer: {
      id: randomUUID(),
      ownerId: randomUUID(),
      kind: MOONRAKER_KIND,
      connectionConfig: overrides.connectionConfig ?? {
        host: '192.168.1.50',
        port: 7125,
        scheme: 'http',
        startPrint: true,
        requiresAuth: true,
      },
    },
    artifact: { storagePath: artifactPath, sizeBytes: ARTIFACT_BYTES.length, sha256: 'deadbeef' },
    credential:
      overrides.credential === undefined
        ? makeValidCredential()
        : overrides.credential,
    http: { fetch: fetchMock as unknown as typeof globalThis.fetch },
    logger: silentLogger,
  };
  return { ctx, fetchMock };
}

function makeValidCredential(): DecryptedCredential {
  return {
    id: randomUUID(),
    printerId: randomUUID(),
    kind: 'fdm_klipper',
    payload: { apiKey: 'test-api-key-abc123' },
    label: null,
    lastUsedAt: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Success with remote path
// ---------------------------------------------------------------------------

describe('createMoonrakerHandler — success', () => {
  it('test 1: 201 with result.item.path → success with that remoteFilename', async () => {
    const touchLastUsed = vi.fn();
    const handler = createMoonrakerHandler({ touchLastUsed });
    const { ctx, fetchMock } = makeCtx({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ result: { item: { path: 'cube.gcode', root: 'gcodes' } } }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('success');
    if (out.kind !== 'success') return;
    expect(out.remoteFilename).toBe('cube.gcode');
    expect(touchLastUsed).toHaveBeenCalledTimes(1);
    expect(touchLastUsed).toHaveBeenCalledWith({ printerId: ctx.printer.id });

    // Verify URL + headers wired correctly.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe('http://192.168.1.50:7125/server/files/upload');
    const headers = (calledInit as RequestInit).headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('test-api-key-abc123');
  });

  it('test 2: 201 with empty body → falls back to basename(storagePath)', async () => {
    const touchLastUsed = vi.fn();
    const handler = createMoonrakerHandler({ touchLastUsed });
    const { ctx } = makeCtx({
      fetchImpl: async () =>
        new Response(JSON.stringify({}), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('success');
    if (out.kind !== 'success') return;
    expect(out.remoteFilename).toBe(path.basename(artifactPath));
    expect(touchLastUsed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3-6: HTTP failure responses
// ---------------------------------------------------------------------------

describe('createMoonrakerHandler — HTTP error responses', () => {
  it('test 3: 401 → auth-failed with body excerpt', async () => {
    const touchLastUsed = vi.fn();
    const handler = createMoonrakerHandler({ touchLastUsed });
    const { ctx } = makeCtx({
      fetchImpl: async () =>
        new Response('unauthorized: missing X-Api-Key', { status: 401 }),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('auth-failed');
    expect(out.details).toContain('unauthorized');
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it('test 4: 403 → auth-failed', async () => {
    const handler = createMoonrakerHandler({ touchLastUsed: vi.fn() });
    const { ctx } = makeCtx({
      fetchImpl: async () => new Response('forbidden', { status: 403 }),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('auth-failed');
  });

  it('test 5: 400 with structured error → rejected with body excerpt', async () => {
    const handler = createMoonrakerHandler({ touchLastUsed: vi.fn() });
    const { ctx } = makeCtx({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { message: 'malformed gcode', code: -32603 } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('rejected');
    expect(out.details).toContain('malformed gcode');
  });

  it('test 6: 500 → unknown', async () => {
    const handler = createMoonrakerHandler({ touchLastUsed: vi.fn() });
    const { ctx } = makeCtx({
      fetchImpl: async () => new Response('internal server error', { status: 500 }),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('unknown');
    expect(out.details).toContain('internal server error');
  });
});

// ---------------------------------------------------------------------------
// 7-8: network + timeout
// ---------------------------------------------------------------------------

describe('createMoonrakerHandler — network failures', () => {
  it('test 7: ECONNREFUSED → unreachable with details', async () => {
    const handler = createMoonrakerHandler({ touchLastUsed: vi.fn() });
    const { ctx } = makeCtx({
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 192.168.1.50:7125');
      },
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('unreachable');
    expect(out.details).toMatch(/ECONNREFUSED/);
  });

  it('test 8: AbortError → timeout', async () => {
    const handler = createMoonrakerHandler({ touchLastUsed: vi.fn(), timeoutMs: 50 });
    const { ctx } = makeCtx({
      fetchImpl: async (_url, init) => {
        // Simulate a real fetch that respects AbortSignal.timeout: wait until
        // the signal aborts, then reject with AbortError.
        return new Promise((_resolve, reject) => {
          const sig = (init as RequestInit | undefined)?.signal;
          if (sig?.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          sig?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// 9-10: credential / requiresAuth gating
// ---------------------------------------------------------------------------

describe('createMoonrakerHandler — auth gating', () => {
  it('test 9: requiresAuth=true + no credential → no-credentials, no fetch call', async () => {
    const handler = createMoonrakerHandler({ touchLastUsed: vi.fn() });
    const { ctx, fetchMock } = makeCtx({
      credential: null,
      connectionConfig: {
        host: '192.168.1.50',
        port: 7125,
        scheme: 'http',
        startPrint: true,
        requiresAuth: true,
      },
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('no-credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test 10: requiresAuth=false + no credential → success without X-Api-Key header', async () => {
    const touchLastUsed = vi.fn();
    const handler = createMoonrakerHandler({ touchLastUsed });
    const { ctx, fetchMock } = makeCtx({
      credential: null,
      connectionConfig: {
        host: '192.168.1.50',
        port: 7125,
        scheme: 'http',
        startPrint: true,
        requiresAuth: false,
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ result: { item: { path: 'trusted.gcode' } } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('success');
    if (out.kind !== 'success') return;
    expect(out.remoteFilename).toBe('trusted.gcode');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11-12: misconfig
// ---------------------------------------------------------------------------

describe('createMoonrakerHandler — misconfiguration', () => {
  it('test 11: invalid connection-config (missing host) → unknown', async () => {
    const handler = createMoonrakerHandler({ touchLastUsed: vi.fn() });
    const { ctx, fetchMock } = makeCtx({
      connectionConfig: {
        // host omitted on purpose
        port: 7125,
        scheme: 'http',
      },
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('unknown');
    expect(out.details).toMatch(/invalid connection-config/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test 12: credential payload wrong shape + requiresAuth=true → auth-failed', async () => {
    const handler = createMoonrakerHandler({ touchLastUsed: vi.fn() });
    const { ctx, fetchMock } = makeCtx({
      credential: {
        id: randomUUID(),
        printerId: randomUUID(),
        kind: 'fdm_klipper',
        payload: { wrongField: 'oops' }, // missing apiKey
        label: null,
        lastUsedAt: null,
      },
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('auth-failed');
    expect(out.details).toMatch(/credential payload/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
