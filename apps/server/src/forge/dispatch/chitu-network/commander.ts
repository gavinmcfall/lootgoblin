/**
 * commander.ts — V2-005d-c T_dc7
 *
 * TCP M-code commander for ChituBox legacy network resin printers (Phrozen
 * Sonic Mighty/Mega/Mini 8K, Uniformation GKtwo/GKone, legacy-firmware
 * Elegoo Mars/Saturn). These devices speak an ASCII M-code protocol over a
 * persistent TCP connection on port 3000, with binary chunks sandwiched
 * between command lines.
 *
 * Wire format (see planning/odad/research/v2-005d-c-chitubox-network.md §3
 * phase 2 + §5; reference implementation is the reverse-engineered Python
 * receiver at github.com/MarcoAntonini/chitubox-file-receiver — we are the
 * SLICER side here, talking to the printer):
 *
 *   → M28 <filename>\n           # open file for writing
 *   ← ok\r\n                     # printer ready
 *
 *   # Per chunk (4 KiB default), NOT newline-terminated:
 *   → <payload bytes><trailer>   # trailer is exactly 6 bytes
 *   ← ok\n                       # success
 *   ← resend <pos>\n             # retry from absolute byte offset <pos>
 *
 *   → M29\n                      # close file
 *   ← ok\n
 *
 *   → M6030 <filename>\n         # start print  (only when startPrint=true)
 *   ← ok\n
 *
 * Trailer layout (6 bytes):
 *   bytes 0..3  uint32 LE — absolute byte offset of THIS chunk's start in the
 *                            original file
 *   byte  4     XOR-fold of all chunk payload bytes (single byte)
 *   byte  5     literal 0x83 marker
 *
 * Concurrency: ONE chunk in flight at a time. Wait for ack before sending next.
 *
 * Speed: WiFi caps at ~8 MB/s; a 100 MB upload takes ~12-13 s minimum.
 *
 * Logging policy: NEVER log payload contents, not even excerpts. The firmware
 * accepts proprietary encrypted .ctb slices and we do not want bytes leaking
 * through structured logs. Stage + bytesSent + reason only.
 */

import * as net from 'node:net';

import { logger } from '@/logger';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface TcpSocketLike {
  connect(port: number, host: string, callback?: () => void): void;
  write(data: Buffer | string, callback?: (err?: Error) => void): void;
  end(): void;
  destroy(): void;
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
}

export interface TcpSocketFactory {
  (): TcpSocketLike;
}

export const defaultTcpSocketFactory: TcpSocketFactory = () => {
  const sock = new net.Socket();
  // Adapt node:net Socket to our slightly stricter TcpSocketLike shape (the
  // built-in `write` callback uses `Error | null | undefined`; we normalise
  // null → undefined here).
  const adapter: TcpSocketLike = {
    connect: (port, host, cb) => {
      sock.connect(port, host, cb);
    },
    write: (data, cb) => {
      sock.write(data, (err) => {
        if (cb) cb(err ?? undefined);
      });
    },
    end: () => {
      sock.end();
    },
    destroy: () => {
      sock.destroy();
    },
    on: (event, listener) => {
      sock.on(event, listener);
    },
    once: (event, listener) => {
      sock.once(event, listener);
    },
  };
  return adapter;
};

export interface UploadAndPrintOptions {
  printerIp: string;
  /** Default 3000. */
  port?: number;
  fileBuffer: Buffer;
  /** e.g. 'cube.ctb' — must NOT include path separators. */
  filename: string;
  /** Default true — issue M6030 after M29. */
  startPrint?: boolean;
  /** Default 4096. */
  chunkSize?: number;
  /** Default 3. */
  maxResendRetries?: number;
  tcpSocketFactory?: TcpSocketFactory;
  /** Per-stage timeout (M28-ack, chunk-ack, M29-ack, M6030-ack). Default 30000 ms. */
  stageTimeoutMs?: number;
  /** Connect timeout. Default 10000 ms. */
  connectTimeoutMs?: number;
  /** Optional progress callback, invoked after each successful chunk ack. */
  onProgress?: (info: { bytesSent: number; totalSize: number }) => void;
}

export type UploadAndPrintFailureStage = 'connect' | 'M28' | 'upload' | 'M29' | 'M6030';

