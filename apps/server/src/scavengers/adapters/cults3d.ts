/**
 * cults3d.ts — Cults3D ScavengerAdapter (V2-003-T5)
 *
 * Fetches model metadata and files from Cults3D via their GraphQL API.
 * Uses HTTP Basic auth (email + API key) per Cults3D documentation.
 *
 * Rate-limit handling delegates to T1's nextRetry + sleep helpers.
 * Credentials are loaded from ctx.credentials (populated by the pipeline
 * from V2-001's source_credentials table — encrypted at rest).
 *
 * This adapter is URL-driven: supports() returns true for cults3d.com hostnames.
 * T3-L9 pattern: exact-host allowlist, no suffix matching.
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
import type {
  SubscribableAdapter,
  DiscoveryContext,
  DiscoveryEvent,
} from '../subscribable';
import type { WatchlistSubscriptionKind } from '../../watchlist/types';
import { nextRetry, sleep } from '../rate-limit';
import { sanitizeFilename } from '../filename-sanitize';
import { logger } from '../../logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Cults3dCredentials = {
  /** Cults3D email for HTTP Basic auth. */
  email: string;
  /** Cults3D API key (the account password equivalent per their docs). */
  apiKey: string;
};

export type Cults3dAdapterOptions = {
  /** Override GraphQL endpoint for tests. Default 'https://cults3d.com/graphql'. */
  endpoint?: string;
  /** Override fetch (test seam). Default globalThis.fetch. */
  httpFetch?: typeof fetch;
  /** Max rate-limit retry attempts before giving up. Default 6. */
  maxRetries?: number;
  /**
   * Override the base backoff delay in milliseconds for rate-limit retries.
   * Default 1000. Set to 0 in tests to skip real sleep delays.
   */
  retryBaseMs?: number;
  /**
   * V2-004 T7 — first-fire bounded backfill cap.
   *
   * On a Watchlist subscription's first firing (no cursor), the discovery
   * methods ingest at most this many items to avoid catastrophic backfill on
   * a creator with thousands of models. Subsequent firings stop at the
   * previously-recorded cursor regardless of this value. Honors
   * `WATCHLIST_FIRST_FIRE_BACKFILL` env var with a 100-item ceiling.
   * Default 20.
   */
  firstFireBackfill?: number;
  /** Page size for GraphQL pagination. Default 50. */
  pageSize?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = 'https://cults3d.com/graphql';
const DEFAULT_MAX_RETRIES = 6;

// V2-004 T7: first-fire bounded backfill defaults.
const DEFAULT_FIRST_FIRE_BACKFILL = 20;
const FIRST_FIRE_BACKFILL_HARD_CAP = 100;
const DEFAULT_DISCOVERY_PAGE_SIZE = 50;

/**
 * Resolve the first-fire backfill cap honoring the env var override and the
 * 100-item hard ceiling. Centralised so all four adapters use the same logic.
 */
function resolveFirstFireBackfill(optionOverride?: number): number {
  if (typeof optionOverride === 'number' && Number.isFinite(optionOverride) && optionOverride > 0) {
    return Math.min(Math.floor(optionOverride), FIRST_FIRE_BACKFILL_HARD_CAP);
  }
  const env = process.env['WATCHLIST_FIRST_FIRE_BACKFILL'];
  if (env) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, FIRST_FIRE_BACKFILL_HARD_CAP);
    }
  }
  return DEFAULT_FIRST_FIRE_BACKFILL;
}

/**
 * Exact set of hostnames this adapter owns.
 * T3-L9: exact-host allowlist — no endsWith or suffix matching.
 */
const CULTS3D_HOSTS = new Set(['cults3d.com', 'www.cults3d.com']);

// Cults3D URLs use locale prefixes (/en/3d-model/, /fr/3d-model/, etc.).
// `extractSlugFromUrl` doesn't enumerate them — it locates the '3d-model'
// landmark segment via `indexOf` and reads the next segment as the slug.
// This handles every current locale plus future additions without a list.

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

const CREATION_QUERY = `query GetCreation($slug: String!) {
  creation(slug: $slug) {
    id
    slug
    name
    description
    tags
    license { name }
    creator { nick }
    illustrations { url }
    downloadableSets { url name size }
  }
}`;

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
 * Build the Base64-encoded HTTP Basic auth token.
 * Intentionally avoids Buffer.from(…, 'base64') in tests — uses btoa when
 * available (Node 22+ global), falls back to Buffer for older Node runtimes.
 */
