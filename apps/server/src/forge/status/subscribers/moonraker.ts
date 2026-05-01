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
 * Reconnect: exponential backoff schedule defaults to
 * [5s, 10s, 30s, 60s, 5min] (capped at the last entry on subsequent
 * failures). On the first connection failure of a disconnect cycle the
 * subscriber emits `'unreachable'`; on the first successful reconnect after
 * a prior disconnect it emits `'reconnected'`.
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

import type {
  StatusSubscriber,
  StatusEvent,
  StatusEventKind,
  PrinterRecord,
  DecryptedCredential,
} from '../types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket-client surface used by the subscriber. Mirrors the
 * relevant subset of the `ws` package and lets tests inject a fake.
 */
export interface WsClientLike {
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'close', listener: (code?: number, reason?: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  send(data: string, callback?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface WsFactory {
  (url: string, options?: { headers?: Record<string, string> }): WsClientLike;
}

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

const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 10_000, 30_000, 60_000, 300_000];
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

// Default factory — lazy-loads `ws` so tests don't have to.
function defaultWsFactory(
  url: string,
  options?: { headers?: Record<string, string> },
): WsClientLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wsMod = require('ws') as
    | (new (url: string, opts?: { headers?: Record<string, string> }) => WsClientLike)
    | {
        default?: new (url: string, opts?: { headers?: Record<string, string> }) => WsClientLike;
        WebSocket?: new (
          url: string,
          opts?: { headers?: Record<string, string> },
        ) => WsClientLike;
      };
  const Ctor =
    typeof wsMod === 'function'
      ? wsMod
      : ((wsMod as { WebSocket?: typeof wsMod }).WebSocket ??
        (wsMod as { default?: typeof wsMod }).default);
  if (typeof Ctor !== 'function') {
    throw new Error('moonraker subscriber: unable to resolve ws constructor');
  }
  return new (Ctor as new (
    url: string,
    opts?: { headers?: Record<string, string> },
  ) => WsClientLike)(url, { headers: options?.headers });
}

// ---------------------------------------------------------------------------
// createMoonrakerSubscriber
// ---------------------------------------------------------------------------

export function createMoonrakerSubscriber(
  opts: MoonrakerSubscriberOpts = {},
): StatusSubscriber {
  const wsFactory = opts.wsFactory ?? defaultWsFactory;
  const backoffSchedule =
    opts.reconnectBackoffMs && opts.reconnectBackoffMs.length > 0
      ? opts.reconnectBackoffMs
      : DEFAULT_BACKOFF_MS;
  const setTimer = opts.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    opts.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let ws: WsClientLike | null = null;
  let connected = false;
  let stopped = false;
  let attempt = 0;
  let reconnectHandle: unknown = null;
  let onEventCb: ((e: StatusEvent) => void) | null = null;
  let printer: PrinterRecord | null = null;
  let credential: DecryptedCredential | null = null;
  let unreachableEmitted = false;
  /** True once a disconnect happens — drives the `reconnected` event on the next open. */
  let needsReconnectedEvent = false;

  function emit(event: StatusEvent): void {
    if (onEventCb !== null) onEventCb(event);
  }

  function emitConnectivity(kind: 'reconnected' | 'unreachable'): void {
    emit({
      kind,
      remoteJobRef: '',
      rawPayload: null,
      occurredAt: new Date(),
    });
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectHandle !== null) return;
    const idx = Math.min(attempt, backoffSchedule.length - 1);
    const delay = backoffSchedule[idx] ?? backoffSchedule[backoffSchedule.length - 1] ?? 5_000;
    attempt += 1;
    reconnectHandle = setTimer(() => {
      reconnectHandle = null;
      if (stopped) return;
      void connect();
    }, delay);
  }

  function handleSubscribeReply(_payload: unknown): void {
    // The reply to id=1 includes the current state. We don't emit a synthetic
    // 'started' here — the next `notify_status_update` (or history change) will
    // cover any active job. If we'd just reconnected, surface that fact.
    if (needsReconnectedEvent) {
      emitConnectivity('reconnected');
      needsReconnectedEvent = false;
    }
  }

