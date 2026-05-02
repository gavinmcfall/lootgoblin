/**
 * _reconnect-base.ts — V2-005f
 *
 * Protocol-agnostic reconnect/lifecycle helper for `StatusSubscriber`
 * implementations. Every subscriber in T_dcf4–T_dcf8 (Moonraker JSON-RPC,
 * OctoPrint SSE, Bambu MQTT, SDCP, ChituNetwork) needs the same state
 * machine around their transport:
 *
 *   - First connect → if it fails, emit `unreachable` exactly once.
 *   - Subsequent retries during the same disconnect cycle → no extra
 *     `unreachable` emissions.
 *   - After a successful session disconnects, the next successful open
 *     emits `reconnected` once.
 *   - `stop()` must drop any in-flight events between the close request
 *     and the actual close handler firing (the I-1 race fix).
 *   - Reconnect backoff schedule + idempotent stop/start.
 *
 * Subscribers supply `openTransport()` — a function that opens their
 * protocol-specific transport (WebSocket, MQTT client, EventSource, raw
 * TCP, etc.) and signals back via three helpers:
 *
 *   - `helpers.onTransportOpen()` — called when the transport is fully
 *     ready. For Moonraker this is *after* the JSON-RPC subscribe reply
 *     comes back, NOT just on `ws.open`. Each subscriber decides what
 *     "fully ready" means.
 *   - `helpers.onTransportClose(wasConnected)` — called when the transport
 *     disconnects. `wasConnected` should be true iff the transport had
 *     previously signalled `onTransportOpen` during the current attempt.
 *   - `helpers.emitProtocolEvent(event)` — surface a protocol-level
 *     `StatusEvent` (progress / paused / completed / failed / etc.) up to
 *     the subscriber's `onEvent` listener. Connectivity events
 *     (`unreachable` / `reconnected`) are synthesized by this base — the
 *     subscriber must NOT emit them itself.
 *
 * The base owns: `attempt` index, `unreachableEmitted` flag, the
 * "needs reconnected on next open" flag, the reconnect timer handle, and
 * the active transport handle. It does NOT know about WebSockets, MQTT,
 * JSON-RPC, or any protocol detail.
 */

import { logger } from '@/logger';
import type {
  StatusEvent,
  StatusSubscriber,
  PrinterRecord,
  DecryptedCredential,
  StatusSourceProtocol,
} from '../types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Active transport returned by `openTransport`. */
export interface TransportHandle {
  /**
   * Close the transport. Must trigger the eventual
   * `helpers.onTransportClose(...)` callback (or be safe if it doesn't —
   * the base nulls listeners on stop).
   */
  close(): void;
}

export interface OpenTransportHelpers {
  /** Signal: the transport is now fully ready. */
  onTransportOpen: () => void;
  /**
   * Signal: the transport disconnected. `wasConnected` is true iff the
   * transport had previously signalled `onTransportOpen` during this
   * attempt.
   */
  onTransportClose: (wasConnected: boolean) => void;
  /**
   * Surface a protocol-level event (progress, completed, etc.) to the
   * subscriber's `onEvent` listener. Drops the event if the subscriber
   * has been stopped — this is the I-1 race fix.
   */
  emitProtocolEvent: (event: StatusEvent) => void;
}

export interface ReconnectingSubscriberOptions {
  /** Wire protocol — copied straight to `StatusSubscriber.protocol`. */
  protocol: StatusSourceProtocol;
  /** Printer kind — copied straight to `StatusSubscriber.printerKind`. */
  printerKind: string;
  /**
   * Open the protocol transport. Called on each connect attempt. Must
   * either:
   *   - return a `TransportHandle` and arrange for `helpers.onTransportOpen`
   *     to fire when the transport is fully ready, OR
   *   - throw / reject — the base treats that as an immediate disconnect
   *     and schedules a retry.
   */
  openTransport: (
    printer: PrinterRecord,
    credential: DecryptedCredential | null,
    helpers: OpenTransportHelpers,
  ) => Promise<TransportHandle> | TransportHandle;
  /**
   * Reconnect backoff schedule in ms. Defaults to
   * `[5_000, 10_000, 30_000, 60_000, 300_000]`. The last entry is reused
   * after the schedule has been exhausted.
   */
  reconnectBackoffMs?: readonly number[];
  /** Override for tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Override for tests. */
  clearTimeout?: (handle: unknown) => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 10_000, 30_000, 60_000, 300_000];

/**
 * Build a `StatusSubscriber` whose lifecycle / reconnect machinery is
 * implemented by the base, with protocol-specifics injected via
 * `openTransport`.
 */
