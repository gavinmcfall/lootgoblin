/**
 * octoprint.ts — V2-005f-T_dcf5
 *
 * OctoPrint status subscriber. Connects to OctoPrint's push API over
 * SockJS at `${scheme}://${host}:${port}/sockjs/websocket` and emits
 * unified `StatusEvent`s via the `onEvent` callback.
 *
 * Protocol notes:
 *   - SockJS framing: server-sent strings carry single-character prefixes:
 *       'o'      — open frame
 *       'h'      — heartbeat (every ~25s)
 *       'a[...]' — JSON array of strings, each string is the inner JSON message
 *       'c[...]' — close frame
 *     We tolerate malformed framing (drop the message).
 *
 *   - Authentication: when `connectionConfig.requiresAuth=true`, we POST
 *     `{apiPath}/login` with body `{passive: true}` and header `X-Api-Key`
 *     to obtain `{name, session}` and then send `{auth: "<name>:<session>"}`
 *     over the WS as the first message. The base treats the subscriber as
 *     "connected" once the auth handshake completes (or once `o` frame is
 *     observed when no auth is required).
 *
 *   - Subscribe: there is no explicit subscribe step — OctoPrint pushes
 *     `current` events ~1Hz once the socket is open + authed.
 *
 *   - State mapping (see `mapCurrentState` + `mapEventType`): `current`
 *     drives progress / paused / idle, while terminal states arrive via
 *     `event` messages (`PrintDone`/`PrintFailed`/`PrintCancelled`).
 *
 *   - measuredConsumption is always undefined: OctoPrint does not natively
 *     report per-slot grams.
 *
 * Reconnect / connectivity events are owned by `_reconnect-base.ts` —
 * this module only contributes the WebSocket transport + SockJS routing.
 */

import { logger } from '@/logger';
import {
  OctoprintConnectionConfig,
  OctoprintCredentialPayload,
} from '@/forge/dispatch/octoprint/types';
import type { HttpClient } from '@/forge/dispatch/handler';

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

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface OctoprintSubscriberOpts {
  /** Inject a fake WebSocket constructor for tests. */
  wsFactory?: WsFactory;
  /** Inject a fake HTTP client for the login call. Defaults to globalThis.fetch. */
  httpClient?: HttpClient;
  /**
   * Reconnect backoff schedule in ms. Defaults to
   * `[5_000, 10_000, 30_000, 60_000, 300_000]`.
   */
  reconnectBackoffMs?: readonly number[];
  /** Override timer for tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Override timer-clear for tests. */
  clearTimeout?: (handle: unknown) => void;
}

// ---------------------------------------------------------------------------
// SockJS framing
// ---------------------------------------------------------------------------

export interface SockJsFrame {
  type: 'open' | 'close' | 'heartbeat' | 'array';
  messages?: string[];
}

/**
 * Parse a SockJS-framed string into its frame-type and (for `array` frames)
 * the inner JSON-encoded message strings. Tolerant of malformed payloads —
 * unknown frames decode to `{type: 'array', messages: []}` so the caller
 * simply sees no inner messages.
 */
export function parseSockJsMessage(raw: string): SockJsFrame {
  if (raw === 'o') return { type: 'open' };
  if (raw === 'h') return { type: 'heartbeat' };
  if (raw.length === 0) return { type: 'array', messages: [] };
  const prefix = raw.charAt(0);
  if (prefix === 'c') return { type: 'close' };
  if (prefix === 'a') {
    try {
      const parsed = JSON.parse(raw.slice(1)) as unknown;
      if (Array.isArray(parsed)) {
        const messages = parsed.filter((m): m is string => typeof m === 'string');
        return { type: 'array', messages };
      }
      return { type: 'array', messages: [] };
    } catch {
      return { type: 'array', messages: [] };
    }
  }
  return { type: 'array', messages: [] };
}

// ---------------------------------------------------------------------------
// State mapping (pure functions)
// ---------------------------------------------------------------------------

/**
 * Map an OctoPrint `current.state.text` to a StatusEventKind. Returns null
 * for states we deliberately suppress (idle, transient).
 *
 * Note: terminal states (`PrintDone` / `PrintFailed` / `PrintCancelled`)
 * arrive on the `event` channel and are handled by `mapEventType`. The
 * `current.state.text` for those states (e.g. "Operational" right after
 * a Done) intentionally maps to null here.
 */
export function mapCurrentState(state: string | undefined): StatusEventKind | null {
  if (!state) return null;
  switch (state) {
    case 'Printing':
    case 'Printing from SD':
      return 'progress';
    case 'Paused':
    case 'Pausing':
      return 'paused';
    case 'Operational':
    case 'Offline':
    case 'Error':
    case 'Cancelling':
    case 'Connecting':
    case 'Detecting baudrate':
    case 'Detecting serial connection':
    case 'Opening serial connection':
      return null;
    default:
      return null;
  }
}