  function handleStatusUpdate(params: unknown): void {
    if (!Array.isArray(params)) return;
    const payload = params[0] as MoonrakerStatusPayload | undefined;
    if (!payload || typeof payload !== 'object') return;
    const state = payload.print_stats?.state;
    const kind = mapPrintStatsState(state);
    if (kind === null) return;
    emit(buildEventFromStatus(kind, payload, new Date()));
  }

  function handleHistoryChanged(params: unknown): void {
    if (!Array.isArray(params)) return;
    const entry = params[0] as { action?: string; job?: MoonrakerHistoryJob } | undefined;
    if (!entry || typeof entry !== 'object') return;
    if (entry.action !== 'finished') return;
    const job = entry.job ?? {};
    const kind = mapHistoryStatus(job.status);
    if (kind === null) return;
    emit(buildEventFromHistory(kind, job, entry, new Date()));
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
      handleSubscribeReply(msg.result);
      return;
    }
  }

  async function connect(): Promise<void> {
    if (printer === null) return;

    const cfgParse = MoonrakerConnectionConfig.safeParse(printer.connectionConfig);
    if (!cfgParse.success) {
      logger.error(
        { printerId: printer.id, err: cfgParse.error.message },
        'moonraker-status: invalid connectionConfig — scheduling reconnect',
      );
      if (!unreachableEmitted) {
        emitConnectivity('unreachable');
        unreachableEmitted = true;
      }
      scheduleReconnect();
      return;
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

    let nextWs: WsClientLike;
    try {
      nextWs = wsFactory(url, Object.keys(headers).length > 0 ? { headers } : undefined);
    } catch (err) {
      logger.warn(
        { printerId: printer.id, err: (err as Error)?.message },
        'moonraker-status: ws factory threw — scheduling reconnect',
      );
      if (!unreachableEmitted) {
        emitConnectivity('unreachable');
        unreachableEmitted = true;
      }
      scheduleReconnect();
      return;
    }
    ws = nextWs;

    nextWs.on('open', () => {
      connected = true;
      attempt = 0;
      unreachableEmitted = false;
      // Send the subscription request. `send` may throw synchronously if
      // the socket is already closed; tolerate it and let the close handler
      // schedule a reconnect.
      try {
        nextWs.send(buildSubscribeMessage());
      } catch (err) {
        logger.warn(
          { printerId: printer?.id, err: (err as Error)?.message },
          'moonraker-status: subscribe send failed',
        );
      }
    });

    nextWs.on('message', (data: unknown) => {
      handleMessage(data);
    });

    nextWs.on('close', () => {
      const wasConnected = connected;
      connected = false;
      ws = null;
      if (stopped) return;
      if (wasConnected) {
        // Genuine disconnect after a successful session — next open should
        // emit 'reconnected'.
        needsReconnectedEvent = true;
        unreachableEmitted = false;
      } else if (!unreachableEmitted) {
        // Failed to ever open — surface unreachable once per cycle.
        emitConnectivity('unreachable');
        unreachableEmitted = true;
      }
      logger.info({ printerId: printer?.id }, 'moonraker-status: ws closed — scheduling reconnect');
      scheduleReconnect();
    });

    nextWs.on('error', (err: Error) => {
      logger.warn(
        { printerId: printer?.id, err: err?.message },
        'moonraker-status: ws error',
      );
      // `connected` will be cleared by the subsequent `close` event; do not
      // schedule reconnect here to avoid double-scheduling.
    });
  }

  return {
    protocol: 'moonraker',
    printerKind: 'fdm_klipper',
    async start(p, cred, onEvent) {
      printer = p;
      credential = cred;
      onEventCb = onEvent;
      stopped = false;
      attempt = 0;
      unreachableEmitted = false;
      needsReconnectedEvent = false;
      await connect();
    },
    async stop() {
      stopped = true;
      if (reconnectHandle !== null) {
        clearTimer(reconnectHandle);
        reconnectHandle = null;
      }
      if (ws !== null) {
        try {
          ws.close(1000, 'subscriber-stop');
        } catch {
          // ignore close-time errors
        }
        ws = null;
      }
      connected = false;
    },
    isConnected() {
      return connected;
    },
  };
}

