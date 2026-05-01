/**
 * Real-printer smoke test — V2-005d-c T_dc13.
 *
 * Skips unless LG_TEST_SDCP_IP and LG_TEST_SDCP_MAINBOARD_ID are set in the
 * environment. CI never sets these → test is a no-op there.
 *
 * Operator runs locally to validate against a real SDCP 3.0 resin printer
 * (Elegoo Saturn 4+/Mars 5+):
 *
 *   LG_TEST_SDCP_IP=192.168.1.42 \
 *   LG_TEST_SDCP_MAINBOARD_ID=<from printer info screen or UDP discovery> \
 *   LG_TEST_SDCP_KIND=sdcp_elegoo_saturn_4_ultra \
 *   LG_TEST_SDCP_PORT=3030 \
 *   npx vitest run tests/integration/forge-sdcp-real.test.ts
 *
 * Calls the SDCP adapter directly with a stubbed `touchLastUsed` (no DB
 * involvement) and `startPrint=false` so a successful upload doesn't actually
 * start a print. The fixture is a tiny .ctb-named buffer — SDCP printers are
 * open-board and accept whatever bytes arrive at /local/<name>.ctb without
 * a print-start command (Cmd 128 is gated by startPrint=false).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import pino from 'pino';

import { createSdcpHandler } from '../../src/forge/dispatch/sdcp/adapter';
import type { DispatchContext } from '../../src/forge/dispatch/handler';
import { isSdcpKind, type SdcpKind } from '../../src/forge/dispatch/sdcp/types';

const PRINTER_IP = process.env.LG_TEST_SDCP_IP;
const PRINTER_MAINBOARD_ID = process.env.LG_TEST_SDCP_MAINBOARD_ID;
const PRINTER_KIND = (process.env.LG_TEST_SDCP_KIND ?? 'sdcp_elegoo_saturn_4_ultra') as SdcpKind;
const PRINTER_PORT = Number(process.env.LG_TEST_SDCP_PORT ?? '3030');

describe.skipIf(!PRINTER_IP || !PRINTER_MAINBOARD_ID)(
  'SDCP dispatcher (real printer) — V2-005d-c T_dc13',
  () => {
    let tmp: string;
    let fixturePath: string;

    beforeAll(async () => {
      // Validate kind — operator may have set LG_TEST_SDCP_KIND to a typo.
      if (!isSdcpKind(PRINTER_KIND)) {
        throw new Error(
          `LG_TEST_SDCP_KIND must be an SdcpKind; got '${PRINTER_KIND}'`,
        );
      }

      // Build a tiny .ctb fixture in tmpdir. SDCP printers accept arbitrary
      // bytes at /local/<name>.ctb when startPrint=false (no Cmd 128 issued).
      // Use the plain CTB v4 magic for visual realism; the printer never
      // parses the slice header on upload-only.
      tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sdcp-real-'));
      fixturePath = path.join(tmp, 'lootgoblin-real-test.ctb');

      const PLAIN_CTB_V4_MAGIC = Buffer.from([0x12, 0xfd, 0x90, 0xc0]);
      const padding = Buffer.alloc(1020, 0); // 1024 bytes total
      await fsp.writeFile(fixturePath, Buffer.concat([PLAIN_CTB_V4_MAGIC, padding]));
    });

    afterAll(async () => {
      if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
    });

    it(
      'uploads a tiny .ctb to a reachable SDCP printer without starting a print',
      async () => {
        const handler = createSdcpHandler({
          touchLastUsed: () => {
            /* no-op — no DB touch in real test */
          },
          // Default httpClient + mqttFactory use real network.
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
              mainboardId: PRINTER_MAINBOARD_ID as string,
              port: PRINTER_PORT,
              startPrint: false, // SAFE: file uploads but doesn't print
              startLayer: 0,
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
            kind: 'sdcp_passcode',
            payload: {},
            label: 'real-test',
            lastUsedAt: null,
          },
          // SDCP adapter doesn't use the http context surface (it has its own
          // chunked uploader), but the interface requires it.
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
      120_000, // 120s timeout — chunked HTTP upload + connect can be slow on first connection.
    );
  },
);
