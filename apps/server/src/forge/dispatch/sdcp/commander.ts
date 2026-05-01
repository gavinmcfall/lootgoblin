/**
 * commander.ts — V2-005d-c T_dc4
 *
 * WebSocket commander for SDCP 3.0 resin printers (Elegoo Saturn/Mars 3+,
 * AnyCubic Photon Mono M5+ generation, plus any other firmware that speaks
 * the unified SDCP 3.0 protocol).
 *
 * Protocol summary (see planning/odad/research/v2-005d-c-sdcp.md §3 channels
 * 2 + 3d):
 *   ws://<printerIp>:3030/websocket
 *   JSON messages.
 *   Commands published on topic `sdcp/request/<MainboardID>`.
 *   No authentication.
 *   60s idle timeout (printer disconnects if nothing exchanged).
 *
 * Cmd 128 (start-print) shape:
 *   {
 *     Id, // random UUID per command
 *     Data: {
 *       Cmd: 128,
 *       Data: { Filename, StartLayer },
 *       RequestID, // random UUID per command
 *       MainboardID, // from discovery
 *       TimeStamp, // unix-seconds
 *       From: 0,
 *     },
 *     Topic: `sdcp/request/${MainboardID}`,
 *   }
 *
 * The MqttClientLike abstraction mirrors V2-005d-b's Bambu adapter so the
 * registry's existing patterns apply uniformly. Internally the default
 * factory wraps the `ws` package (already a runtime dep — added by Bambu's
 * mqtt.js for WebSocket transport) to expose the same shape. Since
 * WebSocket has no publish-ACK semantics, we treat the `send` callback as
 * the ACK.
 *
 * Failure mapping:
 *   - No `connect` event in timeoutMs            → 'timeout'
 *   - ECONNREFUSED|ENOTFOUND|EHOSTUNREACH on the
 *     error message or err.cause?.code           → 'unreachable'
 *   - Any other connect error                    → 'unknown'
 *   - Publish errors mapped the same way
 *   - 'auth-failed' is reserved for future SDCP firmware that adds auth.
 *
 * Logging policy: SDCP carries no credentials, so this is trivial — but we
 * still keep log lines minimal and avoid emitting full payloads.
 */

import { randomUUID } from 'node:crypto';

import { logger } from '@/logger';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface MqttClientLike {
  // Despite SDCP using WebSocket (not real MQTT), the abstraction shape mirrors
  // mqtt.js for symmetry with V2-005d-b Bambu adapter — this lets the
  // registry's existing patterns apply. Internally the SDCP adapter wraps
  // `ws` to expose this interface.
  publish(topic: string, payload: string, opts: object, cb: (err?: Error) => void): void;
  end(): void;
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
}

export interface MqttFactory {
  (url: string, opts: { rejectUnauthorized: boolean }): MqttClientLike;
}

export interface StartPrintOptions {
  printerIp: string;
  /** Default 3030. */
  port?: number;
  mainboardId: string;
  filename: string;
  /** Default 0. */
  startLayer?: number;
  /** Injected for tests. */
  mqttFactory?: MqttFactory;
  /** Connect + publish + ack timeout. Default 30000 ms. */
  timeoutMs?: number;
}

export type StartPrintResult =
  | { kind: 'success' }
  | {
      kind: 'failure';
      reason: 'unreachable' | 'auth-failed' | 'rejected' | 'timeout' | 'unknown';
      details: string;
    };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 3030;
const DEFAULT_START_LAYER = 0;
const DEFAULT_TIMEOUT_MS = 30_000;
const DETAILS_EXCERPT_MAX = 500;

const NETWORK_CODE_RE = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN/i;

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

