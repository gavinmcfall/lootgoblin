/**
 * sdcp.ts — V2-005f-T_dcf7
 *
 * SDCP 3.0 (Elegoo Saturn / Mars families) status subscriber. Connects to the
 * printer's WebSocket at `ws://<ip>:3030/websocket`, sends a Cmd 0 topic
 * subscribe, and emits unified `StatusEvent`s by parsing the `Status.PrintInfo`
 * block on `sdcp/status/<MainboardID>`.
 *
 * Protocol notes:
 *   - SDCP has NO authentication (verified across the spec + every community
 *     implementation). The `SdcpCredentialPayload` is `z.object({}).strict()`.
 *   - Subscribe is best-effort: many SDCP firmwares auto-publish status
 *     regardless of whether Cmd 0 was received, but we send it on every
 *     `ws.open` for parity with other clients.
 *   - Keepalive: SDCP printers drop the WebSocket after 60s of inactivity.
 *     We send a WebSocket-level ping every 30s while the transport is open.
 *     The `ping()` method on `WsClientLike` is optional; the `ws` runtime
 *     dependency exposes it natively.
 *   - measuredConsumption is always undefined: SDCP / resin printers do not
 *     track per-slot grams.
 *   - "Subscribed-and-ready" signal: the FIRST status message arriving on
 *     the printer's status topic. Only at that point do we call
 *     `helpers.onTransportOpen()`.
 *   - State mapping (`PrintInfo.Status`):
 *       0 — stop / idle  → no event
 *       1 — printing     → 'progress' (with progressPct from layer ratio)
 *       2 — complete     → 'completed'
 *       3 — fail         → 'failed'
 *
 * Reconnect / connectivity events are owned by `_reconnect-base.ts` — this
 * module only contributes the WebSocket transport, the keepalive ping timer,
 * and the SDCP-specific message routing.
 */

import { randomUUID } from 'node:crypto';

import { logger } from '@/logger';
import { SdcpConnectionConfig } from '@/forge/dispatch/sdcp/types';

import {
  createReconnectingSubscriber,
  type TransportHandle,
} from './_reconnect-base';
import {
  defaultWsFactory,
  type WsFactory,
} from './_ws-client';
import type {
  StatusSubscriber,
  StatusEvent,
  StatusEventKind,
} from '../types';

export type { WsClientLike, WsFactory } from './_ws-client';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface SdcpSubscriberOpts {
  /** SDCP printer kind (one of `SDCP_KINDS`). Drives `printerKind` on the resulting StatusSubscriber. */
  printerKind: string;
  /** Inject a fake WebSocket constructor for tests. */
  wsFactory?: WsFactory;
  /**
   * Reconnect backoff schedule in ms. Defaults to
   * `[5_000, 10_000, 30_000, 60_000, 300_000]`.
   */
  reconnectBackoffMs?: readonly number[];
  /** Override timer for tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Override timer-clear for tests. */
  clearTimeout?: (handle: unknown) => void;
  /** WebSocket-ping cadence in ms (default 30s — printer disconnects after 60s idle). */
  keepaliveIntervalMs?: number;
}

const DEFAULT_KEEPALIVE_MS = 30_000;

// ---------------------------------------------------------------------------
// SDCP status payload types
// ---------------------------------------------------------------------------

interface SdcpPrintInfo {
  Status?: number;
  CurrentLayer?: number;
  TotalLayer?: number;
  Filename?: string;
  TaskId?: string;
  RemainTime?: number;
}

