/**
 * Real-printer smoke test — V2-005d-c T_dc13.
 *
 * Skips unless LG_TEST_CHITU_IP is set in the environment. CI never sets it
 * → test is a no-op there.
 *
 * Operator runs locally to validate against a real ChituBox legacy network
 * resin printer (Phrozen Sonic 8K family, Uniformation GKtwo/GKone, or
 * legacy-firmware Elegoo):
 *
 *   LG_TEST_CHITU_IP=192.168.1.43 \
 *   LG_TEST_CHITU_KIND=chitu_network_phrozen_sonic_mighty_8k \
 *   LG_TEST_CHITU_PORT=3000 \
 *   npx vitest run tests/integration/forge-chitu-real.test.ts
 *
 * Calls the ChituNetwork adapter directly with a stubbed `touchLastUsed` (no
 * DB involvement) and `startPrint=false` so a successful upload (M28 + chunks
 * + M29) doesn't issue M6030 to actually start a print. The fixture is a
 * tiny encrypted-CTB-magic-prefixed buffer so the dispatcher's encrypted-CTB
 * gate accepts it for kinds that require encrypted CTB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import pino from 'pino';

import { createChituNetworkHandler } from '../../src/forge/dispatch/chitu-network/adapter';
import type { DispatchContext } from '../../src/forge/dispatch/handler';
import {
  isChituNetworkKind,
  type ChituNetworkKind,
} from '../../src/forge/dispatch/chitu-network/types';

const PRINTER_IP = process.env.LG_TEST_CHITU_IP;
const PRINTER_KIND = (process.env.LG_TEST_CHITU_KIND ??
  'chitu_network_phrozen_sonic_mighty_8k') as ChituNetworkKind;
const PRINTER_PORT = Number(process.env.LG_TEST_CHITU_PORT ?? '3000');

/** Encrypted CTB v4 magic — required for locked ChiTu boards. */
const ENCRYPTED_CTB_V4_MAGIC = Buffer.from([0x12, 0xfd, 0x90, 0xc1]);

describe.skipIf(!PRINTER_IP)(
  'ChituNetwork dispatcher (real printer) — V2-005d-c T_dc13',
  () => {
    let tmp: string;
    let fixturePath: string;

    beforeAll(async () => {
      // Validate kind — operator may have set LG_TEST_CHITU_KIND to a typo.
      if (!isChituNetworkKind(PRINTER_KIND)) {
        throw new Error(
          `LG_TEST_CHITU_KIND must be a ChituNetworkKind; got '${PRINTER_KIND}'`,
        );
      }

      // Build a tiny encrypted-CTB-magic fixture (~1KB total). The dispatcher's
      // encrypted-CTB gate reads only the first 4 bytes; the remaining
      // payload is opaque to the adapter and the printer doesn't parse the
      // slice on upload (M6030 is gated by startPrint=false).
      tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'chitu-real-'));
      fixturePath = path.join(tmp, 'lootgoblin-real-test.ctb');

      const payload = crypto.randomBytes(1020);
      await fsp.writeFile(fixturePath, Buffer.concat([ENCRYPTED_CTB_V4_MAGIC, payload]));
    });

    afterAll(async () => {
      if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
    });

    it(
      'uploads a tiny encrypted .ctb to a reachable ChituNetwork printer without starting a print',
      async () => {
        const handler = createChituNetworkHandler({
          touchLastUsed: () => {
            /* no-op — no DB touch in real test */
          },
          // Default tcpFactory uses real network.
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
              port: PRINTER_PORT,
              startPrint: false, // SAFE: M28+chunks+M29 run, M6030 is NOT sent
              stageTimeoutMs: 60_000,
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
          // ChituNetwork adapter doesn't use the http context surface (it
          // speaks raw TCP M-codes), but the interface requires it.
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
      120_000, // 120s timeout — TCP connect + multi-stage handshake + upload.
    );
  },
);