function buildBasicAuth(email: string, apiKey: string): string {
  const cred = `${email}:${apiKey}`;
  // Buffer is always available in Node 22 — btoa is also available globally.
  return Buffer.from(cred).toString('base64');
}

/**
 * Resolve a URL target to a Cults3D slug string.
 * Returns null if the URL does not match the expected /3d-model/{slug} shape.
 */
function extractSlugFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // T3-L2: use indexOf on path segments rather than positional indexing —
  // handles locale prefix variants (/en/, /fr/, etc.) robustly.
  const parts = parsed.pathname.split('/').filter(Boolean);

  // Find the '3d-model' landmark segment.
  const modelIdx = parts.indexOf('3d-model');
  if (modelIdx === -1) return null;

  // The segment immediately after '3d-model' is the slug.
  const slug = parts[modelIdx + 1];
  if (!slug) return null;

  return slug;
}

/**
 * Deduplicate a filename within a seen-names Map (T4-L6 pattern).
 * On first occurrence: use the base name as-is.
 * On collision: insert '-N' before the extension.
 */
function deduplicateName(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  if (count === 0) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  return `${stem}-${count}${ext}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the Cults3D adapter instance.
 *
 * Accepts an optional options bag for test-seam injection (httpFetch, endpoint).
 * There should be one instance per process — register in createDefaultRegistry().
 */
export function createCults3dAdapter(
  options?: Cults3dAdapterOptions,
): ScavengerAdapter & SubscribableAdapter {
  const endpoint = options?.endpoint ?? DEFAULT_ENDPOINT;
  const httpFetch = options?.httpFetch ?? globalThis.fetch;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = options?.retryBaseMs ?? undefined; // undefined → nextRetry uses its own default
  const firstFireBackfill = resolveFirstFireBackfill(options?.firstFireBackfill);
  const pageSize = options?.pageSize ?? DEFAULT_DISCOVERY_PAGE_SIZE;

  return {
    id: 'cults3d' as const,

    metadata: {
      displayName: 'Cults3D',
      authMethods: ['api-key'],
      supports: { url: true, sourceItemId: true, raw: false },
    },

    // V2-004 T7 — SubscribableAdapter capabilities.
    capabilities: new Set<WatchlistSubscriptionKind>(['creator', 'tag', 'saved_search']),

    listCreator(context: DiscoveryContext, creatorId: string): AsyncIterable<DiscoveryEvent> {
      return runCults3dDiscovery({
        context,
        mode: { kind: 'creator', creatorSlug: creatorId },
        endpoint,
        httpFetch,
        maxRetries,
        retryBaseMs,
        firstFireBackfill,
        pageSize,
      });
    },

    searchByTag(context: DiscoveryContext, tag: string): AsyncIterable<DiscoveryEvent> {
      return runCults3dDiscovery({
        context,
        mode: { kind: 'tag', tag },
        endpoint,
        httpFetch,
        maxRetries,
        retryBaseMs,
        firstFireBackfill,
        pageSize,
      });
    },

    search(context: DiscoveryContext, query: string): AsyncIterable<DiscoveryEvent> {
      return runCults3dDiscovery({
        context,
        mode: { kind: 'search', query },
        endpoint,
        httpFetch,
        maxRetries,
        retryBaseMs,
        firstFireBackfill,
        pageSize,
      });
    },

    /**
     * Returns true for cults3d.com and www.cults3d.com.
     * T3-L9: exact-host allowlist — never suffix-match.
     */
    supports(url: string): boolean {
      try {
        const parsed = new URL(url);
        return CULTS3D_HOSTS.has(parsed.host);
      } catch {
        return false;
      }
    },

    fetch(context: FetchContext, target: FetchTarget): AsyncIterable<ScavengerEvent> {
      return {
        [Symbol.asyncIterator]: async function* () {
          try {
            // ── 1. Resolve slug from target ──────────────────────────────────

            let slug: string;

            if (target.kind === 'raw') {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: 'cults3d adapter does not accept raw targets',
              };
              return;
            }

            if (target.kind === 'source-item-id') {
              // Pipeline already resolved the slug (stored as sourceItemId).
              slug = target.sourceItemId;
            } else {
              // target.kind === 'url'
              const extracted = extractSlugFromUrl(target.url);
              if (!extracted) {
                yield {
                  kind: 'failed' as const,
                  reason: 'unknown' as const,
                  details: `URL did not match cults3d /3d-model/{slug} shape: ${target.url}`,
                };
                return;
              }
              slug = extracted;
            }

            // ── 2. Validate credentials ──────────────────────────────────────

            const creds = context.credentials as Cults3dCredentials | undefined;
            if (
              !creds ||
              typeof creds.email !== 'string' ||
              !creds.email ||
              typeof creds.apiKey !== 'string' ||
              !creds.apiKey
            ) {
              yield {
                kind: 'auth-required' as const,
                reason: 'missing' as const,
                surfaceToUser:
                  'Cults3D requires email + API key. Add credentials in Settings > Sources.',
              };
              // Protocol invariant (T7-CF-1): every fetch() MUST terminate
              // with exactly one `completed` or `failed` event as the final
              // item. `auth-required` alone leaves the iterator without a
              // terminal — emit `failed` with reason='auth-revoked' so
              // downstream consumers see a definitive end-of-stream.
              // 'auth-revoked' is the catch-all for "auth needed, can't
              // proceed" per types.ts; 'missing' (the auth-required reason)
              // is a finer-grained UI hint and isn't a failure-reason value.
              yield {
                kind: 'failed' as const,
                reason: 'auth-revoked' as const,
                details: 'Cults3D credentials missing — fetch aborted',
              };
              return;
            }

            const authToken = buildBasicAuth(creds.email, creds.apiKey);
            const headers = {
              Authorization: `Basic ${authToken}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            };

            // ── 3. GraphQL query with rate-limit loop ─────────────────────────

            const gqlBody = JSON.stringify({
              query: CREATION_QUERY,
              variables: { slug },
            });

            let gqlResponseJson: unknown;
            let attempt = 1;

            while (true) {
              yield {
                kind: 'progress' as const,
                message: `Querying Cults3D for ${slug} (attempt ${attempt})`,
              };

              const signal = context.signal;
              let res: Response;
              try {
                res = await httpFetch(endpoint, {
                  method: 'POST',
                  headers,
                  body: gqlBody,
                  signal,
                });
              } catch (fetchErr) {
                // AbortError from signal, or network-level failure.
                const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
                yield {
                  kind: 'failed' as const,
                  reason: 'network-error' as const,
                  details: `Cults3D GraphQL fetch failed: ${msg}`,
                };
                return;
              }

              if (res.status === 429) {
                const retryAfterHeader = res.headers.get('retry-after');
                const retryAfterMs = retryAfterHeader
                  ? parseRetryAfter(retryAfterHeader)
                  : undefined;
                const decision = nextRetry(
                  attempt,
                  { maxAttempts: maxRetries, baseMs: retryBaseMs },
                  retryAfterMs,
                );
                if (!decision.retry) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'rate-limit-exhausted' as const,
                    details: `Cults3D rate-limit after ${attempt} attempts`,
                  };
                  return;
                }
                yield {
                  kind: 'rate-limited' as const,
                  retryAfterMs: decision.delayMs,
                  attempt,
                };
                await sleep(decision.delayMs, context.signal);
                attempt += 1;
                continue;
              }

              if (res.status === 401 || res.status === 403) {
                yield {
                  kind: 'auth-required' as const,
                  reason: 'revoked' as const,
                  surfaceToUser: `Cults3D rejected credentials (${res.status})`,
                };
                // T7-CF-1 protocol invariant: terminal `failed` after the
                // non-terminal `auth-required` event so the iterator ends
                // with a recognised completed/failed sentinel.
                yield {
                  kind: 'failed' as const,
                  reason: 'auth-revoked' as const,
                  details: `Cults3D rejected credentials on GraphQL (${res.status})`,
                };
                return;
              }

              if (!res.ok) {
                yield {
                  kind: 'failed' as const,
                  reason: 'network-error' as const,
                  details: `Cults3D responded ${res.status}`,
                };
                return;
              }

              // HTTP 200 — parse GraphQL response.
              try {
                gqlResponseJson = await res.json();
              } catch (parseErr) {
                yield {
                  kind: 'failed' as const,
                  reason: 'network-error' as const,
                  details: `Cults3D response JSON parse failed: ${(parseErr as Error).message}`,
                };
                return;
              }
              break; // success
            }

            // ── 4. Parse GraphQL response ─────────────────────────────────────

            const gqlResponse = gqlResponseJson as {
              data?: { creation: Record<string, unknown> | null };
              errors?: Array<{ message: string }>;
            };

            if (Array.isArray(gqlResponse.errors) && gqlResponse.errors.length > 0) {
              // GraphQL application-layer error (validation, schema mismatch,
              // server logic). NOT a TCP/DNS-level failure — types.ts reserves
              // 'network-error' for transport-level issues. Use 'unknown' so
              // downstream retry policies don't treat this as a retryable
              // network blip.
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: `Cults3D GraphQL errors: ${JSON.stringify(gqlResponse.errors)}`,
              };
              return;
            }

            const creation = gqlResponse.data?.creation;
            if (creation === null || creation === undefined) {
              // Cults3D returns data.creation = null for BOTH:
              //   (a) truly deleted/nonexistent items ('content-removed')
              //   (b) private items the credentials cannot access ('auth-required'
              //       conceptually)
              // The API does not discriminate between these cases at this
              // layer. We map to 'content-removed' by convention; operators
              // investigating stuck ingests should verify credentials before
              // assuming the item is gone. A private-items API probe is NOT
              // done here.
              yield {
                kind: 'failed' as const,
                reason: 'content-removed' as const,
                details: `Cults3D creation ${slug} not found`,
              };
              return;
            }

            // Type-narrow the creation object.
            const c = creation as {
              id: string;
              slug: string;
              name: string;
              description?: string;
              tags?: string[];
              license?: { name: string } | null;
              creator?: { nick: string } | null;
              illustrations?: Array<{ url: string }>;
              downloadableSets?: Array<{ url: string; name: string; size?: number }>;
            };

            logger.debug(
              { slug, fileCount: c.downloadableSets?.length ?? 0 },
              'cults3d: creation fetched',
            );

            // ── 5. Download files ─────────────────────────────────────────────

            const downloadables = c.downloadableSets ?? [];
            const stagedFiles: Array<{
              stagedPath: string;
              suggestedName: string;
              size?: number;
            }> = [];

            const seenNames = new Map<string, number>();

            for (let i = 0; i < downloadables.length; i++) {
              const dl = downloadables[i]!;

              // Sanitize the filename from the source (T4-L4, T4-L5 pattern).
              const rawName = dl.name || `file-${i}.bin`;
              const sanitized = sanitizeFilename(rawName) ?? `file-${i}.bin`;
              const finalName = deduplicateName(sanitized, seenNames);
              const destPath = path.join(context.stagingDir, finalName);

              yield {
                kind: 'progress' as const,
                message: `Downloading ${finalName} (${i + 1}/${downloadables.length})`,
              };

              // Download with rate-limit loop.
              let dlAttempt = 1;
              while (true) {
                let dlRes: Response;
                try {
                  dlRes = await httpFetch(dl.url, {
                    headers: { Authorization: `Basic ${authToken}` },
                    signal: context.signal,
                  });
                } catch (dlFetchErr) {
                  const msg =
                    dlFetchErr instanceof Error ? dlFetchErr.message : String(dlFetchErr);
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `Cults3D file download failed (${finalName}): ${msg}`,
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
                      details: `Cults3D rate-limit downloading ${finalName} after ${dlAttempt} attempts`,
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

                if (dlRes.status === 401 || dlRes.status === 403) {
                  yield {
                    kind: 'auth-required' as const,
                    reason: 'revoked' as const,
                    surfaceToUser: `Cults3D rejected credentials downloading file (${dlRes.status})`,
                  };
                  // T7-CF-1 protocol invariant: terminal `failed` after
                  // `auth-required` so the iterator ends with a sentinel.
                  yield {
                    kind: 'failed' as const,
                    reason: 'auth-revoked' as const,
                    details: `Cults3D rejected credentials downloading ${finalName} (${dlRes.status})`,
                  };
                  return;
                }

                if (!dlRes.ok) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `Cults3D file download responded ${dlRes.status} for ${finalName}`,
                  };
                  return;
                }

                if (!dlRes.body) {
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `Cults3D file download returned no body for ${finalName}`,
                  };
                  return;
                }

                // Stream response body to disk.
                try {
                  // Node 22: Response.body is a web ReadableStream — convert to Node
                  // Readable for pipeline() compatibility.
                  const nodeReadable = Readable.fromWeb(
                    dlRes.body as import('stream/web').ReadableStream<Uint8Array>,
                  );
                  await streamPipeline(nodeReadable, createWriteStream(destPath));
                } catch (streamErr) {
                  // Remove the partial file — don't leave a truncated artifact
                  // in stagingDir. The pipeline's outer cleanup would also
                  // remove the dir on failure, but that's defence-in-depth;
                  // an adapter should not leave corrupt files behind even for
                  // one tick.
                  await fsp.unlink(destPath).catch(() => {});
                  const msg =
                    streamErr instanceof Error ? streamErr.message : String(streamErr);
                  yield {
                    kind: 'failed' as const,
                    reason: 'network-error' as const,
                    details: `Cults3D download stream error for ${finalName}: ${msg}`,
                    error: streamErr,
                  };
                  return;
                }

                break; // download successful
              }

              // Stat the file for size (dl.size is advisory — re-measure from disk).
              let fileSize: number | undefined;
              try {
                const stat = await fsp.stat(destPath);
                fileSize = stat.size;
              } catch {
                // Non-fatal — pipeline will re-measure if absent.
                logger.warn({ destPath }, 'cults3d: failed to stat staged file');
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

            // ── 6. Build NormalizedItem ───────────────────────────────────────

            const item: NormalizedItem = {
              sourceId: 'cults3d' as const,
              sourceItemId: c.id,
              sourceUrl: `https://cults3d.com/en/3d-model/${c.slug}`,
              title: c.name,
              description: c.description,
              creator: c.creator?.nick,
              license: c.license?.name,
              tags: c.tags,
              files: stagedFiles.map((f) => ({
                stagedPath: f.stagedPath,
                suggestedName: f.suggestedName,
                size: f.size,
              })),
            };

            // ── 7. Yield completed ────────────────────────────────────────────

            yield { kind: 'completed' as const, item };
          } catch (err) {
            // Catch-all — surface as failed event rather than letting the async
            // generator throw (which would propagate as an unhandled rejection
            // from the pipeline's for-await loop).
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn({ err }, 'cults3d: unexpected error');
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

// ---------------------------------------------------------------------------
// V2-004 T7 — SubscribableAdapter discovery support
// ---------------------------------------------------------------------------

/**
 * Cults3D Watchlist discovery cursor format.
 *
 * Stored on `watchlist_subscriptions.cursor` as JSON. Externally opaque —
 * the watchlist worker round-trips the string as-is.
 *
 *   firstSeenSourceItemId — id of the most-recently-yielded item from the
 *     PRIOR firing. The next firing stops paginating once it encounters this
 *     item, so each firing only ingests truly-new items.
 */
type Cults3dCursor = {
  firstSeenSourceItemId: string;
};

type DiscoveryMode =
  | { kind: 'creator'; creatorSlug: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'search'; query: string };

type RunDiscoveryArgs = {
  context: DiscoveryContext;
  mode: DiscoveryMode;
  endpoint: string;
  httpFetch: typeof fetch;
  maxRetries: number;
  retryBaseMs: number | undefined;
  firstFireBackfill: number;
  pageSize: number;
};

const CREATOR_LISTING_QUERY = `query CreatorListing($slug: String!, $first: Int!, $after: String) {
  creator(slug: $slug) {
    creations(first: $first, after: $after) {
      edges {
        cursor
        node { id name publishedAt }
      }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

const TAG_SEARCH_QUERY = `query TagSearch($tags: [String!]!, $first: Int!, $after: String) {
  search(tags: $tags, first: $first, after: $after) {
    edges {
      cursor
      node { id name publishedAt }
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

const QUERY_SEARCH_QUERY = `query QuerySearch($query: String!, $first: Int!, $after: String) {
  search(query: $query, first: $first, after: $after) {
    edges {
      cursor
      node { id name publishedAt }
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

type CreationNode = { id: string; name?: string; publishedAt?: string };
type Edge = { cursor: string; node: CreationNode };
type EdgeConnection = {
  edges: Edge[];
  pageInfo: { endCursor?: string | null; hasNextPage?: boolean };
};

function parseCults3dCursor(raw: string | undefined): Cults3dCursor | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      obj &&
      typeof obj === 'object' &&
      typeof (obj as Record<string, unknown>)['firstSeenSourceItemId'] === 'string'
    ) {
      return { firstSeenSourceItemId: (obj as Record<string, string>)['firstSeenSourceItemId']! };
    }
  } catch {
    // Malformed cursor — treat as first-fire.
  }
  return undefined;
}

function runCults3dDiscovery(args: RunDiscoveryArgs): AsyncIterable<DiscoveryEvent> {
  const { context, mode, endpoint, httpFetch, maxRetries, retryBaseMs, firstFireBackfill, pageSize } = args;

  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<DiscoveryEvent, void, void> {
      try {
        // Validate credentials — same shape as fetch().
        const creds = context.credentials as Cults3dCredentials | undefined;
        if (
          !creds ||
          typeof creds.email !== 'string' ||
          !creds.email ||
          typeof creds.apiKey !== 'string' ||
          !creds.apiKey
        ) {
          yield {
            kind: 'auth-required' as const,
            reason: 'missing' as const,
            surfaceToUser:
              'Cults3D requires email + API key. Add credentials in Settings > Sources.',
          };
          yield {
            kind: 'discovery-failed' as const,
            reason: 'auth-revoked' as const,
            details: 'Cults3D credentials missing — discovery aborted',
          };
          return;
        }

        const authToken = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64');
        const headers = {
          Authorization: `Basic ${authToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };

        const priorCursor = parseCults3dCursor(context.cursor);
        const isFirstFire = priorCursor === undefined;
        const cap = isFirstFire ? firstFireBackfill : Number.MAX_SAFE_INTEGER;

        let itemsTotal = 0;
        let firstSeenIdThisRun: string | undefined;
        let pageAfter: string | undefined;
        let stop = false;

        while (!stop) {
          if (context.signal?.aborted) {
            yield {
              kind: 'discovery-failed' as const,
              reason: 'unknown' as const,
              details: 'cults3d discovery aborted by signal',
            };
            return;
          }

          // Build query + variables for this mode.
          let query: string;
          const variables: Record<string, unknown> = { first: pageSize };
          if (pageAfter) variables['after'] = pageAfter;
          if (mode.kind === 'creator') {
            query = CREATOR_LISTING_QUERY;
            variables['slug'] = mode.creatorSlug;
          } else if (mode.kind === 'tag') {
            query = TAG_SEARCH_QUERY;
            variables['tags'] = [mode.tag];
          } else {
            query = QUERY_SEARCH_QUERY;
            variables['query'] = mode.query;
          }

          const body = JSON.stringify({ query, variables });

          // Rate-limit-aware POST.
          let attempt = 1;
          let pageJson: unknown;
          while (true) {
            yield {
              kind: 'progress' as const,
              message: `Cults3D ${mode.kind} discovery (page attempt ${attempt})`,
              itemsSeen: itemsTotal,
            };
            let res: Response;
            try {
              res = await httpFetch(endpoint, {
                method: 'POST',
                headers,
                body,
                signal: context.signal,
              });
            } catch (fetchErr) {
              const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
              yield {
                kind: 'discovery-failed' as const,
                reason: 'network-error' as const,
                details: `Cults3D discovery fetch failed: ${msg}`,
                error: fetchErr,
              };
              return;
            }

            if (res.status === 429) {
              const retryAfterHeader = res.headers.get('retry-after');
              const retryAfterMs = retryAfterHeader
                ? parseRetryAfter(retryAfterHeader)
                : undefined;
              const decision = nextRetry(
                attempt,
                { maxAttempts: maxRetries, baseMs: retryBaseMs },
                retryAfterMs,
              );
              if (!decision.retry) {
                yield {
                  kind: 'discovery-failed' as const,
                  reason: 'rate-limit-exhausted' as const,
                  details: `Cults3D discovery rate-limited after ${attempt} attempts`,
                };
                return;
              }
              yield {
                kind: 'rate-limited' as const,
                retryAfterMs: decision.delayMs,
                attempt,
              };
              await sleep(decision.delayMs, context.signal);
              attempt += 1;
              continue;
            }

            if (res.status === 401 || res.status === 403) {
              yield {
                kind: 'auth-required' as const,
                reason: 'revoked' as const,
                surfaceToUser: `Cults3D rejected credentials (${res.status})`,
              };
              yield {
                kind: 'discovery-failed' as const,
                reason: 'auth-revoked' as const,
                details: `Cults3D discovery rejected (${res.status})`,
              };
              return;
            }

            if (!res.ok) {
              yield {
                kind: 'discovery-failed' as const,
                reason: 'network-error' as const,
                details: `Cults3D discovery responded ${res.status}`,
              };
              return;
            }

            try {
              pageJson = await res.json();
            } catch (parseErr) {
              yield {
                kind: 'discovery-failed' as const,
                reason: 'network-error' as const,
                details: `Cults3D discovery JSON parse failed: ${(parseErr as Error).message}`,
                error: parseErr,
              };
              return;
            }
            break;
          }

          const gql = pageJson as {
            data?: {
              creator?: { creations?: EdgeConnection } | null;
              search?: EdgeConnection | null;
            };
            errors?: Array<{ message: string }>;
          };

          if (Array.isArray(gql.errors) && gql.errors.length > 0) {
            yield {
              kind: 'discovery-failed' as const,
              reason: 'unknown' as const,
              details: `Cults3D GraphQL errors: ${JSON.stringify(gql.errors)}`,
            };
            return;
          }

          let conn: EdgeConnection | undefined;
          if (mode.kind === 'creator') {
            conn = gql.data?.creator?.creations ?? undefined;
            if (!conn && gql.data?.creator === null) {
              yield {
                kind: 'discovery-failed' as const,
                reason: 'content-removed' as const,
                details: `Cults3D creator ${mode.creatorSlug} not found`,
              };
              return;
            }
          } else {
            conn = gql.data?.search ?? undefined;
          }

          if (!conn) {
            yield {
              kind: 'discovery-failed' as const,
              reason: 'no-results' as const,
              details: `Cults3D discovery returned no connection`,
            };
            return;
          }

          const edges = conn.edges ?? [];
          for (const edge of edges) {
            if (!edge.node?.id) continue;
            // Stop at the first-seen item from the prior firing (rolling cursor).
            if (priorCursor && edge.node.id === priorCursor.firstSeenSourceItemId) {
              stop = true;
              break;
            }
            // Cap at firstFireBackfill on first firing.
            if (itemsTotal >= cap) {
              stop = true;
              break;
            }
            const event: DiscoveryEvent = {
              kind: 'item-discovered' as const,
              sourceItemId: edge.node.id,
            };
            const hint: { title?: string; publishedAt?: Date } = {};
            if (typeof edge.node.name === 'string' && edge.node.name) hint.title = edge.node.name;
            if (typeof edge.node.publishedAt === 'string') {
              const d = new Date(edge.node.publishedAt);
              if (!Number.isNaN(d.getTime())) hint.publishedAt = d;
            }
            if (hint.title || hint.publishedAt) event.metadataHint = hint;
            yield event;
            itemsTotal += 1;
            // Record the first item we see this run — that becomes the new
            // first-seen cursor passed to the next firing.
            if (firstSeenIdThisRun === undefined) {
              firstSeenIdThisRun = edge.node.id;
            }
          }

          if (stop) break;

          if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
          pageAfter = conn.pageInfo.endCursor;
        }

        // Build new cursor: prefer the first-seen id from THIS run, else
        // preserve the prior cursor (so subsequent runs still know where to stop).
        const newCursor: Cults3dCursor | undefined = firstSeenIdThisRun
          ? { firstSeenSourceItemId: firstSeenIdThisRun }
          : priorCursor;

        const completed: DiscoveryEvent = {
          kind: 'discovery-completed' as const,
          itemsTotal,
        };
        if (newCursor) completed.cursor = JSON.stringify(newCursor);
        yield completed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort =
          (err instanceof Error && err.name === 'AbortError') ||
          context.signal?.aborted === true;
        logger.warn({ err }, 'cults3d: discovery unexpected error');
        yield {
          kind: 'discovery-failed' as const,
          reason: isAbort ? 'network-error' : 'unknown',
          details: msg,
          error: err,
        };
      }
    },
  };
}
