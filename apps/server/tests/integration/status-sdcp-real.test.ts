/**
 * Real-printer status feed smoke test — V2-005f T_dcf15.
 *
 * Skips unless LG_TEST_SDCP_IP and LG_TEST_SDCP_MAINBOARD_ID are set in the
 * environment. CI never sets these → test is a no-op there.
 *
 * Operator runs locally to validate the live status feed against a real
 * SDCP 3.0 resin printer (Elegoo Saturn 4+/Mars 5+, Anycubic Photon, etc.):
 *
 *   LG_TEST_SDCP_IP=192.168.1.42 \
 *   LG_TEST_SDCP_MAINBOARD_ID=<from printer info screen or UDP discovery> \
 *   LG_TEST_SDCP_KIND=sdcp_elegoo_saturn_4 \
 *   LG_TEST_SDCP_PORT=3030 \
 *   npx vitest run tests/integration/status-sdcp-real.test.ts
 *
 * SDCP is quieter than FDM protocols — status messages only flow during an
 * active print or in response to subscribe-reply. We give 30s for the
 * subscribe-reply to arrive.
 */
import { describe, it, expect } from 'vitest';

import { createSdcpSubscriber } from '../../src/forge/status/subscribers/sdcp';
import { isSdcpKind, type SdcpKind } from '../../src/forge/dispatch/sdcp/types';
import type { StatusEvent, PrinterRecord } from '../../src/forge/status/types';

const PRINTER_IP = process.env.LG_TEST_SDCP_IP;
const MAINBOARD_ID = process.env.LG_TEST_SDCP_MAINBOARD_ID;
const PRINTER_KIND = (process.env.LG_TEST_SDCP_KIND ?? 'sdcp_elegoo_saturn_4') as SdcpKind;
const PRINTER_PORT = Number(process.env.LG_TEST_SDCP_PORT ?? '3030');

describe.skipIf(!PRINTER_IP || !MAINBOARD_ID)(
  'SDCP status subscriber (real printer) — V2-005f T_dcf15',
  () => {
    it('connects to a real SDCP resin printer and receives at least one status event', async () => {
      if (!isSdcpKind(PRINTER_KIND)) {
        throw new Error(
          `LG_TEST_SDCP_KIND must be an SdcpKind; got '${PRINTER_KIND}'`,
        );
      }

      const subscriber = createSdcpSubscriber({ printerKind: PRINTER_KIND });
      const events: StatusEvent[] = [];

      const printer = {
        id: 'real-status-printer',
        ownerId: 'real-status-owner',
        kind: PRINTER_KIND,
        name: 'real-status-sdcp',
        connectionConfig: {
          ip: PRINTER_IP as string,
          mainboardId: MAINBOARD_ID as string,
          port: PRINTER_PORT,
          startPrint: false,
          startLayer: 0,
        },
        statusLastSeen: null,
        active: true,
        idempotencyKey: null,
        createdAt: new Date(),
      } as unknown as PrinterRecord;

      // SDCP uses 'sdcp_passcode' credentials but the payload is empty for
      // current firmware (no auth at the protocol level on LAN).
      await subscriber.start(printer, null, (e) => {
        events.push(e);
      });

      // Wait up to 30s — SDCP only emits when there's an active print OR
      // when the subscribe-reply arrives. The reply itself is the synthetic
      // `reconnected` event, which counts.
      try {
        await new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const checkInterval = setInterval(() => {
            if (events.length > 0) {
              clearInterval(checkInterval);
              resolve();
              return;
            }
            if (Date.now() - start > 30_000) {
              clearInterval(checkInterval);
              reject(new Error('no status events received in 30s'));
            }
          }, 200);
        });

        expect(events.length).toBeGreaterThan(0);
        expect(subscriber.isConnected()).toBe(true);
      } finally {
        await subscriber.stop();
      }

      expect(subscriber.isConnected()).toBe(false);
    }, 35_000); // 35s test timeout — resin printers are quieter than FDM.
  },
);
