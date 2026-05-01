/**
 * adapter.ts — V2-005d-c T_dc8
 *
 * ChituBox legacy network dispatcher composing T_dc6 (UDP discovery — not
 * invoked here, the operator-supplied connectionConfig already carries `ip`)
 * and T_dc7 (persistent TCP M-code commander). Adds an encrypted-CTB content
 * gate on top of T_dc7 for kinds whose capability table has
 * `encryptedCtbRequired === true` (Phrozen Mighty/Mega/Mini 8K, Uniformation
 * GKtwo/GKone) — locked ChiTu boards silently reject plain CTB at the
 * firmware level, so we want a fast loud reject at the dispatcher rather than
 * an opaque print failure on the LCD.
 *
 * Flow:
 *   1. Defensive kind-check via isChituNetworkKind().
 *   2. Lookup per-model capability for `encryptedCtbRequired` and
 *      `acceptedExtensions`.
 *   3. Validate connectionConfig with the Zod schema (ip required;
 *      port/startPrint/stageTimeoutMs have safe defaults).
 *   4. File-format gate against `acceptedExtensions` (e.g. `.ctb`, `.cbddlp`,
 *      `.jxs`).
 *   5. Read the artifact off disk into a Buffer.
 *   6. ENCRYPTED-CTB GATE — when `encryptedCtbRequired === true` and the
 *      extension is `.ctb`, validate the file's first 4 magic bytes match the
 *      encrypted-CTB v4 signature `0x12 0xfd 0x90 0xc1`. Plain CTB v3/v4
 *      starts with `0x12 0xfd 0x90 0xc0` or `0x07 0x00 0x00 0x00` and would
 *      silently fail at the printer; reject with operator-actionable details.
 *      `.jxs` (Uniformation rename) is treated as encrypted by extension —
 *      the wrapper bytes differ but the gate is the file-extension itself.
 *   7. Upload + (optional) print via uploadAndPrintViaTcp() from T_dc7. Map
 *      any failure to the matching DispatchOutcome reason and prefix details
 *      with the failing stage.
 *   8. On success, touchLastUsed() best-effort and return `/local/<filename>`
 *      as the remote path.
 *
 * Logging policy: filename + IP + size are fine; printer kind is fine.
 * NEVER log file content or excerpts. The encryption-magic check reads the
 * first 4 bytes only and never logs them.
 *
 * NOTE (V2-005d-c-CF): The encrypted-CTB v4 magic `0x12 0xfd 0x90 0xc1` is
 * derived from UVtools' open-source CTB format reverse-engineering. If
 * subsequent integration testing against a real Phrozen Mighty 8K reveals
 * different magic bytes (e.g. firmware version variance), update
 * `ENCRYPTED_CTB_MAGIC` here and add a regression test using the captured
 * sample file.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { DispatchHandler, DispatchContext, DispatchOutcome } from '../handler';
import { touchLastUsed as defaultTouchLastUsed } from '../credentials';
import {
  isChituNetworkKind,
  ChituNetworkConnectionConfig,
  CHITU_NETWORK_MODEL_CAPABILITIES,
  type ChituNetworkKind,
} from './types';
import { uploadAndPrintViaTcp, type TcpSocketFactory } from './commander';

/**
 * 3 minutes — wraps the per-stage timeout (default 60s on stageTimeoutMs)
 * times the worst-case stage count plus headroom for a slow-WiFi multi-MB
 * upload. The commander's stage-level timeouts are the load-bearing limits;
 * this is a worker-level safety bound.
 */
export const CHITU_NETWORK_TIMEOUT_MS = 180_000;

const DETAILS_EXCERPT_MAX = 500;

/**
 * Encrypted CTB v4 signature (UVtools reverse-engineering reference). Plain
 * CTB v3 starts with `0x07 0x00 0x00 0x00`; plain CTB v4 with
 * `0x12 0xfd 0x90 0xc0`. If only the last byte differs (`0xc0` vs `0xc1`),
 * that byte alone is the encryption discriminant.
 */
const ENCRYPTED_CTB_MAGIC = Buffer.from([0x12, 0xfd, 0x90, 0xc1]);
const MAGIC_PROBE_LEN = 16;

function excerpt(s: string): string {
  return s.length > DETAILS_EXCERPT_MAX ? s.slice(0, DETAILS_EXCERPT_MAX) : s;
}

function getFileExtension(storagePath: string): string {
  const base = path.basename(storagePath).toLowerCase();
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx < 0) return '';
  return base.slice(dotIdx);
}

function isEncryptedCtb(head: Buffer): boolean {
  if (head.length < ENCRYPTED_CTB_MAGIC.length) return false;
  for (let i = 0; i < ENCRYPTED_CTB_MAGIC.length; i++) {
    if (head[i] !== ENCRYPTED_CTB_MAGIC[i]) return false;
  }
  return true;
}

