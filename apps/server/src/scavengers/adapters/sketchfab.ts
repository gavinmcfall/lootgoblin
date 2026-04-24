/**
 * sketchfab.ts — Sketchfab ScavengerAdapter (V2-003-T7)
 *
 * First OAuth-flow adapter in the codebase. Patterns established here are
 * inherited by T8 (Google Drive).
 *
 * Auth: Sketchfab supports two credential modes per user preference:
 *   - 'oauth'      — OAuth 2.0 with refresh-token rotation. The adapter
 *                    refreshes silently when the access token is within 60s
 *                    of expiry and hands the new bag to the pipeline via
 *                    `context.onTokenRefreshed` for persistence.
 *   - 'api-token'  — A static API token sent as `Authorization: Token <t>`
 *                    per https://sketchfab.com/developers/data-api/v3.
 *
 * Download flow is two-step per the Sketchfab v3 API:
 *   1. GET /v3/models/{uid}            — metadata (title, license, creator,
 *                                        downloadable boolean)
 *   2. GET /v3/models/{uid}/download   — short-TTL (~5min) signed download
 *                                        URLs keyed by format (source/glb/
 *                                        gltf/usdz). Some keys may be
 *                                        absent depending on what the
 *                                        creator uploaded.
 *
 * Format selection priority is source > glb > gltf > usdz. The adapter
 * picks one format per fetch (the highest-priority one available) — the
 * download endpoint URLs are short-lived so we want minimum round-trips.
 *
 * Sketchfab CC license strings (e.g. `cc-by-4.0`) are PRESERVED VERBATIM in
 * `NormalizedItem.license`. Sketchfab's ToS requires capturing license
 * attribution for every CC-licensed model; downstream surfaces (Loot UI,
 * exports) MUST display it.
 *
 * Patterns reused from cults3d (T5) and extension-mediated (T6):
 *   - Exact-host allowlist for supports() (T3-L9)
 *   - parseRetryAfter() for 429 handling
 *   - nextRetry + sleep for rate-limit backoff
 *   - Stream-error cleanup via fsp.unlink before yielding failed
 *   - sanitizeFilename() for downloaded file names
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
} from '../types';
import { nextRetry, sleep } from '../rate-limit';
import { sanitizeFilename } from '../filename-sanitize';
import { logger } from '../../logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * OAuth credential bag. `expiresAt` is a UTC milliseconds-since-epoch
 * timestamp (NOT a duration). The pipeline computes this when first storing
 * the grant: `Date.now() + expires_in * 1000`.
 *
 * `clientId` and `clientSecret` are the application's OAuth credentials,
 * required for the refresh-token grant.
 */
export type SketchfabOAuthCredentials = {
  kind: 'oauth';
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  clientSecret: string;
};

/**
 * Static API token credentials. Sketchfab supports a per-user "API Token"
 * the user copies from their account settings; it is sent as
 * `Authorization: Token <t>`.
 */
export type SketchfabApiTokenCredentials = {
  kind: 'api-token';
  token: string;
};

export type SketchfabCredentials =
  | SketchfabOAuthCredentials
  | SketchfabApiTokenCredentials;

