/**
 * moonraker.ts — V2-005f-T_dcf4
 *
 * Moonraker (Klipper) status subscriber. Connects to Moonraker's JSON-RPC
 * WebSocket at `ws://<host>:<port>/websocket` (or `wss://` when scheme is
 * https), subscribes to printer object updates, and emits unified
 * `StatusEvent`s via the `onEvent` callback.
 *
 * Protocol:
 *   - Auth via `X-Api-Key` header on the upgrade request when the printer's
 *     `connectionConfig.requiresAuth` is true and a credential is present.
 *   - On open, sends `printer.objects.subscribe` JSON-RPC (id=1) for the
 *     core print/display/sdcard/webhooks objects.
 *   - Routes `notify_status_update` and `notify_history_changed`
 *     notifications into typed StatusEvents.
 *   - `notify_history_changed` (action='finished') is the authoritative
 *     terminal-state signal — `notify_status_update` may emit `complete`
 *     once and be missed during reconnect.
 *
 * Reconnect / connectivity events are owned by `_reconnect-base.ts` —
 * this module only contributes the WebSocket transport + JSON-RPC routing.
 * The base treats Moonraker as "connected" only after the subscribe-reply
 * arrives (not on raw ws.open), so the `reconnected` connectivity event
 * fires once Klipper has actually acknowledged the subscription.
 *
 * Klipper does NOT track per-slot grams (only filament length in mm), so
 * `measuredConsumption` is always left undefined for Moonraker events.
 *
 * The `WsClientLike` / `WsFactory` seam mirrors `forge/dispatch/sdcp/commander.ts`
 * — tests inject a mock factory; the default factory lazy-loads the `ws`
 * runtime dependency.
 */

import { logger } from '@/logger';
import {
  MoonrakerConnectionConfig,
  MoonrakerCredentialPayload,
} from '@/forge/dispatch/moonraker/types';

import {
  createReconnectingSubscriber,
  type TransportHandle,
} from './_reconnect-base';
import {
  defaultWsFactory,
  type WsClientLike,
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

export interface MoonrakerSubscriberOpts {
  /** Inject a fake WebSocket constructor for tests. */
  wsFactory?: WsFactory;
  /**
   * Reconnect backoff schedule in ms. Defaults to
   * [5_000, 10_000, 30_000, 60_000, 300_000].
   */
  reconnectBackoffMs?: readonly number[];
  /** Override timer for tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Override timer-clear for tests. */
  clearTimeout?: (handle: unknown) => void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const SUBSCRIBE_REQUEST_ID = 1;

interface MoonrakerStatusPayload {
  print_stats?: {
    state?: string;
    filename?: string;
    print_duration?: number;
    total_duration?: number;
    filament_used?: number;
    info?: unknown;
  };
  display_status?: {
    progress?: number;
    message?: string | null;
  };
  virtual_sdcard?: {
    progress?: number;
  };
  webhooks?: {
    state?: string;
  };
}

interface MoonrakerHistoryJob {
  job_id?: string;
  filename?: string;
  status?: string;
  filament_used?: number;
  total_duration?: number;
  print_duration?: number;
}

interface MoonrakerNotification {
  jsonrpc: '2.0';
  method?: string;
  id?: number;
  params?: unknown;
  result?: unknown;
}

function mapPrintStatsState(state: string | undefined): StatusEventKind | null {
  switch (state) {
    case 'standby':
      return null;
    case 'printing':
      return 'progress';
    case 'paused':
      return 'paused';
    case 'complete':
      return 'completed';
    case 'cancelled':
    case 'error':
      return 'failed';
    default:
      return null;
  }
}

function mapHistoryStatus(status: string | undefined): StatusEventKind | null {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
    case 'klippy_shutdown':
    case 'error':
    case 'server_exit':
      return 'failed';
    default:
      return null;
  }
}

function buildSubscribeMessage(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'printer.objects.subscribe',
    params: {
      objects: {
        print_stats: ['state', 'filename', 'print_duration', 'total_duration', 'filament_used', 'info'],
        display_status: ['progress', 'message'],
        virtual_sdcard: ['progress'],
        webhooks: ['state'],
      },
    },
    id: SUBSCRIBE_REQUEST_ID,
  });
}

function decodeMessage(data: unknown): MoonrakerNotification | null {
  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else if (data instanceof ArrayBuffer) {
    text = Buffer.from(data).toString('utf8');
  } else if (Buffer.isBuffer(data)) {
    text = data.toString('utf8');
  } else if (Array.isArray(data)) {
    // node ws can deliver fragmented Buffer arrays
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
    return JSON.parse(text) as MoonrakerNotification;
  } catch {
    return null;
  }
}

function buildEventFromStatus(
  kind: StatusEventKind,
  payload: MoonrakerStatusPayload,
  occurredAt: Date,
): StatusEvent {
  const printStats = payload.print_stats ?? {};
  const display = payload.display_status ?? {};
  const sd = payload.virtual_sdcard ?? {};
  const progressSrc = typeof display.progress === 'number' ? display.progress : sd.progress;
  return {
    kind,
    remoteJobRef: typeof printStats.filename === 'string' ? printStats.filename : '',
    progressPct:
      typeof progressSrc === 'number' && Number.isFinite(progressSrc)
        ? Math.round(progressSrc * 100)
        : undefined,
    remainingMin: undefined,
    rawPayload: payload,
    occurredAt,
  };
}