/**
 * Map an OctoPrint `event.type` to a StatusEventKind. Authoritative for
 * terminal states.
 */
export function mapEventType(type: string | undefined): StatusEventKind | null {
  if (!type) return null;
  switch (type) {
    case 'PrintStarted':
      return 'started';
    case 'PrintDone':
      return 'completed';
    case 'PrintFailed':
    case 'PrintCancelled':
      return 'failed';
    case 'PrintPaused':
      return 'paused';
    case 'PrintResumed':
      return 'resumed';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface OctoprintCurrentPayload {
  state?: { text?: string };
  progress?: { completion?: number; printTimeLeft?: number };
  job?: { file?: { name?: string; path?: string } };
  currentZ?: number | null;
}

interface OctoprintEventPayload {
  type?: string;
  payload?: { name?: string; path?: string };
}

interface OctoprintInnerMessage {
  current?: OctoprintCurrentPayload;
  history?: OctoprintCurrentPayload;
  event?: OctoprintEventPayload;
  // plugin / connected / serverReachable / etc — ignored
}

function decodeInnerMessage(json: string): OctoprintInnerMessage | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as OctoprintInnerMessage;
    }
    return null;
  } catch {
    return null;
  }
}

function decodeWsData(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) {
    try {
      return Buffer.concat(data as Buffer[]).toString('utf8');
    } catch {
      return null;
    }
  }
  if (data && typeof (data as { toString?: () => string }).toString === 'function') {
    return String(data);
  }
  return null;
}

function buildEventFromCurrent(
  kind: StatusEventKind,
  payload: OctoprintCurrentPayload,
  occurredAt: Date,
): StatusEvent {
  const completion = payload.progress?.completion;
  const filename = payload.job?.file?.name ?? '';
  const printTimeLeft = payload.progress?.printTimeLeft;
  return {
    kind,
    remoteJobRef: typeof filename === 'string' ? filename : '',
    progressPct:
      typeof completion === 'number' && Number.isFinite(completion)
        ? Math.round(completion)
        : undefined,
    remainingMin:
      typeof printTimeLeft === 'number' && Number.isFinite(printTimeLeft)
        ? Math.round(printTimeLeft / 60)
        : undefined,
    rawPayload: payload,
    occurredAt,
  };
}

function buildEventFromEvent(
  kind: StatusEventKind,
  evt: OctoprintEventPayload,
  rawPayload: unknown,
  occurredAt: Date,
): StatusEvent {
  return {
    kind,
    remoteJobRef:
      typeof evt.payload?.name === 'string'
        ? evt.payload.name
        : typeof evt.payload?.path === 'string'
          ? evt.payload.path
          : '',
    progressPct: kind === 'completed' ? 100 : undefined,
    rawPayload,
    occurredAt,
  };
}

interface LoginReply {
  name?: string;
  session?: string;
}