function mapErrorReason(err: ErrLike): 'unreachable' | 'unknown' {
  if (isNetworkError(err)) return 'unreachable';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Default factory — lazy-loads `ws` and wraps it as MqttClientLike.
// ---------------------------------------------------------------------------

interface WsLike {
  on(event: 'open' | 'message' | 'error' | 'close', cb: (...args: any[]) => void): void;
  send(data: string, cb?: (err?: Error) => void): void;
  close(): void;
  terminate?(): void;
}

interface WsCtor {
  new (url: string, opts?: { rejectUnauthorized?: boolean }): WsLike;
}

export function defaultSdcpMqttFactory(): MqttFactory {
  return (url, opts) => {
    // Lazy require so test environments that stub the factory don't pull `ws`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wsMod = require('ws') as WsCtor | { default: WsCtor; WebSocket?: WsCtor };
    const Ctor: WsCtor =
      typeof wsMod === 'function'
        ? (wsMod as WsCtor)
        : ((wsMod as { default?: WsCtor; WebSocket?: WsCtor }).WebSocket ??
          (wsMod as { default: WsCtor }).default);
    const ws = new Ctor(url, { rejectUnauthorized: opts.rejectUnauthorized });

    type Listener = (...args: any[]) => void;
    const listeners: Record<string, Listener[]> = {
      connect: [],
      error: [],
      close: [],
      message: [],
    };

    const emit = (event: string, ...args: any[]) => {
      const arr = listeners[event];
      if (!arr) return;
      // copy in case a listener mutates the array (e.g. once())
      for (const fn of arr.slice()) {
        try {
          fn(...args);
        } catch (e) {
          logger.warn({ event, err: (e as Error)?.message }, 'sdcp-commander: listener threw');
        }
      }
    };

    ws.on('open', () => emit('connect'));
    ws.on('error', (err: Error) => emit('error', err));
    ws.on('close', () => emit('close'));
    ws.on('message', () => {
      // V2-005f handles status events; ignore for now.
    });

    const client: MqttClientLike = {
      publish(_topic: string, payload: string, _opts: object, cb: (err?: Error) => void) {
        try {
          ws.send(payload, (err?: Error) => {
            if (err) cb(err);
            else cb(undefined);
          });
        } catch (err) {
          cb(err instanceof Error ? err : new Error(String(err)));
        }
      },
      end() {
        try {
          ws.close();
        } catch {
          // ignore close-time errors
        }
      },
      on(event, listener) {
        (listeners[event] ??= []).push(listener);
      },
      once(event, listener) {
        const wrapped: Listener = (...args) => {
          const arr = listeners[event];
          if (arr) {
            const idx = arr.indexOf(wrapped);
            if (idx >= 0) arr.splice(idx, 1);
          }
          listener(...args);
        };
        (listeners[event] ??= []).push(wrapped);
      },
    };

    return client;
  };
}

// ---------------------------------------------------------------------------
// startSdcpPrint
// ---------------------------------------------------------------------------

export async function startSdcpPrint(opts: StartPrintOptions): Promise<StartPrintResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const startLayer = opts.startLayer ?? DEFAULT_START_LAYER;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mqttFactory = opts.mqttFactory ?? defaultSdcpMqttFactory();

  const url = `ws://${opts.printerIp}:${port}/websocket`;
  const client = mqttFactory(url, { rejectUnauthorized: false });

  try {
    const outcome = await new Promise<StartPrintResult>((resolve) => {
      let settled = false;
      const settle = (r: StartPrintResult) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(r);
      };

      const timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        logger.warn(
          { printerIp: opts.printerIp, mainboardId: opts.mainboardId, reason: 'timeout' },
          'sdcp-commander: connect timed out',
        );
        settle({
          kind: 'failure',
          reason: 'timeout',
          details: `no connect event within ${timeoutMs}ms`,
        });
      }, timeoutMs);

      client.on('error', (err: unknown) => {
        const e = asErrLike(err);
        const reason = mapErrorReason(e);
        const msg = e.message ?? '';
        logger.warn(
          { printerIp: opts.printerIp, mainboardId: opts.mainboardId, reason },
          'sdcp-commander: WebSocket error',
        );
        settle({ kind: 'failure', reason, details: excerpt(msg) });
      });

      client.once('connect', () => {
        const payload = JSON.stringify({
          Id: randomUUID(),
          Data: {
            Cmd: 128,
            Data: { Filename: opts.filename, StartLayer: startLayer },
            RequestID: randomUUID(),
            MainboardID: opts.mainboardId,
            TimeStamp: Math.floor(Date.now() / 1000),
            From: 0,
          },
          Topic: `sdcp/request/${opts.mainboardId}`,
        });
        const topic = `sdcp/request/${opts.mainboardId}`;
        client.publish(topic, payload, {}, (err?: Error) => {
          if (err) {
            const e = asErrLike(err);
            const reason = mapErrorReason(e);
            const msg = e.message ?? '';
            logger.warn(
              { printerIp: opts.printerIp, mainboardId: opts.mainboardId, reason },
              'sdcp-commander: publish failed',
            );
            settle({ kind: 'failure', reason, details: excerpt(msg) });
            return;
          }
          settle({ kind: 'success' });
        });
      });
    });

    return outcome;
  } finally {
    try {
      client.end();
    } catch {
      // ignore end-time errors
    }
  }
}