function buildEventFromHistory(
  kind: StatusEventKind,
  job: MoonrakerHistoryJob,
  rawPayload: unknown,
  occurredAt: Date,
): StatusEvent {
  return {
    kind,
    remoteJobRef: typeof job.filename === 'string' ? job.filename : '',
    progressPct: kind === 'completed' ? 100 : undefined,
    remainingMin: undefined,
    rawPayload,
    occurredAt,
  };
}

// ---------------------------------------------------------------------------
// createMoonrakerSubscriber
// ---------------------------------------------------------------------------

export function createMoonrakerSubscriber(
  opts: MoonrakerSubscriberOpts = {},
): StatusSubscriber {
  const wsFactory = opts.wsFactory ?? defaultWsFactory;

  return createReconnectingSubscriber({
    protocol: 'moonraker',
    printerKind: 'fdm_klipper',
    reconnectBackoffMs: opts.reconnectBackoffMs,
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
    openTransport: (printer, credential, helpers): TransportHandle => {
      // ----- Validate connection config / build URL + headers -----
      const cfgParse = MoonrakerConnectionConfig.safeParse(printer.connectionConfig);
      if (!cfgParse.success) {
        logger.error(
          { printerId: printer.id, err: cfgParse.error.message },
          'moonraker-status: invalid connectionConfig',
        );
        throw new Error(`moonraker-status: invalid connectionConfig: ${cfgParse.error.message}`);
      }
      const cfg = cfgParse.data;

      const headers: Record<string, string> = {};
      if (cfg.requiresAuth && credential !== null) {
        const credParse = MoonrakerCredentialPayload.safeParse(credential.payload);
        if (credParse.success) {
          headers['X-Api-Key'] = credParse.data.apiKey;
        } else {
          logger.warn(
            { printerId: printer.id },
            'moonraker-status: requiresAuth but credential payload invalid — connecting without header',
          );
        }
      }

      const wsScheme = cfg.scheme === 'https' ? 'wss' : 'ws';
      const url = `${wsScheme}://${cfg.host}:${cfg.port}/websocket`;

      // ----- Open the WebSocket -----
      // (ws factory throwing is treated as openTransport-throw by the base.)
      const ws = wsFactory(url, Object.keys(headers).length > 0 ? { headers } : undefined);

      // Track whether ws.open has fired, to inform onTransportClose's
      // `wasConnected` argument. Note: "connected" from the base's
      // perspective is gated on subscribe-reply, but for the purpose of
      // distinguishing "first-connect failure" from "session disconnect"
      // we use ws.open as the boundary — if the socket actually opened we
      // consider that a real session, even if klippy never sent the
      // subscribe-reply.
      let socketOpened = false;
      let closedReported = false;

      const reportClose = (): void => {
        if (closedReported) return;
        closedReported = true;
        helpers.onTransportClose(socketOpened);
      };

      // ----- Message router -----
      function handleStatusUpdate(params: unknown): void {
        if (!Array.isArray(params)) return;
        const payload = params[0] as MoonrakerStatusPayload | undefined;
        if (!payload || typeof payload !== 'object') return;
        const state = payload.print_stats?.state;
        const kind = mapPrintStatsState(state);
        if (kind === null) return;
        helpers.emitProtocolEvent(buildEventFromStatus(kind, payload, new Date()));
      }

      function handleHistoryChanged(params: unknown): void {
        if (!Array.isArray(params)) return;
        const entry = params[0] as { action?: string; job?: MoonrakerHistoryJob } | undefined;
        if (!entry || typeof entry !== 'object') return;
        if (entry.action !== 'finished') return;
        const job = entry.job ?? {};
        const kind = mapHistoryStatus(job.status);
        if (kind === null) return;
        helpers.emitProtocolEvent(buildEventFromHistory(kind, job, entry, new Date()));
      }

      function handleMessage(data: unknown): void {
        const msg = decodeMessage(data);
        if (msg === null) return;
        if (msg.method === 'notify_status_update') {
          handleStatusUpdate(msg.params);
          return;
        }
        if (msg.method === 'notify_history_changed') {
          handleHistoryChanged(msg.params);
          return;
        }
        if (msg.id === SUBSCRIBE_REQUEST_ID) {
          // Subscribe-reply received — Moonraker is fully ready.
          helpers.onTransportOpen();
          return;
        }
      }

      ws.on('open', () => {
        socketOpened = true;
        try {
          ws.send(buildSubscribeMessage());
        } catch (err) {
          logger.warn(
            { printerId: printer.id, err: (err as Error)?.message },
            'moonraker-status: subscribe send failed',
          );
        }
      });

      ws.on('message', (data: unknown) => {
        handleMessage(data);
      });

      ws.on('close', () => {
        logger.info(
          { printerId: printer.id },
          'moonraker-status: ws closed',
        );
        reportClose();
      });

      ws.on('error', (err: Error) => {
        logger.warn(
          { printerId: printer.id, err: err?.message },
          'moonraker-status: ws error',
        );
        // Defer to the subsequent 'close' for reconnect bookkeeping.
      });

      return {
        close: () => {
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