export function createReconnectingSubscriber(
  opts: ReconnectingSubscriberOptions,
): StatusSubscriber {
  const backoffSchedule =
    opts.reconnectBackoffMs && opts.reconnectBackoffMs.length > 0
      ? opts.reconnectBackoffMs
      : DEFAULT_BACKOFF_MS;
  const setTimer = opts.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    opts.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let printer: PrinterRecord | null = null;
  let credential: DecryptedCredential | null = null;
  let onEventCb: ((e: StatusEvent) => void) | null = null;

  let handle: TransportHandle | null = null;
  let connected = false;
  let stopped = true;
  let attempt = 0;
  let reconnectHandle: unknown = null;
  let unreachableEmitted = false;
  /** Set when a previously-connected session disconnects; cleared on next successful open. */
  let needsReconnectedEvent = false;
  /**
   * Each call to `connect()` gets a fresh "attempt id". When `stop()` runs,
   * any helper callbacks tied to a stale attempt id become no-ops. Combined
   * with `onEventCb=null` this gives us full I-1 race coverage even for
   * transports whose close/open events fire after `stop()` returned.
   */
  let attemptId = 0;

  function emit(event: StatusEvent): void {
    if (onEventCb !== null) onEventCb(event);
  }

  function emitConnectivity(kind: 'reconnected' | 'unreachable'): void {
    emit({
      kind,
      remoteJobRef: '',
      rawPayload: {},
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

  function makeHelpers(myAttemptId: number): OpenTransportHelpers {
    return {
      onTransportOpen: () => {
        if (stopped || myAttemptId !== attemptId) return;
        connected = true;
        attempt = 0;
        unreachableEmitted = false;
        if (needsReconnectedEvent) {
          emitConnectivity('reconnected');
          needsReconnectedEvent = false;
        }
      },
      onTransportClose: (wasConnected: boolean) => {
        if (myAttemptId !== attemptId) return;
        connected = false;
        if (handle !== null) {
          handle = null;
        }
        if (stopped) return;
        if (wasConnected) {
          // Genuine disconnect after a live session — surface 'reconnected'
          // when the next open succeeds, but DON'T emit 'unreachable' for
          // this disconnect cycle until/unless retries also fail (current
          // policy: do not emit unreachable mid-cycle once we've seen a
          // successful session — preserves prior subscriber behaviour).
          needsReconnectedEvent = true;
          unreachableEmitted = false;
        } else if (!unreachableEmitted) {
          emitConnectivity('unreachable');
          unreachableEmitted = true;
        }
        scheduleReconnect();
      },
      emitProtocolEvent: (event: StatusEvent) => {
        // I-1 fix: drop events that arrive after stop() has nulled the
        // listener, OR that belong to a stale attempt.
        if (stopped || myAttemptId !== attemptId) return;
        if (onEventCb === null) return;
        onEventCb(event);
      },
    };
  }

  async function connect(): Promise<void> {
    if (printer === null) return;
    if (stopped) return;

    attemptId += 1;
    const myAttemptId = attemptId;
    const helpers = makeHelpers(myAttemptId);

    let opened: TransportHandle;
    try {
      opened = await opts.openTransport(printer, credential, helpers);
    } catch (err) {
      logger.warn(
        {
          printerId: printer.id,
          protocol: opts.protocol,
          err: (err as Error)?.message,
        },
        'status-subscriber: openTransport threw — scheduling reconnect',
      );
      // Fail-fast: treat as immediate disconnect of an attempt that never
      // reached the connected state.
      if (myAttemptId === attemptId && !stopped) {
        if (!unreachableEmitted) {
          emitConnectivity('unreachable');
          unreachableEmitted = true;
        }
        scheduleReconnect();
      }
      return;
    }

    if (stopped || myAttemptId !== attemptId) {
      // Raced with stop()/another connect() — drop this transport.
      try {
        opened.close();
      } catch {
        // ignore close-time errors
      }
      return;
    }
    handle = opened;
  }

  return {
    protocol: opts.protocol,
    printerKind: opts.printerKind,
    async start(p, cred, onEvent) {
      printer = p;
      credential = cred;
      onEventCb = onEvent;
      stopped = false;
      attempt = 0;
      unreachableEmitted = false;
      needsReconnectedEvent = false;
      connected = false;
      await connect();
    },
    async stop() {
      stopped = true;
      // Bump attemptId so any in-flight helper calls become no-ops.
      attemptId += 1;
      if (reconnectHandle !== null) {
        clearTimer(reconnectHandle);
        reconnectHandle = null;
      }
      if (handle !== null) {
        try {
          handle.close();
        } catch {
          // ignore close-time errors
        }
        handle = null;
      }
      connected = false;
      // I-1 fix: drop events that arrive between close-request and the
      // actual close-event firing.
      onEventCb = null;
    },
    isConnected() {
      return connected;
    },
  };
}
