/**
 * Real-printer status feed smoke test — V2-005f T_dcf15.
 *
 * Skips unless LG_TEST_CHITU_IP is set in the environment. CI never sets
 * it → test is a no-op there.
 *
 * Operator runs locally to validate the live status feed against a real
 * ChituBox legacy-network printer (Phrozen Sonic 8K family, Uniformation
 * GKtwo/GKone, or legacy-firmware Elegoo):
 *
 *   LG_TEST_CHITU_IP=192.168.1.43 \
 *   LG_TEST_CHITU_KIND=chitu_network_phrozen_sonic_mighty_8k \
 *   LG_TEST_CHITU_PORT=3000 \
 *   npx vitest run tests/integration/status-chitu-real.test.ts
 *
 * ChituNetwork uses adaptive M27 polling. The IDLE-state cadence is 60s, so
 * to keep the test fast we call `notifyPrinting()` immediately after start
 * to force the PRINTING state (10s polls) — the next M27 reply (or the
 * synthetic `reconnected` connectivity event) is then surfaced quickly.
 */
import { describe, it, expect } from 'vitest';

import { createChituNetworkSubscriber } from '../../src/forge/status/subscribers/chitu-network';
import {
  isChituNetworkKind,
  type ChituNetworkKind,
} from '../../src/forge/dispatch/chitu-network/types';
import type { StatusEvent, PrinterRecord } from '../../src/forge/status/types';

const PRINTER_IP = process.env.LG_TEST_CHITU_IP;
const PRINTER_KIND = (process.env.LG_TEST_CHITU_KIND ??
  'chitu_network_phrozen_sonic_mighty_8k') as ChituNetworkKind;
const PRINTER_PORT = Number(process.env.LG_TEST_CHITU_PORT ?? '3000');

describe.skipIf(!PRINTER_IP)(
  'ChituNetwork status subscriber (real printer) — V2-005f T_dcf15',
  () => {
    it('connects to a real ChituNetwork printer and receives at least one status event', async () => {
      if (!isChituNetworkKind(PRINTER_KIND)) {
        throw new Error(
          `LG_TEST_CHITU_KIND must be a ChituNetworkKind; got '${PRINTER_KIND}'`,
        );
      }

      const subscriber = createChituNetworkSubscriber({ printerKind: PRINTER_KIND });
      const events: StatusEvent[] = [];

      const printer = {
        id: 'real-status-printer',
        ownerId: 'real-status-owner',
        kind: PRINTER_KIND,
        name: 'real-status-chitu',
        connectionConfig: {
          ip: PRINTER_IP as string,
          port: PRINTER_PORT,
          startPrint: false,
          stageTimeoutMs: 60_000,
        },
        statusLastSeen: null,
        active: true,
        idempotencyKey: null,
        createdAt: new Date(),
      } as unknown as PrinterRecord;

      await subscriber.start(printer, null, (e) => {
        events.push(e);
      });

      // Force the IDLE→PRINTING cadence so we don't have to wait 60s for the
      // first M27. notifyPrinting is the worker-extended seam from T_dcf8.
      // Small delay so the TCP connect has settled before we ask the state
      // machine to advance.
      await new Promise((r) => setTimeout(r, 500));
      subscriber.notifyPrinting();

      // Wait up to 25s for at least one event (M27 reply OR synthetic
      // `reconnected` from base-class transport-open).
      try {
        await new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const checkInterval = setInterval(() => {
            if (events.length > 0) {
              clearInterval(checkInterval);
              resolve();
              return;
            }
            if (Date.now() - start > 25_000) {
              clearInterval(checkInterval);
              reject(new Error('no status events received in 25s'));
            }
          }, 200);
        });

        expect(events.length).toBeGreaterThan(0);
        expect(subscriber.isConnected()).toBe(true);
      } finally {
        await subscriber.stop();
      }

      expect(subscriber.isConnected()).toBe(false);
    }, 30_000); // 30s test timeout — TCP connect + adaptive poll cadence.
  },
);
