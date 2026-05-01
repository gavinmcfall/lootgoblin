/**
 * types.ts — V2-005f-T_dcf3
 *
 * Module-level types for the per-printer status feed subsystem.
 *
 * Locked decisions reflected here:
 *   - Per-printer subscription model: one StatusSubscriber instance per
 *     printer (NOT per dispatch_job). T_dcf9 worker manages lifecycle —
 *     `start()` runs once when the first active dispatch lands; `stop()`
 *     fires when no active dispatches remain.
 *   - Lazy-start lifecycle: subscribers stay disconnected until needed.
 *     `isConnected()` is the UI-facing surface for the live-status indicator.
 *   - Raw payload preserved: every emitted StatusEvent carries the
 *     protocol-native payload in `rawPayload`, which the worker writes into
 *     `dispatch_status_events.event_data` as a per-protocol JSON blob (audit
 *     log) before the typed cache columns get updated.
 *   - Snake_case wire shape: `measuredConsumption[i]` uses snake_case keys
 *     (`slot_index`, `grams`, `volume_ml`) so it serializes compatibly with
 *     T_dcf1 `MaterialsUsedEntry` and T_dcf2 `SlicerEstimateSlot`. Other
 *     StatusEvent fields are camelCase TS-side API names that never hit the
 *     wire directly.
 *
 * Re-exports: `StatusEventKind` / `STATUS_EVENT_KINDS` /
 * `StatusSourceProtocol` / `STATUS_SOURCE_PROTOCOLS` come from
 * `@/db/schema.forge` (T_dcf1) — do not redefine. `PrinterRecord` is the
 * Drizzle row type for the `printers` table; `DecryptedCredential` is the
 * existing per-printer credential type from `@/forge/dispatch/credentials`
 * (V2-005d-a T_da2). Single-source-of-truth across the status pipeline.
 *
 * Pure type module — no DB, network, or filesystem dependencies. T_dcf12
 * implements `StatusEventBus`; T_dcf4–8 implement protocol-specific
 * `StatusSubscriber`s; T_dcf9 wires them to the worker.
 */

import type { printers } from '@/db/schema.forge';
import {
  STATUS_EVENT_KINDS,
  STATUS_SOURCE_PROTOCOLS,
  type StatusEventKind,
  type StatusSourceProtocol,
} from '@/db/schema.forge';
import type { DecryptedCredential } from '@/forge/dispatch/credentials';

export {
  STATUS_EVENT_KINDS,
  STATUS_SOURCE_PROTOCOLS,
  type StatusEventKind,
  type StatusSourceProtocol,
  type DecryptedCredential,
};

/** Drizzle row type for the `printers` table. */
export type PrinterRecord = typeof printers.$inferSelect;

/**
 * One slot's worth of printer-reported consumption attributed to a dispatch
 * job. Emitted on `completed` / `failed` events when the protocol surfaces
 * per-slot consumption (e.g. Bambu AMS weight delta). Snake_case to match
 * the on-disk wire shape used by T_dcf1 `MaterialsUsedEntry` and T_dcf2
 * `SlicerEstimateSlot`.
 */
export interface MeasuredConsumptionSlot {
  slot_index: number;
  grams: number;
  volume_ml?: number;
  /**
   * Bambu AMS / similar protocols: tray remaining as percentage 0–100.
   * Surfaced when the printer reports remaining-stock as a percentage rather
   * than an absolute mass. T_dcf11 uses this together with the slicer-derived
   * `materials_used` estimate to back-calculate measured grams.
   */
  remain_percent?: number;
}

