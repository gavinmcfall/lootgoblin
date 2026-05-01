/**
 * Unit tests for V2-005f-T_dcf3 status types + StatusSubscriber interface.
 *
 * Type-contract smoke tests: the real value of this task is the TypeScript
 * shape, which the compiler checks at build time. These runtime asserts
 * confirm the module imports cleanly, the runtime constants re-exported
 * from `@/db/schema.forge` are present and intact, and that fake objects
 * shaped like StatusEvent / StatusSubscriber / StatusEventBus satisfy the
 * declared interfaces (the `as` annotations make tsc the real arbiter).
 */

import { describe, it, expect } from 'vitest';

import {
  STATUS_EVENT_KINDS,
  STATUS_SOURCE_PROTOCOLS,
  type StatusEvent,
  type StatusEventKind,
  type StatusSourceProtocol,
  type StatusSubscriber,
  type StatusEventBus,
  type PrinterRecord,
  type DecryptedCredential,
  type MeasuredConsumptionSlot,
} from '../../src/forge/status';

describe('V2-005f-T_dcf3 status types', () => {
  it('re-exports STATUS_EVENT_KINDS from schema.forge', () => {
    expect(STATUS_EVENT_KINDS).toEqual([
      'started',
      'progress',
      'paused',
      'resumed',
      'completed',
      'failed',
      'reconnected',
      'unreachable',
    ]);
  });

  it('re-exports STATUS_SOURCE_PROTOCOLS from schema.forge', () => {
    expect(STATUS_SOURCE_PROTOCOLS).toEqual([
      'moonraker',
      'octoprint',
      'bambu_lan',
      'sdcp',
      'chitu_network',
    ]);
  });

  it('accepts a fully-populated StatusEvent through a typed pass-through', () => {
    const slots: MeasuredConsumptionSlot[] = [
      { slot_index: 0, grams: 12.5, volume_ml: 4.2 },
      { slot_index: 1, grams: 3.0 },
    ];
    const ev: StatusEvent = {
      kind: 'completed' satisfies StatusEventKind,
      remoteJobRef: 'job-42.gcode',
      progressPct: 100,
      layerNum: 200,
      totalLayers: 200,
      remainingMin: 0,
      measuredConsumption: slots,
      rawPayload: { source: 'test' },
      occurredAt: new Date('2026-05-01T12:00:00Z'),
    };
    const passthrough = (e: StatusEvent): StatusEvent => e;
    expect(passthrough(ev)).toBe(ev);
    expect(ev.measuredConsumption?.[0]?.slot_index).toBe(0);
    expect(ev.measuredConsumption?.[0]?.grams).toBe(12.5);
    expect(ev.measuredConsumption?.[0]?.volume_ml).toBe(4.2);
  });

  it('accepts a minimal StatusEvent (only required fields)', () => {
    const ev: StatusEvent = {
      kind: 'started',
      remoteJobRef: 'foo.gcode',
      rawPayload: null,
      occurredAt: new Date(0),
    };
    expect(ev.kind).toBe('started');
    expect(ev.progressPct).toBeUndefined();
    expect(ev.measuredConsumption).toBeUndefined();
  });

  it('supports a fake StatusSubscriber implementation satisfying the interface', async () => {
    let connected = false;
    let started = 0;
    let stopped = 0;
    const events: StatusEvent[] = [];

    const protocol: StatusSourceProtocol = 'moonraker';

    const subscriber: StatusSubscriber = {
      protocol,
      printerKind: 'fdm_klipper',
      async start(
        _printer: PrinterRecord,
        _credential: DecryptedCredential | null,
        onEvent: (event: StatusEvent) => void,
      ): Promise<void> {
        started += 1;
        connected = true;
        onEvent({
          kind: 'started',
          remoteJobRef: 'fake.gcode',
          rawPayload: { ok: true },
          occurredAt: new Date(),
        });
      },
      async stop(): Promise<void> {
        stopped += 1;
        connected = false;
      },
      isConnected(): boolean {
        return connected;
      },
    };

    expect(subscriber.protocol).toBe('moonraker');
    expect(subscriber.printerKind).toBe('fdm_klipper');
    expect(subscriber.isConnected()).toBe(false);

    await subscriber.start(
      // Cast: the test doesn't need a real Drizzle row, only the type slot.
      {} as PrinterRecord,
      null,
      (e) => {
        events.push(e);
      },
    );
    expect(started).toBe(1);
    expect(subscriber.isConnected()).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('started');

    await subscriber.stop();
    expect(stopped).toBe(1);
    expect(subscriber.isConnected()).toBe(false);
  });

  it('supports a fake StatusEventBus implementation satisfying the interface', () => {
    const listeners = new Map<string, Set<(e: StatusEvent) => void>>();
    const bus: StatusEventBus = {
      emit(dispatchJobId, event) {
        for (const fn of listeners.get(dispatchJobId) ?? []) fn(event);
      },
      subscribe(dispatchJobId, listener) {
        let set = listeners.get(dispatchJobId);
        if (!set) {
          set = new Set();
          listeners.set(dispatchJobId, set);
        }
        set.add(listener);
        return () => {
          set!.delete(listener);
        };
      },
    };

    const seen: StatusEvent[] = [];
    const unsubscribe = bus.subscribe('dispatch-1', (e) => {
      seen.push(e);
    });

    const ev: StatusEvent = {
      kind: 'progress',
      remoteJobRef: 'foo.gcode',
      progressPct: 50,
      rawPayload: { p: 50 },
      occurredAt: new Date(),
    };
    bus.emit('dispatch-1', ev);
    bus.emit('dispatch-2', ev); // different job — listener should not fire
    expect(seen).toEqual([ev]);

    unsubscribe();
    bus.emit('dispatch-1', ev);
    expect(seen).toEqual([ev]); // still just one — unsubscribed
  });
});
