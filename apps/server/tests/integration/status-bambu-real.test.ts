/**
 * Real-printer status feed smoke test — V2-005f T_dcf15.
 *
 * Skips unless LG_TEST_BAMBU_IP, LG_TEST_BAMBU_ACCESS_CODE, and
 * LG_TEST_BAMBU_SERIAL are set in the environment. CI never sets these →
 * test is a no-op there.
 *
 * Operator runs locally to validate the live status feed against a real
 * Bambu LAN-mode printer:
 *
 *   LG_TEST_BAMBU_IP=192.168.1.42 \
 *   LG_TEST_BAMBU_ACCESS_CODE=<from printer screen: Settings → WLAN → LAN Mode> \
 *   LG_TEST_BAMBU_SERIAL=<from printer screen> \
 *   LG_TEST_BAMBU_KIND=bambu_p1s \
 *   npx vitest run tests/integration/status-bambu-real.test.ts
 *
 * IMPORTANT: requires Developer Mode ON (firmware 01.08+) and the printer to
 * be powered on. Bambu emits a `pushall` (full status snapshot) within a
 * couple of seconds of MQTT subscribe — no print needs to be active.
 */
import { describe, it, expect } from 'vitest';

import { createBambuSubscriber } from '../../src/forge/status/subscribers/bambu';
import { isBambuLanKind, type BambuLanKind } from '../../src/forge/dispatch/bambu/types';
import type { StatusEvent, PrinterRecord, DecryptedCredential } from '../../src/forge/status/types';

const PRINTER_IP = process.env.LG_TEST_BAMBU_IP;
const ACCESS_CODE = process.env.LG_TEST_BAMBU_ACCESS_CODE;
const SERIAL = process.env.LG_TEST_BAMBU_SERIAL;
const PRINTER_KIND = (process.env.LG_TEST_BAMBU_KIND ?? 'bambu_x1c') as BambuLanKind;

describe.skipIf(!PRINTER_IP || !ACCESS_CODE || !SERIAL)(
  'Bambu LAN status subscriber (real printer) — V2-005f T_dcf15',
  () => {
    it('connects to a real Bambu printer over MQTT and receives at least one status event', async () => {
      if (!isBambuLanKind(PRINTER_KIND)) {
        throw new Error(
          `LG_TEST_BAMBU_KIND must be a BambuLanKind; got '${PRINTER_KIND}'`,
        );
      }

      const subscriber = createBambuSubscriber({ printerKind: PRINTER_KIND });
      const events: StatusEvent[] = [];

      const printer = {
        id: 'real-status-printer',
        ownerId: 'real-status-owner',
        kind: PRINTER_KIND,
        name: 'real-status-bambu',
        connectionConfig: {
          ip: PRINTER_IP as string,
          mqttPort: 8883,
          ftpPort: 990,
          startPrint: false,
          forceAmsDisabled: false,
          plateIndex: 1,
          bedType: 'auto',
          bedLevelling: true,
          flowCalibration: true,
          vibrationCalibration: true,
          layerInspect: false,
          timelapse: false,
          accessCode: ACCESS_CODE as string,
          serial: SERIAL as string,
        },
        statusLastSeen: null,
        active: true,
        idempotencyKey: null,
        createdAt: new Date(),
      } as unknown as PrinterRecord;

      const credential: DecryptedCredential = {
        id: 'real-status-cred',
        printerId: printer.id,
        kind: 'bambu_lan',
        payload: {
          accessCode: ACCESS_CODE as string,
          serial: SERIAL as string,
        },
        label: 'real-status',
        lastUsedAt: null,
      };

      await subscriber.start(printer, credential, (e) => {
        events.push(e);
      });

      // Wait up to 15s — Bambu pushall typically arrives within 2-3s of
      // MQTT subscribe but TLS handshake on first connection adds latency.
      try {
        await new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const checkInterval = setInterval(() => {
            if (events.length > 0) {
              clearInterval(checkInterval);
              resolve();
              return;
            }
            if (Date.now() - start > 15_000) {
              clearInterval(checkInterval);
              reject(new Error('no status events received in 15s'));
            }
          }, 100);
        });

        expect(events.length).toBeGreaterThan(0);
        expect(subscriber.isConnected()).toBe(true);
      } finally {
        await subscriber.stop();
      }

      expect(subscriber.isConnected()).toBe(false);
    }, 25_000); // 25s test timeout — TLS handshake on first MQTT connect can be slow.
  },
);