export type SketchfabAdapterOptions = {
  /** Override the v3 API base. Default 'https://api.sketchfab.com/v3'. */
  apiBase?: string;
  /** Override the OAuth token endpoint. Default 'https://sketchfab.com/oauth2/token/'. */
  tokenEndpoint?: string;
  /** Override fetch (test seam). Default globalThis.fetch. */
  httpFetch?: typeof fetch;
  /** Max rate-limit retry attempts before giving up. Default 6. */
  maxRetries?: number;
  /**
   * Override the base backoff delay in ms for rate-limit retries.
   * Default undefined → nextRetry uses its own default (1000ms).
   * Set to 0 in tests to skip real sleep delays (T5-L1 pattern).
   */
  retryBaseMs?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE = 'https://api.sketchfab.com/v3';
const DEFAULT_TOKEN_ENDPOINT = 'https://sketchfab.com/oauth2/token/';
const DEFAULT_MAX_RETRIES = 6;

/** 1-minute safety margin: refresh OAuth tokens this far before expiry. */
const TOKEN_REFRESH_LEAD_MS = 60_000;

/**
 * Exact set of hostnames this adapter owns.
 * T3-L9 pattern: exact-host allowlist — no endsWith / suffix matching.
 */
const SKETCHFAB_HOSTS = new Set(['sketchfab.com', 'www.sketchfab.com']);

/**
 * Format priority — first available wins. Source files have the best fidelity;
 * glb is a single packed binary; gltf is a ZIP with textures; usdz is the
 * last-resort format.
 */
const FORMAT_PRIORITY = ['source', 'glb', 'gltf', 'usdz'] as const;
type FormatKey = (typeof FORMAT_PRIORITY)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the Retry-After header value into milliseconds.
 * Accepts both integer-seconds form ("120") and HTTP-date form.
 *
 * I2: an empty / whitespace-only header MUST return `undefined` so the caller
 * falls back to exponential backoff. `Number("")` is 0, not NaN, which would
 * otherwise translate "no value" into "retry immediately".
 */
function parseRetryAfter(header: string): number | undefined {
  if (!header.trim()) return undefined;
  const asNumber = Number(header);
  if (!isNaN(asNumber)) return asNumber * 1000;
  const asDate = new Date(header).getTime();
  if (!isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

/**
 * Extract the Sketchfab UID from a model URL of the form
 * `/3d-models/<slug>-<uid>` (or `/models/<uid>`). UID is the last hyphen-
 * separated segment of the slug. Returns null if no UID can be extracted.
 *
 * Sketchfab UIDs are typically 32-char alphanumeric (lowercase hex). We
 * accept any alphanumeric run between 12 and 64 characters to allow for
 * format drift while rejecting obviously-malformed inputs.
 */
function extractUidFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const parts = parsed.pathname.split('/').filter(Boolean);

  // Form 1: /3d-models/<slug>-<uid>
  const modelsIdx = parts.indexOf('3d-models');
  if (modelsIdx !== -1 && parts[modelsIdx + 1]) {
    const lastSegment = parts[modelsIdx + 1]!;
    // Trailing portion after the final '-' is the UID candidate.
    const lastDash = lastSegment.lastIndexOf('-');
    if (lastDash >= 0 && lastDash < lastSegment.length - 1) {
      const uidCandidate = lastSegment.slice(lastDash + 1);
      if (/^[A-Za-z0-9]{12,64}$/.test(uidCandidate)) return uidCandidate;
    }
    // No '-': the segment itself might be a bare UID (some short URLs).
    if (/^[A-Za-z0-9]{12,64}$/.test(lastSegment)) return lastSegment;
  }

  // Form 2: /models/<uid>
  const modelsIdx2 = parts.indexOf('models');
  if (modelsIdx2 !== -1 && parts[modelsIdx2 + 1]) {
    const candidate = parts[modelsIdx2 + 1]!;
    if (/^[A-Za-z0-9]{12,64}$/.test(candidate)) return candidate;
  }

  return null;
}

/**
 * Result of validating a credential bag. Discriminated to give callers a
 * precise reason string for the `failed` event (T6 pattern).
 */
type CredentialValidation =
  | { ok: true; creds: SketchfabCredentials }
  | { ok: false; reason: string };

/**
 * Validate the credential bag shape. Adapters cannot trust the shape because
 * the bag comes from `source_credentials` (encrypted, but caller-controlled
 * in tests + mock pipelines).
 */
function validateCredentials(raw: unknown): CredentialValidation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'credentials missing or not an object' };
  }
  const c = raw as Record<string, unknown>;
  const kind = c['kind'];
  if (kind === 'oauth') {
    if (typeof c['accessToken'] !== 'string' || !c['accessToken']) {
      return { ok: false, reason: 'oauth credentials missing accessToken' };
    }
    if (typeof c['refreshToken'] !== 'string' || !c['refreshToken']) {
      return { ok: false, reason: 'oauth credentials missing refreshToken' };
    }
    if (typeof c['expiresAt'] !== 'number' || !Number.isFinite(c['expiresAt'])) {
      return { ok: false, reason: 'oauth credentials missing numeric expiresAt' };
    }
    if (typeof c['clientId'] !== 'string' || !c['clientId']) {
      return { ok: false, reason: 'oauth credentials missing clientId' };
    }
    if (typeof c['clientSecret'] !== 'string' || !c['clientSecret']) {
      return { ok: false, reason: 'oauth credentials missing clientSecret' };
    }
    return { ok: true, creds: c as unknown as SketchfabOAuthCredentials };
  }
  if (kind === 'api-token') {
    if (typeof c['token'] !== 'string' || !c['token']) {
      return { ok: false, reason: 'api-token credentials missing token' };
    }
    return { ok: true, creds: c as unknown as SketchfabApiTokenCredentials };
  }
  return {
    ok: false,
    reason: `credentials missing or invalid kind discriminator (got ${JSON.stringify(kind)})`,
  };
}

