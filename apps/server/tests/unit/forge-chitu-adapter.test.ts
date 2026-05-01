/**
 * Unit tests — ChituNetwork dispatcher adapter — V2-005d-c T_dc8
 *
 * Composes the T_dc7 commander (TCP M-code) via a stubbed TcpSocketLike so no
 * real network I/O happens, plus on-disk fixtures with crafted magic bytes
 * to drive the encrypted-CTB content gate.
 *
 * The encrypted-CTB v4 magic is `0x12 0xfd 0x90 0xc1` (UVtools reverse-eng
 * reference); plain CTB v4 is `0x12 0xfd 0x90 0xc0`; plain CTB v3 is
 * `0x07 0x00 0x00 0x00`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import pino from 'pino';

import { createChituNetworkHandler } from '@/forge/dispatch/chitu-network/adapter';
import type { TcpSocketLike, TcpSocketFactory } from '@/forge/dispatch/chitu-network/commander';
import type { DispatchContext } from '@/forge/dispatch/handler';

const silentLogger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Fixture builders — magic-byte prefixes
// ---------------------------------------------------------------------------

const ENCRYPTED_CTB_V4_MAGIC = Buffer.from([0x12, 0xfd, 0x90, 0xc1]);
const PLAIN_CTB_V4_MAGIC = Buffer.from([0x12, 0xfd, 0x90, 0xc0]);
const PLAIN_CTB_V3_MAGIC = Buffer.from([0x07, 0x00, 0x00, 0x00]);

function buildFixture(magic: Buffer, payloadBytes = 1024): Buffer {
  return Buffer.concat([magic, randomBytes(payloadBytes)]);
}

// ---------------------------------------------------------------------------
// Mock TCP socket — the same shape used by forge-chitu-commander.test.ts
// ---------------------------------------------------------------------------

interface MockTcpSocket {
  socket: TcpSocketLike;
  fireConnect: () => void;
  fireData: (data: Buffer | string) => void;
  fireError: (err: Error) => void;
  destroyed: () => boolean;
}

/**
 * Builds a mock TCP socket whose responses are driven by a per-write rule
 * function. The rule receives the bytes the commander wrote (UTF-8 decoded
 * for command lines, Buffer for chunk frames) and returns the printer reply
 * to fire on the data listener (queued as a microtask after the write so the
 * commander has a chance to install its ack waiter first).
 *
 * Set the rule to `null` for a particular write to suppress the auto-reply
 * (used by the unreachable / connect-timeout tests where the printer never
 * responds and we drive errors manually via fireError).
 */
function createMockTcpSocket(opts?: {
  autoConnect?: boolean;
  /** Reply rule. Return undefined to send no reply for this write. */
  reply?: (write: Buffer | string) => Buffer | string | undefined;
}): MockTcpSocket {
  const dataListeners: Array<(data: Buffer) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const closeListeners: Array<() => void> = [];
  const connectListenersOnce: Array<() => void> = [];
  let destroyed = false;
  const autoConnect = opts?.autoConnect !== false;
  const reply = opts?.reply;

  const fireDataInternal = (data: Buffer | string) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    for (const fn of dataListeners.slice()) fn(buf);
  };

  const socket: TcpSocketLike = {
    connect: vi.fn((_port: number, _host: string, cb?: () => void) => {
      if (autoConnect) {
        queueMicrotask(() => {
          for (const fn of connectListenersOnce.splice(0, connectListenersOnce.length)) {
            fn();
          }
          if (cb) cb();
        });
      } else {
        if (cb) connectListenersOnce.push(cb);
      }
    }),
    write: vi.fn((data: Buffer | string, cb?: (err?: Error) => void) => {
      if (cb) cb(undefined);
      if (reply) {
        const r = reply(data);
        if (r !== undefined) {
          // Defer to a setImmediate so the commander's `await writeBuf` has
          // settled and `installWaiter` has run before the printer reply
          // arrives.
          setImmediate(() => fireDataInternal(r));
        }
      }
    }),
    end: vi.fn(() => {}),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      if (event === 'data') dataListeners.push(listener as (d: Buffer) => void);
      else if (event === 'error') errorListeners.push(listener as (e: Error) => void);
      else if (event === 'close') closeListeners.push(listener as () => void);
    }),
    once: vi.fn((event: string, listener: (...args: any[]) => void) => {
      if (event === 'error') {
        const wrapped = (err: Error) => {
          const idx = errorListeners.indexOf(wrapped as (e: Error) => void);
          if (idx >= 0) errorListeners.splice(idx, 1);
          (listener as (e: Error) => void)(err);
        };
        errorListeners.push(wrapped as (e: Error) => void);
      } else if (event === 'connect') {
        connectListenersOnce.push(listener as () => void);
      }
    }),
  };

  return {
    socket,
    fireConnect: () => {
      for (const fn of connectListenersOnce.splice(0, connectListenersOnce.length)) {
        fn();
      }
    },
    fireData: fireDataInternal,
    fireError: (err: Error) => {
      for (const fn of errorListeners.slice()) fn(err);
    },
    destroyed: () => destroyed,
  };
}

