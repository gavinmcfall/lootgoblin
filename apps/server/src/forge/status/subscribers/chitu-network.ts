/**
 * chitu-network.ts — V2-005f-T_dcf8
 *
 * ChituBox legacy network resin printer status subscriber. Unlike the prior
 * four subscribers (Moonraker, OctoPrint, Bambu, SDCP), the ChituNetwork
 * firmware does NOT push status — we have to POLL via M27 over the same
 * persistent TCP connection (port 3000) used by the dispatch commander.
 *
 * Adaptive polling cadence state machine:
 *
 *   IDLE             — poll every 60s. No protocol events emitted.
 *                      Transition → PRINTING when:
 *                        a) `notifyPrinting()` is called by T_dcf9 worker
 *                           after dispatch sends M6030, OR
 *                        b) M27 reports `Print: X/Y` with X > 0 (printer
 *                           was started by some other actor — e.g. operator).
 *
 *   PRINTING         — poll every 10s. M27 replies with `Print: X/Y` are
 *                      surfaced as `progress` events with progressPct from
 *                      the byte ratio. Transition → NEAR_COMPLETION when
 *                      progress > 90%. Transition → JUST_FINISHED on
 *                      `Not currently printing`.
 *
 *   NEAR_COMPLETION  — poll every 2s. Same `progress` event surface as
 *                      PRINTING. Transition → JUST_FINISHED on
 *                      `Not currently printing`.
 *
 *   JUST_FINISHED    — poll every 30s for 5 minutes, then back to IDLE.
 *                      Emits a single `completed` event on entry from
 *                      PRINTING / NEAR_COMPLETION (NOT on entry from IDLE
 *                      — that path means we never saw the print start, so
 *                      we have nothing to "complete").
 *
 * Wire protocol:
 *   request : `M27\n`
 *   reply   : `Print: <bytes_printed>/<total_bytes>\n`  (during print)
 *   reply   : `Not currently printing\n`                (after / between prints)
 *   reply   : tolerated noise (other M-codes, ok-only lines) — kept in state.
 *
 * NOTES:
 *   - measuredConsumption is ALWAYS undefined for ChituNetwork — these resin
 *     boards have no per-slot weight tracking. T_dcf11 will use the slicer
 *     estimate as a proxy.
 *   - ChituNetwork can't distinguish completed vs cancelled via M27 alone —
 *     both surface as `Not currently printing`. We always emit `completed`.
 *     T_dcf11 reasons about success vs failure from the bytes-printed
 *     trajectory.
 *   - `notifyPrinting()` is OUTSIDE the StatusSubscriber interface — it's a
 *     ChituNetwork-specific extension consumed by T_dcf9. Returned handle
 *     widens StatusSubscriber to expose it.
 *   - This module only contributes the TCP transport + the polling state
 *     machine. Connectivity events (`unreachable` / `reconnected`) are
 *     synthesized by `_reconnect-base.ts`.
 */

import * as net from 'node:net';

import { logger } from '@/logger';
import {
  type TcpSocketLike,
  type TcpSocketFactory,
} from '@/forge/dispatch/chitu-network/commander';
import { ChituNetworkConnectionConfig } from '@/forge/dispatch/chitu-network/types';

import {
  createReconnectingSubscriber,
  type TransportHandle,
} from './_reconnect-base';
import type { StatusSubscriber } from '../types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type ChituPollingState = 'IDLE' | 'PRINTING' | 'NEAR_COMPLETION' | 'JUST_FINISHED';

export const CHITU_POLL_INTERVALS_MS: Record<ChituPollingState, number> = {
  IDLE: 60_000,
  PRINTING: 10_000,
  NEAR_COMPLETION: 2_000,
  JUST_FINISHED: 30_000,
};

export const CHITU_NEAR_COMPLETION_THRESHOLD_PCT = 90;
export const CHITU_JUST_FINISHED_DURATION_MS = 5 * 60 * 1000; // 5 minutes
export const CHITU_DEFAULT_TCP_PORT = 3000;
export const CHITU_M27_TIMEOUT_MS = 5_000;

