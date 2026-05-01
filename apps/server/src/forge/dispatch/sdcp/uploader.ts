/**
 * uploader.ts — V2-005d-c T_dc3
 *
 * Chunked HTTP multipart uploader for SDCP 3.0 resin printers (Elegoo
 * Saturn/Mars 3+ generation, AnyCubic Photon Mono M5 + Pro generation, plus
 * any other firmware that speaks the unified SDCP 3.0 file-upload protocol).
 *
 * Protocol summary (see planning/odad/research/v2-005d-c-sdcp.md §3 channel 3):
 *   POST http://<printerIp>:3030/uploadFile/upload
 *     Content-Type: multipart/form-data
 *     fields:
 *       - S-File-MD5  hex MD5 of the COMPLETE file (same value on every chunk)
 *       - Check       '1' on the first chunk (offset=0), '0' on every subsequent
 *                     chunk; printer uses this to enable verification mode.
 *       - Offset      byte offset for THIS chunk
 *       - Uuid        upload session UUID (same value on every chunk)
 *       - TotalSize   total file size in bytes (same value on every chunk)
 *       - File        binary chunk payload
 *   Chunk size: 1 MiB (1048576 bytes) per POST. Files land at /local/<filename>
 *   on the printer's storage.
 *
 * Defensive failure mapping:
 *   - 401/403   → 'auth-failed'   (SDCP 3.0 is currently unauthenticated, but
 *                                   firmware may add auth — be ready)
 *   - other 4xx → 'rejected'      (with body excerpt, max 500 chars)
 *   - 5xx       → 'unknown'
 *   - AbortError / TimeoutError   → 'timeout'
 *   - ECONNREFUSED/ENOTFOUND/etc. → 'unreachable'
 *   - other Error                 → 'unknown'
 *
 * Logging policy: MD5 + UUID are non-sensitive (they identify the upload, not
 * the printer or the user) — fine to log. NEVER log file content, however —
 * even chunk excerpts are off-limits.
 *
 * Test ergonomics: `httpClient` is injectable so the unit suite can stub the
 * HTTP layer entirely. Production code uses globalThis.fetch via the default
 * client.
 */

import { createHash, randomUUID } from 'node:crypto';

import { logger } from '@/logger';

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export interface HttpClient {
  fetch(url: string, init: RequestInit): Promise<HttpResponseLike>;
}

const defaultHttpClient: HttpClient = {
  fetch: (url, init) =>
    globalThis.fetch(url, init).then((r) => ({
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      text: () => r.text(),
    })),
};

export interface UploadOptions {
  printerIp: string;
  fileBuffer: Buffer;
  filename: string;
  /** Optional override port — defaults to 3030. */
  port?: number;
  /** Optional override chunk size — defaults to 1MB. */
  chunkSize?: number;
  /** Injected HTTP client for tests. Defaults to globalThis.fetch wrapper. */
  httpClient?: HttpClient;
  /** Optional progress callback called after each successful chunk. */
  onProgress?: (info: { bytesSent: number; totalSize: number }) => void;
  /** Per-chunk timeout — defaults to 30000 (30s). */
  chunkTimeoutMs?: number;
}

export type UploadResult =
  | { kind: 'success'; uuid: string; md5: string; bytesSent: number }
  | {
      kind: 'failure';
      reason: 'unreachable' | 'auth-failed' | 'rejected' | 'timeout' | 'unknown';
      details: string;
      bytesSent: number;
      uuid?: string;
    };

const DEFAULT_PORT = 3030;
const DEFAULT_CHUNK_SIZE = 1_048_576; // 1 MiB
const DEFAULT_CHUNK_TIMEOUT_MS = 30_000;
const BODY_EXCERPT_MAX = 500;

const NETWORK_CODE_RE =
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i;

function excerpt(s: string): string {
  return s.length > BODY_EXCERPT_MAX ? s.slice(0, BODY_EXCERPT_MAX) : s;
}

interface ErrLike {
  name?: string;
  message?: string;
  code?: string;
  cause?: unknown;
}

function asErrLike(err: unknown): ErrLike {
  if (err instanceof Error) {
    const e = err as Error & { code?: string; cause?: unknown };
    return { name: e.name, message: e.message, code: e.code, cause: e.cause };
  }
  if (err && typeof err === 'object') {
    return err as ErrLike;
  }
  return { message: String(err) };
}

