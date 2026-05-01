/**
 * Unit tests — SDCP dispatcher adapter — V2-005d-c T_dc5
 *
 * Composes the T_dc3 uploader (HTTP) and T_dc4 commander (WebSocket-as-MQTT)
 * via stubs so no real network or filesystem reads happen. A real .ctb
 * artifact is written to tmpdir before each test so path.basename() and the
 * extension gate run against the real storagePath.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

import { createSdcpHandler } from '@/forge/dispatch/sdcp/adapter';
import type { HttpClient, HttpResponseLike } from '@/forge/dispatch/sdcp/uploader';
import type { MqttClientLike, MqttFactory } from '@/forge/dispatch/sdcp/commander';
import type { DispatchContext } from '@/forge/dispatch/handler';

const silentLogger = pino({ level: 'silent' });

let tmpRoot: string;
let artifactPath: string;
const ARTIFACT_BYTES = Buffer.from('CTB fake — uploader is mocked, contents do not matter');

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sdcp-adapter-'));
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  artifactPath = path.join(tmpRoot, `${randomUUID()}.ctb`);
  await fsp.writeFile(artifactPath, ARTIFACT_BYTES);
});

afterEach(async () => {
  await fsp.rm(artifactPath, { force: true }).catch(() => {});
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// HTTP mock — drives upload outcome
// ---------------------------------------------------------------------------

interface HttpMock {
  client: HttpClient;
  calls: Array<{ url: string; init: RequestInit }>;
}

function makeHttp(opts?: {
  status?: number;
  statusText?: string;
  body?: string;
  throw?: Error;
}): HttpMock {
  const calls: HttpMock['calls'] = [];
  const client: HttpClient = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (opts?.throw) throw opts.throw;
      const status = opts?.status ?? 200;
      const res: HttpResponseLike = {
        ok: status >= 200 && status < 300,
        status,
        statusText: opts?.statusText ?? 'OK',
        text: async () => opts?.body ?? '',
      };
      return res;
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// MQTT/WebSocket mock — drives commander outcome
// ---------------------------------------------------------------------------

interface MqttMock {
  factory: MqttFactory;
  client: MqttClientLike & {
    publish: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  factoryCalls: Array<{ url: string; opts: { rejectUnauthorized: boolean } }>;
}

function makeMqtt(opts?: {
  publishError?: Error;
  autoConnect?: boolean;
  errorOnConnect?: Error;
  neverConnect?: boolean;
}): MqttMock {
  const factoryCalls: MqttMock['factoryCalls'] = [];
  let connectListener: (() => void) | null = null;
  let errorListener: ((err: Error) => void) | null = null;

  const client = {
    publish: vi.fn(
      (
        _topic: string,
        _payload: string,
        _o: object,
        cb: (err?: Error) => void,
      ) => {
        if (opts?.publishError) cb(opts.publishError);
        else cb(undefined);
      },
    ),
    end: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'error') errorListener = listener as (err: Error) => void;
    }),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'connect') {
        connectListener = listener as () => void;
        if (opts?.autoConnect) queueMicrotask(() => connectListener?.());
      }
    }),
  };

  const factory: MqttFactory = (url, factoryOpts) => {
    factoryCalls.push({ url, opts: factoryOpts });
    if (opts?.errorOnConnect) {
      queueMicrotask(() => errorListener?.(opts.errorOnConnect as Error));
    }
    if (opts?.neverConnect) {
      // never fires connect or error; commander timer should fire
    }
    return client;
  };

  return { factory, client, factoryCalls };
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

interface CtxOverrides {
  connectionConfig?: Record<string, unknown>;
  storagePath?: string;
  kind?: string;
}

function makeCtx(overrides: CtxOverrides = {}): DispatchContext {
  return {
    job: { id: randomUUID(), ownerId: randomUUID(), targetId: randomUUID() },
    printer: {
      id: randomUUID(),
      ownerId: randomUUID(),
      kind: overrides.kind ?? 'sdcp_elegoo_saturn_4',
      connectionConfig: overrides.connectionConfig ?? {
        ip: '192.168.1.77',
        mainboardId: 'MB-DEADBEEF-001',
      },
    },
    artifact: {
      storagePath: overrides.storagePath ?? artifactPath,
      sizeBytes: ARTIFACT_BYTES.length,
      sha256: 'deadbeef',
    },
    credential: null,
    http: { fetch: (() => Promise.reject(new Error('http not used'))) as typeof globalThis.fetch },
    logger: silentLogger,
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('createSdcpHandler', () => {
  it('1. happy path — upload + start-print succeed; touchLastUsed called once', async () => {
    const http = makeHttp({ status: 200 });
    const mqtt = makeMqtt({ autoConnect: true });
    const touchLastUsed = vi.fn();
    const handler = createSdcpHandler({
      httpClient: http.client,
      mqttFactory: mqtt.factory,
      touchLastUsed,
    });

    const ctx = makeCtx();
    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('success');
    if (out.kind === 'success') {
      expect(out.remoteFilename).toBe(`/local/${path.basename(artifactPath)}`);
    }
    expect(http.calls.length).toBeGreaterThanOrEqual(1);
    expect(mqtt.factoryCalls).toHaveLength(1);
    expect(mqtt.factoryCalls[0]?.url).toBe('ws://192.168.1.77:3030/websocket');
    expect(mqtt.client.publish).toHaveBeenCalledOnce();
    expect(touchLastUsed).toHaveBeenCalledOnce();
    expect(touchLastUsed).toHaveBeenCalledWith({ printerId: ctx.printer.id });
  });

  it('2. startPrint=false — upload succeeds, commander never invoked', async () => {
    const http = makeHttp({ status: 200 });
    const mqtt = makeMqtt({ autoConnect: true });
    const touchLastUsed = vi.fn();
    const handler = createSdcpHandler({
      httpClient: http.client,
      mqttFactory: mqtt.factory,
      touchLastUsed,
    });

    const out = await handler.dispatch(
      makeCtx({
        connectionConfig: { ip: '192.168.1.77', mainboardId: 'MB-X', startPrint: false },
      }),
    );

    expect(out.kind).toBe('success');
    expect(mqtt.factoryCalls).toHaveLength(0);
    expect(mqtt.client.publish).not.toHaveBeenCalled();
    expect(touchLastUsed).toHaveBeenCalledOnce();
  });

  it('3. wrong file extension (.stl) — early reject before upload/print', async () => {
    const stlPath = path.join(tmpRoot, `${randomUUID()}.stl`);
    await fsp.writeFile(stlPath, ARTIFACT_BYTES);
    try {
      const http = makeHttp();
      const mqtt = makeMqtt();
      const handler = createSdcpHandler({
        httpClient: http.client,
        mqttFactory: mqtt.factory,
      });

      const out = await handler.dispatch(makeCtx({ storagePath: stlPath }));

      expect(out.kind).toBe('failure');
      if (out.kind === 'failure') {
        expect(out.reason).toBe('rejected');
        expect(out.details).toContain('.ctb');
      }
      expect(http.calls).toHaveLength(0);
      expect(mqtt.factoryCalls).toHaveLength(0);
    } finally {
      await fsp.rm(stlPath, { force: true });
    }
  });

  it('4. wrong file extension (.gcode.3mf) — early reject', async () => {
    const bambuPath = path.join(tmpRoot, `${randomUUID()}.gcode.3mf`);
    await fsp.writeFile(bambuPath, ARTIFACT_BYTES);
    try {
      const http = makeHttp();
      const mqtt = makeMqtt();
      const handler = createSdcpHandler({
        httpClient: http.client,
        mqttFactory: mqtt.factory,
      });

      const out = await handler.dispatch(makeCtx({ storagePath: bambuPath }));

      expect(out.kind).toBe('failure');
      if (out.kind === 'failure') expect(out.reason).toBe('rejected');
      expect(http.calls).toHaveLength(0);
      expect(mqtt.factoryCalls).toHaveLength(0);
    } finally {
      await fsp.rm(bambuPath, { force: true });
    }
  });

  it('5. wrong kind (fdm_klipper) — defensive unsupported-protocol', async () => {
    const http = makeHttp();
    const mqtt = makeMqtt();
    const handler = createSdcpHandler({
      httpClient: http.client,
      mqttFactory: mqtt.factory,
    });

    const out = await handler.dispatch(makeCtx({ kind: 'fdm_klipper' }));

    expect(out).toEqual({ kind: 'failure', reason: 'unsupported-protocol' });
    expect(http.calls).toHaveLength(0);
    expect(mqtt.factoryCalls).toHaveLength(0);
  });

  it('6. invalid connection-config (missing ip) — reason=unknown', async () => {
    const http = makeHttp();
    const mqtt = makeMqtt();
    const handler = createSdcpHandler({
      httpClient: http.client,
      mqttFactory: mqtt.factory,
    });

    const out = await handler.dispatch(
      makeCtx({ connectionConfig: { mainboardId: 'MB-X' } }),
    );

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('unknown');
      expect(out.details).toContain('invalid connection-config');
    }
    expect(http.calls).toHaveLength(0);
    expect(mqtt.factoryCalls).toHaveLength(0);
  });

  it('7. fs read error (file does not exist) — reason=unknown', async () => {
    const http = makeHttp();
    const mqtt = makeMqtt();
    const handler = createSdcpHandler({
      httpClient: http.client,
      mqttFactory: mqtt.factory,
    });

    const out = await handler.dispatch(
      makeCtx({ storagePath: path.join(tmpRoot, `${randomUUID()}-missing.ctb`) }),
    );

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('unknown');
      expect(out.details).toContain('failed to read artifact');
    }
    expect(http.calls).toHaveLength(0);
    expect(mqtt.factoryCalls).toHaveLength(0);
  });

  it('8. upload 401 → reason=auth-failed', async () => {
    const http = makeHttp({ status: 401, statusText: 'Unauthorized', body: 'nope' });
    const mqtt = makeMqtt({ autoConnect: true });
    const handler = createSdcpHandler({
      httpClient: http.client,
      mqttFactory: mqtt.factory,
    });

    const out = await handler.dispatch(makeCtx());

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('auth-failed');
      expect(out.details).toContain('upload failed');
    }
    expect(mqtt.factoryCalls).toHaveLength(0);
  });

  it('9. upload ECONNREFUSED → reason=unreachable', async () => {
    const err = new Error('connect ECONNREFUSED 192.168.1.77:3030');
    const http = makeHttp({ throw: err });
    const mqtt = makeMqtt();
    const handler = createSdcpHandler({
      httpClient: http.client,
      mqttFactory: mqtt.factory,
    });

    const out = await handler.dispatch(makeCtx());

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('unreachable');
    }
    expect(mqtt.factoryCalls).toHaveLength(0);
  });

  it('10. start-print timeout — upload happened but Cmd 128 did not start', async () => {
    const http = makeHttp({ status: 200 });
    const mqtt = makeMqtt({ neverConnect: true });
    const handler = createSdcpHandler({
      httpClient: http.client,
      mqttFactory: mqtt.factory,
      timeoutMs: 50,
    });

    const out = await handler.dispatch(makeCtx());

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('timeout');
      expect(out.details).toContain('start-print failed');
    }
    expect(http.calls.length).toBeGreaterThanOrEqual(1);
    expect(mqtt.factoryCalls).toHaveLength(1);
    expect(mqtt.client.publish).not.toHaveBeenCalled();
  });

  it('11. custom port (8080) flows through to both uploader and commander', async () => {
    const http = makeHttp({ status: 200 });
    const mqtt = makeMqtt({ autoConnect: true });
    const handler = createSdcpHandler({
      httpClient: http.client,
      mqttFactory: mqtt.factory,
    });

    const out = await handler.dispatch(
      makeCtx({
        connectionConfig: { ip: '10.0.0.5', mainboardId: 'MB-PORT', port: 8080 },
      }),
    );

    expect(out.kind).toBe('success');
    expect(http.calls[0]?.url).toBe('http://10.0.0.5:8080/uploadFile/upload');
    expect(mqtt.factoryCalls[0]?.url).toBe('ws://10.0.0.5:8080/websocket');
  });
});
