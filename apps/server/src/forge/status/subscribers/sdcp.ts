// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * sdcp.ts — V2-005f-T_dcf7 + V2-005f-CF-5a-T_a5
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
 *   - State mapping (`PrintInfo.Status`) — V2-005f-CF-5a-T_a5 (11-value):
 *       0 — IDLE / stop     → no event
 *       1 — PRINTING        → 'progress' (with progressPct from layer ratio)
 *       2 — COMPLETE        → 'completed'
 *       3 — FAIL            → 'firmware_error' (CF-5a: was 'failed')
 *                             errorCode from ErrorStatusReason (SDCP_PRINT_CAUSE)
 *       8 — STOPPED         → 'cancelled' (operator stop, NEW CF-5a)
 *       9 — COMPLETE (alt)  → 'completed' (NEW CF-5a; SDCP has two complete codes)
 *       other               → no event (null)
 *   - Subscription / field-level filtering (FG-L4): SDCP WebSocket pushes FULL
 *     Status + PrintInfo objects on every status frame — there is no field-level
 *     subscription. All fields (including ErrorStatusReason) are present in
 *     every push; client-side routing via mapSdcpStatus is sufficient.
 *   - rawPayload convention: the full SdcpStatusPayload envelope (entire push
 *     frame) is used as rawPayload. SDCP is a single-stream protocol — the
 *     whole frame is the atomic unit. See buildSdcpEvent.
 *   - severity: not set for SDCP firmware_error events — SDCP has no tiered
 *     severity field analogous to Bambu's HMS level. Matches Moonraker T_a2
 *     and OctoPrint T_a3 patterns.
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
  /**
   * SDCP_PRINT_CAUSE enum — root-cause code for FAIL (Status=3) events.
   * 28+ values covering motor failures, bed adhesion, temp errors, resin-level
   * warnings, and file errors. May be a string enum value or a numeric code
   * depending on firmware version. Coerced to string in buildSdcpEvent.
   * V2-005f-CF-5a: added to surface native error taxonomy.
   */
  ErrorStatusReason?: string | number;
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
 *
 * V2-005f-CF-5a-T_a5: expanded from 4 → 6 cases to surface the 11-value
 * SDCP status enum natively:
 *   - Status=3 (FAIL)    → 'firmware_error' (was 'failed')
 *   - Status=8 (STOPPED) → 'cancelled' (operator stop, NEW)
 *   - Status=9 (COMPLETE alt) → 'completed' (NEW; SDCP has two complete codes)
 *
 * Unmapped intentionally (all → null = no event emitted): 4 (LIFTING),
 * 5 (PAUSING), 6 (PAUSED — pause state communicated via gcode-level events;
 * SDCP printers usually don't surface distinct paused-print events at this
 * layer), 7 (unknown reserved), 10 (FILE_CHECKING — pre-print validation,
 * no dispatch impact). See planning/odad/research/v2-005f-cf-5-protocol-failure-signals.md
 * for the full SDCP_STATUS enum.
 */
export function mapSdcpStatus(status: number | undefined): StatusEventKind | null {
  switch (status) {
    case 0:
      return null; // IDLE / stop
    case 1:
      return 'progress';
    case 2:
      return 'completed'; // COMPLETE
    case 3:
      return 'firmware_error'; // FAIL — CF-5a: was 'failed'
    case 8:
      return 'cancelled'; // STOPPED — CF-5a: operator stop
    case 9:
      return 'completed'; // COMPLETE (alt code) — CF-5a
    default:
      // 4=LIFTING, 5=PAUSING, 6=PAUSED, 7=reserved, 10=FILE_CHECKING — see
      // jsdoc above for rationale on each.
      return null;
  }
}

/**
 * Build a unified `StatusEvent` from a parsed SDCP status payload + a
 * resolved kind. SDCP does not surface per-slot grams — `measuredConsumption`
 * is always omitted.
 *
 * rawPayload convention: the full SdcpStatusPayload envelope (entire push
 * frame) is used as rawPayload. SDCP is a single-stream protocol; the whole
 * frame is the atomic unit of status information.
 *
 * V2-005f-CF-5a-T_a5: populate errorCode from PrintInfo.ErrorStatusReason
 * (SDCP_PRINT_CAUSE) on firmware_error events. String or numeric — coerced to
 * decimal string via String(). No hex formatting (SDCP codes are small integers,
 * not bitmask values like Bambu HMS). No errorMessage (SDCP has no separate
 * human-readable description field in the spec). No severity (SDCP has no tiered
 * severity field analogous to Bambu's HMS level).
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

  // V2-005f-CF-5a: populate errorCode from SDCP_PRINT_CAUSE on firmware_error.
  // String or numeric — coerce to decimal string. No hex formatting (SDCP codes
  // are small integers, not bitmask values). Only set on firmware_error to keep
  // the event shape clean for other kinds.
  //
  // Guards (review followups):
  //   - empty string → undefined (unhelpful dedup key)
  //   - NaN / non-finite numeric → undefined (firmware bug case)
  //   - SDCP_PRINT_CAUSE code 0 is NOT documented as a no-error sentinel
  //     (unlike Bambu's print_error). Pass through — let dedup record what
  //     firmware sends. So `ErrorStatusReason: 0` produces errorCode='0'.
  let errorCode: string | undefined;
  if (kind === 'firmware_error') {
    const reason = printInfo.ErrorStatusReason;
    if (typeof reason === 'string' && reason.length > 0) {
      errorCode = reason;
    } else if (typeof reason === 'number' && Number.isFinite(reason)) {
      errorCode = String(reason);
    }
  }

  const event: StatusEvent = {
    kind,
    remoteJobRef,
    // rawPayload is the full Status envelope — the entire push frame.
    rawPayload: payload,
    occurredAt,
  };
  if (progressPct !== undefined) event.progressPct = progressPct;
  if (layerNum !== undefined) event.layerNum = layerNum;
  if (totalLayers !== undefined) event.totalLayers = totalLayers;
  if (remainingMin !== undefined) event.remainingMin = remainingMin;
  if (errorCode !== undefined) event.errorCode = errorCode;
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