function isAbortLike(err: ErrLike): boolean {
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = typeof err.code === 'string' ? err.code : '';
  if (code === 'ABORT_ERR') return true;
  return false;
}

function isNetworkError(err: ErrLike): boolean {
  const msg = err.message ?? '';
  if (NETWORK_CODE_RE.test(msg)) return true;
  if (typeof err.code === 'string' && NETWORK_CODE_RE.test(err.code)) return true;
  const cause = err.cause;
  if (cause && typeof cause === 'object') {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string' && NETWORK_CODE_RE.test(causeCode)) return true;
    const causeMsg = (cause as { message?: unknown }).message;
    if (typeof causeMsg === 'string' && NETWORK_CODE_RE.test(causeMsg)) return true;
  }
  return false;
}

/**
 * Build a Blob from a Buffer slice. Node 22's Buffer is ArrayBufferLike, which
 * lib.dom's Blob constructor refuses (it wants ArrayBuffer). Copy into a fresh
 * ArrayBuffer so the backing buffer's type narrows. (FB-L6 pattern from
 * V2-005b/d — see Moonraker + OctoPrint adapters.)
 */
function bufferToBlob(chunk: Buffer): Blob {
  const ab = new ArrayBuffer(chunk.byteLength);
  new Uint8Array(ab).set(chunk);
  return new Blob([ab]);
}

export async function uploadFileChunked(opts: UploadOptions): Promise<UploadResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkTimeoutMs = opts.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
  const httpClient = opts.httpClient ?? defaultHttpClient;

  const uuid = randomUUID();
  const md5 = createHash('md5').update(opts.fileBuffer).digest('hex');
  const totalSize = opts.fileBuffer.length;
  const url = `http://${opts.printerIp}:${port}/uploadFile/upload`;

  let bytesSent = 0;
  let chunkIndex = 0;

  while (bytesSent < totalSize) {
    const chunk = opts.fileBuffer.subarray(bytesSent, bytesSent + chunkSize);
    const isFirst = chunkIndex === 0;

    const form = new FormData();
    form.append('S-File-MD5', md5);
    form.append('Check', isFirst ? '1' : '0');
    form.append('Offset', String(bytesSent));
    form.append('Uuid', uuid);
    form.append('TotalSize', String(totalSize));
    form.append('File', bufferToBlob(chunk), opts.filename);

    let res: HttpResponseLike;
    try {
      res = await httpClient.fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(chunkTimeoutMs),
      });
    } catch (err) {
      const e = asErrLike(err);
      let reason: 'timeout' | 'unreachable' | 'unknown';
      if (isAbortLike(e)) {
        reason = 'timeout';
      } else if (isNetworkError(e)) {
        reason = 'unreachable';
      } else {
        reason = 'unknown';
      }
      logger.warn(
        {
          printerIp: opts.printerIp,
          port,
          uuid,
          md5,
          chunkIndex,
          bytesSent,
          totalSize,
          reason,
        },
        'sdcp-uploader: chunk POST threw',
      );
      return {
        kind: 'failure',
        reason,
        details: excerpt(e.message ?? ''),
        bytesSent,
        uuid,
      };
    }

    if (!res.ok) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        // ignore — body read failure isn't fatal context
      }
      let reason: 'auth-failed' | 'rejected' | 'unknown';
      if (res.status === 401 || res.status === 403) {
        reason = 'auth-failed';
      } else if (res.status >= 400 && res.status < 500) {
        reason = 'rejected';
      } else {
        reason = 'unknown';
      }
      const details = `HTTP ${res.status} ${res.statusText}: ${excerpt(bodyText)}`;
      logger.warn(
        {
          printerIp: opts.printerIp,
          port,
          uuid,
          md5,
          chunkIndex,
          bytesSent,
          totalSize,
          status: res.status,
          reason,
        },
        'sdcp-uploader: chunk rejected',
      );
      return {
        kind: 'failure',
        reason,
        details,
        bytesSent,
        uuid,
      };
    }

    bytesSent += chunk.length;
    chunkIndex += 1;

    if (opts.onProgress) {
      opts.onProgress({ bytesSent, totalSize });
    }
  }

  return { kind: 'success', uuid, md5, bytesSent };
}
