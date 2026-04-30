/**
 * Unit tests — Bambu LAN dispatcher adapter — V2-005d-b T_db3
 *
 * Covers all 14 cases from the task spec. We inject mock factories for both
 * the MQTT and FTPS clients plus a stubbed extractAmsConfig so no real
 * network or zip parsing happens here.
 *
 * Patterns:
 *  - vi.fn() factories with reset between tests so call assertions stay tight.
 *  - Real on-disk artifact written to tmpdir (path.basename + .gcode.3mf
 *    suffix-check both run on the actual storagePath; AMS extractor is
 *    mocked so the file contents don't have to be a real 3MF).
 *  - Pino silent logger so log lines don't pollute test output.
 *  - touchLastUsed injected as vi.fn() so we never touch the DB.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

import {
  createBambuLanHandler,
  type MqttClientLike,
  type FtpClientLike,
} from '@/forge/dispatch/bambu/adapter';
import type { DispatchContext } from '@/forge/dispatch/handler';
import type { DecryptedCredential } from '@/forge/dispatch/credentials';
import type { AmsConfig } from '@/forge/dispatch/bambu/ams-extractor';

const silentLogger = pino({ level: 'silent' });

let tmpRoot: string;
let artifactPath: string;
const ARTIFACT_BYTES = Buffer.from('PK fake 3mf contents — extractor is mocked');

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-bambu-adapter-'));
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  artifactPath = path.join(tmpRoot, `${randomUUID()}.gcode.3mf`);
  await fsp.writeFile(artifactPath, ARTIFACT_BYTES);
});

afterEach(async () => {
  await fsp.rm(artifactPath, { force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockMqttClient extends MqttClientLike {
  publish: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
}

interface MockFtpClient extends FtpClientLike {
  access: ReturnType<typeof vi.fn>;
  uploadFrom: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockShape {
  mqttFactory: ReturnType<typeof vi.fn>;
  mqttClient: MockMqttClient;
  ftpFactory: ReturnType<typeof vi.fn>;
  ftpClient: MockFtpClient;
  touchLastUsed: ReturnType<typeof vi.fn>;
  extractAmsConfig: ReturnType<typeof vi.fn>;
}

function makeMocks(opts?: {
  ams?: Partial<AmsConfig>;
  mqttConnectImmediately?: boolean;
  mqttPublishError?: Error;
  mqttErrorEvent?: Error; // emitted on the 'error' event listener
  mqttNeverConnect?: boolean;
  ftpAccessError?: Error;
}): MockShape {
  const ams: AmsConfig = {
    useAms: opts?.ams?.useAms ?? false,
    amsMapping: opts?.ams?.amsMapping ?? [],
    plateIndex: opts?.ams?.plateIndex ?? 1,
    subtaskName: opts?.ams?.subtaskName ?? 'fake-subtask',
  };

  const mqttClient: MockMqttClient = {
    publish: vi.fn(
      (
        _topic: string,
        _payload: string,
        _opts: object,
        cb: (err?: Error) => void,
      ) => {
        if (opts?.mqttPublishError) {
          cb(opts.mqttPublishError);
        } else {
          cb();
        }
      },
    ),
    end: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'error' && opts?.mqttErrorEvent) {
        queueMicrotask(() => listener(opts.mqttErrorEvent as Error));
      }
    }),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'connect') {
        if (opts?.mqttNeverConnect) return;
        if (opts?.mqttErrorEvent) return; // error short-circuits connect
        if (opts?.mqttConnectImmediately === false) return;
        queueMicrotask(() => listener());
      }
    }),
  };
  const mqttFactory = vi.fn(() => mqttClient);

  const ftpClient: MockFtpClient = {
    access: vi.fn(async () => {
      if (opts?.ftpAccessError) throw opts.ftpAccessError;
    }),
    uploadFrom: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const ftpFactory = vi.fn(() => ftpClient);

  const touchLastUsed = vi.fn();
  const extractAmsConfig = vi.fn(async () => ams);

  return { mqttFactory, mqttClient, ftpFactory, ftpClient, touchLastUsed, extractAmsConfig };
}

interface CtxOverrides {
  connectionConfig?: Record<string, unknown>;
  credential?: DecryptedCredential | null;
  storagePath?: string;
  kind?: string;
}

function makeCtx(overrides: CtxOverrides = {}): DispatchContext {
  return {
    job: { id: randomUUID(), ownerId: randomUUID(), targetId: randomUUID() },
    printer: {
      id: randomUUID(),
      ownerId: randomUUID(),
      kind: overrides.kind ?? 'bambu_x1c',
      connectionConfig: overrides.connectionConfig ?? {
        ip: '192.168.1.50',
      },
    },
    artifact: {
      storagePath: overrides.storagePath ?? artifactPath,
      sizeBytes: ARTIFACT_BYTES.length,
      sha256: 'deadbeef',
    },
    credential:
      overrides.credential === undefined ? makeValidCredential() : overrides.credential,
    http: { fetch: (() => Promise.reject(new Error('http not used'))) as typeof globalThis.fetch },
    logger: silentLogger,
  };
}

function makeValidCredential(): DecryptedCredential {
  return {
    id: randomUUID(),
    printerId: randomUUID(),
    kind: 'fdm_bambu_lan',
    payload: { accessCode: 'abcd1234', serial: '01P00A123456789' },
    label: null,
    lastUsedAt: null,
  };
}

function getPublishedPayload(client: MockMqttClient): {
  topic: string;
  payload: Record<string, unknown>;
} {
  expect(client.publish).toHaveBeenCalled();
  const call = client.publish.mock.calls[0];
  const topic = call[0] as string;
  const payloadStr = call[1] as string;
  return { topic, payload: JSON.parse(payloadStr) };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('createBambuLanHandler', () => {
  it('1. success — no AMS — publishes use_ams=false, ams_mapping=[], touchLastUsed called', async () => {
    const m = makeMocks({ ams: { useAms: false, amsMapping: [] } });
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });
    const ctx = makeCtx();

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('success');
    expect(m.ftpClient.access).toHaveBeenCalledOnce();
    expect(m.ftpClient.uploadFrom).toHaveBeenCalledOnce();
    expect(m.ftpClient.close).toHaveBeenCalled();
    const { payload, topic } = getPublishedPayload(m.mqttClient);
    expect(topic).toBe('device/01P00A123456789/request');
    expect((payload.print as Record<string, unknown>).use_ams).toBe(false);
    expect((payload.print as Record<string, unknown>).ams_mapping).toEqual([]);
    expect(m.mqttClient.end).toHaveBeenCalled();
    expect(m.touchLastUsed).toHaveBeenCalledWith({ printerId: ctx.printer.id });
  });

  it('2. success — 4-color AMS — publishes use_ams=true with mapping', async () => {
    const m = makeMocks({ ams: { useAms: true, amsMapping: [0, 1, 2, 3] } });
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(makeCtx());

    expect(out.kind).toBe('success');
    const { payload } = getPublishedPayload(m.mqttClient);
    expect((payload.print as Record<string, unknown>).use_ams).toBe(true);
    expect((payload.print as Record<string, unknown>).ams_mapping).toEqual([0, 1, 2, 3]);
  });

  it('3. forceAmsDisabled overrides slicer hint → use_ams=false, ams_mapping=[]', async () => {
    const m = makeMocks({ ams: { useAms: true, amsMapping: [0, 1] } });
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(
      makeCtx({ connectionConfig: { ip: '192.168.1.50', forceAmsDisabled: true } }),
    );

    expect(out.kind).toBe('success');
    const { payload } = getPublishedPayload(m.mqttClient);
    expect((payload.print as Record<string, unknown>).use_ams).toBe(false);
    expect((payload.print as Record<string, unknown>).ams_mapping).toEqual([]);
  });

  it('4. no credentials → no-credentials, factories not called', async () => {
    const m = makeMocks();
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(makeCtx({ credential: null }));

    expect(out).toEqual({ kind: 'failure', reason: 'no-credentials' });
    expect(m.mqttFactory).not.toHaveBeenCalled();
    expect(m.ftpFactory).not.toHaveBeenCalled();
    expect(m.touchLastUsed).not.toHaveBeenCalled();
  });

  it('5. wrong credential shape (accessCode too short) → auth-failed, factories not called', async () => {
    const m = makeMocks();
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });
    const cred: DecryptedCredential = {
      id: randomUUID(),
      printerId: randomUUID(),
      kind: 'fdm_bambu_lan',
      payload: { accessCode: 'abc', serial: '01P00A123' }, // too short
      label: null,
      lastUsedAt: null,
    };

    const out = await handler.dispatch(makeCtx({ credential: cred }));

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') expect(out.reason).toBe('auth-failed');
    expect(m.mqttFactory).not.toHaveBeenCalled();
    expect(m.ftpFactory).not.toHaveBeenCalled();
  });

  it('6. invalid connection-config (missing ip) → unknown, factories not called', async () => {
    const m = makeMocks();
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(makeCtx({ connectionConfig: {} }));

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('unknown');
      expect(out.details).toContain('invalid connection-config');
    }
    expect(m.mqttFactory).not.toHaveBeenCalled();
    expect(m.ftpFactory).not.toHaveBeenCalled();
  });

  it('7. wrong file extension (.stl) → rejected, factories not called', async () => {
    const m = makeMocks();
    const stlPath = path.join(tmpRoot, `${randomUUID()}.stl`);
    await fsp.writeFile(stlPath, ARTIFACT_BYTES);
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(makeCtx({ storagePath: stlPath }));

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('rejected');
      expect(out.details).toContain('.gcode.3mf');
    }
    expect(m.mqttFactory).not.toHaveBeenCalled();
    expect(m.ftpFactory).not.toHaveBeenCalled();
    await fsp.rm(stlPath, { force: true }).catch(() => {});
  });

  it('8. FTP auth fail (530) → auth-failed', async () => {
    const m = makeMocks({ ftpAccessError: new Error('530 Login incorrect') });
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(makeCtx());

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') expect(out.reason).toBe('auth-failed');
    expect(m.ftpClient.close).toHaveBeenCalled();
    expect(m.mqttFactory).not.toHaveBeenCalled();
  });

  it('9. FTP unreachable (ECONNREFUSED on cause) → unreachable', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 192.168.1.50:990'), {
      code: 'ECONNREFUSED',
    });
    const err = Object.assign(new Error('ftp connection failed'), { cause });
    const m = makeMocks({ ftpAccessError: err });
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(makeCtx());

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') expect(out.reason).toBe('unreachable');
    expect(m.mqttFactory).not.toHaveBeenCalled();
  });

  it('10. MQTT "Not authorized" → auth-failed with Developer Mode hint', async () => {
    const m = makeMocks({ mqttErrorEvent: new Error('Connection refused: Not authorized') });
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(makeCtx());

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('auth-failed');
      expect(out.details).toContain('Developer Mode');
    }
    expect(m.ftpClient.uploadFrom).toHaveBeenCalled(); // FTP succeeded
    expect(m.mqttClient.end).toHaveBeenCalled();
    expect(m.touchLastUsed).not.toHaveBeenCalled();
  });

  it('11. MQTT timeout (no connect event) → timeout', async () => {
    const m = makeMocks({ mqttNeverConnect: true });
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
      timeoutMs: 50, // tiny timeout for test speed
    });

    const out = await handler.dispatch(makeCtx());

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') expect(out.reason).toBe('timeout');
    expect(m.mqttClient.end).toHaveBeenCalled();
  });

  it('12. MQTT publish error → unknown', async () => {
    const m = makeMocks({ mqttPublishError: new Error('publish queue full') });
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(makeCtx());

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') expect(out.reason).toBe('unknown');
    expect(m.mqttClient.end).toHaveBeenCalled();
  });

  it('13. startPrint=false — FTP runs, MQTT factory not called, success + touchLastUsed', async () => {
    const m = makeMocks();
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(
      makeCtx({ connectionConfig: { ip: '192.168.1.50', startPrint: false } }),
    );

    expect(out.kind).toBe('success');
    expect(m.ftpClient.uploadFrom).toHaveBeenCalled();
    expect(m.mqttFactory).not.toHaveBeenCalled();
    expect(m.touchLastUsed).toHaveBeenCalled();
  });

  it('14. bedType passthrough — engineering_plate → published payload bed_type=engineering_plate', async () => {
    const m = makeMocks();
    const handler = createBambuLanHandler({
      mqttFactory: m.mqttFactory,
      ftpFactory: m.ftpFactory,
      touchLastUsed: m.touchLastUsed,
      extractAmsConfig: m.extractAmsConfig,
    });

    const out = await handler.dispatch(
      makeCtx({ connectionConfig: { ip: '192.168.1.50', bedType: 'engineering_plate' } }),
    );

    expect(out.kind).toBe('success');
    const { payload } = getPublishedPayload(m.mqttClient);
    expect((payload.print as Record<string, unknown>).bed_type).toBe('engineering_plate');
  });
});
