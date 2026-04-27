/**
 * Measurement Source seam — V2-007a-T9
 *
 * INTERFACE ONLY. No implementations are registered in v2-007a per ADR-010.
 *
 * Future use (v3+): a scale-agent (running on a Pi or microcontroller bridge)
 * implements this interface and registers with the lootgoblin server. Mix +
 * Recycle + Consumption flows can then accept readings with provenanceClass=
 * 'measured' instead of relying on user manual entry ('entered').
 *
 * The integration design is documented in user memory:
 * `project_planned_scale_integration.md`.
 *
 * Why interface-only now:
 *   - Locks the contract before any consumer is written.
 *   - Allows tests + UI mockups to use a stub implementation.
 *   - Avoids committing to MQTT / WebSocket / HTTP-polling at this layer.
 *
 * Future implementers MUST satisfy this interface and provide:
 *   - Stable deviceId across reconnects (so historical readings have continuity)
 *   - Tare-aware weight (subtract scale tare if applicable; report both)
 *   - Monotonic timestamps for a single device
 *   - Idempotent calls (same reading returned if no change since last call)
 */

/**
 * A single weight reading from a measurement source.
 *
 * weight_g and tare_g are both in GRAMS regardless of underlying scale unit
 * (the implementer is responsible for unit conversion). The handler in T8
 * consumption + T5 mix + T6 recycle expects grams.
 */
export interface MeasurementReading {
  /**
   * Stable identifier for the source device. Survives reconnects.
   * e.g. "pi-scale-01", "esp-bridge-kitchen", "manual-entry-stub".
   */
  deviceId: string;
  /** Net weight in grams. May be negative (tare > current) or zero. */
  weight_g: number;
  /** Tare offset in grams. 0 if no tare applied or unknown. */
  tare_g: number;
  /** Reading timestamp from the device. Independent of server clock. */
  timestamp: Date;
}

/**
 * The seam. v3+ implementations register concrete classes that satisfy this.
 *
 * v2-007a ships ONE stub implementation in `apps/server/src/measurement/stub.ts`
 * usable for tests and UI mocks; never registered in production.
 */
export interface MeasurementSource {
  /**
   * Returns the current reading. Implementations should be cheap (cached
   * value or quick HTTP call); long-polling implementations should expose
   * a separate stream API which is OUT OF SCOPE for v2-007a.
   *
   * MUST NOT throw under normal conditions. If the device is offline,
   * implementations should throw a `MeasurementSourceError` with a
   * structured `code` field (defined separately in v3+ if needed).
   */
  readWeight(): Promise<MeasurementReading>;
}
