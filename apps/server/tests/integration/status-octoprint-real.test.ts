/**
 * Real-printer status feed smoke test — V2-005f T_dcf15.
 *
 * Skips unless LG_TEST_OCTOPRINT_HOST and LG_TEST_OCTOPRINT_API_KEY are set
 * in the environment. CI never sets these → test is a no-op there.
 *
 * Operator runs locally to validate the live status feed against a real
 * OctoPrint instance:
 *
 *   LG_TEST_OCTOPRINT_HOST=octopi.lan \
 *   LG_TEST_OCTOPRINT_API_KEY=<from Settings → API → Application Keys> \
 *   LG_TEST_OCTOPRINT_PORT=80 \
 *   LG_TEST_OCTOPRINT_API_PATH=/api \
 *   LG_TEST_OCTOPRINT_SCHEME=http \
 *   npx vitest run tests/integration/status-octoprint-real.test.ts
 *
 * Connects the real `createOctoprintSubscriber` (no mocks) to the printer's
 * SockJS push channel, awaits at least one StatusEvent, then stops cleanly.
 * OctoPrint emits a `current` push frame within seconds of the auth handshake
 * regardless of print state.
 */
import { describe, it, expect } from 'vitest';

import { createOctoprintSubscriber } from '../../src/forge/status/subscribers/octoprint';
import type { StatusEvent, PrinterRecord, DecryptedCredential } from '../../src/forge/status/types';

const HOST = process.env.LG_TEST_OCTOPRINT_HOST;
const API_KEY = process.env.LG_TEST_OCTOPRINT_API_KEY;
const PORT = process.env.LG_TEST_OCTOPRINT_PORT ?? '80';
const API_PATH = process.env.LG_TEST_OCTOPRINT_API_PATH ?? '/api';
const SCHEME = process.env.LG_TEST_OCTOPRINT_SCHEME ?? 'http';

describe.skipIf(!HOST || !API_KEY)(
  'OctoPrint status subscriber (real printer) — V2-005f T_dcf15',
  () => {
    it('connects to a real OctoPrint instance and receives at least one status event', async () => {
      const subscriber = createOctoprintSubscriber({});
      const events: StatusEvent[] = [];

      const printer = {
        id: 'real-status-printer',
        ownerId: 'real-status-owner',
        kind: 'fdm_octoprint',
        name: 'real-status-octoprint',
        connectionConfig: {
          host: HOST as string,
          port: Number.parseInt(PORT, 10),
          scheme: SCHEME,
          apiPath: API_PATH,
          select: false,
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
        kind: 'octoprint_api_key',
        payload: { apiKey: API_KEY as string },
        label: 'real-status',
        lastUsedAt: null,
      };

      await subscriber.start(printer, credential, (e) => {
        events.push(e);
      });

      // Wait up to 15s for at least one event. OctoPrint's SockJS push opens,
      // auths, then immediately flushes a `current` payload — but the SockJS
      // handshake (info → xhr_streaming negotiate → auth) is wire-chatty so
      // we give it more headroom than Moonraker.
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
    }, 20_000); // 20s test timeout — wider for SockJS handshake.
  },
);