export type ChituM27Reply =
  | { bytesPrinted: number; totalBytes: number }
  | 'not-printing'
  | null;

export interface ChituNetworkSubscriberOpts {
  /** ChituNetwork printer kind (one of `CHITU_NETWORK_KINDS`). */
  printerKind: string;
  /** Inject a fake TCP factory for tests. */
  tcpFactory?: TcpSocketFactory;
  /**
   * Reconnect backoff schedule in ms. Defaults to
   * `[5_000, 10_000, 30_000, 60_000, 300_000]`.
   */
  reconnectBackoffMs?: readonly number[];
  /** Override timer for tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Override timer-clear for tests. */
  clearTimeout?: (handle: unknown) => void;
  /** M27 reply timeout in ms. Defaults to 5000. */
  m27TimeoutMs?: number;
}

/**
 * Worker-extended subscriber surface. T_dcf9 type-checks for the presence of
 * `notifyPrinting` on Chitu subscribers and calls it after dispatch handover.
 */
export interface ChituNetworkSubscriberHandle extends StatusSubscriber {
  /**
   * Worker signal: dispatch just sent M6030 to this printer. Force the
   * IDLE → PRINTING transition without waiting for the next 60s poll.
   * No-op if already printing or finished.
   */
  notifyPrinting(): void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single `\n`-terminated (or trimmed) M27 reply line.
 *   `Print: 12345/100000` → `{ bytesPrinted: 12345, totalBytes: 100000 }`
 *   `Not currently printing` → `'not-printing'`
 *   anything else → `null`
 */
export function parseM27Reply(line: string): ChituM27Reply {
  const trimmed = line.trim();
  const m = /^Print:\s*(\d+)\s*\/\s*(\d+)/i.exec(trimmed);
  if (m) {
    const bytesPrinted = Number.parseInt(m[1] ?? '', 10);
    const totalBytes = Number.parseInt(m[2] ?? '', 10);
    if (
      Number.isFinite(bytesPrinted) &&
      Number.isFinite(totalBytes) &&
      bytesPrinted >= 0 &&
      totalBytes >= 0
    ) {
      return { bytesPrinted, totalBytes };
    }
    return null;
  }
  if (/not currently printing/i.test(trimmed)) return 'not-printing';
  return null;
}

/**
 * Compute the next polling state given the current state and the most recent
 * M27 reply. Pure function — no side effects, no event emission.
 */
export function nextState(
  current: ChituPollingState,
  m27Result: ChituM27Reply,
): ChituPollingState {
  if (m27Result === null) return current; // unknown / malformed — stay
  if (m27Result === 'not-printing') {
    if (current === 'PRINTING' || current === 'NEAR_COMPLETION') return 'JUST_FINISHED';
    if (current === 'JUST_FINISHED') return current;
    return 'IDLE';
  }
  if (m27Result.totalBytes === 0) return current;
  const pct = (m27Result.bytesPrinted / m27Result.totalBytes) * 100;
  if (pct >= CHITU_NEAR_COMPLETION_THRESHOLD_PCT) return 'NEAR_COMPLETION';
  if (m27Result.bytesPrinted > 0) return 'PRINTING';
  // bytesPrinted === 0 — printer reports a job is loaded but not progressed.
  // Preserve any non-IDLE state we were already in (e.g. JUST_FINISHED window
  // hasn't elapsed); otherwise treat as IDLE.
  return current === 'JUST_FINISHED' ? current : 'IDLE';
}

// ---------------------------------------------------------------------------
// Default TCP factory
// ---------------------------------------------------------------------------

const defaultChituStatusTcpFactory: TcpSocketFactory = () => {
  const sock = new net.Socket();
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

// ---------------------------------------------------------------------------
// createChituNetworkSubscriber
// ---------------------------------------------------------------------------

export function createChituNetworkSubscriber(
  opts: ChituNetworkSubscriberOpts,
): ChituNetworkSubscriberHandle {
  const tcpFactory = opts.tcpFactory ?? defaultChituStatusTcpFactory;
  const setTimer = opts.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    opts.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const m27TimeoutMs = opts.m27TimeoutMs ?? CHITU_M27_TIMEOUT_MS;

  // Per-attempt mutable state. Reset on each transport open via openTransport.
  let state: ChituPollingState = 'IDLE';
  let pollHandle: unknown = null;
  let justFinishedExitHandle: unknown = null;
  let socket: TcpSocketLike | null = null;
  let helpersRef: {
    onTransportOpen: () => void;
    onTransportClose: (wasConnected: boolean) => void;
    emitProtocolEvent: (event: import('../types').StatusEvent) => void;
  } | null = null;
  let recvBuf = '';
  let pendingM27: {
    resolve: (line: string) => void;
    reject: (err: Error) => void;
    timer: unknown;
  } | null = null;

  function clearPollTimer(): void {
    if (pollHandle !== null) {
      clearTimer(pollHandle);
      pollHandle = null;
    }
  }

  function clearJustFinishedTimer(): void {
    if (justFinishedExitHandle !== null) {
      clearTimer(justFinishedExitHandle);
      justFinishedExitHandle = null;
    }
  }

  function clearAllTimers(): void {
    clearPollTimer();
    clearJustFinishedTimer();
  }

  function rejectPendingM27(err: Error): void {
    if (pendingM27 === null) return;
    const { reject, timer } = pendingM27;
    pendingM27 = null;
    if (timer !== null) clearTimer(timer);
    reject(err);
  }

  /** Send `M27\n` and resolve with the next `\n`-terminated reply line. */
  function sendM27(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const sock = socket;
      if (sock === null) {
        reject(new Error('chitu-status: no active socket'));
        return;
      }
      // If a previous M27 is still pending (shouldn't happen because polls are
      // serialized, but be defensive), reject the old one first.
      if (pendingM27 !== null) {
        rejectPendingM27(new Error('chitu-status: superseded by next M27'));
      }
      const timer = setTimer(() => {
        if (pendingM27 !== null) {
          const { reject: r } = pendingM27;
          pendingM27 = null;
          r(new Error(`chitu-status: M27 timeout after ${m27TimeoutMs}ms`));
        }
      }, m27TimeoutMs);
      pendingM27 = { resolve, reject, timer };
      try {
        sock.write('M27\n');
      } catch (err) {
        rejectPendingM27(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Drain one `\n`-terminated line out of recvBuf into pendingM27, if any. */
  function drainOneLineToWaiter(): void {
    if (pendingM27 === null) return;
    const nl = recvBuf.indexOf('\n');
    if (nl < 0) return;
    let end = nl;
    if (end > 0 && recvBuf.charCodeAt(end - 1) === 0x0d) end -= 1;
    const line = recvBuf.slice(0, end);
    recvBuf = recvBuf.slice(nl + 1);
    const { resolve, timer } = pendingM27;
    pendingM27 = null;
    if (timer !== null) clearTimer(timer);
    resolve(line);
  }

  function scheduleNextPoll(): void {
    clearPollTimer();
    const interval = CHITU_POLL_INTERVALS_MS[state];
    pollHandle = setTimer(() => {
      pollHandle = null;
      void doPoll();
    }, interval);
  }

  async function doPoll(): Promise<void> {
    if (socket === null || helpersRef === null) return;
    let result: ChituM27Reply;
    try {
      const line = await sendM27();
      result = parseM27Reply(line);
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message },
        'chitu-status: M27 poll failed',
      );
      result = null;
    }
    const prev = state;
    state = nextState(state, result);

    // Surface progress events for live print states.
    if (
      (state === 'PRINTING' || state === 'NEAR_COMPLETION') &&
      typeof result === 'object' &&
      result !== null &&
      result.totalBytes > 0
    ) {
      const progressPct = Math.round((result.bytesPrinted / result.totalBytes) * 100);
      helpersRef.emitProtocolEvent({
        kind: 'progress',
        remoteJobRef: '', // M27 doesn't include the filename
        progressPct,
        rawPayload: result,
        occurredAt: new Date(),
      });
    } else if (
      state === 'JUST_FINISHED' &&
      (prev === 'PRINTING' || prev === 'NEAR_COMPLETION')
    ) {
      // Transitioned from a live print → emit completed exactly once.
      helpersRef.emitProtocolEvent({
        kind: 'completed',
        remoteJobRef: '',
        progressPct: 100,
        rawPayload: result,
        occurredAt: new Date(),
      });
      // Schedule the JUST_FINISHED → IDLE exit after 5 minutes.
      clearJustFinishedTimer();
      justFinishedExitHandle = setTimer(() => {
        justFinishedExitHandle = null;
        if (state === 'JUST_FINISHED') {
          state = 'IDLE';
          // Re-arm at IDLE cadence; if there's a poll already scheduled at
          // JUST_FINISHED cadence, reset it.
          scheduleNextPoll();
        }
      }, CHITU_JUST_FINISHED_DURATION_MS);
    }

    if (socket !== null) scheduleNextPoll();
  }

  const subscriber = createReconnectingSubscriber({
    protocol: 'chitu_network',
    printerKind: opts.printerKind,
    reconnectBackoffMs: opts.reconnectBackoffMs,
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
    openTransport: (printer, _credential, helpers): TransportHandle => {
      // ----- Validate connection-config -----
      const cfgParse = ChituNetworkConnectionConfig.safeParse(printer.connectionConfig);
      if (!cfgParse.success) {
        logger.error(
          { printerId: printer.id, err: cfgParse.error.message },
          'chitu-status: invalid connectionConfig',
        );
        throw new Error(
          `chitu-status: invalid connectionConfig: ${cfgParse.error.message}`,
        );
      }
      const cfg = cfgParse.data;
      const port = cfg.port ?? CHITU_DEFAULT_TCP_PORT;

      // ----- Per-attempt state reset -----
      state = 'IDLE';
      recvBuf = '';
      pendingM27 = null;
      const sock = tcpFactory();
      socket = sock;
      helpersRef = helpers;
      let connected = false;
      let closeReported = false;

      const reportClose = (): void => {
        if (closeReported) return;
        closeReported = true;
        clearAllTimers();
        rejectPendingM27(new Error('chitu-status: socket closed'));
        if (socket === sock) socket = null;
        helpers.onTransportClose(connected);
      };

      sock.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        recvBuf += text;
        drainOneLineToWaiter();
      });

      sock.on('error', (err: Error) => {
        logger.warn(
          { printerId: printer.id, err: err?.message },
          'chitu-status: tcp error',
        );
        // Reject any pending M27 so doPoll moves on. Defer to 'close' for
        // reconnect bookkeeping.
        rejectPendingM27(err);
      });

      sock.on('close', () => {
        logger.info({ printerId: printer.id }, 'chitu-status: tcp closed');
        reportClose();
      });

      try {
        sock.connect(port, cfg.ip, () => {
          connected = true;
          helpers.onTransportOpen();
          // Begin polling at the IDLE cadence.
          scheduleNextPoll();
        });
      } catch (err) {
        // Synchronous connect throw (rare) — surface immediate close so the
        // reconnect base schedules a retry.
        logger.warn(
          { printerId: printer.id, err: (err as Error)?.message },
          'chitu-status: tcp connect threw',
        );
        reportClose();
      }

      return {
        close: () => {
          clearAllTimers();
          rejectPendingM27(new Error('chitu-status: subscriber stop'));
          try {
            sock.end();
          } catch {
            // ignore
          }
          try {
            sock.destroy();
          } catch {
            // ignore
          }
          if (socket === sock) socket = null;
        },
      };
    },
  });

  return {
    ...subscriber,
    notifyPrinting() {
      // Only honour from IDLE — other states already represent an active /
      // recently-active print; the next poll will refine the state.
      if (state !== 'IDLE') return;
      if (socket === null) return;
      state = 'PRINTING';
      // Re-arm at the new cadence (10s instead of the IDLE 60s).
      scheduleNextPoll();
    },
  };
}
