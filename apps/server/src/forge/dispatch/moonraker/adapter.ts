/**
 * adapter.ts — V2-005d-a T_da5
 *
 * Moonraker (Klipper) HTTP-multipart upload DispatchHandler.
 *
 * Flow:
 *   1. Parse `printer.connectionConfig` via MoonrakerConnectionConfig.
 *   2. If `requiresAuth=true` and no credential row exists → fail
 *      'no-credentials' immediately (without touching the network).
 *   3. If credential present, validate its payload against
 *      MoonrakerCredentialPayload. Wrong shape:
 *        - requiresAuth=true → 'auth-failed' (we can't authenticate)
 *        - requiresAuth=false → log warn and proceed without header
 *          (trusted-clients mode tolerates broken creds since it doesn't
 *          use them anyway).
 *   4. POST multipart/form-data to {scheme}://{host}:{port}/server/files/upload
 *      with fields: file, root='gcodes', path='', print=startPrint.
 *      Header: X-Api-Key when apiKey is available.
 *   5. Map response to DispatchOutcome:
 *        - 200/201   → success (remoteFilename from result.item.path or filename)
 *        - 401/403   → 'auth-failed'
 *        - other 4xx → 'rejected'
 *        - 5xx       → 'unknown'
 *   6. AbortError (timeout) → 'timeout'.
 *      ECONNREFUSED/ENOTFOUND/ETIMEDOUT/etc → 'unreachable'.
 *      Anything else → 'unknown'.
 *   7. On success, call touchLastUsed({ printerId }).
 *
 * Logging policy: NEVER log apiKey or full credential payload. Body excerpts
 * (capped at 500 chars) are surfaced in DispatchOutcome.details and may appear
 * in worker logs by way of the outcome — but we don't put apiKey or payload
 * into any log line emitted from this module.
 *
 * Production wiring (T_da6) supplies `ctx.http.fetch` bound to globalThis.fetch
 * and uses the default `touchLastUsed` from `../credentials`. Tests inject both
 * via `createMoonrakerHandler({ touchLastUsed })` + the per-call `ctx.http`.
 */

import * as fsp from 'node:fs/promises';
import path from 'node:path';

import type { DispatchHandler, DispatchContext, DispatchOutcome } from '../handler';
import { touchLastUsed as defaultTouchLastUsed } from '../credentials';

import { MoonrakerConnectionConfig, MoonrakerCredentialPayload } from './types';

export const MOONRAKER_KIND = 'fdm_klipper' as const;
export const MOONRAKER_TIMEOUT_MS = 60_000;

const BODY_EXCERPT_MAX = 500;

function excerpt(s: string): string {
  return s.length > BODY_EXCERPT_MAX ? s.slice(0, BODY_EXCERPT_MAX) : s;
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function isNetworkError(err: Error): boolean {
  const msg = err.message ?? '';
  // Node's undici fetch surfaces network failures as TypeError('fetch failed')
  // with a `cause` property carrying the underlying error code. We also accept
  // bare ECONNREFUSED/ENOTFOUND/ETIMEDOUT in the message for tests + custom
  // mocks that throw plain Error objects.
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
    return true;
  }
  // Inspect cause chain for the same codes.
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(code)) {
      return true;
    }
    const causeMsg = (cause as { message?: unknown }).message;
    if (typeof causeMsg === 'string' && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(causeMsg)) {
      return true;
    }
  }
  return false;
}

