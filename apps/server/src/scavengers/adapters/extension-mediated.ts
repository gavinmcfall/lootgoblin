/**
 * extension-mediated.ts — shared helper for extension-mediated ScavengerAdapters.
 *
 * MakerWorld and Printables both forbid direct server-side scraping per their ToS.
 * Instead the paired browser extension scrapes metadata and obtains pre-authorized
 * download URLs; the server receives that payload as a `target.kind = 'raw'` blob
 * and this adapter downloads the files via plain HTTP fetch.
 *
 * Architecture:
 *   Browser extension (scrapes + authorizes URLs)
 *     → FetchTarget { kind: 'raw', payload: ExtensionPayload }
 *       → createExtensionMediatedAdapter (downloads files, builds NormalizedItem)
 *         → yields ScavengerEvent stream (progress + completed | failed)
 *
 * Rate-limit loop, stream-error cleanup, and filename dedup follow the patterns
 * established in T5 (cults3d adapter).
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';

import type {
  ScavengerAdapter,
  ScavengerEvent,
  FetchContext,
  FetchTarget,
  NormalizedItem,
  SourceId,
} from '../types';
import { nextRetry, sleep } from '../rate-limit';
import { sanitizeFilename } from '../filename-sanitize';
import { logger } from '../../logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Payload the paired browser extension produces.
 *
 * The extension scrapes metadata and obtains pre-authorized download URLs from
 * the source site using its session cookies. The server adapter does NO scraping —
 * it only downloads the URLs the extension has already authorized.
 *
 * URLs may be short-lived presigned-style links; fetch immediately on receipt.
 */
export type ExtensionPayload = {
  /** Source's own id (e.g. MakerWorld model id, Printables model id). */
  sourceItemId: string;
  /** Canonical URL of this item on the source site. */
  sourceUrl: string;
  /** Display title — required. */
  title: string;
  description?: string;
  creator?: string;
  license?: string;
  tags?: string[];
  /** File descriptors with download URLs the extension already authorized. */
  files: Array<{
    /** Direct-download URL. May expire; fetch immediately. */
    url: string;
    /** Suggested filename from the source. */
    name: string;
    /** Optional pre-known size in bytes. */
    size?: number;
  }>;
};

export type ExtensionMediatedAdapterOptions = {
  /** Override fetch (test seam). Default globalThis.fetch. */
  httpFetch?: typeof fetch;
  /** Max retries on rate-limited responses. Default 6. */
  maxRetries?: number;
  /**
   * Override the base backoff delay in milliseconds.
   * Default undefined → nextRetry uses its own default (1000ms).
   * Set to 0 in tests to skip real sleep delays (T5-L1 pattern).
   */
  retryBaseMs?: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the Retry-After header value into milliseconds.
 * Accepts both integer-seconds form ("120") and HTTP-date form ("Thu, 01 Jan ...").
 */
function parseRetryAfter(header: string): number | undefined {
  const asNumber = Number(header);
  if (!isNaN(asNumber)) return asNumber * 1000; // seconds → ms
  const asDate = new Date(header).getTime();
  if (!isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

/**
 * Deduplicate a sanitized filename within a seen-names Map (T4-L6 pattern).
 * On first occurrence: use the base name as-is.
 * On collision: insert '-N' before the extension.
 * Keyed on the sanitized base name so collisions from different raw names that
 * sanitize to the same result are also caught.
 */
function deduplicateName(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  if (count === 0) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  return `${stem}-${count}${ext}`;
}

/**
 * Result of validating a payload — distinguishes the various failure modes
 * so the adapter can surface a precise `details` string. The `reason` field
 * is interpolated into a `failed` event's `details`, which lets tests assert
 * specific guards (e.g. /sourceItemId/i) instead of relying on a generic
 * "invalid shape" message.
 */
type PayloadValidation =
  | { ok: true; payload: ExtensionPayload }
  | { ok: false; reason: string };

/**
 * Validate that a value looks like an ExtensionPayload.
 * Checks only the fields this adapter requires — extra fields are allowed.
 *
 * Each `files[].url` MUST parse to an `http:` or `https:` URL. Schemes such
 * as `javascript:`, `file:`, `data:`, and unparseable values are rejected
 * here so the download loop never fetches an attacker-controlled scheme even
 * if upstream callers relax their own validation.
 */
function validatePayload(payload: unknown): PayloadValidation {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'payload is not an object' };
  }
  const p = payload as Record<string, unknown>;
  if (typeof p['sourceItemId'] !== 'string' || !p['sourceItemId']) {
    return { ok: false, reason: 'sourceItemId must be a non-empty string' };
  }
  if (typeof p['sourceUrl'] !== 'string' || !p['sourceUrl']) {
    return { ok: false, reason: 'sourceUrl must be a non-empty string' };
  }
  if (typeof p['title'] !== 'string' || !(p['title'] as string).trim()) {
    return { ok: false, reason: 'title must be a non-empty string' };
  }
  if (!Array.isArray(p['files']) || (p['files'] as unknown[]).length === 0) {
    return { ok: false, reason: 'files must be a non-empty array' };
  }

  // Per-file URL protocol guard. Only http(s) is permitted — `javascript:`,
  // `file:`, `data:`, and unparseable URLs all reject here.
  const files = p['files'] as unknown[];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const rawUrl =
      f && typeof f === 'object' ? (f as Record<string, unknown>)['url'] : undefined;
    if (typeof rawUrl !== 'string' || !rawUrl) {
      return { ok: false, reason: `files[${i}].url must be a non-empty string` };
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return { ok: false, reason: `files[${i}].url is not a parseable URL: ${rawUrl}` };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        ok: false,
        reason: `files[${i}].url uses unsupported protocol "${parsedUrl.protocol}": ${rawUrl}`,
      };
    }
  }

  return { ok: true, payload: payload as ExtensionPayload };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `ScavengerAdapter` for an extension-mediated source.
 *
 * This adapter only accepts `target.kind = 'raw'` payloads produced by the
 * paired browser extension. URL targets and source-item-id targets are
 * explicitly rejected — the extension does the scraping; the server doesn't.
 *
 * @internal Only `createMakerWorldAdapter` and `createPrintablesAdapter` are
 *           public consumers — this factory is not re-exported from the
 *           scavengers barrel. Future extension-mediated wrappers should
 *           import this directly from `./adapters/extension-mediated`.
 *
 * @param sourceId   The SourceId this adapter handles (e.g. 'makerworld').
 * @param hosts      Exact set of hostnames whose URLs this adapter claims for
 *                   supports() routing. T3-L9: exact-host allowlist, no suffix-match.
 * @param options    Test seams and retry config.
 */
