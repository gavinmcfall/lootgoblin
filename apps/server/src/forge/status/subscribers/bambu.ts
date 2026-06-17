// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * bambu.ts — V2-005f-T_dcf6
 *
 * Bambu Lab LAN-mode status subscriber. Connects over MQTTS to the printer
 * (`mqtts://<ip>:8883`), subscribes to `device/<serial>/report`, and emits
 * unified `StatusEvent`s by parsing `pushing.pushall` payloads.
 *
 * Per-slot AMS consumption is the differentiator vs Moonraker / OctoPrint —
 * Bambu reports `ams.ams[*].tray[*].remain` as a percentage 0–100 (NOT grams)
 * for each filled slot. The protocol does not expose spool weight, so this
 * subscriber surfaces the raw `remain_percent` per slot in
 * `MeasuredConsumptionSlot` on terminal events; T_dcf11 combines that with
 * the slicer-derived `materials_used` estimate to back-calculate measured
 * grams against the dispatch's per-slot baseline.
 *
 * Reconnect / connectivity events are owned by `_reconnect-base.ts` —
 * this module only contributes the MQTT transport + pushall routing. The
 * base treats us as "fully ready" only after the FIRST `pushing.pushall`
 * arrives (Bambu sends a one-shot full-state pushall right after subscribe),
 * not on raw MQTT `connect`.
 *
 * The MQTT seam (`MqttClientLike` / `MqttFactory` / `defaultMqttFactory`) is
 * shared with the dispatch-side adapter (T_db3) — a single source of truth
 * for the `mqtt` runtime dependency. The literal username `'bblp'` is also
 * imported as `BAMBU_LAN_USERNAME` from there so the
 * username-next-to-password GitGuardian heuristic only ever fires on the
 * adapter constant, never duplicated here.
 */

import { logger } from '@/logger';
import {
  BambuLanConnectionConfig,
  BambuLanCredentialPayload,
  type BambuLanKind,
} from '@/forge/dispatch/bambu/types';
import {
  BAMBU_LAN_USERNAME,
  defaultMqttFactory,
  type MqttClientLike,
  type MqttFactory,
} from '@/forge/dispatch/bambu/adapter';

import {
  createReconnectingSubscriber,
  type TransportHandle,
} from './_reconnect-base';
import type {
  StatusSubscriber,
  StatusEvent,
  StatusEventKind,
  MeasuredConsumptionSlot,
} from '../types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface BambuSubscriberOpts {
  /** Bambu printer kind (one of `BAMBU_LAN_KINDS`). Drives `printerKind` on the resulting StatusSubscriber. */
  printerKind: BambuLanKind;
  /** Inject a fake MQTT factory for tests. */
  mqttFactory?: MqttFactory;
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
// Pushall payload types (loose — Bambu firmware adds fields between releases)
// ---------------------------------------------------------------------------

interface BambuTrayPayload {
  id?: string;
  tray_type?: string;
  tray_color?: string;
  remain?: number;
  n?: number;
}

interface BambuAmsUnitPayload {
  id?: string;
  tray?: BambuTrayPayload[];
}

interface BambuAmsBlock {
  ams?: BambuAmsUnitPayload[];
}

interface BambuHmsEntry {
  /** Bambu attribute identifier — 32-bit unsigned int. */
  attr?: number;
  /** Bambu HMS code — 32-bit unsigned int. */
  code?: number;
  /**
   * Severity tier: 0 = info/blue, 1 = warning/orange, 2+ = error/red.
   * Per Bambu firmware spec; may be a float in unusual builds — Math.floor
   * before mapping.
   */
  level?: number;
}