interface SdcpStatusPayload {
  Topic?: string;
  Status?: {
    PrintInfo?: SdcpPrintInfo;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Map SDCP `PrintInfo.Status` enum to a unified `StatusEventKind`. Returns
 * null when the state should not surface a protocol event (idle).
 */
export function mapSdcpStatus(status: number | undefined): StatusEventKind | null {
  switch (status) {
    case 0:
      return null; // idle / stop
    case 1:
      return 'progress';
    case 2:
      return 'completed';
    case 3:
      return 'failed';
    default:
      return null;
  }
}

/**
 * Build a unified `StatusEvent` from a parsed SDCP status payload + a
 * resolved kind. SDCP does not surface per-slot grams — `measuredConsumption`
 * is always omitted.
 */
export function buildSdcpEvent(
  payload: SdcpStatusPayload,
  kind: StatusEventKind,
  occurredAt: Date,
): StatusEvent {
  const printInfo = payload.Status?.PrintInfo ?? {};
  const layerNum =
    typeof printInfo.CurrentLayer === 'number' && Number.isFinite(printInfo.CurrentLayer)
      ? printInfo.CurrentLayer
      : undefined;
  const totalLayers =
    typeof printInfo.TotalLayer === 'number' && Number.isFinite(printInfo.TotalLayer)
      ? printInfo.TotalLayer
      : undefined;
  const progressPct =
    typeof layerNum === 'number' && typeof totalLayers === 'number' && totalLayers > 0
      ? Math.round((layerNum / totalLayers) * 100)
      : undefined;
  const remainingMin =
    typeof printInfo.RemainTime === 'number' && Number.isFinite(printInfo.RemainTime)
      ? Math.round(printInfo.RemainTime / 60)
      : undefined;
  const remoteJobRef =
    typeof printInfo.Filename === 'string' && printInfo.Filename.length > 0
      ? printInfo.Filename
      : typeof printInfo.TaskId === 'string'
        ? printInfo.TaskId
        : '';

  const event: StatusEvent = {
    kind,
    remoteJobRef,
    rawPayload: payload,
    occurredAt,
  };
  if (progressPct !== undefined) event.progressPct = progressPct;
  if (layerNum !== undefined) event.layerNum = layerNum;
  if (totalLayers !== undefined) event.totalLayers = totalLayers;
  if (remainingMin !== undefined) event.remainingMin = remainingMin;
  return event;
}

function decodeSdcpMessage(data: unknown): SdcpStatusPayload | null {
  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else if (data instanceof ArrayBuffer) {
    text = Buffer.from(data).toString('utf8');
  } else if (Buffer.isBuffer(data)) {
    text = data.toString('utf8');
  } else if (Array.isArray(data)) {
    try {
      text = Buffer.concat(data as Buffer[]).toString('utf8');
    } catch {
      return null;
    }
  } else if (data && typeof (data as { toString?: () => string }).toString === 'function') {
    text = String(data);
  } else {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as SdcpStatusPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function buildSubscribeMessage(mainboardId: string): string {
  return JSON.stringify({
    Id: randomUUID(),
    Data: {
      Cmd: 0,
      Data: {},
      RequestID: randomUUID(),
      MainboardID: mainboardId,
      TimeStamp: Math.floor(Date.now() / 1000),
      From: 0,
    },
    Topic: `sdcp/status/${mainboardId}`,
  });
}

// ---------------------------------------------------------------------------
// createSdcpSubscriber
// ---------------------------------------------------------------------------

/**
 * Build an SDCP StatusSubscriber. Lifecycle / reconnect behaviour is
 * delegated to `_reconnect-base.ts`; this factory only provides the
 * WebSocket transport, the 30s keepalive ping, and the SDCP-specific
 * message routing.
 */
export function createSdcpSubscriber(opts: SdcpSubscriberOpts): StatusSubscriber {
  const wsFactory = opts.wsFactory ?? defaultWsFactory;
  const keepaliveMs = opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
  const setTimer = opts.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    opts.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return createReconnectingSubscriber({
    protocol: 'sdcp',
    printerKind: opts.printerKind,
    reconnectBackoffMs: opts.reconnectBackoffMs,
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
    openTransport: (printer, _credential, helpers): TransportHandle => {
      // ----- Validate connection-config -----
      const cfgParse = SdcpConnectionConfig.safeParse(printer.connectionConfig);
      if (!cfgParse.success) {
        logger.error(
          { printerId: printer.id, err: cfgParse.error.message },
          'sdcp-status: invalid connectionConfig',
        );
        throw new Error(`sdcp-status: invalid connectionConfig: ${cfgParse.error.message}`);
      }
      const cfg = cfgParse.data;
      const expectedTopic = `sdcp/status/${cfg.mainboardId}`;
      const url = `ws://${cfg.ip}:3030/websocket`;

      // ----- Open the WebSocket -----
      const ws = wsFactory(url);

      let socketOpened = false;
      let firstStatusSeen = false;
      let closedReported = false;
      let keepaliveHandle: unknown = null;

      const stopKeepalive = (): void => {
        if (keepaliveHandle !== null) {
          clearTimer(keepaliveHandle);
          keepaliveHandle = null;
        }
      };

      const armKeepalive = (): void => {
        keepaliveHandle = setTimer(() => {
          keepaliveHandle = null;
          try {
            if (typeof ws.ping === 'function') ws.ping();
          } catch (err) {
            logger.warn(
              { printerId: printer.id, err: (err as Error)?.message },
              'sdcp-status: ws ping failed',
            );
          }
          // Re-arm only if the transport is still active (closedReported flips
          // synchronously inside the close handler).
          if (!closedReported) armKeepalive();
        }, keepaliveMs);
      };

      const reportClose = (): void => {
        if (closedReported) return;
        closedReported = true;
        stopKeepalive();
        helpers.onTransportClose(socketOpened && firstStatusSeen);
      };

      function handleMessage(data: unknown): void {
        const msg = decodeSdcpMessage(data);
        if (msg === null) return;
        // Filter to our topic — printer can echo other traffic (e.g. attributes).
        if (msg.Topic !== expectedTopic) return;
        const status = msg.Status?.PrintInfo?.Status;
        if (typeof status !== 'number') return;

        // First valid status payload = subscribed-and-ready.
        if (!firstStatusSeen) {
          firstStatusSeen = true;
          helpers.onTransportOpen();
        }

        const kind = mapSdcpStatus(status);
        if (kind === null) return;
        helpers.emitProtocolEvent(buildSdcpEvent(msg, kind, new Date()));
      }

      ws.on('open', () => {
        socketOpened = true;
        try {
          ws.send(buildSubscribeMessage(cfg.mainboardId));
        } catch (err) {
          logger.warn(
            { printerId: printer.id, err: (err as Error)?.message },
            'sdcp-status: subscribe send failed',
          );
        }
        armKeepalive();
      });

      ws.on('message', (data: unknown) => {
        handleMessage(data);
      });

      ws.on('close', () => {
        logger.info({ printerId: printer.id }, 'sdcp-status: ws closed');
        reportClose();
      });

      ws.on('error', (err: Error) => {
        logger.warn(
          { printerId: printer.id, err: err?.message },
          'sdcp-status: ws error',
        );
        // Defer to the subsequent 'close' for reconnect bookkeeping.
      });

      return {
        close: () => {
          stopKeepalive();
          try {
            ws.close(1000, 'subscriber-stop');
          } catch {
            // ignore close-time errors
          }
        },
      };
    },
  });
}
