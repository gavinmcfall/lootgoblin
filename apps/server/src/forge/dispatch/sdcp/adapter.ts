/**
 * adapter.ts — V2-005d-c T_dc5
 *
 * SDCP 3.0 dispatcher composing T_dc2 (UDP discovery — not invoked here, the
 * operator-supplied connectionConfig already carries `ip` + `mainboardId`),
 * T_dc3 (chunked HTTP uploader), and T_dc4 (WebSocket Cmd 128 commander).
 *
 * Flow:
 *   1. Defensive kind-check via isSdcpKind().
 *   2. Validate connectionConfig with the Zod schema (ip + mainboardId
 *      required, port/startPrint/startLayer have safe defaults).
 *   3. Reject anything that is not a `.ctb` file — the printer firmware
 *      cannot consume plain `.gcode` or Bambu's `.gcode.3mf`.
 *   4. Read the artifact off disk into a Buffer (sliced+chunked by the
 *      uploader; T_dc3 owns the chunk loop).
 *   5. Upload via uploadFileChunked(). Map any failure to the matching
 *      DispatchOutcome reason.
 *   6. If `startPrint=false`, short-circuit to success.
 *   7. Otherwise call startSdcpPrint() to issue Cmd 128. Map failure.
 *   8. On full success, touchLastUsed() (best-effort) and return
 *      `/local/<filename>` as the remote path.
 *
 * Logging policy: filename is fine; mainboardId is fine (printer identifier,
 * not a credential). NEVER log file content or excerpts. The MD5/UUID pair
 * the uploader generates is OK for diagnostic logs but kept out of the
 * operator-visible `details` string in failure envelopes — the operator
 * only sees a pruned message.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { DispatchHandler, DispatchContext, DispatchOutcome } from '../handler';
import { touchLastUsed as defaultTouchLastUsed } from '../credentials';
import { isSdcpKind, SdcpConnectionConfig } from './types';
import { uploadFileChunked, type HttpClient } from './uploader';
import { startSdcpPrint, type MqttFactory } from './commander';

/**
 * Larger than the FDM HTTP timeouts because SDCP combines a chunked
 * multipart upload (1 MiB chunks, individual 30s chunk timeout) with a
 * WebSocket connect + send. A few-MB .ctb file plus connect handshake
 * comfortably fits inside 120s on a healthy LAN.
 */
export const SDCP_TIMEOUT_MS = 120_000;

const DETAILS_EXCERPT_MAX = 500;

function excerpt(s: string): string {
  return s.length > DETAILS_EXCERPT_MAX ? s.slice(0, DETAILS_EXCERPT_MAX) : s;
}