interface BambuPushallPrint {
  command?: string;
  msg?: number;
  sequence_id?: string;
  gcode_state?: string;
  mc_percent?: number;
  mc_remaining_time?: number;
  layer_num?: number;
  total_layer_num?: number;
  subtask_name?: string;
  ams?: BambuAmsBlock;
  /**
   * V2-005f-CF-5a: Bambu firmware-reported error code on gcode_state=FAILED.
   * 32-bit unsigned integer; decimal string in StatusEvent.errorCode so
   * operators can look it up in Bambu firmware logs.
   */
  print_error?: number;
  /**
   * V2-005f-CF-5a: Bambu Health Monitoring System codes. One entry per active
   * alert; firmware re-emits the full list on every pushall (~1 Hz) until the
   * condition clears. T_a6's dedup logic downstream handles the repeat
   * suppression — this subscriber emits one 'warning' per entry per pushall.
   */
  hms?: BambuHmsEntry[];
}

interface BambuPushallEnvelope {
  print?: BambuPushallPrint;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Map a Bambu `gcode_state` enum value to a unified `StatusEventKind`.
 * Returns null when the state should not surface a protocol event (e.g.
 * `IDLE` — the operator-cancel detection for PAUSE→IDLE is handled separately
 * in the subscriber closure, not here).
 *
 * V2-005f-CF-5a: FAILED → 'firmware_error' (was 'failed') to distinguish
 * firmware-detected faults from operator cancellations.
 */
export function mapBambuState(state: string | undefined): StatusEventKind | null {
  if (!state) return null;
  switch (state) {
    case 'IDLE':
      return null;
    case 'PREPARE':
      return 'started';
    case 'RUNNING':
      return 'progress';
    case 'PAUSE':
      return 'paused';
    case 'FINISH':
      return 'completed';
    case 'FAILED':
      return 'firmware_error'; // CF-5a: was 'failed' — firmware fault, not operator cancel
    default:
      return null;
  }
}

/**
 * V2-005f-CF-5a: Map a Bambu HMS level integer to a severity tier.
 * Level is defensively coerced via Math.floor to handle unexpected floats.
 *
 *   0  → 'info'    (blue in Bambu UI)
 *   1  → 'warning' (orange in Bambu UI)
 *   2+ → 'error'   (red in Bambu UI)
 */
export function hmsLevelToSeverity(level: number): 'info' | 'warning' | 'error' {
  const tier = Math.floor(level);
  if (tier <= 0) return 'info';
  if (tier === 1) return 'warning';
  return 'error';
}

/**
 * V2-005f-CF-5a: Format a Bambu HMS attr+code pair as a zero-padded hex
 * string `XXXX-XXXX-XXXX-XXXX` (attr split into two 4-hex groups, code split
 * into two 4-hex groups). T_a6's dedup logic uses this string as the
 * unique key for a warning within a dispatch job.
 *
 * Both inputs are coerced to unsigned 32-bit integers via `>>> 0` before
 * stringifying. JavaScript bitwise ops can yield signed integers from
 * upstream parsing; without coercion `(-1).toString(16)` produces `'-1'` and
 * the resulting key would be malformed (`'0000-00-1'` etc.), permanently
 * splitting one HMS condition into two dedup buckets in T_a6.
 */
export function formatHmsCode(attr: number, code: number): string {
  const hi = (attr >>> 0).toString(16).padStart(8, '0').toUpperCase();
  const lo = (code >>> 0).toString(16).padStart(8, '0').toUpperCase();
  return `${hi.slice(0, 4)}-${hi.slice(4)}-${lo.slice(0, 4)}-${lo.slice(4)}`;
}

/**
 * Flatten an `ams.ams[*].tray[*]` block into per-slot consumption entries.
 * Each AMS unit owns 4 trays (slot ids 0–3) — the global flat slot index is
 * `unit_index * 4 + parsed_tray_id`.
 *
 * `grams` is set to 0 because Bambu does not expose spool weight; T_dcf11
 * back-calculates the measured grams using the slicer-derived per-slot
 * materials_used estimate combined with `remain_percent`.
 */
export function extractAmsSlots(ams: BambuAmsBlock | undefined): MeasuredConsumptionSlot[] {
  if (!ams || !Array.isArray(ams.ams)) return [];
  const slots: MeasuredConsumptionSlot[] = [];
  ams.ams.forEach((unit, unitIdx) => {
    if (!unit || !Array.isArray(unit.tray)) return;
    for (const tray of unit.tray) {
      if (!tray) continue;
      const trayIdRaw = typeof tray.id === 'string' ? Number.parseInt(tray.id, 10) : NaN;
      const trayId = Number.isFinite(trayIdRaw) ? trayIdRaw : 0;
      const slotIndex = unitIdx * 4 + trayId;
      const remainPercent =
        typeof tray.remain === 'number' && Number.isFinite(tray.remain) ? tray.remain : undefined;
      const slot: MeasuredConsumptionSlot = {
        slot_index: slotIndex,
        grams: 0,
      };
      if (remainPercent !== undefined) slot.remain_percent = remainPercent;
      slots.push(slot);
    }
  });
  return slots;
}

/**
 * Build a unified `StatusEvent` from a parsed Bambu pushall payload + a
 * resolved kind. `measuredConsumption` is populated only on terminal kinds
 * (`completed` / `firmware_error`) to match the contract documented on
 * `MeasuredConsumptionSlot`.
 *
 * V2-005f-CF-5a: `printError` is the raw `print_error` integer from the
 * pushall payload on FAILED states; it is stringified as decimal and stored
 * in `errorCode` so operators can look it up in Bambu firmware logs.
 * Zero is treated as "no error code reported" and omitted.
 */
export function buildBambuEvent(
  envelope: BambuPushallEnvelope,
  kind: StatusEventKind,
  occurredAt: Date,
  printError?: number,
): StatusEvent {
  const print = envelope.print ?? {};
  const remoteJobRef = typeof print.subtask_name === 'string' ? print.subtask_name : '';
  const progressPct =
    typeof print.mc_percent === 'number' && Number.isFinite(print.mc_percent)
      ? print.mc_percent
      : undefined;
  const remainingMin =
    typeof print.mc_remaining_time === 'number' && Number.isFinite(print.mc_remaining_time)
      ? Math.round(print.mc_remaining_time / 60)
      : undefined;
  const layerNum =
    typeof print.layer_num === 'number' && Number.isFinite(print.layer_num)
      ? print.layer_num
      : undefined;
  const totalLayers =
    typeof print.total_layer_num === 'number' && Number.isFinite(print.total_layer_num)
      ? print.total_layer_num
      : undefined;

  const event: StatusEvent = {
    kind,
    remoteJobRef,
    rawPayload: envelope,
    occurredAt,
  };
  if (progressPct !== undefined) event.progressPct = progressPct;
  if (remainingMin !== undefined) event.remainingMin = remainingMin;
  if (layerNum !== undefined) event.layerNum = layerNum;
  if (totalLayers !== undefined) event.totalLayers = totalLayers;

  // V2-005f-CF-5a: populate errorCode from print_error on firmware_error events.
  // Zero means "no error code" — omit rather than stringifying '0'.
  if (typeof printError === 'number' && printError !== 0) {
    event.errorCode = String(printError);
  }

  // Per-slot consumption only on terminal events.
  // CF-5a: include firmware_error (was failed) — AMS data is still valid at FAILED state.
  if (kind === 'completed' || kind === 'firmware_error') {
    const slots = extractAmsSlots(print.ams);
    if (slots.length > 0) event.measuredConsumption = slots;
  }

  return event;
}

function decodeMqttPayload(payload: unknown): BambuPushallEnvelope | null {
  let text: string;
  if (typeof payload === 'string') {
    text = payload;
  } else if (Buffer.isBuffer(payload)) {
    text = payload.toString('utf8');
  } else if (payload instanceof ArrayBuffer) {
    text = Buffer.from(payload).toString('utf8');
  } else if (Array.isArray(payload)) {
    try {
      text = Buffer.concat(payload as Buffer[]).toString('utf8');
    } catch {
      return null;
    }
  } else if (payload && typeof (payload as { toString?: () => string }).toString === 'function') {
    text = String(payload);
  } else {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as BambuPushallEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// createBambuSubscriber
// ---------------------------------------------------------------------------

/**
 * Build a Bambu LAN-mode StatusSubscriber for a single printer kind. The
 * V2-005f status worker (T_dcf9) constructs one instance per registered
 * Bambu printer, reading the kind off the printer row.
 *
 * Lifecycle / reconnect behaviour is delegated to `_reconnect-base.ts`; this
 * factory only provides the MQTT transport and the pushall message routing.
 */
export function createBambuSubscriber(opts: BambuSubscriberOpts): StatusSubscriber {
  const mqttFactory = opts.mqttFactory ?? defaultMqttFactory;

  return createReconnectingSubscriber({
    protocol: 'bambu_lan',
    printerKind: opts.printerKind,
    reconnectBackoffMs: opts.reconnectBackoffMs,
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
    openTransport: (printer, credential, helpers): TransportHandle => {
      // ----- Validate connection-config -----
      const cfgParse = BambuLanConnectionConfig.safeParse(printer.connectionConfig);
      if (!cfgParse.success) {
        logger.error(
          { printerId: printer.id, err: cfgParse.error.message },
          'bambu-status: invalid connectionConfig',
        );
        throw new Error(`bambu-status: invalid connectionConfig: ${cfgParse.error.message}`);
      }
      const cfg = cfgParse.data;

      // ----- Validate credential payload (always required for Bambu LAN) -----
      if (credential === null) {
        throw new Error('bambu-status: requires credential (accessCode + serial)');
      }
      const credParse = BambuLanCredentialPayload.safeParse(credential.payload);
      if (!credParse.success) {
        throw new Error(
          `bambu-status: invalid credential payload: ${credParse.error.message}`,
        );
      }
      const credPayload = credParse.data;

      const url = `mqtts://${cfg.ip}:${cfg.mqttPort}`;
      const topic = `device/${credPayload.serial}/report`;
      const clientId = `lootgoblin-status-${printer.id}-${Math.random().toString(36).slice(2, 10)}`;

      // ----- Open the MQTT client -----
      const client: MqttClientLike = mqttFactory(url, {
        username: BAMBU_LAN_USERNAME,
        password: credPayload.accessCode,
        clientId,
        rejectUnauthorized: false,
      });

      let socketOpened = false;
      let firstPushallSeen = false;
      let closedReported = false;
      /**
       * V2-005f-CF-5a: Per-instance state for operator-cancel detection.
       * Bambu does not emit a dedicated 'CANCELLED' gcode_state — the operator
       * pressing STOP while paused results in PAUSE → IDLE without a FINISH in
       * between. We detect this state pair and synthesise a 'cancelled' event.
       *
       * This is closure-local (one variable per createBambuSubscriber() call),
       * which is correct because createBambuSubscriber() builds one instance per
       * printer subscription. No Map keyed by printerId is needed.
       *
       * NOTE: openTransport runs per reconnect attempt, so lastGcodeState resets
       * to null on each reconnect. A PAUSE→disconnect→reconnect→IDLE sequence
       * will miss the cancelled detection. Acceptable at QoS-0; T_a6 dedup is
       * unaffected since no cancelled event is emitted in that case.
       */
      let lastGcodeState: string | null = null;

      const reportClose = (): void => {
        if (closedReported) return;
        closedReported = true;
        helpers.onTransportClose(socketOpened && firstPushallSeen);
      };

      function onMqttMessage(receivedTopic: string, payload: unknown): void {
        // Ignore traffic on other topics (e.g. printer-side request echoes).
        // NOTE: Bambu's MQTT broker delivers full pushall objects regardless of
        // the subscribed topic; there is no field-level broker-side filtering.
        // The topic filter here is purely to ignore the printer-side echo on
        // `device/<serial>/request` and similar non-report topics.
        if (receivedTopic !== topic) return;
        const envelope = decodeMqttPayload(payload);
        if (envelope === null) return;
        const print = envelope.print;
        if (!print || typeof print !== 'object') return;

        // First pushall = subscribed-and-ready.
        if (!firstPushallSeen) {
          firstPushallSeen = true;
          helpers.onTransportOpen();
        }

        const currentGcodeState = print.gcode_state;

        // V2-005f-CF-5a: Operator-cancel detection (state-pair).
        // PAUSE → IDLE without an intervening FINISH means the operator
        // pressed STOP from the paused state. Emit 'cancelled' before
        // processing the IDLE state (which produces no event from mapBambuState).
        if (lastGcodeState === 'PAUSE' && currentGcodeState === 'IDLE') {
          const remoteJobRef =
            typeof print.subtask_name === 'string' ? print.subtask_name : '';
          helpers.emitProtocolEvent({
            kind: 'cancelled',
            remoteJobRef,
            occurredAt: new Date(),
            rawPayload: envelope,
          });
        }
        lastGcodeState = currentGcodeState ?? null;

        const kind = mapBambuState(currentGcodeState);
        if (kind !== null) {
          // V2-005f-CF-5a: pass print_error to buildBambuEvent for firmware_error events.
          const printError =
            kind === 'firmware_error' &&
            typeof print.print_error === 'number' &&
            Number.isFinite(print.print_error)
              ? print.print_error
              : undefined;
          helpers.emitProtocolEvent(buildBambuEvent(envelope, kind, new Date(), printError));
        }

        // V2-005f-CF-5a: HMS array — one 'warning' event per entry per pushall.
        // T_a6 downstream deduplicates repeating codes (Bambu re-emits the full
        // hms list on every pushall ~1 Hz until the condition clears), so this
        // subscriber stays simple and emits every occurrence.
        const remoteJobRef = typeof print.subtask_name === 'string' ? print.subtask_name : '';
        for (const hms of (print.hms ?? [])) {
          if (typeof hms.attr !== 'number' || typeof hms.code !== 'number') continue;
          helpers.emitProtocolEvent({
            kind: 'warning',
            remoteJobRef,
            occurredAt: new Date(),
            errorCode: formatHmsCode(hms.attr, hms.code),
            severity: hmsLevelToSeverity(hms.level ?? 0),
            rawPayload: hms,
          });
        }
      }

      client.on('connect', () => {
        socketOpened = true;
        if (typeof client.subscribe !== 'function') {
          logger.error(
            { printerId: printer.id },
            'bambu-status: MQTT client missing subscribe() — cannot proceed',
          );
          return;
        }
        client.subscribe(topic, { qos: 0 }, (err) => {
          if (err) {
            logger.warn(
              { printerId: printer.id, err: err.message, topic },
              'bambu-status: MQTT subscribe failed',
            );
          }
        });
      });

      client.on('message', (...args: unknown[]) => {
        const receivedTopic = typeof args[0] === 'string' ? args[0] : '';
        onMqttMessage(receivedTopic, args[1]);
      });

      client.on('close', () => {
        logger.info(
          { printerId: printer.id },
          'bambu-status: MQTT closed',
        );
        reportClose();
      });

      client.on('error', (...args: unknown[]) => {
        const err = args[0] as Error | undefined;
        logger.warn(
          { printerId: printer.id, err: err?.message },
          'bambu-status: MQTT error',
        );
        // Defer to the subsequent 'close' for reconnect bookkeeping.
      });

      return {
        close: () => {
          try {
            client.end(false, () => {
              // ignore — base owns reconnect via the 'close' listener.
            });
          } catch {
            // ignore close-time errors
          }
        },
      };
    },
  });
}