export function createExtensionMediatedAdapter(
  sourceId: SourceId,
  hosts: Set<string>,
  options?: ExtensionMediatedAdapterOptions,
): ScavengerAdapter {
  const httpFetch = options?.httpFetch ?? globalThis.fetch;
  const maxRetries = options?.maxRetries ?? 6;
  const retryBaseMs = options?.retryBaseMs; // undefined → nextRetry uses default 1000ms

  return {
    // id is set by the wrapping factory (makerworld.ts / printables.ts) which
    // spreads this object and overwrites id with the correct SourceId literal.
    // Providing it here too keeps the return type compatible with ScavengerAdapter.
    id: sourceId,

    /**
     * Returns true for any URL whose hostname exactly matches the allowlist.
     * T3-L9: exact-host allowlist — never endsWith or suffix-match.
     */
    supports(url: string): boolean {
      try {
        const parsed = new URL(url);
        return hosts.has(parsed.hostname.toLowerCase());
      } catch {
        return false;
      }
    },

    fetch(context: FetchContext, target: FetchTarget): AsyncIterable<ScavengerEvent> {
      return {
        [Symbol.asyncIterator]: async function* () {
          try {
            // ── 1. Validate target kind ──────────────────────────────────────
            //
            // Extension-mediated adapters ONLY accept raw payloads. URL targets
            // and source-item-id targets are not supported — the extension does
            // the scraping and resolves URLs; the server is a pure downloader.

            if (target.kind !== 'raw') {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details:
                  `${sourceId} adapter only accepts raw payloads from the paired extension; ` +
                  `received target.kind='${target.kind}'`,
              };
              return;
            }

            // ── 2. Validate payload shape ────────────────────────────────────

            const validation = validatePayload(target.payload);
            if (!validation.ok) {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: `${sourceId} adapter: invalid payload — ${validation.reason}`,
              };
              return;
            }

            const payload = validation.payload;

            logger.debug(
              {
                sourceId,
                sourceItemId: payload.sourceItemId,
                fileCount: payload.files.length,
              },
              'extension-mediated: starting download',
            );

            // ── 3. Download each file ────────────────────────────────────────

            const stagedFiles: Array<{
              stagedPath: string;
              suggestedName: string;
              size?: number;
            }> = [];

            const seenNames = new Map<string, number>();

            for (let i = 0; i < payload.files.length; i++) {
              const fileDesc = payload.files[i]!;

              // Sanitize the filename from the source (T4-L4, T4-L5 pattern).
              const rawName = fileDesc.name || `file-${i}.bin`;
              const sanitized = sanitizeFilename(rawName) ?? `file-${i}.bin`;
              const finalName = deduplicateName(sanitized, seenNames);
              const destPath = path.join(context.stagingDir, finalName);

              yield {
                kind: 'progress' as const,
                message: `Downloading ${finalName} (${i + 1}/${payload.files.length})`,
              };

              // Download with rate-limit loop (T5 pattern).
              // Per-file retry budget — declared inside the loop so one slow
              // file doesn't burn the whole batch's allowance.
              let dlAttempt = 1;
              while (true) {
                let dlRes: Response;
                try {
                  dlRes = await httpFetch(fileDesc.url, {
                    signal: context.signal,
                  });
                } catch (dlFetchErr) {
                  const msg =
                    dlFetchErr instanceof Error ? dlFetchErr.message : String(dlFetchErr);
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `${sourceId}: file download failed (${finalName}): ${msg}`,
                  };
                  return;
                }

                if (dlRes.status === 429) {
                  const retryAfterHeader = dlRes.headers.get('retry-after');
                  const retryAfterMs = retryAfterHeader
                    ? parseRetryAfter(retryAfterHeader)
                    : undefined;
                  const decision = nextRetry(
                    dlAttempt,
                    { maxAttempts: maxRetries, baseMs: retryBaseMs },
                    retryAfterMs,
                  );
                  if (!decision.retry) {
                    yield {
                      kind: 'failed' as const,
                      reason: 'rate-limit-exhausted' as const,
                      details: `${sourceId}: rate-limit exhausted downloading ${finalName} after ${dlAttempt} attempts`,
                    };
                    return;
                  }
                  yield {
                    kind: 'rate-limited' as const,
                    retryAfterMs: decision.delayMs,
                    attempt: dlAttempt,
                  };
                  await sleep(decision.delayMs, context.signal);
                  dlAttempt += 1;
                  continue;
                }

                // 401/403 — extension session expired.
                if (dlRes.status === 401 || dlRes.status === 403) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'auth-revoked' as const,
                    details:
                      `${sourceId}: file download rejected (${dlRes.status}) — ` +
                      'extension session may have expired; re-pair the extension',
                  };
                  return;
                }

                // 404/410 — file no longer exists at this URL.
                if (dlRes.status === 404 || dlRes.status === 410) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'content-removed' as const,
                    details: `${sourceId}: file URL returned ${dlRes.status} for ${finalName}`,
                  };
                  return;
                }

                if (!dlRes.ok) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `${sourceId}: file download responded ${dlRes.status} for ${finalName}`,
                  };
                  return;
                }

                if (!dlRes.body) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `${sourceId}: file download returned no body for ${finalName}`,
                  };
                  return;
                }

                // Stream response body to disk (T5-L2 pattern).
                try {
                  const nodeReadable = Readable.fromWeb(
                    dlRes.body as import('stream/web').ReadableStream<Uint8Array>,
                  );
                  await streamPipeline(nodeReadable, createWriteStream(destPath));
                } catch (streamErr) {
                  // Remove the partial file — don't leave a truncated artifact.
                  await fsp.unlink(destPath).catch(() => {});
                  const msg =
                    streamErr instanceof Error ? streamErr.message : String(streamErr);
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `${sourceId}: download stream error for ${finalName}: ${msg}`,
                    error: streamErr,
                  };
                  return;
                }

                break; // download successful
              }

              // Stat the staged file for an accurate size reading.
              let fileSize: number | undefined;
              try {
                const stat = await fsp.stat(destPath);
                fileSize = stat.size;
              } catch {
                logger.warn({ destPath, sourceId }, 'extension-mediated: failed to stat staged file');
              }

              stagedFiles.push({
                stagedPath: destPath,
                suggestedName: finalName,
                size: fileSize,
              });

              yield {
                kind: 'progress' as const,
                message: `Staged ${finalName}`,
                completedBytes: fileSize,
              };
            }

            // ── 4. Build NormalizedItem ──────────────────────────────────────

            const item: NormalizedItem = {
              sourceId,
              sourceItemId: payload.sourceItemId,
              sourceUrl: payload.sourceUrl,
              title: payload.title.trim(),
              description: payload.description,
              creator: payload.creator,
              license: payload.license,
              tags: payload.tags,
              files: stagedFiles.map((f) => ({
                stagedPath: f.stagedPath,
                suggestedName: f.suggestedName,
                size: f.size,
              })),
            };

            // ── 5. Yield completed ────────────────────────────────────────────

            yield { kind: 'completed' as const, item };
          } catch (err) {
            // Catch-all — surface as failed event rather than letting the async
            // generator throw (which would propagate as an unhandled rejection
            // from the pipeline's for-await loop).
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn({ err, sourceId }, 'extension-mediated: unexpected error');
            yield {
              kind: 'failed' as const,
              reason: 'unknown' as const,
              details: msg,
            };
          }
        },
      };
    },
  };
}