export function createSdcpHandler(opts?: {
  /** Override timeout for tests / wrapper callers. */
  timeoutMs?: number;
  /** Inject a stubbed touchLastUsed for unit tests. */
  touchLastUsed?: (opts: { printerId: string }) => void;
  /** Inject HTTP client (passes through to uploader). */
  httpClient?: HttpClient;
  /** Inject MQTT/WebSocket factory (passes through to commander). */
  mqttFactory?: MqttFactory;
}): DispatchHandler {
  const timeoutMs = opts?.timeoutMs ?? SDCP_TIMEOUT_MS;
  const touch = opts?.touchLastUsed ?? defaultTouchLastUsed;
  const httpClient = opts?.httpClient;
  const mqttFactory = opts?.mqttFactory;

  // Sentinel kind for the registry; the runtime defends below via isSdcpKind()
  // if the registry happens to route a non-SDCP kind.
  const KIND = 'sdcp_elegoo_saturn_4' as const;

  return {
    kind: KIND,

    async dispatch(ctx: DispatchContext): Promise<DispatchOutcome> {
      // 1. Defensive kind check.
      if (!isSdcpKind(ctx.printer.kind)) {
        return { kind: 'failure', reason: 'unsupported-protocol' };
      }

      // 2. Parse connection-config.
      const parsedConfig = SdcpConnectionConfig.safeParse(ctx.printer.connectionConfig);
      if (!parsedConfig.success) {
        const issues = parsedConfig.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        ctx.logger.warn(
          { printerId: ctx.printer.id, kind: ctx.printer.kind, reason: 'unknown', source: 'config' },
          'sdcp: invalid connection-config',
        );
        return {
          kind: 'failure',
          reason: 'unknown',
          details: `invalid connection-config: ${issues}`,
        };
      }
      const config = parsedConfig.data;

      // 3. File-format gate.
      const filename = path.basename(ctx.artifact.storagePath);
      if (!filename.toLowerCase().endsWith('.ctb')) {
        ctx.logger.warn(
          { printerId: ctx.printer.id, kind: ctx.printer.kind, reason: 'rejected', source: 'config' },
          'sdcp: rejected non-.ctb artifact',
        );
        return {
          kind: 'failure',
          reason: 'rejected',
          details:
            'SDCP printers require .ctb format. Slice in Chitubox or Lychee. (Plain .gcode and .gcode.3mf are not accepted.)',
        };
      }

      // 4. Read file into memory.
      let fileBuffer: Buffer;
      try {
        fileBuffer = await fsp.readFile(ctx.artifact.storagePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(
          { printerId: ctx.printer.id, kind: ctx.printer.kind, reason: 'unknown', source: 'config' },
          'sdcp: failed to read artifact from disk',
        );
        return {
          kind: 'failure',
          reason: 'unknown',
          details: `failed to read artifact: ${excerpt(msg)}`,
        };
      }

      // 5. Upload.
      const uploadResult = await uploadFileChunked({
        printerIp: config.ip,
        port: config.port,
        fileBuffer,
        filename,
        ...(httpClient ? { httpClient } : {}),
      });
      if (uploadResult.kind === 'failure') {
        ctx.logger.warn(
          {
            printerId: ctx.printer.id,
            kind: ctx.printer.kind,
            reason: uploadResult.reason,
            source: 'upload',
          },
          'sdcp: upload failed',
        );
        return {
          kind: 'failure',
          reason: uploadResult.reason,
          details: `upload failed: ${uploadResult.details}`,
        };
      }

      const remoteFilename = `/local/${filename}`;

      // 6. Upload-only short-circuit.
      if (!config.startPrint) {
        try {
          touch({ printerId: ctx.printer.id });
        } catch (err) {
          const tMsg = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(
            { printerId: ctx.printer.id, err: tMsg },
            'sdcp: touchLastUsed failed — non-fatal',
          );
        }
        ctx.logger.info(
          {
            printerId: ctx.printer.id,
            kind: ctx.printer.kind,
            mainboardId: config.mainboardId,
            filename,
            sizeBytes: ctx.artifact.sizeBytes,
            startPrint: false,
          },
          'sdcp: upload-only dispatch succeeded',
        );
        return { kind: 'success', remoteFilename };
      }

      // 7. Start print via Cmd 128.
      const printResult = await startSdcpPrint({
        printerIp: config.ip,
        port: config.port,
        mainboardId: config.mainboardId,
        filename,
        startLayer: config.startLayer,
        timeoutMs,
        ...(mqttFactory ? { mqttFactory } : {}),
      });
      if (printResult.kind === 'failure') {
        ctx.logger.warn(
          {
            printerId: ctx.printer.id,
            kind: ctx.printer.kind,
            reason: printResult.reason,
            source: 'start-print',
          },
          'sdcp: start-print failed',
        );
        return {
          kind: 'failure',
          reason: printResult.reason,
          details: `start-print failed: ${printResult.details}`,
        };
      }

      // 8. Success.
      try {
        touch({ printerId: ctx.printer.id });
      } catch (err) {
        const tMsg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(
          { printerId: ctx.printer.id, err: tMsg },
          'sdcp: touchLastUsed failed — non-fatal',
        );
      }

      ctx.logger.info(
        {
          printerId: ctx.printer.id,
          kind: ctx.printer.kind,
          mainboardId: config.mainboardId,
          filename,
          sizeBytes: ctx.artifact.sizeBytes,
        },
        'sdcp: dispatch succeeded',
      );

      return { kind: 'success', remoteFilename };
    },
  };
}