async function performLogin(
  http: HttpClient,
  url: string,
  apiKey: string,
): Promise<LoginReply> {
  const res = await http.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({ passive: true }),
  });
  if (!res.ok) {
    throw new Error(`octoprint login failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    return {
      name: typeof obj.name === 'string' ? obj.name : undefined,
      session: typeof obj.session === 'string' ? obj.session : undefined,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// createOctoprintSubscriber
// ---------------------------------------------------------------------------

const OCTOPRINT_PRINTER_KIND = 'fdm_octoprint';

/**
 * Build an OctoPrint StatusSubscriber. Lifecycle / reconnect behaviour is
 * delegated to `_reconnect-base.ts`; this factory only provides the
 * SockJS-over-WebSocket transport and the OctoPrint-specific message
 * routing.
 */
export function createOctoprintSubscriber(
  opts: OctoprintSubscriberOpts = {},
): StatusSubscriber {
  const wsFactory = opts.wsFactory ?? defaultWsFactory;
  const httpClient: HttpClient =
    opts.httpClient ?? {
      fetch: (url, init) => globalThis.fetch(url, init),
    };

  return createReconnectingSubscriber({
    protocol: 'octoprint',
    printerKind: OCTOPRINT_PRINTER_KIND,
    reconnectBackoffMs: opts.reconnectBackoffMs,
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
    openTransport: async (printer, credential, helpers): Promise<TransportHandle> => {
      // ----- Validate connection config -----
      const cfgParse = OctoprintConnectionConfig.safeParse(printer.connectionConfig);
      if (!cfgParse.success) {
        logger.error(
          { printerId: printer.id, err: cfgParse.error.message },
          'octoprint-status: invalid connectionConfig',
        );
        throw new Error(
          `octoprint-status: invalid connectionConfig: ${cfgParse.error.message}`,
        );
      }
      const cfg = cfgParse.data;

      // ----- Resolve apiKey (when auth required) -----
      let apiKey: string | null = null;
      if (cfg.requiresAuth) {
        if (credential === null) {
          throw new Error('octoprint-status: requiresAuth=true but no credential provided');
        }
        const credParse = OctoprintCredentialPayload.safeParse(credential.payload);
        if (!credParse.success) {
          throw new Error(
            `octoprint-status: invalid credential payload: ${credParse.error.message}`,
          );
        }
        apiKey = credParse.data.apiKey;
      }

      // ----- HTTP login (only when auth required) -----
      let authMessage: string | null = null;
      if (apiKey !== null) {
        const loginUrl = `${cfg.scheme}://${cfg.host}:${cfg.port}${cfg.apiPath}/login`;
        try {
          const reply = await performLogin(httpClient, loginUrl, apiKey);
          if (typeof reply.name === 'string' && typeof reply.session === 'string') {
            authMessage = JSON.stringify({ auth: `${reply.name}:${reply.session}` });
          } else {
            // Fall back to bare apiKey-style auth — the message shape OctoPrint
            // also accepts is `{auth: "<apiKey>"}` for some plugin builds.
            logger.warn(
              { printerId: printer.id },
              'octoprint-status: login reply missing name/session — proceeding with apiKey auth fallback',
            );
            authMessage = JSON.stringify({ auth: apiKey });
          }
        } catch (err) {
          logger.warn(
            { printerId: printer.id, err: (err as Error)?.message },
            'octoprint-status: login HTTP call failed',
          );
          throw err;
        }
      }

      // ----- Open the SockJS WebSocket -----
      const wsScheme = cfg.scheme === 'https' ? 'wss' : 'ws';
      const url = `${wsScheme}://${cfg.host}:${cfg.port}/sockjs/websocket`;
      const ws = wsFactory(url);

      let socketOpened = false;
      let authed = authMessage === null; // No auth required → already authed.
      let closedReported = false;

      const reportClose = (): void => {
        if (closedReported) return;
        closedReported = true;
        helpers.onTransportClose(socketOpened);
      };

      function dispatchInner(json: string): void {
        const inner = decodeInnerMessage(json);
        if (inner === null) return;
        if (inner.current) {
          const kind = mapCurrentState(inner.current.state?.text);
          if (kind !== null) {
            helpers.emitProtocolEvent(buildEventFromCurrent(kind, inner.current, new Date()));
          }
          return;
        }
        if (inner.history) {
          // Treat history identically to current — it's the initial-state
          // payload and follows the same shape.
          const kind = mapCurrentState(inner.history.state?.text);
          if (kind !== null) {
            helpers.emitProtocolEvent(buildEventFromCurrent(kind, inner.history, new Date()));
          }
          return;
        }
        if (inner.event) {
          const kind = mapEventType(inner.event.type);
          if (kind !== null) {
            helpers.emitProtocolEvent(buildEventFromEvent(kind, inner.event, inner, new Date()));
          }
          return;
        }
        // plugin/connected/serverReachable/etc — ignored.
      }

      function handleFrame(frame: SockJsFrame): void {
        if (frame.type === 'heartbeat') return;
        if (frame.type === 'close') {
          // Server-initiated close — defer to the subsequent ws 'close' event
          // for the actual reconnect bookkeeping.
          return;
        }
        if (frame.type === 'open') {
          socketOpened = true;
          if (authMessage !== null) {
            try {
              ws.send(authMessage);
            } catch (err) {
              logger.warn(
                { printerId: printer.id, err: (err as Error)?.message },
                'octoprint-status: auth send failed',
              );
            }
            // Treat the very next frame from server (or simply the auth
            // having been sent) as completing the auth handshake. OctoPrint
            // does not send an explicit auth-ack; we mark authed once the
            // first array-frame arrives (handled below).
          } else {
            helpers.onTransportOpen();
          }
          return;
        }
        // array frame
        if (!authed && authMessage !== null) {
          // First array-frame after sending auth indicates the server
          // accepted the credentials — surface as fully ready.
          authed = true;
          helpers.onTransportOpen();
        }
        for (const inner of frame.messages ?? []) {
          dispatchInner(inner);
        }
      }

      ws.on('message', (data: unknown) => {
        const text = decodeWsData(data);
        if (text === null) return;
        handleFrame(parseSockJsMessage(text));
      });

      ws.on('close', () => {
        logger.info(
          { printerId: printer.id },
          'octoprint-status: ws closed',
        );
        reportClose();
      });

      ws.on('error', (err: Error) => {
        logger.warn(
          { printerId: printer.id, err: err?.message },
          'octoprint-status: ws error',
        );
        // Defer to subsequent 'close' for reconnect bookkeeping.
      });

      // Some `ws` impls fire 'open' before message; SockJS sends 'o' as the
      // first message. Many test rigs fire .open() then .message('o'). Use
      // either signal to set socketOpened; the actual handshake completes
      // when 'o' is observed via the message handler.
      ws.on('open', () => {
        // intentionally no-op — SockJS's 'o' frame is the real signal.
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

export type { WsClientLike, WsFactory } from './_ws-client';