export function createChituNetworkHandler(opts?: {
  /**
   * Override worker-level timeout for tests / wrapper callers. Note: actual
   * stage-level limits come from `connectionConfig.stageTimeoutMs` (commander
   * default 30s, adapter default via Zod is 60s); this constant is the
   * worker-level safety bound surfaced for parity with the SDCP adapter.
   */
  timeoutMs?: number;
  /** Inject a stubbed touchLastUsed for unit tests. */
  touchLastUsed?: (opts: { printerId: string }) => void;
  /** Inject TCP socket factory (passes through to commander). */
  tcpSocketFactory?: TcpSocketFactory;
}): DispatchHandler {
  // timeoutMs is reserved for future worker-level wrapping; stage timeouts are
  // applied inside the commander via `connectionConfig.stageTimeoutMs`.
  void opts?.timeoutMs;
  const touch = opts?.touchLastUsed ?? defaultTouchLastUsed;
  const tcpSocketFactory = opts?.tcpSocketFactory;

  // Sentinel kind for the registry; the runtime defends below via
  // isChituNetworkKind() if the registry happens to route a non-ChituNetwork
  // kind. The registry expansion in T_dc10 binds the same handler under each
  // per-model kind; this is just the prototype label.
  const KIND = 'chitu_network_phrozen_sonic_mighty_8k' as const;

  return {
    kind: KIND,

    async dispatch(ctx: DispatchContext): Promise<DispatchOutcome> {
      // 1. Defensive kind check.
      if (!isChituNetworkKind(ctx.printer.kind)) {
        return { kind: 'failure', reason: 'unsupported-protocol' };
      }
      const printerKind = ctx.printer.kind as ChituNetworkKind;

      // 2. Lookup per-model capability.
      const capability = CHITU_NETWORK_MODEL_CAPABILITIES[printerKind];

      // 3. Parse connection-config.
      const parsedConfig = ChituNetworkConnectionConfig.safeParse(ctx.printer.connectionConfig);
      if (!parsedConfig.success) {
        const issues = parsedConfig.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        ctx.logger.warn(
          { printerId: ctx.printer.id, kind: ctx.printer.kind, reason: 'unknown', source: 'config' },
          'chitu-network: invalid connection-config',
        );
        return {
          kind: 'failure',
          reason: 'unknown',
          details: `invalid connection-config: ${issues}`,
        };
      }
      const config = parsedConfig.data;

      // 4. File-format gate.
      const filename = path.basename(ctx.artifact.storagePath);
      const ext = getFileExtension(ctx.artifact.storagePath);
      if (!capability.acceptedExtensions.includes(ext)) {
        ctx.logger.warn(
          {
            printerId: ctx.printer.id,
            kind: ctx.printer.kind,
            reason: 'rejected',
            source: 'file-format',
          },
          'chitu-network: rejected unsupported extension',
        );
        return {
          kind: 'failure',
          reason: 'rejected',
          details:
            `${capability.displayName} accepts ${capability.acceptedExtensions.join(', ')}. ` +
            `Got '${ext || '<no-extension>'}'. Slice in Chitubox or Lychee Pro.`,
        };
      }

      // 5. Read file into memory.
      let fileBuffer: Buffer;
      try {
        fileBuffer = await fsp.readFile(ctx.artifact.storagePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(
          { printerId: ctx.printer.id, kind: ctx.printer.kind, reason: 'unknown', source: 'fs' },
          'chitu-network: failed to read artifact from disk',
        );
        return {
          kind: 'failure',
          reason: 'unknown',
          details: `failed to read artifact: ${excerpt(msg)}`,
        };
      }

      // 6. Encrypted-CTB gate.
      // Only enforced for kinds where `encryptedCtbRequired === true` AND the
      // extension is `.ctb`. `.jxs` (Uniformation) is presumed encrypted by
      // extension; `.cbddlp` (legacy Elegoo) only appears on kinds where
      // encryptedCtbRequired is false, so this branch never runs there.
      if (capability.encryptedCtbRequired && ext === '.ctb') {
        const head = fileBuffer.subarray(0, Math.min(MAGIC_PROBE_LEN, fileBuffer.length));
        if (!isEncryptedCtb(head)) {
          ctx.logger.warn(
            {
              printerId: ctx.printer.id,
              kind: ctx.printer.kind,
              reason: 'rejected',
              source: 'encryption-check',
            },
            'chitu-network: rejected unencrypted CTB on locked-board kind',
          );
          return {
            kind: 'failure',
            reason: 'rejected',
            details:
              `${capability.displayName} (and other locked ChiTu boards) requires encrypted CTB. ` +
              `Plain/unencrypted CTB will silently fail at the printer. Slice in Chitubox Basic/Pro ` +
              `or Lychee Pro with encryption enabled. lootgoblin's V2-005c slicer pipeline does not ` +
              `yet produce encrypted CTB (V2-005d-c-CF-1 carry-forward).`,
          };
        }
      }

      // 7. Upload + (optional) print via T_dc7.
      const result = await uploadAndPrintViaTcp({
        printerIp: config.ip,
        port: config.port,
        fileBuffer,
        filename,
        startPrint: config.startPrint,
        stageTimeoutMs: config.stageTimeoutMs,
        ...(tcpSocketFactory ? { tcpSocketFactory } : {}),
      });
      if (result.kind === 'failure') {
        ctx.logger.warn(
          {
            printerId: ctx.printer.id,
            kind: ctx.printer.kind,
            reason: result.reason,
            source: 'upload-print',
          },
          'chitu-network: upload/print failed',
        );
        return {
          kind: 'failure',
          reason: result.reason,
          details: `${result.stage}: ${excerpt(result.details)}`,
        };
      }

      // 8. Success.
      try {
        touch({ printerId: ctx.printer.id });
      } catch (err) {
        const tMsg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(
          { printerId: ctx.printer.id, err: tMsg },
          'chitu-network: touchLastUsed failed — non-fatal',
        );
      }

      ctx.logger.info(
        {
          printerId: ctx.printer.id,
          kind: ctx.printer.kind,
          ip: config.ip,
          filename,
          sizeBytes: ctx.artifact.sizeBytes,
          encryptedCtbRequired: capability.encryptedCtbRequired,
        },
        'chitu-network: dispatch succeeded',
      );

      return { kind: 'success', remoteFilename: `/local/${filename}` };
    },
  };
}
