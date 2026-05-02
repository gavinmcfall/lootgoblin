/**
 * Real-printer status feed smoke test — V2-005f T_dcf15.
 *
 * Skips unless LG_TEST_MOONRAKER_HOST and LG_TEST_MOONRAKER_API_KEY are set
 * in the environment. CI never sets these → test is a no-op there.
 *
 * Operator runs locally to validate the live status feed against a real
 * Klipper / Moonraker instance:
 *
 *   LG_TEST_MOONRAKER_HOST=voron.lan \
 *   LG_TEST_MOONRAKER_API_KEY=<from /access/api_key> \
 *   LG_TEST_MOONRAKER_PORT=7125 \
 *   npx vitest run tests/integration/status-moonraker-real.test.ts
 *
 * Connects the real `createMoonrakerSubscriber` (no mocks) to the printer's
 * WebSocket, awaits at least one StatusEvent (any kind — `progress`,
 * `paused`, `completed`, or the synthetic `reconnected` connectivity event),
 * then stops cleanly. No print is started — this just validates the WS
 * upgrade + JSON-RPC subscribe handshake produces events.
 */
import { describe, it, expect } from 'vitest';

import { createMoonrakerSubscriber } from '../../src/forge/status/subscribers/moonraker';
import type { StatusEvent, PrinterRecord, DecryptedCredential } from '../../src/forge/status/types';

const HOST = process.env.LG_TEST_MOONRAKER_HOST;
const API_KEY = process.env.LG_TEST_MOONRAKER_API_KEY;
const PORT = process.env.LG_TEST_MOONRAKER_PORT ?? '7125';

describe.skipIf(!HOST || !API_KEY)(
  'Moonraker status subscriber (real printer) — V2-005f T_dcf15',
  () => {
    it('connects to a real Klipper instance and receives at least one status event', async () => {
      const subscriber = createMoonrakerSubscriber({});
      const events: StatusEvent[] = [];

      const printer = {
        id: 'real-status-printer',
        ownerId: 'real-status-owner',
        kind: 'fdm_klipper',
        name: 'real-status-moonraker',
        connectionConfig: {
          host: HOST as string,
          port: Number.parseInt(PORT, 10),
          scheme: 'http',
          startPrint: false,
          requiresAuth: true,
        },
        statusLastSeen: null,
        active: true,
        idempotencyKey: null,
        createdAt: new Date(),
      } as unknown as PrinterRecord;

      const credential: DecryptedCredential = {
        id: 'real-status-cred',
        printerId: printer.id,
        kind: 'moonraker_api_key',
        payload: { apiKey: API_KEY as string },
        label: 'real-status',
        lastUsedAt: null,
      };

      await subscriber.start(printer, credential, (e) => {
        events.push(e);
      });

      // Wait up to 10s for at least one event — Moonraker publishes the
      // initial subscribe-reply + a `notify_status_update` immediately on
      // attach, so any reachable instance should fire well within this.
      try {
        await new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const checkInterval = setInterval(() => {
            if (events.length > 0) {
              clearInterval(checkInterval);
              resolve();
              return;
            }
            if (Date.now() - start > 10_000) {
              clearInterval(checkInterval);
              reject(new Error('no status events received in 10s'));
            }
          }, 100);
        });

        expect(events.length).toBeGreaterThan(0);
        expect(subscriber.isConnected()).toBe(true);
      } finally {
        await subscriber.stop();
      }

      expect(subscriber.isConnected()).toBe(false);
    }, 15_000); // 15s test timeout — generous for real-network handshake.
  },
);
