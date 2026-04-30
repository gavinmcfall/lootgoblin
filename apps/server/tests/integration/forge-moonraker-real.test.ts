/**
 * Real-printer smoke test — V2-005d-a T_da7.
 *
 * Skips unless LG_TEST_MOONRAKER_HOST and LG_TEST_MOONRAKER_API_KEY are set
 * in the environment. CI never sets these → test is a no-op there.
 *
 * Operator runs locally to validate against a real Klipper instance:
 *
 *   LG_TEST_MOONRAKER_HOST=voron.lan \
 *   LG_TEST_MOONRAKER_API_KEY=<from /access/api_key> \
 *   LG_TEST_MOONRAKER_PORT=7125 \
 *   npx vitest run tests/integration/forge-moonraker-real.test.ts
 *
 * Calls the Moonraker adapter directly with a stubbed `touchLastUsed` (no DB
 * involvement) and `startPrint=false` so a successful upload doesn't actually
 * start a print. The fixture gcode is just G28 + M84 — homing + steppers off,
 * a no-op even if it did start.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import pino from 'pino';

import { createMoonrakerHandler } from '../../src/forge/dispatch/moonraker/adapter';
import type { DispatchContext } from '../../src/forge/dispatch/handler';

const PRINTER_HOST = process.env.LG_TEST_MOONRAKER_HOST;
const PRINTER_API_KEY = process.env.LG_TEST_MOONRAKER_API_KEY;
const PRINTER_PORT = process.env.LG_TEST_MOONRAKER_PORT ?? '7125';

describe.skipIf(!PRINTER_HOST || !PRINTER_API_KEY)(
  'Moonraker dispatcher (real printer) — V2-005d-a T_da7',
  () => {
    it('uploads a tiny gcode fixture to a reachable printer without starting a print', async () => {
      // 1. Build a tiny no-op gcode file in a tmpdir.
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'moonraker-real-'));
      const filePath = path.join(tmp, 'lootgoblin-real-test.gcode');
      const content =
        '; lootgoblin V2-005d-a real-printer smoke test\n; SAFE: print=false\nG28\nM84\n';
      await fsp.writeFile(filePath, content);
      const sizeBytes = (await fsp.stat(filePath)).size;
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');

      // 2. Build the adapter with a stubbed touchLastUsed (we don't want any
      //    DB side-effects in this test).
      const handler = createMoonrakerHandler({
        touchLastUsed: () => {
          /* no-op */
        },
      });

      // 3. Build a DispatchContext with real fetch + startPrint=false.
      const ctx: DispatchContext = {
        job: {
          id: 'real-test-job-id',
          ownerId: 'real-test-owner',
          targetId: 'real-test-printer-id',
        },
        printer: {
          id: 'real-test-printer-id',
          ownerId: 'real-test-owner',
          kind: 'fdm_klipper',
          connectionConfig: {
            host: PRINTER_HOST as string,
            port: Number.parseInt(PRINTER_PORT, 10),
            scheme: 'http',
            startPrint: false,
            requiresAuth: true,
          },
        },
        artifact: { storagePath: filePath, sizeBytes, sha256 },
        credential: {
          id: 'real-test-cred',
          printerId: 'real-test-printer-id',
          kind: 'moonraker_api_key',
          payload: { apiKey: PRINTER_API_KEY as string },
          label: 'real-test',
          lastUsedAt: null,
        },
        http: { fetch: globalThis.fetch.bind(globalThis) },
        logger: pino({ level: 'silent' }),
      };

      // 4. Run the dispatch.
      const outcome = await handler.dispatch(ctx);

      // 5. Cleanup tmpdir before assertions so a failure still cleans up.
      await fsp.rm(tmp, { recursive: true, force: true });

      // 6. Assert success.
      expect(outcome.kind).toBe('success');
      if (outcome.kind === 'success') {
        expect(outcome.remoteFilename).toBeTruthy();
      }
    }, 90_000); // wider timeout — real-network upload, Moonraker may be slow.
  },
);
