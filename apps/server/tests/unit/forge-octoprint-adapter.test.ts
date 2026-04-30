/**
 * Unit tests — OctoPrint dispatcher adapter — V2-005d-d T_dd1
 *
 * Covers all 14 cases from the task spec:
 *   1.  201 success with files.local.path → remoteFilename = path
 *   2.  201 success with empty body → remoteFilename = basename(storagePath)
 *   3.  401 → auth-failed (with body excerpt)
 *   4.  403 → auth-failed
 *   5.  400 with structured error → rejected (with body excerpt)
 *   6.  500 → unknown
 *   7.  ECONNREFUSED → unreachable
 *   8.  AbortError / timeout → timeout
 *   9.  no creds + requiresAuth=true → no-credentials, no fetch call
 *   10. no creds + requiresAuth=false → success without X-Api-Key
 *   11. invalid connection-config → unknown
 *   12. credential payload wrong shape + requiresAuth=true → auth-failed
 *   13. select=false + startPrint=false → FormData fields reflect
 *   14. custom apiPath='/octoprint/api' → URL composition
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

import {
  OCTOPRINT_KIND,
  createOctoprintHandler,
} from '@/forge/dispatch/octoprint/adapter';
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
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-octoprint-adapter-'));
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
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
      kind: OCTOPRINT_KIND,
      connectionConfig: overrides.connectionConfig ?? {
        host: '192.168.1.60',
        port: 80,
        scheme: 'http',
        apiPath: '/api',
        select: true,
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
    kind: 'octoprint_api_key',
    payload: { apiKey: 'op-test-api-key-xyz789' },
    label: null,
    lastUsedAt: null,
  };
}

async function formDataFromInit(init: RequestInit): Promise<Record<string, string>> {
  // The body is a FormData when our adapter built it; read string fields out.
  const fd = init.body as FormData;
  const result: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1-2: Success paths
// ---------------------------------------------------------------------------

describe('createOctoprintHandler — success', () => {
  it('test 1: 201 with files.local.path → success with that remoteFilename', async () => {
    const touchLastUsed = vi.fn();
    const handler = createOctoprintHandler({ touchLastUsed });
    const { ctx, fetchMock } = makeCtx({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            done: true,
            files: { local: { name: 'cube.gcode', path: 'lootgoblin/cube.gcode' } },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('success');
    if (out.kind !== 'success') return;
    expect(out.remoteFilename).toBe('lootgoblin/cube.gcode');
    expect(touchLastUsed).toHaveBeenCalledTimes(1);
    expect(touchLastUsed).toHaveBeenCalledWith({ printerId: ctx.printer.id });

    // Verify URL + headers wired correctly.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe('http://192.168.1.60:80/api/files/local');
    const headers = (calledInit as RequestInit).headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('op-test-api-key-xyz789');
  });

  it('test 2: 201 with empty body → falls back to basename(storagePath)', async () => {
    const touchLastUsed = vi.fn();
    const handler = createOctoprintHandler({ touchLastUsed });
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

describe('createOctoprintHandler — HTTP error responses', () => {
  it('test 3: 401 → auth-failed with body excerpt', async () => {
    const touchLastUsed = vi.fn();
    const handler = createOctoprintHandler({ touchLastUsed });
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
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn() });
    const { ctx } = makeCtx({
      fetchImpl: async () => new Response('forbidden', { status: 403 }),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('auth-failed');
  });

  it('test 5: 400 with structured error → rejected with body excerpt', async () => {
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn() });
    const { ctx } = makeCtx({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'Invalid file' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('rejected');
    expect(out.details).toContain('Invalid file');
  });

  it('test 6: 500 → unknown', async () => {
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn() });
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

describe('createOctoprintHandler — network failures', () => {
  it('test 7: ECONNREFUSED → unreachable with details', async () => {
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn() });
    const { ctx } = makeCtx({
      fetchImpl: async () => {
        // Simulate undici style: TypeError('fetch failed') with cause carrying code.
        const cause = Object.assign(new Error('connect ECONNREFUSED 192.168.1.60:80'), {
          code: 'ECONNREFUSED',
        });
        const err = Object.assign(new TypeError('fetch failed'), { cause });
        throw err;
      },
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('failure');
    if (out.kind !== 'failure') return;
    expect(out.reason).toBe('unreachable');
    expect(out.details).toMatch(/fetch failed|ECONNREFUSED/);
  });

  it('test 8: AbortError → timeout', async () => {
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn(), timeoutMs: 50 });
    const { ctx } = makeCtx({
      fetchImpl: async (_url, init) => {
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

describe('createOctoprintHandler — auth gating', () => {
  it('test 9: requiresAuth=true + no credential → no-credentials, no fetch call', async () => {
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn() });
    const { ctx, fetchMock } = makeCtx({
      credential: null,
      connectionConfig: {
        host: '192.168.1.60',
        port: 80,
        scheme: 'http',
        apiPath: '/api',
        select: true,
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
    const handler = createOctoprintHandler({ touchLastUsed });
    const { ctx, fetchMock } = makeCtx({
      credential: null,
      connectionConfig: {
        host: '192.168.1.60',
        port: 80,
        scheme: 'http',
        apiPath: '/api',
        select: true,
        startPrint: true,
        requiresAuth: false,
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ done: true, files: { local: { path: 'trusted.gcode' } } }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
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

describe('createOctoprintHandler — misconfiguration', () => {
  it('test 11: invalid connection-config (missing host) → unknown', async () => {
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn() });
    const { ctx, fetchMock } = makeCtx({
      connectionConfig: {
        // host omitted on purpose
        port: 80,
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
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn() });
    const { ctx, fetchMock } = makeCtx({
      credential: {
        id: randomUUID(),
        printerId: randomUUID(),
        kind: 'octoprint_api_key',
        payload: { wrongField: 'oops' },
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

// ---------------------------------------------------------------------------
// 13-14: form-data fields + custom apiPath
// ---------------------------------------------------------------------------

describe('createOctoprintHandler — form-data + apiPath variants', () => {
  it('test 13: select=false + startPrint=false → FormData fields reflect both', async () => {
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn() });
    let captured: Record<string, string> = {};
    const { ctx } = makeCtx({
      connectionConfig: {
        host: '192.168.1.60',
        port: 80,
        scheme: 'http',
        apiPath: '/api',
        select: false,
        startPrint: false,
        requiresAuth: true,
      },
      fetchImpl: async (_url, init) => {
        captured = await formDataFromInit(init as RequestInit);
        return new Response(
          JSON.stringify({ done: true, files: { local: { path: 'idle.gcode' } } }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('success');
    expect(captured.select).toBe('false');
    expect(captured.print).toBe('false');
  });

  it('test 14: custom apiPath=/octoprint/api → URL built correctly', async () => {
    const handler = createOctoprintHandler({ touchLastUsed: vi.fn() });
    const { ctx, fetchMock } = makeCtx({
      connectionConfig: {
        host: '192.168.1.60',
        port: 80,
        scheme: 'http',
        apiPath: '/octoprint/api',
        select: true,
        startPrint: true,
        requiresAuth: true,
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ done: true, files: { local: { path: 'sub/file.gcode' } } }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe('http://192.168.1.60:80/octoprint/api/files/local');
  });
});