/**
 * Build the Authorization header value for the current credentials.
 */
function authHeaderFor(creds: SketchfabCredentials): string {
  if (creds.kind === 'oauth') return `Bearer ${creds.accessToken}`;
  return `Token ${creds.token}`;
}

/**
 * Derive a filename from a Content-Disposition header value, if present
 * and parseable. Returns null otherwise.
 *
 * Handles both `filename="x.zip"` (quoted) and `filename=x.zip` (bare) forms.
 * Does NOT decode RFC-5987 `filename*=UTF-8''...` because Sketchfab's CDN
 * has not been observed using it; if that changes, extend here.
 */
function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename\s*=\s*("([^"]+)"|([^;]+))/i.exec(header);
  if (!m) return null;
  const raw = (m[2] ?? m[3] ?? '').trim();
  return raw || null;
}

/**
 * Default-format extension to use when no Content-Disposition is supplied.
 */
function fallbackExtForFormat(format: FormatKey): string {
  switch (format) {
    case 'glb':
      return 'glb';
    case 'gltf':
      return 'zip'; // gltf format ships as a ZIP with textures
    case 'usdz':
      return 'usdz';
    case 'source':
      return 'zip'; // source archive — unknown contents
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the Sketchfab adapter instance.
 */
export function createSketchfabAdapter(options?: SketchfabAdapterOptions): ScavengerAdapter {
  const apiBase = (options?.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const tokenEndpoint = options?.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
  const httpFetch = options?.httpFetch ?? globalThis.fetch;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = options?.retryBaseMs;

  return {
    id: 'sketchfab' as const,

    /**
     * Returns true for `sketchfab.com` and `www.sketchfab.com` URLs whose
     * path matches a model URL shape and from which a UID can be extracted.
     * T3-L9: exact-host allowlist.
     */
    supports(url: string): boolean {
      try {
        const parsed = new URL(url);
        if (!SKETCHFAB_HOSTS.has(parsed.host.toLowerCase())) return false;
        return extractUidFromUrl(url) !== null;
      } catch {
        return false;
      }
    },

    fetch(context: FetchContext, target: FetchTarget): AsyncIterable<ScavengerEvent> {
      return {
        [Symbol.asyncIterator]: async function* () {
          try {
            // ── 1. Resolve UID from target ───────────────────────────────────

            let uid: string;

            if (target.kind === 'raw') {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details:
                  'sketchfab adapter only accepts url or source-item-id targets',
              };
              return;
            }

            if (target.kind === 'source-item-id') {
              uid = target.sourceItemId;
            } else {
              const extracted = extractUidFromUrl(target.url);
              if (!extracted) {
                yield {
                  kind: 'failed' as const,
                  reason: 'unknown' as const,
                  details: `sketchfab adapter could not extract uid from URL: ${target.url}`,
                };
                return;
              }
              uid = extracted;
            }

            // ── 2. Validate credentials ──────────────────────────────────────

            const credValidation = validateCredentials(context.credentials);
            if (!credValidation.ok) {
              yield {
                kind: 'failed' as const,
                reason: 'auth-revoked' as const,
                details: `sketchfab adapter: ${credValidation.reason}`,
              };
              return;
            }

            let creds: SketchfabCredentials = credValidation.creds;

            // ── 3. Refresh OAuth token if near expiry ────────────────────────

            if (creds.kind === 'oauth') {
              const remaining = creds.expiresAt - Date.now();
              if (remaining < TOKEN_REFRESH_LEAD_MS) {
                const oauthCreds = creds; // narrow for closure use
                yield {
                  kind: 'progress' as const,
                  message: 'Refreshing Sketchfab OAuth token',
                };

                const refreshBody = new URLSearchParams({
                  grant_type: 'refresh_token',
                  refresh_token: oauthCreds.refreshToken,
                  client_id: oauthCreds.clientId,
                  client_secret: oauthCreds.clientSecret,
                });

                let refreshRes: Response;
                try {
                  refreshRes = await httpFetch(tokenEndpoint, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded',
                      Accept: 'application/json',
                    },
                    body: refreshBody.toString(),
                    signal: context.signal,
                  });
                } catch (refreshErr) {
                  const msg =
                    refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `sketchfab token refresh fetch failed: ${msg}`,
                    error: refreshErr,
                  };
                  return;
                }

                if (refreshRes.status === 400 || refreshRes.status === 401) {
                  // Refresh token rejected — credential is permanently invalid.
                  yield {
                    kind: 'auth-required' as const,
                    reason: 'revoked' as const,
                    surfaceToUser:
                      'Sketchfab refresh token rejected. Reconnect Sketchfab in Settings > Sources.',
                  };
                  yield {
                    kind: 'failed' as const,
                    reason: 'auth-revoked' as const,
                    details: `sketchfab refresh token rejected (HTTP ${refreshRes.status})`,
                  };
                  return;
                }

                if (!refreshRes.ok) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `sketchfab token endpoint responded ${refreshRes.status}`,
                  };
                  return;
                }

                let refreshJson: unknown;
                try {
                  refreshJson = await refreshRes.json();
                } catch (parseErr) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `sketchfab token response parse failed: ${(parseErr as Error).message}`,
                    error: parseErr,
                  };
                  return;
                }

                const tokenPayload = refreshJson as {
                  access_token?: unknown;
                  refresh_token?: unknown;
                  expires_in?: unknown;
                };

                if (
                  typeof tokenPayload.access_token !== 'string' ||
                  !tokenPayload.access_token ||
                  typeof tokenPayload.expires_in !== 'number'
                ) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details:
                      'sketchfab token response missing access_token or expires_in',
                  };
                  return;
                }

                // Sketchfab's refresh response usually includes a rotated
                // refresh_token; if absent, keep the existing one.
                const newRefreshToken =
                  typeof tokenPayload.refresh_token === 'string' &&
                  tokenPayload.refresh_token
                    ? tokenPayload.refresh_token
                    : oauthCreds.refreshToken;

                const newCreds: SketchfabOAuthCredentials = {
                  kind: 'oauth',
                  accessToken: tokenPayload.access_token,
                  refreshToken: newRefreshToken,
                  expiresAt: Date.now() + tokenPayload.expires_in * 1000,
                  clientId: oauthCreds.clientId,
                  clientSecret: oauthCreds.clientSecret,
                };

                creds = newCreds;

                // Hand the new bag to the pipeline. The callback may throw or
                // reject — log and continue. The token is valid for THIS
                // request even if persistence fails; failing the fetch on a
                // persistence error would be more surprising than logging.
                if (context.onTokenRefreshed) {
                  try {
                    await context.onTokenRefreshed(
                      newCreds as unknown as Record<string, unknown>,
                    );
                  } catch (cbErr) {
                    logger.warn(
                      { err: cbErr },
                      'sketchfab: onTokenRefreshed callback failed; continuing with new creds for this request',
                    );
                  }
                }
              }
            }

            // ── 4. Fetch model metadata (with rate-limit loop) ───────────────

            const metaUrl = `${apiBase}/models/${encodeURIComponent(uid)}`;
            const metadataJson = yield* requestJsonWithRetries(
              httpFetch,
              metaUrl,
              authHeaderFor(creds),
              context.signal,
              maxRetries,
              retryBaseMs,
              'metadata',
            );
            if (metadataJson === undefined) return; // failure already yielded

            const metadata = metadataJson as {
              uid?: string;
              name?: string;
              description?: string;
              license?: { slug?: string; label?: string } | null;
              user?: { displayName?: string; username?: string } | null;
              tags?: Array<{ name?: string; slug?: string } | string> | null;
              downloadable?: boolean;
              publishedAt?: string;
              viewerUrl?: string;
            };

            if (metadata.downloadable === false) {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: `Sketchfab model not downloadable (uid=${uid})`,
              };
              return;
            }

            // ── 5. Fetch download endpoint ───────────────────────────────────

            const dlUrl = `${apiBase}/models/${encodeURIComponent(uid)}/download`;
            const downloadJson = yield* requestJsonWithRetries(
              httpFetch,
              dlUrl,
              authHeaderFor(creds),
              context.signal,
              maxRetries,
              retryBaseMs,
              'download',
            );
            if (downloadJson === undefined) return;

            const dlPayload = downloadJson as Partial<
              Record<FormatKey, { url?: string; expires?: number; size?: number }>
            >;

            // Pick the highest-priority format available.
            let chosen: { format: FormatKey; url: string; size?: number } | null = null;
            for (const fmt of FORMAT_PRIORITY) {
              const entry = dlPayload[fmt];
              if (entry && typeof entry.url === 'string' && entry.url) {
                chosen = { format: fmt, url: entry.url, size: entry.size };
                break;
              }
            }

            if (!chosen) {
              yield {
                kind: 'failed' as const,
                reason: 'no-downloadable-formats' as const,
                details: `Sketchfab model ${uid} has no downloadable formats (source-file-only or restricted)`,
              };
              return;
            }

            // ── 6. Stream chosen file to staging ─────────────────────────────

            const titleForFile =
              metadata.name && metadata.name.trim() ? metadata.name : `sketchfab-${uid}`;

            yield {
              kind: 'progress' as const,
              message: `Downloading Sketchfab ${chosen.format} (${titleForFile})`,
            };

            // Note: download URLs are signed/short-lived — no Authorization
            // header is sent. Sending one is harmless if the URL is on the
            // same origin, but signed CDN URLs typically reject extraneous
            // auth headers.
            let dlRes: Response;
            try {
              dlRes = await httpFetch(chosen.url, { signal: context.signal });
            } catch (dlErr) {
              const msg = dlErr instanceof Error ? dlErr.message : String(dlErr);
              yield {
                kind: 'failed' as const,
                reason: 'network-error' as const,
                details: `Sketchfab file download failed: ${msg}`,
                error: dlErr,
              };
              return;
            }

            if (!dlRes.ok) {
              yield {
                kind: 'failed' as const,
                reason: 'network-error' as const,
                details: `Sketchfab file download responded ${dlRes.status}`,
              };
              return;
            }

            if (!dlRes.body) {
              yield {
                kind: 'failed' as const,
                reason: 'network-error' as const,
                details: 'Sketchfab file download returned no body',
              };
              return;
            }

            // Filename: prefer Content-Disposition; fall back to <title>.<ext>.
            const cdHeader = dlRes.headers.get('content-disposition');
            const cdName = filenameFromContentDisposition(cdHeader);
            const fallbackName = `${titleForFile}.${fallbackExtForFormat(chosen.format)}`;
            const sanitized =
              sanitizeFilename(cdName ?? fallbackName) ?? `sketchfab-${uid}.bin`;
            const destPath = path.join(context.stagingDir, sanitized);

            try {
              const nodeReadable = Readable.fromWeb(
                dlRes.body as import('stream/web').ReadableStream<Uint8Array>,
              );
              await streamPipeline(nodeReadable, createWriteStream(destPath));
            } catch (streamErr) {
              await fsp.unlink(destPath).catch(() => {});
              const msg =
                streamErr instanceof Error ? streamErr.message : String(streamErr);
              yield {
                kind: 'failed' as const,
                reason: 'network-error' as const,
                details: `Sketchfab download stream error: ${msg}`,
                error: streamErr,
              };
              return;
            }

            let fileSize: number | undefined;
            try {
              const stat = await fsp.stat(destPath);
              fileSize = stat.size;
            } catch {
              logger.warn({ destPath }, 'sketchfab: failed to stat staged file');
            }

            // ── 7. Build NormalizedItem ──────────────────────────────────────

            const creator =
              metadata.user?.displayName?.trim() ||
              metadata.user?.username?.trim() ||
              undefined;

            const tags = Array.isArray(metadata.tags)
              ? (metadata.tags
                  .map((t) =>
                    typeof t === 'string' ? t : t?.name ?? t?.slug ?? null,
                  )
                  .filter((t): t is string => typeof t === 'string' && t.length > 0))
              : undefined;

            const sourceUrl =
              typeof metadata.viewerUrl === 'string' && metadata.viewerUrl
                ? metadata.viewerUrl
                : `https://sketchfab.com/3d-models/${uid}`;

            // Sketchfab license slugs (e.g. cc-by-4.0) are PRESERVED VERBATIM.
            const license =
              typeof metadata.license?.slug === 'string' && metadata.license.slug
                ? metadata.license.slug
                : metadata.license?.label;

            const sourcePublishedAt =
              typeof metadata.publishedAt === 'string'
                ? new Date(metadata.publishedAt)
                : undefined;

            const item: NormalizedItem = {
              sourceId: 'sketchfab' as const,
              sourceItemId: typeof metadata.uid === 'string' ? metadata.uid : uid,
              sourceUrl,
              title: titleForFile,
              description: metadata.description,
              creator,
              license,
              tags,
              files: [
                {
                  stagedPath: destPath,
                  suggestedName: sanitized,
                  size: fileSize,
                  format: chosen.format,
                },
              ],
              sourcePublishedAt,
            };

            yield { kind: 'completed' as const, item };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // I3: AbortError (or pre-aborted signal) is a transport-layer
            // interruption — closer in spirit to 'network-error' than the
            // generic 'unknown' bucket. Common path: context.signal aborts
            // during the rate-limit `sleep()` in requestJsonWithRetries,
            // which rejects with an AbortError that bubbles here.
            const isAbort =
              (err instanceof Error && err.name === 'AbortError') ||
              context.signal?.aborted === true;
            if (isAbort) {
              logger.warn({ err }, 'sketchfab: aborted');
              yield {
                kind: 'failed' as const,
                reason: 'network-error' as const,
                details: `sketchfab aborted: ${msg}`,
                error: err,
              };
              return;
            }
            logger.warn({ err }, 'sketchfab: unexpected error');
            yield {
              kind: 'failed' as const,
              reason: 'unknown' as const,
              details: msg,
              error: err,
            };
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: shared rate-limit-aware JSON GET
//
// Pulled into a helper because the metadata + download endpoints share the
// exact same retry/error semantics. Extracting also keeps the main fetch
// generator readable. Yields any error/rate-limited events through the
// caller's iterator and returns either the parsed JSON or `undefined` if a
// terminal `failed`/`auth-required` was already yielded.
// ---------------------------------------------------------------------------

