/**
 * Unit tests — ChituNetwork TCP M-code commander — V2-005d-c T_dc7
 *
 * Drives the persistent-TCP wire format described in
 * planning/odad/research/v2-005d-c-chitubox-network.md §3 phase 2 + §5.
 *
 * Mocks TcpSocketLike so no real network I/O happens. Each test fires
 * 'connect', 'data', 'error', or 'close' events at the right moments to drive
 * the state machine through M28 → chunked upload → M29 → (optional M6030).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  uploadAndPrintViaTcp,
  type TcpSocketLike,
  type UploadAndPrintResult,
} from '@/forge/dispatch/chitu-network/commander';

const PRINTER_IP = '192.168.1.99';

interface MockTcpSocket {
  socket: TcpSocketLike;
  /** All write() payloads, in order, captured as Buffers. */
  writes: Buffer[];
  fireConnect: () => void;
  fireData: (data: Buffer | string) => void;
  fireError: (err: Error) => void;
  fireClose: () => void;
  destroyed: () => boolean;
  endCalled: () => boolean;
  /** Return the connect() args (port, host) once invoked. */
  connectCall: () => { port: number; host: string } | null;
}

function createMockTcpSocket(opts?: {
  /**
   * If set, the mock auto-fires 'connect' at next microtask after connect()
   * is invoked. Most tests want this; tests that drive timing manually pass
   * `false`.
   */
  autoConnect?: boolean;
}): MockTcpSocket {
  const writes: Buffer[] = [];
  const dataListeners: Array<(data: Buffer) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const closeListeners: Array<() => void> = [];
  // 'connect' is registered via `once`; we collect all and fire each only once.
  const connectListenersOnce: Array<() => void> = [];
  let destroyed = false;
  let endCalled = false;
  let connectArgs: { port: number; host: string } | null = null;

  const autoConnect = opts?.autoConnect !== false;

  const socket: TcpSocketLike = {
    connect: vi.fn((port: number, host: string, cb?: () => void) => {
      connectArgs = { port, host };
      if (autoConnect) {
        queueMicrotask(() => {
          // Fire any registered 'connect' listeners, plus the connect callback
          // (mirrors node:net Socket behaviour where the cb is registered as a
          // one-shot 'connect' listener).
          for (const fn of connectListenersOnce.splice(0, connectListenersOnce.length)) {
            fn();
          }
          if (cb) cb();
        });
      } else {
        // Stash the callback so manual fireConnect() can run it.
        if (cb) connectListenersOnce.push(cb);
      }
    }),
    write: vi.fn((data: Buffer | string, cb?: (err?: Error) => void) => {
      writes.push(Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, 'utf8'));
      if (cb) cb(undefined);
    }),
    end: vi.fn(() => {
      endCalled = true;
    }),
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
        // wrap as one-shot
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
    writes,
    fireConnect: () => {
      for (const fn of connectListenersOnce.splice(0, connectListenersOnce.length)) {
        fn();
      }
    },
    fireData: (data: Buffer | string) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      for (const fn of dataListeners.slice()) fn(buf);
    },
    fireError: (err: Error) => {
      for (const fn of errorListeners.slice()) fn(err);
    },
    fireClose: () => {
      for (const fn of closeListeners.slice()) fn();
    },
    destroyed: () => destroyed,
    endCalled: () => endCalled,
    connectCall: () => connectArgs,
  };
}

/**
 * Wait for the next microtask + macrotask, so that the in-flight Promise
 * chain inside the commander reaches its next `await`. Used between firing
 * events to let the state machine advance.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

/**
 * Find the index of the chunk-frame write following an M28 line.
 * Useful for inspecting trailer bytes.
 */
function findChunkWrites(writes: Buffer[]): Buffer[] {
  return writes.filter((w) => {
    // ASCII control writes start with M2/M6/M9 or are short newline-terminated text.
    // Chunk frames are binary + 6-byte trailer; they end with 0x83.
    return w.length >= 6 && w[w.length - 1] === 0x83;
  });
}