/** Default reply rule: ok to every write. */
const ALWAYS_OK_REPLY = (data: Buffer | string): string => {
  void data;
  return 'ok\n';
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tmpdir + context
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-chitu-adapter-'));
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

async function writeFixture(ext: string, content: Buffer): Promise<string> {
  const p = path.join(tmpRoot, `${randomUUID()}${ext}`);
  await fsp.writeFile(p, content);
  return p;
}

interface CtxOverrides {
  connectionConfig?: Record<string, unknown>;
  storagePath?: string;
  kind?: string;
  sizeBytes?: number;
}

function makeCtx(overrides: CtxOverrides): DispatchContext {
  return {
    job: { id: randomUUID(), ownerId: randomUUID(), targetId: randomUUID() },
    printer: {
      id: randomUUID(),
      ownerId: randomUUID(),
      kind: overrides.kind ?? 'chitu_network_phrozen_sonic_mighty_8k',
      connectionConfig: overrides.connectionConfig ?? {
        ip: '192.168.1.99',
      },
    },
    artifact: {
      storagePath: overrides.storagePath ?? '/dev/null',
      sizeBytes: overrides.sizeBytes ?? 1024,
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

describe('createChituNetworkHandler', () => {
  // -----------------------------------------------------------------------
  it('1. encrypted-required + encrypted CTB → success; touchLastUsed called', async () => {
    const fixturePath = await writeFixture('.ctb', buildFixture(ENCRYPTED_CTB_V4_MAGIC));
    const m = createMockTcpSocket({ reply: ALWAYS_OK_REPLY });
    const factory: TcpSocketFactory = () => m.socket;
    const touchLastUsed = vi.fn();
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory, touchLastUsed });

    const ctx = makeCtx({
      kind: 'chitu_network_phrozen_sonic_mighty_8k',
      storagePath: fixturePath,
    });

    const out = await handler.dispatch(ctx);

    expect(out.kind).toBe('success');
    if (out.kind === 'success') {
      expect(out.remoteFilename).toBe(`/local/${path.basename(fixturePath)}`);
    }
    expect(touchLastUsed).toHaveBeenCalledOnce();
    expect(touchLastUsed).toHaveBeenCalledWith({ printerId: ctx.printer.id });
  });

  // -----------------------------------------------------------------------
  it('2. encrypted-required + plain CTB v4 → rejected (mentions encrypted CTB); TCP NOT called', async () => {
    const fixturePath = await writeFixture('.ctb', buildFixture(PLAIN_CTB_V4_MAGIC));
    const factory: TcpSocketFactory = vi.fn();
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_phrozen_sonic_mighty_8k',
        storagePath: fixturePath,
      }),
    );

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('rejected');
      expect(out.details).toContain('encrypted CTB');
    }
    expect(factory).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  it('3. encrypted-required + plain CTB v3 → rejected; TCP NOT called', async () => {
    const fixturePath = await writeFixture('.ctb', buildFixture(PLAIN_CTB_V3_MAGIC));
    const factory: TcpSocketFactory = vi.fn();
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_phrozen_sonic_mega_8k',
        storagePath: fixturePath,
      }),
    );

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('rejected');
      expect(out.details).toContain('encrypted CTB');
    }
    expect(factory).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  it('4. encrypted NOT required + plain CTB v3 → success (legacy Elegoo)', async () => {
    const fixturePath = await writeFixture('.ctb', buildFixture(PLAIN_CTB_V3_MAGIC));
    const m = createMockTcpSocket({ reply: ALWAYS_OK_REPLY });
    const factory: TcpSocketFactory = () => m.socket;
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_elegoo_mars_legacy',
        storagePath: fixturePath,
      }),
    );

    expect(out.kind).toBe('success');
  });

  // -----------------------------------------------------------------------
  it('5. .jxs on Uniformation GKtwo → success (treated as encrypted by extension)', async () => {
    // .jxs is the Uniformation rename of encrypted CTB; we still write the
    // encrypted-magic prefix to be future-proof, but the gate skips the
    // encryption check on non-.ctb extensions.
    const fixturePath = await writeFixture('.jxs', buildFixture(ENCRYPTED_CTB_V4_MAGIC));
    const m = createMockTcpSocket({ reply: ALWAYS_OK_REPLY });
    const factory: TcpSocketFactory = () => m.socket;
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_uniformation_gktwo',
        storagePath: fixturePath,
      }),
    );

    expect(out.kind).toBe('success');
  });

  // -----------------------------------------------------------------------
  it('6. .cbddlp on legacy Elegoo → success', async () => {
    // .cbddlp is legacy; the encryption gate is bypassed because the kind
    // has encryptedCtbRequired=false. Content here is irrelevant.
    const fixturePath = await writeFixture('.cbddlp', Buffer.from('legacy stub'));
    const m = createMockTcpSocket({ reply: ALWAYS_OK_REPLY });
    const factory: TcpSocketFactory = () => m.socket;
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_elegoo_saturn_legacy',
        storagePath: fixturePath,
      }),
    );

    expect(out.kind).toBe('success');
  });

  // -----------------------------------------------------------------------
  it('7. wrong file extension (.stl) — rejected with hint about CTB', async () => {
    const fixturePath = await writeFixture('.stl', Buffer.from('mesh'));
    const factory: TcpSocketFactory = vi.fn();
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_phrozen_sonic_mighty_8k',
        storagePath: fixturePath,
      }),
    );

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('rejected');
      expect(out.details).toContain('.ctb');
    }
    expect(factory).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  it('8. wrong kind (fdm_klipper) — defensive unsupported-protocol', async () => {
    const factory: TcpSocketFactory = vi.fn();
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(makeCtx({ kind: 'fdm_klipper' }));

    expect(out).toEqual({ kind: 'failure', reason: 'unsupported-protocol' });
    expect(factory).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  it('9. invalid connection-config (missing ip) — reason=unknown', async () => {
    const fixturePath = await writeFixture('.ctb', buildFixture(ENCRYPTED_CTB_V4_MAGIC));
    const factory: TcpSocketFactory = vi.fn();
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_phrozen_sonic_mighty_8k',
        storagePath: fixturePath,
        connectionConfig: {},
      }),
    );

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('unknown');
      expect(out.details).toContain('invalid connection-config');
    }
    expect(factory).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  it('10. fs read error (file does not exist) — reason=unknown', async () => {
    const factory: TcpSocketFactory = vi.fn();
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_phrozen_sonic_mighty_8k',
        storagePath: path.join(tmpRoot, `${randomUUID()}-missing.ctb`),
      }),
    );

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('unknown');
      expect(out.details).toContain('failed to read artifact');
    }
    expect(factory).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  it('11. TCP unreachable → reason=unreachable, details prefixed with stage', async () => {
    const fixturePath = await writeFixture('.ctb', buildFixture(ENCRYPTED_CTB_V4_MAGIC));
    const m = createMockTcpSocket({ autoConnect: false });
    const factory: TcpSocketFactory = () => m.socket;
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const promise = handler.dispatch(
      makeCtx({
        kind: 'chitu_network_phrozen_sonic_mighty_8k',
        storagePath: fixturePath,
      }),
    );

    // Allow file read + connect() invocation to register listeners.
    for (let i = 0; i < 6; i++) await flush();
    const err = new Error('connect ECONNREFUSED 192.168.1.99:3000');
    (err as Error & { code?: string }).code = 'ECONNREFUSED';
    m.fireError(err);

    const out = await promise;

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('unreachable');
      expect(out.details).toMatch(/^connect: /);
    }
  });

  // -----------------------------------------------------------------------
  it('12. TCP M28 rejection → reason=rejected, details prefixed with M28', async () => {
    const fixturePath = await writeFixture('.ctb', buildFixture(ENCRYPTED_CTB_V4_MAGIC));
    // Reply with a non-ok line on the M28 command write, suppress further
    // replies (the commander aborts after M28 fails so no more writes).
    const m = createMockTcpSocket({
      reply: (data) => {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
        if (text.startsWith('M28 ')) return 'error: disk full\n';
        return undefined;
      },
    });
    const factory: TcpSocketFactory = () => m.socket;
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_phrozen_sonic_mighty_8k',
        storagePath: fixturePath,
      }),
    );

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('rejected');
      expect(out.details).toMatch(/^M28: /);
    }
  });

  // -----------------------------------------------------------------------
  it('13. TCP retry exhausted → reason=rejected, details prefixed with upload', async () => {
    const fixturePath = await writeFixture('.ctb', buildFixture(ENCRYPTED_CTB_V4_MAGIC, 64));
    // M28 → ok; every subsequent write is a chunk frame, reply with `resend 0`.
    // The commander caps at maxResendRetries=3, so the 4th resend triggers
    // a `rejected` failure at stage='upload'.
    const m = createMockTcpSocket({
      reply: (data) => {
        const text = Buffer.isBuffer(data) ? data.toString('utf8', 0, Math.min(8, data.length)) : data;
        if (typeof text === 'string' && text.startsWith('M28 ')) return 'ok\n';
        return 'resend 0\n';
      },
    });
    const factory: TcpSocketFactory = () => m.socket;
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_phrozen_sonic_mighty_8k',
        storagePath: fixturePath,
        connectionConfig: { ip: '192.168.1.99', stageTimeoutMs: 200 },
      }),
    );

    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('rejected');
      expect(out.details).toMatch(/^upload: /);
    }
  });

  // -----------------------------------------------------------------------
  it('14. startPrint=false flows through to commander; success returned, M6030 not sent', async () => {
    const fixturePath = await writeFixture('.ctb', buildFixture(ENCRYPTED_CTB_V4_MAGIC));
    const m = createMockTcpSocket({ reply: ALWAYS_OK_REPLY });
    const factory: TcpSocketFactory = () => m.socket;
    const handler = createChituNetworkHandler({ tcpSocketFactory: factory });

    const out = await handler.dispatch(
      makeCtx({
        kind: 'chitu_network_phrozen_sonic_mighty_8k',
        storagePath: fixturePath,
        connectionConfig: { ip: '192.168.1.99', startPrint: false },
      }),
    );

    expect(out.kind).toBe('success');
    if (out.kind === 'success') {
      expect(out.remoteFilename).toBe(`/local/${path.basename(fixturePath)}`);
    }
    // Confirm the commander never wrote an M6030 line at the wire level.
    const writeCalls = (m.socket.write as ReturnType<typeof vi.fn>).mock.calls;
    const writeStrings = writeCalls.map((args: unknown[]) => {
      const data = args[0] as Buffer | string;
      return Buffer.isBuffer(data) ? data.toString('utf8') : data;
    });
    expect(writeStrings.some((s) => s.startsWith('M6030'))).toBe(false);
  });
});