async function* requestJsonWithRetries(
  httpFetch: typeof fetch,
  url: string,
  authHeader: string,
  signal: AbortSignal | undefined,
  maxRetries: number,
  retryBaseMs: number | undefined,
  label: string,
): AsyncGenerator<ScavengerEvent, unknown, void> {
  let attempt = 1;
  while (true) {
    yield {
      kind: 'progress' as const,
      message: `Sketchfab ${label} request (attempt ${attempt})`,
    };

    let res: Response;
    try {
      res = await httpFetch(url, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Sketchfab ${label} fetch failed: ${msg}`,
        error: err,
      };
      return undefined;
    }

    // Retryable: 429 (rate-limit) and any 5xx (transient server error).
    // I1: 5xx blips are common on Sketchfab's edge; treat them with the same
    // backoff machinery as 429. 5xx has no Retry-After (typically) so the
    // helper falls through to the exponential branch in nextRetry.
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const ra = res.status === 429 ? res.headers.get('retry-after') : null;
      const retryAfterMs = ra ? parseRetryAfter(ra) : undefined;
      const decision = nextRetry(
        attempt,
        { maxAttempts: maxRetries, baseMs: retryBaseMs },
        retryAfterMs,
      );
      if (!decision.retry) {
        // Both 429 exhaustion and 5xx exhaustion surface as
        // 'rate-limit-exhausted' — the user-facing meaning is "we tried and
        // gave up". Distinguishing 5xx-exhausted from 429-exhausted at the
        // reason level would only matter to operators reading logs, and the
        // `details` string already includes the status code for that.
        yield {
          kind: 'failed' as const,
          reason: 'rate-limit-exhausted' as const,
          details: `Sketchfab ${label} retries exhausted after ${attempt} attempts (last status ${res.status})`,
        };
        return undefined;
      }
      yield {
        kind: 'rate-limited' as const,
        retryAfterMs: decision.delayMs,
        attempt,
      };
      await sleep(decision.delayMs, signal);
      attempt += 1;
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      yield {
        kind: 'auth-required' as const,
        reason: 'revoked' as const,
        surfaceToUser: `Sketchfab rejected credentials (${res.status})`,
      };
      yield {
        kind: 'failed' as const,
        reason: 'auth-revoked' as const,
        details: `Sketchfab ${label} responded ${res.status}`,
      };
      return undefined;
    }

    if (res.status === 404 || res.status === 410) {
      yield {
        kind: 'failed' as const,
        reason: 'content-removed' as const,
        details: `Sketchfab ${label} responded ${res.status}`,
      };
      return undefined;
    }

    if (!res.ok) {
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Sketchfab ${label} responded ${res.status}`,
      };
      return undefined;
    }

    try {
      return (await res.json()) as unknown;
    } catch (parseErr) {
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Sketchfab ${label} JSON parse failed: ${(parseErr as Error).message}`,
        error: parseErr,
      };
      return undefined;
    }
  }
}