describe('uploadAndPrintViaTcp', () => {
  // -----------------------------------------------------------------------
  it('1. happy path — single chunk → connect, M28, 1 chunk+trailer, M29, M6030', async () => {
    const m = createMockTcpSocket();
    const fileBuffer = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50]); // 5 bytes — fits in one chunk

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'cube.ctb',
      tcpSocketFactory: () => m.socket,
    });

    await flush(); // connect resolves
    await flush(); // M28 written, awaiting ack

    // Drive the rest: M28 ack, then chunk ack, then M29 ack, then M6030 ack.
    m.fireData('ok\r\n');
    await flush();
    m.fireData('ok\n');
    await flush();
    m.fireData('ok\n');
    await flush();
    m.fireData('ok\n');
    await flush();

    const result = await promise;
    expect(result).toEqual({ kind: 'success', bytesSent: 5 });

    // Verify connect target.
    expect(m.connectCall()).toEqual({ port: 3000, host: PRINTER_IP });

    // Verify write sequence: M28, chunk, M29, M6030.
    expect(m.writes[0]?.toString('utf8')).toBe('M28 cube.ctb\n');
    const chunkFrames = findChunkWrites(m.writes);
    expect(chunkFrames).toHaveLength(1);
    const frame = chunkFrames[0]!;
    // Payload (5 bytes) + 6-byte trailer = 11 bytes.
    expect(frame.length).toBe(11);
    expect(frame.subarray(0, 5).equals(fileBuffer)).toBe(true);
    // Trailer: file_pos=0 LE, XOR of 0x10^0x20^0x30^0x40^0x50, 0x83.
    expect(frame[5]).toBe(0x00);
    expect(frame[6]).toBe(0x00);
    expect(frame[7]).toBe(0x00);
    expect(frame[8]).toBe(0x00);
    expect(frame[9]).toBe(0x10 ^ 0x20 ^ 0x30 ^ 0x40 ^ 0x50);
    expect(frame[10]).toBe(0x83);

    // M29 + M6030 lines present.
    const writeStrings = m.writes.map((w) => w.toString('utf8'));
    expect(writeStrings).toContain('M29\n');
    expect(writeStrings).toContain('M6030 cube.ctb\n');

    expect(m.destroyed()).toBe(true);
  });

  // -----------------------------------------------------------------------
  it('2. happy path multi-chunk — N chunks with incrementing file_pos in trailer', async () => {
    const m = createMockTcpSocket();
    const chunkSize = 16;
    // 3 full chunks (48) + 7-byte tail = 55 bytes total (4 chunks).
    const fileBuffer = Buffer.alloc(55);
    for (let i = 0; i < fileBuffer.length; i++) fileBuffer[i] = (i * 7) & 0xff;

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'big.ctb',
      chunkSize,
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    await flush();
    m.fireData('ok\r\n'); // M28 ack
    await flush();

    // 4 chunk acks
    for (let i = 0; i < 4; i++) {
      m.fireData('ok\n');
      await flush();
    }
    m.fireData('ok\n'); // M29
    await flush();
    m.fireData('ok\n'); // M6030
    await flush();

    const result = await promise;
    expect(result).toEqual({ kind: 'success', bytesSent: 55 });

    const chunks = findChunkWrites(m.writes);
    expect(chunks).toHaveLength(4);

    const expectedOffsets = [0, 16, 32, 48];
    for (let i = 0; i < chunks.length; i++) {
      const frame = chunks[i]!;
      const expectedPayloadLen = i < 3 ? 16 : 7;
      expect(frame.length).toBe(expectedPayloadLen + 6);
      const trailer = frame.subarray(frame.length - 6);
      const filePos = trailer.readUInt32LE(0);
      expect(filePos).toBe(expectedOffsets[i]);
      expect(trailer[5]).toBe(0x83);

      // XOR check.
      const payload = frame.subarray(0, frame.length - 6);
      let xor = 0;
      for (const b of payload) xor ^= b;
      expect(trailer[4]).toBe(xor & 0xff);
    }
  });

  // -----------------------------------------------------------------------
  it('3. trailer XOR + position correctness — known input', async () => {
    const m = createMockTcpSocket();
    const fileBuffer = Buffer.from([0x01, 0x02, 0x04, 0x08]);

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'k.ctb',
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    await flush();
    m.fireData('ok\r\n'); // M28
    await flush();
    m.fireData('ok\n'); // chunk
    await flush();
    m.fireData('ok\n'); // M29
    await flush();
    m.fireData('ok\n'); // M6030
    await flush();
    await promise;

    const frame = findChunkWrites(m.writes)[0]!;
    expect(frame.subarray(0, 4).equals(fileBuffer)).toBe(true);
    // file_pos = 0 LE
    expect(frame[4]).toBe(0x00);
    expect(frame[5]).toBe(0x00);
    expect(frame[6]).toBe(0x00);
    expect(frame[7]).toBe(0x00);
    // XOR = 0x01 ^ 0x02 ^ 0x04 ^ 0x08 = 0x0F
    expect(frame[8]).toBe(0x0f);
    expect(frame[9]).toBe(0x83);
  });

  // -----------------------------------------------------------------------
  it('4. resend handling — printer asks for retry from a specific offset', async () => {
    const m = createMockTcpSocket();
    const chunkSize = 16;
    const fileBuffer = Buffer.alloc(48);
    for (let i = 0; i < fileBuffer.length; i++) fileBuffer[i] = i & 0xff;

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'r.ctb',
      chunkSize,
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    await flush();
    m.fireData('ok\r\n'); // M28
    await flush();

    // First chunk → resend 0 (printer says "go back to start").
    m.fireData('resend 0\n');
    await flush();
    // Then ack the retried chunks normally.
    m.fireData('ok\n'); // chunk 1 retry
    await flush();
    m.fireData('ok\n'); // chunk 2
    await flush();
    m.fireData('ok\n'); // chunk 3
    await flush();
    m.fireData('ok\n'); // M29
    await flush();
    m.fireData('ok\n'); // M6030
    await flush();

    const result = await promise;
    expect(result.kind).toBe('success');

    const chunks = findChunkWrites(m.writes);
    // We expect at least 4 chunk frames: original 1st (rejected), then retried 1st + 2nd + 3rd.
    expect(chunks.length).toBeGreaterThanOrEqual(4);

    // After resend, the next chunk frame should have file_pos=0 (we reset).
    const retried = chunks[1]!;
    const trailer = retried.subarray(retried.length - 6);
    expect(trailer.readUInt32LE(0)).toBe(0);
    expect(trailer[5]).toBe(0x83);
  });

  // -----------------------------------------------------------------------
  it('5. retry exhausted — printer keeps firing resend forever', async () => {
    const m = createMockTcpSocket();
    const fileBuffer = Buffer.alloc(8, 0xaa);

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'x.ctb',
      maxResendRetries: 2,
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    await flush();
    m.fireData('ok\r\n'); // M28
    await flush();

    // 3 resends (one more than maxResendRetries=2).
    m.fireData('resend 0\n');
    await flush();
    m.fireData('resend 0\n');
    await flush();
    m.fireData('resend 0\n');
    await flush();

    const result = (await promise) as Extract<UploadAndPrintResult, { kind: 'failure' }>;
    expect(result.kind).toBe('failure');
    expect(result.stage).toBe('upload');
    expect(result.reason).toBe('rejected');
  });

  // -----------------------------------------------------------------------
  it('6. M28 rejected — printer replies with non-ok line', async () => {
    const m = createMockTcpSocket();
    const fileBuffer = Buffer.from([0x00]);

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'rej.ctb',
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    await flush();
    m.fireData('error: disk full\n');
    await flush();

    const result = (await promise) as Extract<UploadAndPrintResult, { kind: 'failure' }>;
    expect(result.kind).toBe('failure');
    expect(result.stage).toBe('M28');
    expect(result.reason).toBe('rejected');
  });

  // -----------------------------------------------------------------------
  it('7. ECONNREFUSED on connect → unreachable', async () => {
    const m = createMockTcpSocket({ autoConnect: false });
    const fileBuffer = Buffer.from([0x00]);

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'noconn.ctb',
      tcpSocketFactory: () => m.socket,
    });

    // Let connect() get invoked, then fire error on the registered listener.
    await flush();
    const err = new Error('connect ECONNREFUSED 192.168.1.99:3000');
    (err as Error & { code?: string }).code = 'ECONNREFUSED';
    m.fireError(err);
    await flush();

    const result = (await promise) as Extract<UploadAndPrintResult, { kind: 'failure' }>;
    expect(result.kind).toBe('failure');
    expect(result.stage).toBe('connect');
    expect(result.reason).toBe('unreachable');
    expect(m.destroyed()).toBe(true);
  });

  // -----------------------------------------------------------------------
  it('8. M29 timeout — printer never replies after M29', async () => {
    const m = createMockTcpSocket();
    const fileBuffer = Buffer.from([0x42]);

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'm29-timeout.ctb',
      stageTimeoutMs: 50, // tiny real timeout so the test runs fast
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    await flush();
    m.fireData('ok\r\n'); // M28
    await flush();
    m.fireData('ok\n'); // chunk
    await flush();
    // No M29 ack — wait past the 50ms stage timeout.
    await new Promise((r) => setTimeout(r, 100));

    const result = (await promise) as Extract<UploadAndPrintResult, { kind: 'failure' }>;
    expect(result.kind).toBe('failure');
    expect(result.stage).toBe('M29');
    expect(result.reason).toBe('timeout');
  });

  // -----------------------------------------------------------------------
  it('9. startPrint=false — M6030 is never sent', async () => {
    const m = createMockTcpSocket();
    const fileBuffer = Buffer.from([0xab]);

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'noprint.ctb',
      startPrint: false,
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    await flush();
    m.fireData('ok\r\n'); // M28
    await flush();
    m.fireData('ok\n'); // chunk
    await flush();
    m.fireData('ok\n'); // M29
    await flush();

    const result = await promise;
    expect(result).toEqual({ kind: 'success', bytesSent: 1 });

    const writeStrings = m.writes.map((w) => w.toString('utf8'));
    expect(writeStrings.some((s) => s.startsWith('M6030'))).toBe(false);
  });

  // -----------------------------------------------------------------------
  it('10. invalid filename (contains "/") — fails immediately, no socket connect', async () => {
    const factory = vi.fn();
    const result = (await uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer: Buffer.from([0]),
      filename: 'subdir/cube.ctb',
      tcpSocketFactory: factory,
    })) as Extract<UploadAndPrintResult, { kind: 'failure' }>;

    expect(result.kind).toBe('failure');
    expect(result.stage).toBe('M28');
    expect(result.reason).toBe('rejected');
    expect(result.details).toContain('invalid filename');
    expect(factory).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  it('11. invalid filename (path traversal — starts with ".") — fails immediately', async () => {
    const factory = vi.fn();
    const result = (await uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer: Buffer.from([0]),
      filename: '../etc/passwd',
      tcpSocketFactory: factory,
    })) as Extract<UploadAndPrintResult, { kind: 'failure' }>;

    expect(result.kind).toBe('failure');
    expect(result.stage).toBe('M28');
    expect(result.reason).toBe('rejected');
    expect(factory).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  it('12. onProgress called per chunk with cumulative bytesSent', async () => {
    const m = createMockTcpSocket();
    const chunkSize = 8;
    const fileBuffer = Buffer.alloc(20); // 3 chunks: 8 + 8 + 4
    const events: Array<{ bytesSent: number; totalSize: number }> = [];

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'p.ctb',
      chunkSize,
      onProgress: (info) => {
        events.push(info);
      },
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    await flush();
    m.fireData('ok\r\n'); // M28
    await flush();
    m.fireData('ok\n'); // chunk 1
    await flush();
    m.fireData('ok\n'); // chunk 2
    await flush();
    m.fireData('ok\n'); // chunk 3
    await flush();
    m.fireData('ok\n'); // M29
    await flush();
    m.fireData('ok\n'); // M6030
    await flush();

    await promise;
    expect(events).toEqual([
      { bytesSent: 8, totalSize: 20 },
      { bytesSent: 16, totalSize: 20 },
      { bytesSent: 20, totalSize: 20 },
    ]);
  });

  // -----------------------------------------------------------------------
  it('13. socket.destroy() called even on failure', async () => {
    const m = createMockTcpSocket({ autoConnect: false });

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer: Buffer.from([0]),
      filename: 'f.ctb',
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    m.fireError(new Error('connect ECONNREFUSED 1.2.3.4:3000'));
    await flush();
    await promise;

    expect(m.destroyed()).toBe(true);
  });

  // -----------------------------------------------------------------------
  it('14. bytesSent preserved on mid-upload failure', async () => {
    const m = createMockTcpSocket();
    const chunkSize = 8;
    const fileBuffer = Buffer.alloc(24); // 3 chunks of 8

    const promise = uploadAndPrintViaTcp({
      printerIp: PRINTER_IP,
      fileBuffer,
      filename: 'mid.ctb',
      chunkSize,
      tcpSocketFactory: () => m.socket,
    });

    await flush();
    await flush();
    m.fireData('ok\r\n'); // M28
    await flush();
    m.fireData('ok\n'); // chunk 1 OK (8 bytes)
    await flush();
    // Chunk 2: printer replies with garbage — fails 'upload' stage.
    m.fireData('huh?\n');
    await flush();

    const result = (await promise) as Extract<UploadAndPrintResult, { kind: 'failure' }>;
    expect(result.kind).toBe('failure');
    expect(result.stage).toBe('upload');
    expect(result.bytesSent).toBe(8);
  });
});