/**
 * A single status update from a printer's live feed. Emitted by a
 * `StatusSubscriber` via the `onEvent` callback.
 *
 *   kind                — discriminator for what happened (see
 *                         `STATUS_EVENT_KINDS`).
 *   remoteJobRef        — the printer's own identifier for the job. Most
 *                         protocols use the uploaded filename; Bambu MQTT
 *                         uses `sequence_id`. Worker correlates this back
 *                         to the dispatch_job that owns the print.
 *   progressPct         — 0..100 print progress, when reported.
 *   layerNum            — current layer index, when reported (FDM only).
 *   totalLayers         — total layers in the print, when reported.
 *   remainingMin        — printer's own remaining-time estimate, in
 *                         minutes, when reported.
 *   measuredConsumption — per-slot consumption populated on `completed`
 *                         (and sometimes `failed`) events when the
 *                         protocol exposes it. Empty / undefined otherwise.
 *   rawPayload          — the protocol-native payload, persisted as-is to
 *                         `dispatch_status_events.event_data` for the audit
 *                         log. Shape varies per `StatusSourceProtocol`.
 *   occurredAt          — printer's clock when known, otherwise the
 *                         subscriber's ingest clock at emit time.
 */
export interface StatusEvent {
  kind: StatusEventKind;
  remoteJobRef: string;
  progressPct?: number;
  layerNum?: number;
  totalLayers?: number;
  remainingMin?: number;
  measuredConsumption?: MeasuredConsumptionSlot[];
  rawPayload: unknown;
  occurredAt: Date;
}

/**
 * Per-protocol live status feed for a single printer.
 *
 * Lifecycle is owned by T_dcf9's status worker:
 *   - `start()` is invoked once when the first active dispatch lands on
 *     the printer. Implementations open the protocol-specific transport
 *     (Moonraker WebSocket, OctoPrint SSE, Bambu MQTT, etc.) and begin
 *     emitting events via `onEvent`.
 *   - `stop()` is invoked when no active dispatches remain on the printer.
 *     Implementations must release every transport-level resource
 *     (sockets, timers, listeners). Idempotent: safe to call when already
 *     stopped.
 *   - `isConnected()` is the UI-facing connectivity flag. It must stay
 *     accurate across reconnects and feeds the live-status indicator.
 *
 * Implementations are pure protocol clients — they do NOT touch the DB or
 * the SSE bus directly. The worker routes `onEvent` callbacks into both
 * (event persistence + broadcast).
 */
export interface StatusSubscriber {
  /** Wire protocol used by this subscriber (NOT the printer model). */
  protocol: StatusSourceProtocol;
  /** Matches `printers.kind` (e.g. `fdm_klipper`, `bambu_x1c`). */
  printerKind: string;
  /**
   * Open the connection and start emitting events. Called once per
   * subscriber instance, when the first active dispatch lands.
   */
  start(
    printer: PrinterRecord,
    credential: DecryptedCredential | null,
    onEvent: (event: StatusEvent) => void,
  ): Promise<void>;
  /**
   * Close the connection and release all resources. Called when no
   * active dispatches remain. Must be idempotent.
   */
  stop(): Promise<void>;
  /** True when the underlying transport is currently connected. */
  isConnected(): boolean;
}

/**
 * In-memory pub/sub for live StatusEvents. T_dcf12 implements this and
 * wires it to the SSE transport on `/api/v1/forge/dispatch/:id/events`.
 * T_dcf3 only declares the contract so subscribers (T_dcf4–8) and the
 * status worker (T_dcf9) can take it as a typed dependency.
 *
 * Scope is per-`dispatchJobId`: SSE clients subscribe to a single dispatch
 * and receive only its events. The worker calls `emit()` after persisting
 * each event to `dispatch_status_events`.
 */
export interface StatusEventBus {
  /** Broadcast an event to all listeners for the given dispatch job. */
  emit(dispatchJobId: string, event: StatusEvent): void;
  /**
   * Subscribe to events for a single dispatch job. Returns an unsubscribe
   * function — listeners must call it on disconnect to avoid leaks.
   */
  subscribe(
    dispatchJobId: string,
    listener: (event: StatusEvent) => void,
  ): () => void;
}