export type UploadAndPrintResult =
  | { kind: 'success'; bytesSent: number }
  | {
      kind: 'failure';
      reason: 'unreachable' | 'rejected' | 'timeout' | 'unknown';
      stage: UploadAndPrintFailureStage;
      details: string;
      bytesSent: number;
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 3000;
const DEFAULT_CHUNK_SIZE = 4096;
const DEFAULT_MAX_RESEND_RETRIES = 3;
const DEFAULT_STAGE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const TRAILER_MARKER = 0x83;
const TRAILER_LEN = 6;
const DETAILS_EXCERPT_MAX = 500;

const NETWORK_CODE_RE =
  /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN|EPIPE/i;

interface ErrLike {
  message?: string;
  code?: string;
  cause?: unknown;
}

function asErrLike(err: unknown): ErrLike {
  if (err instanceof Error) {
    const e = err as Error & { code?: string; cause?: unknown };
    return { message: e.message, code: e.code, cause: e.cause };
  }
  if (err && typeof err === 'object') return err as ErrLike;
  return { message: String(err) };
}

function isNetworkError(err: ErrLike): boolean {
  const msg = err.message ?? '';
  if (NETWORK_CODE_RE.test(msg)) return true;
  if (typeof err.code === 'string' && NETWORK_CODE_RE.test(err.code)) return true;
  const cause = err.cause;
  if (cause && typeof cause === 'object') {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string' && NETWORK_CODE_RE.test(causeCode)) return true;
    const causeMsg = (cause as { message?: unknown }).message;
    if (typeof causeMsg === 'string' && NETWORK_CODE_RE.test(causeMsg)) return true;
  }
  return false;
}

function excerpt(s: string): string {
  return s.length > DETAILS_EXCERPT_MAX ? s.slice(0, DETAILS_EXCERPT_MAX) : s;
}

function isInvalidFilename(name: string): boolean {
  if (name.length === 0) return true;
  if (name.startsWith('.')) return true;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return true;
  return false;
}

/** Build the 6-byte trailer for a chunk. */
function buildTrailer(filePos: number, payload: Buffer): Buffer {
  const trailer = Buffer.alloc(TRAILER_LEN);
  trailer.writeUInt32LE(filePos >>> 0, 0);
  let xor = 0;
  for (let i = 0; i < payload.length; i++) {
    xor ^= payload[i] ?? 0;
  }
  trailer[4] = xor & 0xff;
  trailer[5] = TRAILER_MARKER;
  return trailer;
}

// ---------------------------------------------------------------------------
// Internal: line-buffered ACK reader
//
// The state machine waits for one ACK line at a time. Bytes arrive via 'data'
// events and may be split arbitrarily; we buffer them and split on '\n'.
// Each settled stage installs a single waiter; new data drives the waiter.
// ---------------------------------------------------------------------------

type AckLine = string;

interface AckWaiter {
  resolve(line: AckLine): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// uploadAndPrintViaTcp
// ---------------------------------------------------------------------------

export async function uploadAndPrintViaTcp(
  opts: UploadAndPrintOptions,
): Promise<UploadAndPrintResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const maxResendRetries = opts.maxResendRetries ?? DEFAULT_MAX_RESEND_RETRIES;
  const stageTimeoutMs = opts.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const startPrint = opts.startPrint ?? true;
  const factory = opts.tcpSocketFactory ?? defaultTcpSocketFactory;
  const totalSize = opts.fileBuffer.length;

  // Filename safety — refuse before opening any socket.
  if (isInvalidFilename(opts.filename)) {
    return {
      kind: 'failure',
      reason: 'rejected',
      stage: 'M28',
      details: 'invalid filename',
      bytesSent: 0,
    };
  }

  const socket = factory();

  // Receive buffer + ack waiter.
  let recvBuf = Buffer.alloc(0);
  let waiter: AckWaiter | null = null;
  let closed = false;
  let lastErr: Error | null = null;
  let bytesSent = 0;

  const installWaiter = (timeoutMs: number): Promise<AckLine> =>
    new Promise<AckLine>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waiter && waiter.timer === timer) {
          waiter = null;
        }
        reject(new Error(`stage timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      waiter = {
        resolve: (line) => {
          clearTimeout(timer);
          waiter = null;
          resolve(line);
        },
        reject: (err) => {
          clearTimeout(timer);
          waiter = null;
          reject(err);
        },
        timer,
      };

      // Drain any line already in the buffer (in case ack arrived before waiter).
      drainOneLineToWaiter();

      // If socket already closed before ack delivered, fail immediately.
      if (closed && waiter) {
        const err = lastErr ?? new Error('socket closed before ack');
        waiter.reject(err);
      }
    });

  const drainOneLineToWaiter = () => {
    if (!waiter) return;
    const nl = recvBuf.indexOf(0x0a); // '\n'
    if (nl < 0) return;
    // Strip optional trailing '\r' before the '\n'
    let end = nl;
    if (end > 0 && recvBuf[end - 1] === 0x0d) end -= 1;
    const line = recvBuf.subarray(0, end).toString('utf8');
    recvBuf = recvBuf.subarray(nl + 1);
    waiter.resolve(line);
  };

  socket.on('data', (chunk: Buffer) => {
    recvBuf = recvBuf.length === 0 ? Buffer.from(chunk) : Buffer.concat([recvBuf, chunk]);
    drainOneLineToWaiter();
  });

  socket.on('error', (err: Error) => {
    lastErr = err;
    if (waiter) waiter.reject(err);
  });

  socket.on('close', () => {
    closed = true;
    if (waiter) {
      waiter.reject(lastErr ?? new Error('socket closed'));
    }
  });

  const writeBuf = (data: Buffer | string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      try {
        socket.write(data, (err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

  const connect = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`connect timeout after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      socket.once('error', onError);

      try {
        socket.connect(port, opts.printerIp, () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

  const fail = (
    stage: UploadAndPrintFailureStage,
    err: unknown,
  ): UploadAndPrintResult => {
    const e = asErrLike(err);
    const msg = e.message ?? '';
    let reason: 'unreachable' | 'rejected' | 'timeout' | 'unknown';
    if (/timeout/i.test(msg)) reason = 'timeout';
    else if (isNetworkError(e)) reason = 'unreachable';
    else reason = 'unknown';
    logger.warn(
      {
        printerIp: opts.printerIp,
        stage,
        reason,
        bytesSent,
      },
      'chitu-network commander: stage failed',
    );
    return { kind: 'failure', reason, stage, details: excerpt(msg), bytesSent };
  };

  const failRejected = (
    stage: UploadAndPrintFailureStage,
    details: string,
  ): UploadAndPrintResult => {
    logger.warn(
      { printerIp: opts.printerIp, stage, reason: 'rejected', bytesSent },
      'chitu-network commander: stage rejected',
    );
    return { kind: 'failure', reason: 'rejected', stage, details: excerpt(details), bytesSent };
  };

  try {
    // 1. Connect ----------------------------------------------------------
    try {
      await connect();
    } catch (err) {
      return fail('connect', err);
    }

    // 2. M28 --------------------------------------------------------------
    try {
      await writeBuf(`M28 ${opts.filename}\n`);
      const ackPromise = installWaiter(stageTimeoutMs);
      const line = await ackPromise;
      if (!line.toLowerCase().startsWith('ok')) {
        return failRejected('M28', `printer rejected M28: ${line}`);
      }
    } catch (err) {
      return fail('M28', err);
    }

    // 3. Upload chunks ----------------------------------------------------
    let offset = 0;
    let retryCount = 0;
    try {
      while (offset < totalSize) {
        const end = Math.min(offset + chunkSize, totalSize);
        const payload = opts.fileBuffer.subarray(offset, end);
        const trailer = buildTrailer(offset, payload);
        const frame = Buffer.concat([payload, trailer], payload.length + trailer.length);

        await writeBuf(frame);
        const line = (await installWaiter(stageTimeoutMs)).trim();

        if (line.toLowerCase().startsWith('ok')) {
          offset = end;
          bytesSent = offset;
          retryCount = 0;
          if (opts.onProgress) {
            try {
              opts.onProgress({ bytesSent, totalSize });
            } catch (e) {
              logger.warn(
                { err: (e as Error)?.message },
                'chitu-network commander: onProgress threw',
              );
            }
          }
          continue;
        }

        if (line.toLowerCase().startsWith('resend')) {
          retryCount += 1;
          if (retryCount > maxResendRetries) {
            return failRejected(
              'upload',
              `resend retry limit exceeded (${maxResendRetries}) after '${line}'`,
            );
          }
          const m = /resend\s+(\d+)/i.exec(line);
          if (!m) {
            return failRejected('upload', `malformed resend reply: '${line}'`);
          }
          const requested = parseInt(m[1] ?? '', 10);
          if (!Number.isFinite(requested) || requested < 0 || requested > totalSize) {
            return failRejected('upload', `resend out-of-range: ${requested}`);
          }
          offset = requested;
          bytesSent = offset;
          continue;
        }

        return failRejected('upload', `unexpected reply during upload: '${line}'`);
      }
    } catch (err) {
      return fail('upload', err);
    }

    // 4. M29 --------------------------------------------------------------
    try {
      await writeBuf('M29\n');
      const line = (await installWaiter(stageTimeoutMs)).trim();
      if (!line.toLowerCase().startsWith('ok')) {
        return failRejected('M29', `printer rejected M29: ${line}`);
      }
    } catch (err) {
      return fail('M29', err);
    }

    // 5. M6030 (optional) -------------------------------------------------
    if (startPrint) {
      try {
        await writeBuf(`M6030 ${opts.filename}\n`);
        const line = (await installWaiter(stageTimeoutMs)).trim();
        if (!line.toLowerCase().startsWith('ok')) {
          return failRejected('M6030', `printer rejected M6030: ${line}`);
        }
      } catch (err) {
        return fail('M6030', err);
      }
    }

    // Cleanly close write side. (destroy still happens in finally.)
    try {
      socket.end();
    } catch {
      // ignore
    }

    return { kind: 'success', bytesSent: totalSize };
  } finally {
    try {
      socket.destroy();
    } catch {
      // ignore destroy-time errors
    }
  }
}