export function createMoonrakerHandler(opts?: {
  /** Override timeout for tests. */
  timeoutMs?: number;
  /** Inject a stubbed touchLastUsed for unit tests. Defaults to credentials.touchLastUsed. */
  touchLastUsed?: (opts: { printerId: string }) => void;
}): DispatchHandler {
  const timeoutMs = opts?.timeoutMs ?? MOONRAKER_TIMEOUT_MS;
  const touch = opts?.touchLastUsed ?? defaultTouchLastUsed;

  return {
    kind: MOONRAKER_KIND,

    async dispatch(ctx: DispatchContext): Promise<DispatchOutcome> {
      // 1. Parse connection config.
      const parsedConfig = MoonrakerConnectionConfig.safeParse(ctx.printer.connectionConfig);
      if (!parsedConfig.success) {
        const issues = parsedConfig.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        return {
          kind: 'failure',
          reason: 'unknown',
          details: `invalid connection-config: ${issues}`,
        };
      }
      const config = parsedConfig.data;

      // 2. requiresAuth + no credential → no-credentials before any network IO.
      if (config.requiresAuth && ctx.credential === null) {
        return { kind: 'failure', reason: 'no-credentials' };
      }

      // 3. Validate credential payload (if present).
      let apiKey: string | undefined;
      if (ctx.credential !== null) {
        const parsedCred = MoonrakerCredentialPayload.safeParse(ctx.credential.payload);
        if (parsedCred.success) {
          apiKey = parsedCred.data.apiKey;
        } else if (config.requiresAuth) {
          return {
            kind: 'failure',
            reason: 'auth-failed',
            details: 'credential payload missing apiKey or wrong shape',
          };
        } else {
          ctx.logger.warn(
            { printerId: ctx.printer.id },
            'moonraker: credential payload invalid but requiresAuth=false — proceeding without X-Api-Key',
          );
        }
      }

      // 4. Build URL.
      const url = `${config.scheme}://${config.host}:${config.port}/server/files/upload`;

      // 5. Build multipart body.
      let fileBytes: Buffer;
      try {
        fileBytes = await fsp.readFile(ctx.artifact.storagePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'failure',
          reason: 'unknown',
          details: `failed to read artifact: ${excerpt(msg)}`,
        };
      }
      const filename = path.basename(ctx.artifact.storagePath);
      // Node's Buffer (ArrayBufferLike) doesn't satisfy lib.dom Blob's BlobPart
      // (which requires ArrayBuffer). Copy into a fresh ArrayBuffer so the
      // backing buffer's type narrows to plain ArrayBuffer.
      const ab = new ArrayBuffer(fileBytes.byteLength);
      new Uint8Array(ab).set(fileBytes);
      const blob = new Blob([ab]);
      const fd = new FormData();
      fd.append('file', blob, filename);
      fd.append('root', 'gcodes');
      fd.append('path', '');
      fd.append('print', config.startPrint ? 'true' : 'false');

      // 6. Build init.
      const headers: Record<string, string> = {};
      if (apiKey) headers['X-Api-Key'] = apiKey;
      const init: RequestInit = {
        method: 'POST',
        headers,
        body: fd,
        signal: AbortSignal.timeout(timeoutMs),
      };

      // 7. Fetch.
      let res: Response;
      try {
        res = await ctx.http.fetch(url, init);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (e.name === 'AbortError' || e.name === 'TimeoutError') {
          ctx.logger.warn(
            { printerId: ctx.printer.id, reason: 'timeout' },
            'moonraker: dispatch timed out',
          );
          return { kind: 'failure', reason: 'timeout' };
        }
        if (isNetworkError(e)) {
          ctx.logger.warn(
            { printerId: ctx.printer.id, reason: 'unreachable' },
            'moonraker: printer unreachable',
          );
          return {
            kind: 'failure',
            reason: 'unreachable',
            details: excerpt(e.message),
          };
        }
        ctx.logger.warn(
          { printerId: ctx.printer.id, reason: 'unknown' },
          'moonraker: dispatch failed with unexpected error',
        );
        return {
          kind: 'failure',
          reason: 'unknown',
          details: excerpt(e.message),
        };
      }

      // 8. Inspect response.
      const status = res.status;

      if (status === 200 || status === 201) {
        let remoteFilename = filename;
        try {
          const body = (await res.json()) as unknown;
          const itemPath = (body as { result?: { item?: { path?: unknown } } })?.result?.item?.path;
          if (typeof itemPath === 'string' && itemPath.length > 0) {
            remoteFilename = itemPath;
          }
        } catch {
          // Body wasn't JSON or didn't match expected shape — keep filename fallback.
        }

        // Fire touchLastUsed (sync sqlite). Don't let a touch failure mask success.
        try {
          touch({ printerId: ctx.printer.id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(
            { printerId: ctx.printer.id, err: msg },
            'moonraker: touchLastUsed failed — non-fatal',
          );
        }

        ctx.logger.info(
          {
            printerId: ctx.printer.id,
            remoteFilename,
            sizeBytes: ctx.artifact.sizeBytes,
          },
          'moonraker: dispatch succeeded',
        );

        return { kind: 'success', remoteFilename };
      }

      const bodyText = await readBodyText(res);
      const details = excerpt(bodyText);

      if (status === 401 || status === 403) {
        ctx.logger.warn(
          { printerId: ctx.printer.id, reason: 'auth-failed', statusCode: status },
          'moonraker: auth rejected by printer',
        );
        return { kind: 'failure', reason: 'auth-failed', details };
      }

      if (status >= 400 && status < 500) {
        ctx.logger.warn(
          { printerId: ctx.printer.id, reason: 'rejected', statusCode: status },
          'moonraker: printer rejected upload',
        );
        return { kind: 'failure', reason: 'rejected', details };
      }

      // 5xx and anything else.
      ctx.logger.warn(
        { printerId: ctx.printer.id, reason: 'unknown', statusCode: status },
        'moonraker: printer returned server error',
      );
      return { kind: 'failure', reason: 'unknown', details };
    },
  };
}
