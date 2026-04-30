/**
 * Real-printer smoke test — V2-005d-b T_db5.
 *
 * Skips unless LG_TEST_BAMBU_IP, LG_TEST_BAMBU_ACCESS_CODE, and
 * LG_TEST_BAMBU_SERIAL are set in the environment. CI never sets these →
 * test is a no-op there.
 *
 * Operator runs locally to validate against a real Bambu LAN-mode printer:
 *
 *   LG_TEST_BAMBU_IP=192.168.1.42 \
 *   LG_TEST_BAMBU_ACCESS_CODE=<from printer screen: Settings → WLAN → LAN Mode> \
 *   LG_TEST_BAMBU_SERIAL=<from printer screen> \
 *   LG_TEST_BAMBU_KIND=bambu_p1s \
 *   LG_TEST_BAMBU_MQTT_PORT=8883 \
 *   LG_TEST_BAMBU_FTP_PORT=990 \
 *   npx vitest run tests/integration/forge-bambu-real.test.ts
 *
 * IMPORTANT: requires Developer Mode ON (Settings → WLAN → LAN Mode → Developer
 * Mode) on firmware 01.08+ — without it, the FTPS upload succeeds but the
 * MQTT print command is rejected with "Connection refused: Not authorized".
 *
 * Calls the Bambu adapter directly with a stubbed `touchLastUsed` (no DB
 * involvement) and `startPrint=false` so a successful upload doesn't actually
 * start a print. The fixture is a tiny single-color (no AMS) `.gcode.3mf`
 * containing G28 + M84 — homing + steppers off, a no-op even if it did start.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import JSZip from 'jszip';
import pino from 'pino';

import { createBambuLanHandler } from '../../src/forge/dispatch/bambu/adapter';
import type { DispatchContext } from '../../src/forge/dispatch/handler';
import { isBambuLanKind, type BambuLanKind } from '../../src/forge/dispatch/bambu/types';

const PRINTER_IP = process.env.LG_TEST_BAMBU_IP;
const PRINTER_ACCESS_CODE = process.env.LG_TEST_BAMBU_ACCESS_CODE;
const PRINTER_SERIAL = process.env.LG_TEST_BAMBU_SERIAL;
const PRINTER_KIND = (process.env.LG_TEST_BAMBU_KIND ?? 'bambu_p1s') as BambuLanKind;
const MQTT_PORT = Number(process.env.LG_TEST_BAMBU_MQTT_PORT ?? '8883');
const FTP_PORT = Number(process.env.LG_TEST_BAMBU_FTP_PORT ?? '990');

describe.skipIf(!PRINTER_IP || !PRINTER_ACCESS_CODE || !PRINTER_SERIAL)(
  'Bambu LAN dispatcher (real printer) — V2-005d-b T_db5',
  () => {
    let tmp: string;
    let fixturePath: string;

    beforeAll(async () => {
      // Validate kind — operator may have set LG_TEST_BAMBU_KIND to a typo.
      if (!isBambuLanKind(PRINTER_KIND)) {
        throw new Error(
          `LG_TEST_BAMBU_KIND must be a BambuLanKind; got '${PRINTER_KIND}'`,
        );
      }

      // Build a tiny .gcode.3mf fixture with single-color (no AMS) slice_info.config.
      tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bambu-real-'));
      fixturePath = path.join(tmp, 'lootgoblin-real-test.gcode.3mf');

      const zip = new JSZip();
      // Minimal Bambu Studio metadata — single filament (no AMS).
      const sliceInfoConfig = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object>
    <plate id="1">
      <filament id="0" />
    </plate>
  </object>
</config>`;
      zip.file('Metadata/slice_info.config', sliceInfoConfig);
      // Tiny no-op gcode (G28 home + M84 disable steppers — even if accidentally
      // printed it's safe).
      const gcode =
        '; lootgoblin V2-005d-b real-printer smoke test\n; SAFE: startPrint=false\nG28\nM84\n';
      zip.file('Metadata/plate_1.gcode', gcode);

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      await fsp.writeFile(fixturePath, buffer);
    });

    afterAll(async () => {
      if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
    });

    it(
      'uploads a tiny .gcode.3mf to a reachable Bambu printer without starting a print',
      async () => {
        const handler = createBambuLanHandler({
          touchLastUsed: () => {
            /* no-op — no DB touch in real test */
          },
          // Default mqttFactory + ftpFactory use real network.
        });

        const stat = await fsp.stat(fixturePath);

        const ctx: DispatchContext = {
          job: {
            id: 'real-test-job-id',
            ownerId: 'real-test-owner',
            targetId: 'real-test-printer-id',
          },
          printer: {
            id: 'real-test-printer-id',
            ownerId: 'real-test-owner',
            kind: PRINTER_KIND,
            connectionConfig: {
              ip: PRINTER_IP as string,
              mqttPort: MQTT_PORT,
              ftpPort: FTP_PORT,
              startPrint: false, // SAFE: file uploads but doesn't print
              forceAmsDisabled: false,
              plateIndex: 1,
              bedType: 'auto',
              bedLevelling: true,
              flowCalibration: true,
              vibrationCalibration: true,
              layerInspect: false,
              timelapse: false,
            },
          },
          artifact: {
            storagePath: fixturePath,
            sizeBytes: stat.size,
            sha256: 'unused-in-real-test',
          },
          credential: {
            id: 'real-test-cred',
            printerId: 'real-test-printer-id',
            kind: 'bambu_lan',
            payload: {
              accessCode: PRINTER_ACCESS_CODE as string,
              serial: PRINTER_SERIAL as string,
            },
            label: 'real-test',
            lastUsedAt: null,
          },
          // Bambu adapter doesn't use HTTP, but the interface requires it.
          http: { fetch: globalThis.fetch.bind(globalThis) },
          logger: pino({ level: 'silent' }),
        };

        const outcome = await handler.dispatch(ctx);

        if (outcome.kind === 'failure') {
          throw new Error(
            `Real-printer dispatch failed: reason=${outcome.reason} details=${outcome.details ?? ''}`,
          );
        }
        expect(outcome.kind).toBe('success');
      },
      120_000, // 120s timeout — TLS handshake + FTP upload can be slow on first connection.
    );
  },
);
