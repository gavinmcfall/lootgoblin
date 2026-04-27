/**
 * Stub MeasurementSource for tests and UI mocks. NEVER registered in production.
 *
 * Construct with a fixed reading (or a function returning one). Useful for:
 *   - Unit tests that need to inject a known weight
 *   - UI mockups that want a predictable scale display
 *   - Future integration tests for the v3+ scale-agent before the real
 *     bridge is wired
 *
 * Production code MUST NOT import this stub.
 */

import type { MeasurementSource, MeasurementReading } from './types';

export class StubMeasurementSource implements MeasurementSource {
  private readonly source: () => MeasurementReading;

  /**
   * Pass either a fixed reading or a function that returns one. The function
   * form is useful for tests that want to advance the timestamp or weight
   * across multiple reads.
   */
  constructor(source: MeasurementReading | (() => MeasurementReading)) {
    this.source = typeof source === 'function' ? source : () => source;
  }

  async readWeight(): Promise<MeasurementReading> {
    return this.source();
  }
}
