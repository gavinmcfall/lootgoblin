/**
 * gdrive.ts — Google Drive ScavengerAdapter (V2-003-T8)
 *
 * Inherits the OAuth-flow patterns established in T7 (Sketchfab):
 *   - TOKEN_REFRESH_LEAD_MS = 60_000 silent refresh
 *   - onTokenRefreshed callback (failure-tolerant — log + continue)
 *   - 429 ∪ 5xx unified retry via shared `nextRetry` + `sleep`
 *   - parseRetryAfter with whitespace guard (empty header → undefined)
 *   - AbortError → 'network-error' (not 'unknown')
 *   - Always populate failed.error when an Error object is in scope
 *   - Discriminated `validateCredentials` return shape
 *   - Signed CDN download URLs fetched WITHOUT Authorization (T7-L3)
 *
 * Two paired modes coexist in one adapter, discriminated by credential `kind`:
 *   - 'oauth'         — OAuth 2.0 with PKCE for the user's own Drive account.
 *                       Uses `Authorization: Bearer <accessToken>`.
 *   - 'api-key'       — anonymous API key for unauthenticated public links.
 *                       Uses `?key=<apiKey>` query param on every request.
 *   - 'oauth+api-key' — both. The adapter tries the API-key path FIRST
 *                       (cheaper, works for anything public) and falls back
 *                       to OAuth on 401/403 from metadata or download.
 *
 * Folder URLs are walked recursively up to per-credential or default caps.
 * Google-native files (Doc/Sheet/Slide/Form/Drawing/Script/Site) are SILENTLY
 * SKIPPED with a `progress` event — they have no canonical bytes to download.
 * If a folder yields ZERO ingestable files after recursion (only natives), the
 * adapter yields `failed reason='no-downloadable-formats'`.
 *
 * Resource Keys: legacy public links carry `?resourcekey=…`. When present we
 * forward it verbatim as `X-Goog-Drive-Resource-Keys: <fileId>/<resourceKey>`
 * on every metadata + download call for that file.
 *
 * Auth-required `reason: 'missing'`: when a public link is pasted with NO
 * credentials configured at all and the bare metadata fetch (no API key, no
 * OAuth) will obviously fail, we yield `auth-required reason: 'missing'`
 * before the terminal `failed reason: 'auth-revoked'`. This locks the
 * deferred T7-CF-2 semantics:
 *   - 'missing' = no creds at all
 *   - 'revoked' = creds were rejected by the server
 *
 * @see https://developers.google.com/drive/api/v3/reference
 * @see https://developers.google.com/drive/api/v3/resource-keys
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

/**
 * OAuth credential bag. `expiresAt` is a UTC ms-since-epoch timestamp.
 * Google does NOT rotate refresh tokens on refresh — when the response omits
 * `refresh_token`, we preserve the existing one.
 */
export type GDriveOAuthCredentials = {
  kind: 'oauth';
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  clientSecret: string;
};

/** API-key-only credentials for public-link access. */
export type GDriveApiKeyCredentials = {
  kind: 'api-key';
  apiKey: string;
};

/** Dual mode: try API key first, fall back to OAuth on 401/403. */
export type GDriveDualCredentials = {
  kind: 'oauth+api-key';
  oauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    clientId: string;
    clientSecret: string;
  };
  apiKey: string;
};

export type GDriveCredentials =
  | GDriveOAuthCredentials
  | GDriveApiKeyCredentials
  | GDriveDualCredentials;

/** Per-credential cap overrides. Each field is independently optional. */
export type GDriveCaps = {
  maxFiles?: number;
  maxBytes?: number;
  maxDepth?: number;
};

/** Resolved (non-optional) caps used internally. */
type ResolvedCaps = {
  maxFiles: number;
  maxBytes: number;
  maxDepth: number;
};

export type GDriveAdapterOptions = {
  /** Override the v3 metadata/download base URL. */
  apiBase?: string;
  /** Override the OAuth token endpoint. */
  tokenEndpoint?: string;
  /** Override fetch (test seam). */
  httpFetch?: typeof fetch;
  /** Max retry attempts for 429/5xx. Default 6. */
  maxRetries?: number;
  /** Override base backoff delay in ms. Set to 0 in tests. */
  retryBaseMs?: number;
  /** Default caps when credentials don't carry their own. */
  defaultCaps?: ResolvedCaps;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE = 'https://www.googleapis.com/drive/v3';
const DEFAULT_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_MAX_RETRIES = 6;
const TOKEN_REFRESH_LEAD_MS = 60_000;

const DEFAULT_CAPS: ResolvedCaps = {
  maxFiles: 500,
  maxBytes: 10 * 1024 * 1024 * 1024, // 10 GiB
  maxDepth: 5,
};

/** Exact-host allowlist (T3-L9). */
const GDRIVE_HOSTS = new Set([
  'drive.google.com',
  'www.drive.google.com',
  'docs.google.com',
  'www.docs.google.com',
]);

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * MIME types that are Google-native authored files (Docs, Sheets, etc.).
 * These have no canonical downloadable bytes — exporting would lose fidelity
 * and is out-of-scope for an ingest pipeline. We skip them silently.
 *
 * NOTE: 'application/vnd.google-apps.folder' is NOT here — folders are
 * structural, not skip targets.
 */
const GOOGLE_NATIVE_MIMES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.drawing',
  'application/vnd.google-apps.script',
  'application/vnd.google-apps.site',
]);

const FILE_LIST_PAGE_SIZE = 1000;
const META_FIELDS =
  'id,name,mimeType,size,parents,md5Checksum,modifiedTime,owners,description';
const LIST_FIELDS = `files(${META_FIELDS}),nextPageToken`;

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

type ParsedTarget = {
  /**
   * 'file' = drive.google.com/file/d/{id}
   * 'folder' = drive.google.com/drive/folders/{id}
   * 'open' = drive.google.com/open?id={id} (ambiguous — disambiguate via metadata)
   * 'doc-shaped' = docs.google.com/{document|spreadsheets|presentation}/d/{id}
   *                (always Google-native; will skip)
   */
  resourceType: 'file' | 'folder' | 'open' | 'doc-shaped';
  id: string;
  resourceKey?: string;
};

/**
 * Parse a Drive/Docs URL into `{ resourceType, id, resourceKey? }`.
 * Returns null if the host or path shape is unrecognised.
 */
function parseGDriveUrl(url: string): ParsedTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.host.toLowerCase();
  if (!GDRIVE_HOSTS.has(host)) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  const resourceKey = parsed.searchParams.get('resourcekey') || undefined;

  // docs.google.com/{document|spreadsheets|presentation}/d/{id}
  if (host === 'docs.google.com' || host === 'www.docs.google.com') {
    const dIdx = parts.indexOf('d');
    if (dIdx > 0 && parts[dIdx + 1]) {
      const out: ParsedTarget = { resourceType: 'doc-shaped', id: parts[dIdx + 1]! };
      if (resourceKey) out.resourceKey = resourceKey;
      return out;
    }
    return null;
  }

  // drive.google.com URLs.
  // /open?id={id}
  if (parts[0] === 'open') {
    const id = parsed.searchParams.get('id');
    if (!id) return null;
    const out: ParsedTarget = { resourceType: 'open', id };
    if (resourceKey) out.resourceKey = resourceKey;
    return out;
  }

  // /file/d/{id}/... or /file/u/N/d/{id}/... (multi-account shape)
  if (parts.includes('file')) {
    const dIdx = parts.indexOf('d');
    if (dIdx > 0 && parts[dIdx + 1]) {
      const out: ParsedTarget = { resourceType: 'file', id: parts[dIdx + 1]! };
      if (resourceKey) out.resourceKey = resourceKey;
      return out;
    }
    return null;
  }

  // /drive/folders/{id} or /drive/u/N/folders/{id}
  const fIdx = parts.indexOf('folders');
  if (fIdx >= 0 && parts[fIdx + 1]) {
    const out: ParsedTarget = { resourceType: 'folder', id: parts[fIdx + 1]! };
    if (resourceKey) out.resourceKey = resourceKey;
    return out;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

type CredentialValidation =
  | { ok: true; creds: GDriveCredentials; caps: ResolvedCaps }
  | { ok: false; reason: string };

function isValidOAuthShape(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r['accessToken'] === 'string' &&
    !!r['accessToken'] &&
    typeof r['refreshToken'] === 'string' &&
    !!r['refreshToken'] &&
    typeof r['expiresAt'] === 'number' &&
    Number.isFinite(r['expiresAt']) &&
    typeof r['clientId'] === 'string' &&
    !!r['clientId'] &&
    typeof r['clientSecret'] === 'string' &&
    !!r['clientSecret']
  );
}

/**
 * Validate the raw credential record. Also extracts the optional caps sibling.
 * Caps are NOT credential-shape-specific — any kind may carry caps.
 */
function validateCredentials(
  raw: unknown,
  defaults: ResolvedCaps,
): CredentialValidation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'credentials missing or not an object' };
  }
  const c = raw as Record<string, unknown>;
  const kind = c['kind'];

  // Resolve caps (any kind may carry them as a sibling).
  const caps = resolveCaps(c['caps'], defaults);

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
    return { ok: true, creds: c as unknown as GDriveOAuthCredentials, caps };
  }

  if (kind === 'api-key') {
    if (typeof c['apiKey'] !== 'string' || !c['apiKey']) {
      return { ok: false, reason: 'api-key credentials missing apiKey' };
    }
    return { ok: true, creds: c as unknown as GDriveApiKeyCredentials, caps };
  }

  if (kind === 'oauth+api-key') {
    if (typeof c['apiKey'] !== 'string' || !c['apiKey']) {
      return {
        ok: false,
        reason: 'oauth+api-key credentials missing apiKey',
      };
    }
    if (!isValidOAuthShape(c['oauth'])) {
      return {
        ok: false,
        reason: 'oauth+api-key credentials missing or invalid nested oauth shape',
      };
    }
    return { ok: true, creds: c as unknown as GDriveDualCredentials, caps };
  }

  return {
    ok: false,
    reason: `credentials missing or invalid kind discriminator (got ${JSON.stringify(kind)})`,
  };
}

/**
 * Resolve per-credential caps, falling back to `defaults` for any field that
 * is missing, non-finite, or NOT strictly positive.
 *
 * Zero / negative values are intentionally REJECTED (treated as "use default")
 * because silently producing empty enumerations is more surprising than
 * ignoring an obviously-broken override. Callers who want to disable a cap
 * should use `Number.MAX_SAFE_INTEGER`, not 0.
 */
function resolveCaps(raw: unknown, defaults: ResolvedCaps): ResolvedCaps {
  if (!raw || typeof raw !== 'object') return defaults;
  const r = raw as Record<string, unknown>;
  const out: ResolvedCaps = { ...defaults };
  if (typeof r['maxFiles'] === 'number' && Number.isFinite(r['maxFiles']) && r['maxFiles'] > 0) {
    out.maxFiles = r['maxFiles'];
  }
  if (typeof r['maxBytes'] === 'number' && Number.isFinite(r['maxBytes']) && r['maxBytes'] > 0) {
    out.maxBytes = r['maxBytes'];
  }
  if (typeof r['maxDepth'] === 'number' && Number.isFinite(r['maxDepth']) && r['maxDepth'] > 0) {
    out.maxDepth = r['maxDepth'];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auth header / query param selection
// ---------------------------------------------------------------------------

type AuthMode = 'api-key-first' | 'oauth-only' | 'api-key-only';

type RequestAuth = {
  /** Headers to attach (Authorization, X-Goog-Drive-Resource-Keys, etc.). */
  headers: Record<string, string>;
  /** Query params to merge onto the URL (e.g. `key=<apiKey>`). */
  query: Record<string, string>;
  /**
   * True when this attempt used the OAuth bearer (so a 401/403 is a real
   * OAuth failure rather than "API key didn't help, try OAuth").
   */
  usedOAuth: boolean;
  /** True when this attempt used an API key (vs anonymous). */
  usedApiKey: boolean;
};

function selectAuth(
  creds: GDriveCredentials,
  mode: AuthMode,
  resourceKeyHeader: string | undefined,
): RequestAuth {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const query: Record<string, string> = {};
  let usedOAuth = false;
  let usedApiKey = false;

  if (creds.kind === 'oauth') {
    headers['Authorization'] = `Bearer ${creds.accessToken}`;
    usedOAuth = true;
  } else if (creds.kind === 'api-key') {
    query['key'] = creds.apiKey;
    usedApiKey = true;
  } else {
    // 'oauth+api-key'
    if (mode === 'oauth-only') {
      headers['Authorization'] = `Bearer ${creds.oauth.accessToken}`;
      usedOAuth = true;
    } else if (mode === 'api-key-only') {
      query['key'] = creds.apiKey;
      usedApiKey = true;
    } else {
      // api-key-first — try anonymous-style API-key, OAuth bearer NOT sent.
      // This mirrors Google's recommendation: API key alone for public files
      // avoids consuming OAuth quota.
      query['key'] = creds.apiKey;
      usedApiKey = true;
    }
  }

  if (resourceKeyHeader) {
    headers['X-Goog-Drive-Resource-Keys'] = resourceKeyHeader;
  }

  return { headers, query, usedOAuth, usedApiKey };
}

/** Append/overwrite query params on a URL, preserving existing ones. */
function withQuery(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

function parseRetryAfter(header: string): number | undefined {
  if (!header.trim()) return undefined;
  const asNumber = Number(header);
  if (!isNaN(asNumber)) return asNumber * 1000;
  const asDate = new Date(header).getTime();
  if (!isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename\s*=\s*("([^"]+)"|([^;]+))/i.exec(header);
  if (!m) return null;
  const raw = (m[2] ?? m[3] ?? '').trim();
  return raw || null;
}

// ---------------------------------------------------------------------------
// GDrive file shape
// ---------------------------------------------------------------------------

type GDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string; // Google returns size as a string of digits
  parents?: string[];
  md5Checksum?: string;
  modifiedTime?: string;
  description?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
};

type SkipRecord = { name: string; mimeType: string };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGdriveAdapter(
  options?: GDriveAdapterOptions,
): ScavengerAdapter & SubscribableAdapter {
  const apiBase = (options?.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const tokenEndpoint = options?.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
  const httpFetch = options?.httpFetch ?? globalThis.fetch;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = options?.retryBaseMs;
  const defaultCaps = options?.defaultCaps ?? DEFAULT_CAPS;

  return {
    id: 'google-drive' as const,

    metadata: {
      displayName: 'Google Drive',
      authMethods: ['oauth', 'api-key'],
      supports: { url: true, sourceItemId: true, raw: false },
    },

    // V2-004 T7 — SubscribableAdapter capabilities.
    // GDrive uniquely supports folder + URL polling. No creator/tag/search.
    capabilities: new Set<WatchlistSubscriptionKind>(['folder_watch', 'url_watch']),

    enumerateFolder(context: DiscoveryContext, folderId: string): AsyncIterable<DiscoveryEvent> {
      return runGdriveEnumerateFolder({
        context,
        folderId,
        apiBase,
        tokenEndpoint,
        httpFetch,
        maxRetries,
        retryBaseMs,
        defaultCaps,
      });
    },

    pollUrl(context: DiscoveryContext, url: string): AsyncIterable<DiscoveryEvent> {
      return runGdrivePollUrl({
        context,
        url,
        apiBase,
        tokenEndpoint,
        httpFetch,
        maxRetries,
        retryBaseMs,
        defaultCaps,
      });
    },

    /**
     * Returns true when host is in `GDRIVE_HOSTS` and a recognisable
     * file/folder/doc id can be extracted. Doc-shaped URLs return true even
     * though they will subsequently skip — we want to claim them so the
     * registry doesn't fall through to a wrong adapter.
     */
    supports(url: string): boolean {
      try {
        const parsed = parseGDriveUrl(url);
        return parsed !== null;
      } catch {
        return false;
      }
    },

    fetch(context: FetchContext, target: FetchTarget): AsyncIterable<ScavengerEvent> {
      return {
        [Symbol.asyncIterator]: async function* () {
          try {
            // ── 1. Resolve target ────────────────────────────────────────────

            let parsedTarget: ParsedTarget;

            if (target.kind === 'raw') {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details: 'google-drive adapter only accepts url or source-item-id targets',
              };
              return;
            }

            if (target.kind === 'source-item-id') {
              // Treat as a file or folder id; metadata fetch will disambiguate.
              parsedTarget = { resourceType: 'open', id: target.sourceItemId };
            } else {
              const parsed = parseGDriveUrl(target.url);
              if (!parsed) {
                yield {
                  kind: 'failed' as const,
                  reason: 'unknown' as const,
                  details: `google-drive adapter could not parse URL: ${target.url}`,
                };
                return;
              }
              parsedTarget = parsed;
            }

            // ── 2. Validate credentials (or signal "missing") ────────────────

            // Locked semantics for T7-CF-2:
            //   - `auth-required reason: 'missing'`  = no creds at all
            //   - `auth-required reason: 'revoked'`  = creds rejected by server
            // For url-target with truly absent creds we still terminate with
            // `failed reason: 'auth-revoked'` (the failure reason union is the
            // same for both — only the auth-required.reason differs).
            if (context.credentials === undefined || context.credentials === null) {
              if (target.kind === 'url') {
                yield {
                  kind: 'auth-required' as const,
                  reason: 'missing' as const,
                  surfaceToUser:
                    'Google Drive credentials not configured. Add an API key or connect a Google account in Settings > Sources.',
                };
              }
              yield {
                kind: 'failed' as const,
                reason: 'auth-revoked' as const,
                details: 'google-drive adapter: credentials missing or not an object',
              };
              return;
            }

            const credValidation = validateCredentials(context.credentials, defaultCaps);
            if (!credValidation.ok) {
              yield {
                kind: 'failed' as const,
                reason: 'auth-revoked' as const,
                details: `google-drive adapter: ${credValidation.reason}`,
              };
              return;
            }

            let creds: GDriveCredentials = credValidation.creds;
            const caps = credValidation.caps;

            // ── 3. Refresh OAuth token if near expiry ────────────────────────

            const refreshed = yield* maybeRefreshToken(
              creds,
              context,
              tokenEndpoint,
              httpFetch,
            );
            if (refreshed === 'failed') return;
            if (refreshed) creds = refreshed;

            // ── 4. Fetch metadata (disambiguates file vs folder) ─────────────

            const resourceKeyHeader = parsedTarget.resourceKey
              ? `${parsedTarget.id}/${parsedTarget.resourceKey}`
              : undefined;

            // Docs/Sheets/Slides/Forms URLs are guaranteed Google-native by
            // their URL shape — short-circuit without spending a metadata API
            // call. Saves an authoritative request per docs URL.
            if (parsedTarget.resourceType === 'doc-shaped') {
              yield {
                kind: 'failed' as const,
                reason: 'no-downloadable-formats' as const,
                details: `Google Drive URL ${target.kind === 'url' ? target.url : parsedTarget.id} is a Google-native document; export not supported`,
              };
              return;
            }

            const meta = yield* fetchMetadata(
              parsedTarget.id,
              creds,
              resourceKeyHeader,
              context.signal,
              { httpFetch, apiBase, maxRetries, retryBaseMs },
            );
            if (!meta) return;

            // Folder → recursive enumeration.
            if (meta.mimeType === FOLDER_MIME) {
              yield* handleFolder(meta, creds, resourceKeyHeader, caps, context, {
                httpFetch,
                apiBase,
                maxRetries,
                retryBaseMs,
              });
              return;
            }

            // Single Google-native file → skip with no-downloadable-formats.
            if (GOOGLE_NATIVE_MIMES.has(meta.mimeType)) {
              yield {
                kind: 'failed' as const,
                reason: 'no-downloadable-formats' as const,
                details: `Google Drive item ${meta.name} (${meta.mimeType}) is a Google-native format; export not supported`,
              };
              return;
            }

            // Single regular file.
            yield* handleSingleFile(meta, creds, resourceKeyHeader, context, {
              httpFetch,
              apiBase,
              maxRetries,
              retryBaseMs,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isAbort =
              (err instanceof Error && err.name === 'AbortError') ||
              context.signal?.aborted === true;
            if (isAbort) {
              logger.warn({ err }, 'gdrive: aborted');
              yield {
                kind: 'failed' as const,
                reason: 'network-error' as const,
                details: `google-drive aborted: ${msg}`,
                error: err,
              };
              return;
            }
            logger.warn({ err }, 'gdrive: unexpected error');
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
// Internal helpers (delegated generators)
// ---------------------------------------------------------------------------

type RequestEnv = {
  httpFetch: typeof fetch;
  apiBase: string;
  maxRetries: number;
  retryBaseMs: number | undefined;
};

/**
 * Refresh OAuth tokens when within TOKEN_REFRESH_LEAD_MS of expiry.
 *
 * Returns:
 *   - `false` (literal): no refresh was needed; keep existing creds.
 *   - new credential bag: refresh succeeded; use this for subsequent calls.
 *   - `'failed'` sentinel: a terminal failed/auth-required event was already
 *     yielded; caller should return.
 */
async function* maybeRefreshToken(
  creds: GDriveCredentials,
  context: FetchContext,
  tokenEndpoint: string,
  httpFetch: typeof fetch,
): AsyncGenerator<ScavengerEvent, GDriveCredentials | false | 'failed', void> {
  const oauthBag =
    creds.kind === 'oauth'
      ? creds
      : creds.kind === 'oauth+api-key'
      ? creds.oauth
      : null;
  if (!oauthBag) return false;

  const remaining = oauthBag.expiresAt - Date.now();
  if (remaining >= TOKEN_REFRESH_LEAD_MS) return false;

  yield {
    kind: 'progress' as const,
    message: 'Refreshing Google Drive OAuth token',
  };

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: oauthBag.refreshToken,
    client_id: oauthBag.clientId,
    client_secret: oauthBag.clientSecret,
  });

  let res: Response;
  try {
    res = await httpFetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: context.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: `google-drive token refresh fetch failed: ${msg}`,
      error: err,
    };
    return 'failed';
  }

  // Google returns 400 with `{ "error": "invalid_grant" }` when the refresh
  // token is permanently invalid. 401 is rare here but handled identically.
  if (res.status === 400 || res.status === 401) {
    yield {
      kind: 'auth-required' as const,
      reason: 'revoked' as const,
      surfaceToUser:
        'Google Drive refresh token rejected. Reconnect Google in Settings > Sources.',
    };
    yield {
      kind: 'failed' as const,
      reason: 'auth-revoked' as const,
      details: `google-drive refresh token rejected (HTTP ${res.status})`,
    };
    return 'failed';
  }

  if (!res.ok) {
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: `google-drive token endpoint responded ${res.status}`,
    };
    return 'failed';
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: `google-drive token response parse failed: ${(err as Error).message}`,
      error: err,
    };
    return 'failed';
  }

  const tok = payload as {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
  };

  if (
    typeof tok.access_token !== 'string' ||
    !tok.access_token ||
    typeof tok.expires_in !== 'number'
  ) {
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: 'google-drive token response missing access_token or expires_in',
    };
    return 'failed';
  }

  // Google does NOT rotate refresh tokens unless they revoke. Preserve the
  // existing one when the response omits it (typical case).
  const newRefreshToken =
    typeof tok.refresh_token === 'string' && tok.refresh_token
      ? tok.refresh_token
      : oauthBag.refreshToken;

  const newExpiresAt = Date.now() + tok.expires_in * 1000;

  let newCreds: GDriveCredentials;
  if (creds.kind === 'oauth') {
    newCreds = {
      kind: 'oauth',
      accessToken: tok.access_token,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt,
      clientId: oauthBag.clientId,
      clientSecret: oauthBag.clientSecret,
    };
  } else {
    // 'oauth+api-key': preserve apiKey + clientId/secret, swap nested oauth.
    const dual = creds as GDriveDualCredentials;
    newCreds = {
      kind: 'oauth+api-key',
      apiKey: dual.apiKey,
      oauth: {
        accessToken: tok.access_token,
        refreshToken: newRefreshToken,
        expiresAt: newExpiresAt,
        clientId: oauthBag.clientId,
        clientSecret: oauthBag.clientSecret,
      },
    };
  }

  if (context.onTokenRefreshed) {
    try {
      await context.onTokenRefreshed(newCreds as unknown as Record<string, unknown>);
    } catch (cbErr) {
      logger.warn(
        { err: cbErr },
        'gdrive: onTokenRefreshed callback failed; continuing with new creds for this request',
      );
    }
  }

  return newCreds;
}

/**
 * Fetch metadata for a file or folder, with the dual-mode "API key first,
 * OAuth on 401/403" cascade for `oauth+api-key` credentials.
 */
async function* fetchMetadata(
  fileId: string,
  creds: GDriveCredentials,
  resourceKeyHeader: string | undefined,
  signal: AbortSignal | undefined,
  env: RequestEnv,
): AsyncGenerator<ScavengerEvent, GDriveFile | null, void> {
  const url = `${env.apiBase}/files/${encodeURIComponent(fileId)}`;
  const baseQuery = { fields: META_FIELDS };

  // For oauth+api-key, try API-key path first.
  if (creds.kind === 'oauth+api-key') {
    const apiKeyAttempt = yield* requestJsonWithRetries<GDriveFile>(
      env.httpFetch,
      withQuery(url, baseQuery),
      selectAuth(creds, 'api-key-only', resourceKeyHeader),
      signal,
      env.maxRetries,
      env.retryBaseMs,
      'metadata',
      true, // tolerateAuthFailure — caller will fall back to OAuth
    );
    if (apiKeyAttempt.outcome === 'value') {
      return apiKeyAttempt.value;
    }
    if (apiKeyAttempt.outcome === 'auth-rejected') {
      // Fall through to OAuth attempt.
    } else {
      // outcome 'terminal' — already yielded a failed event.
      return null;
    }
  }

  const auth = selectAuth(creds, 'oauth-only', resourceKeyHeader);
  const result = yield* requestJsonWithRetries<GDriveFile>(
    env.httpFetch,
    withQuery(url, baseQuery),
    auth,
    signal,
    env.maxRetries,
    env.retryBaseMs,
    'metadata',
    false,
  );
  if (result.outcome === 'value') return result.value;
  return null;
}

/**
 * Recursive folder listing with caps. Yields progress events for caps hits and
 * skipped Google-native files. Returns the enumerated files + skip records.
 */
async function* enumerateFolder(
  folderId: string,
  depth: number,
  caps: ResolvedCaps,
  state: { count: number; bytes: number; capHit: boolean },
  creds: GDriveCredentials,
  parentResourceKeyHeader: string | undefined,
  signal: AbortSignal | undefined,
  env: RequestEnv,
): AsyncGenerator<ScavengerEvent, { files: GDriveFile[]; skipped: SkipRecord[] }, void> {
  const files: GDriveFile[] = [];
  const skipped: SkipRecord[] = [];

  if (state.capHit) return { files, skipped };

  if (depth > caps.maxDepth) {
    yield {
      kind: 'progress' as const,
      message: 'Google Drive: stopped recursion: max-depth reached',
    };
    state.capHit = true;
    return { files, skipped };
  }

  let pageToken: string | undefined;
  do {
    const url = `${env.apiBase}/files`;
    const query: Record<string, string> = {
      q: `'${folderId}' in parents and trashed=false`,
      fields: LIST_FIELDS,
      pageSize: String(FILE_LIST_PAGE_SIZE),
    };
    if (pageToken) query['pageToken'] = pageToken;

    // List endpoint follows the same dual-mode cascade as metadata.
    const requestUrl = withQuery(url, query);

    let listing: { files?: GDriveFile[]; nextPageToken?: string } | null = null;

    if (creds.kind === 'oauth+api-key') {
      const attempt = yield* requestJsonWithRetries<{ files?: GDriveFile[]; nextPageToken?: string }>(
        env.httpFetch,
        requestUrl,
        selectAuth(creds, 'api-key-only', parentResourceKeyHeader),
        signal,
        env.maxRetries,
        env.retryBaseMs,
        'folder-list',
        true,
      );
      if (attempt.outcome === 'value') {
        listing = attempt.value;
      } else if (attempt.outcome === 'auth-rejected') {
        const fallback = yield* requestJsonWithRetries<{ files?: GDriveFile[]; nextPageToken?: string }>(
          env.httpFetch,
          requestUrl,
          selectAuth(creds, 'oauth-only', parentResourceKeyHeader),
          signal,
          env.maxRetries,
          env.retryBaseMs,
          'folder-list',
          false,
        );
        if (fallback.outcome === 'value') listing = fallback.value;
        else return { files, skipped };
      } else {
        return { files, skipped };
      }
    } else {
      const auth = selectAuth(
        creds,
        creds.kind === 'oauth' ? 'oauth-only' : 'api-key-only',
        parentResourceKeyHeader,
      );
      const attempt = yield* requestJsonWithRetries<{ files?: GDriveFile[]; nextPageToken?: string }>(
        env.httpFetch,
        requestUrl,
        auth,
        signal,
        env.maxRetries,
        env.retryBaseMs,
        'folder-list',
        false,
      );
      if (attempt.outcome === 'value') listing = attempt.value;
      else return { files, skipped };
    }

    if (!listing) return { files, skipped };

    const children = listing.files ?? [];
    for (const child of children) {
      if (state.capHit) return { files, skipped };

      if (child.mimeType === FOLDER_MIME) {
        const sub = yield* enumerateFolder(
          child.id,
          depth + 1,
          caps,
          state,
          creds,
          parentResourceKeyHeader, // resource keys propagate down for legacy shared folders
          signal,
          env,
        );
        files.push(...sub.files);
        skipped.push(...sub.skipped);
        continue;
      }

      if (GOOGLE_NATIVE_MIMES.has(child.mimeType)) {
        skipped.push({ name: child.name, mimeType: child.mimeType });
        yield {
          kind: 'progress' as const,
          message: `Google Drive: skipped Google-native: ${child.name} (${child.mimeType})`,
        };
        continue;
      }

      // Cap: file count.
      if (state.count >= caps.maxFiles) {
        yield {
          kind: 'progress' as const,
          message: 'Google Drive: stopped: file-count cap reached',
        };
        state.capHit = true;
        return { files, skipped };
      }

      // Cap: bytes (best-effort using metadata size; download streams cannot
      // know in advance so we refuse to start any file once the budget is gone).
      const childBytes = child.size ? Number(child.size) : 0;
      if (state.bytes + childBytes > caps.maxBytes) {
        yield {
          kind: 'progress' as const,
          message: 'Google Drive: stopped: byte cap reached',
        };
        state.capHit = true;
        return { files, skipped };
      }

      state.count += 1;
      state.bytes += childBytes;
      files.push(child);
    }

    pageToken = listing.nextPageToken;
  } while (pageToken);

  return { files, skipped };
}

/**
 * Handle a folder URL: enumerate, download all non-native children, build
 * a single NormalizedItem with all files in `files[]`.
 */
async function* handleFolder(
  meta: GDriveFile,
  creds: GDriveCredentials,
  resourceKeyHeader: string | undefined,
  caps: ResolvedCaps,
  context: FetchContext,
  env: RequestEnv,
): AsyncGenerator<ScavengerEvent, void, void> {
  const state = { count: 0, bytes: 0, capHit: false };

  yield {
    kind: 'progress' as const,
    message: `Google Drive: enumerating folder ${meta.name}`,
  };

  const enumeration = yield* enumerateFolder(
    meta.id,
    1,
    caps,
    state,
    creds,
    resourceKeyHeader,
    context.signal,
    env,
  );

  if (enumeration.files.length === 0) {
    yield {
      kind: 'failed' as const,
      reason: 'no-downloadable-formats' as const,
      details: `Google Drive folder ${meta.name} contained no downloadable files (skipped ${enumeration.skipped.length} Google-native item(s))`,
    };
    return;
  }

  // Track names for dedup-counter pattern (T6-L5).
  const usedNames = new Set<string>();
  const fileDescriptors: NormalizedItem['files'] = [];

  for (const child of enumeration.files) {
    yield {
      kind: 'progress' as const,
      message: `Google Drive: downloading ${child.name}`,
    };

    const childResourceKey = resourceKeyHeader; // share parent's resource key
    const result = yield* downloadFile(child, creds, childResourceKey, usedNames, context, env);
    if (result === null) return; // terminal failure already yielded
    fileDescriptors.push(result);
  }

  const creator =
    meta.owners?.[0]?.displayName?.trim() || meta.owners?.[0]?.emailAddress?.trim() || undefined;

  const item: NormalizedItem = {
    sourceId: 'google-drive' as const,
    sourceItemId: meta.id,
    sourceUrl: `https://drive.google.com/drive/folders/${meta.id}`,
    title: meta.name,
    description: meta.description,
    creator,
    files: fileDescriptors,
    sourcePublishedAt: meta.modifiedTime ? new Date(meta.modifiedTime) : undefined,
  };

  yield { kind: 'completed' as const, item };
}

/**
 * Handle a single non-native file: download, build NormalizedItem.
 */
async function* handleSingleFile(
  meta: GDriveFile,
  creds: GDriveCredentials,
  resourceKeyHeader: string | undefined,
  context: FetchContext,
  env: RequestEnv,
): AsyncGenerator<ScavengerEvent, void, void> {
  const usedNames = new Set<string>();
  const result = yield* downloadFile(meta, creds, resourceKeyHeader, usedNames, context, env);
  if (result === null) return;

  const creator =
    meta.owners?.[0]?.displayName?.trim() || meta.owners?.[0]?.emailAddress?.trim() || undefined;

  const item: NormalizedItem = {
    sourceId: 'google-drive' as const,
    sourceItemId: meta.id,
    sourceUrl: `https://drive.google.com/file/d/${meta.id}/view`,
    title: meta.name,
    description: meta.description,
    creator,
    files: [result],
    sourcePublishedAt: meta.modifiedTime ? new Date(meta.modifiedTime) : undefined,
  };

  yield { kind: 'completed' as const, item };
}

/**
 * Download a single file's bytes to staging. Returns the file descriptor on
 * success, `null` if a terminal failed event was yielded.
 *
 * Naming strategy (T6-L5 dedup-counter):
 *   1. Sanitize `meta.name`. Fall back to `gdrive-<id>.bin` if empty.
 *   2. If a name collision exists, suffix `_2`, `_3`, … before the extension.
 */
async function* downloadFile(
  file: GDriveFile,
  creds: GDriveCredentials,
  resourceKeyHeader: string | undefined,
  usedNames: Set<string>,
  context: FetchContext,
  env: RequestEnv,
): AsyncGenerator<ScavengerEvent, NormalizedItem['files'][number] | null, void> {
  // Build download URL. For oauth+api-key, follow the same cascade.
  const baseDlUrl = `${env.apiBase}/files/${encodeURIComponent(file.id)}`;
  const dlQuery = { alt: 'media' };

  // Helper for one download attempt with given auth mode.
  async function attemptDownload(
    authMode: 'api-key-only' | 'oauth-only',
  ): Promise<{ outcome: 'value'; res: Response } | { outcome: 'auth-rejected' } | { outcome: 'terminal'; failedEvent: ScavengerEvent }> {
    const auth = selectAuth(creds, authMode, resourceKeyHeader);
    const url = withQuery(baseDlUrl, { ...dlQuery, ...auth.query });

    let res: Response;
    try {
      // `redirect: 'manual'` lets us strip the Authorization header before
      // following Google's signed CDN redirect (T7-L3 pattern).
      res = await env.httpFetch(url, {
        headers: auth.headers,
        signal: context.signal,
        redirect: 'manual',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        outcome: 'terminal',
        failedEvent: {
          kind: 'failed' as const,
          reason: 'network-error' as const,
          details: `Google Drive download fetch failed: ${msg}`,
          error: err,
        },
      };
    }

    // Manual redirect handling.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return {
          outcome: 'terminal',
          failedEvent: {
            kind: 'failed' as const,
            reason: 'network-error' as const,
            details: `Google Drive download responded ${res.status} with no Location header`,
          },
        };
      }
      // Refetch the redirect target WITHOUT Authorization (T7-L3).
      try {
        res = await env.httpFetch(location, { signal: context.signal });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          outcome: 'terminal',
          failedEvent: {
            kind: 'failed' as const,
            reason: 'network-error' as const,
            details: `Google Drive download redirect fetch failed: ${msg}`,
            error: err,
          },
        };
      }
    }

    if (res.status === 401 || res.status === 403) {
      if (creds.kind === 'oauth+api-key' && authMode === 'api-key-only') {
        // Signal cascade fallback to the caller.
        return { outcome: 'auth-rejected' };
      }
      return {
        outcome: 'terminal',
        failedEvent: {
          kind: 'failed' as const,
          reason: 'auth-revoked' as const,
          details: `Google Drive download responded ${res.status}`,
        },
      };
    }

    if (res.status === 404 || res.status === 410) {
      return {
        outcome: 'terminal',
        failedEvent: {
          kind: 'failed' as const,
          reason: 'content-removed' as const,
          details: `Google Drive download responded ${res.status}`,
        },
      };
    }

    if (!res.ok) {
      return {
        outcome: 'terminal',
        failedEvent: {
          kind: 'failed' as const,
          reason: 'network-error' as const,
          details: `Google Drive download responded ${res.status}`,
        },
      };
    }

    if (!res.body) {
      return {
        outcome: 'terminal',
        failedEvent: {
          kind: 'failed' as const,
          reason: 'network-error' as const,
          details: 'Google Drive download returned no body',
        },
      };
    }

    return { outcome: 'value', res };
  }

  // First attempt: chosen by credential kind.
  let attempt: Awaited<ReturnType<typeof attemptDownload>>;
  if (creds.kind === 'oauth+api-key') {
    attempt = await attemptDownload('api-key-only');
    if (attempt.outcome === 'auth-rejected') {
      attempt = await attemptDownload('oauth-only');
    }
  } else if (creds.kind === 'oauth') {
    attempt = await attemptDownload('oauth-only');
  } else {
    attempt = await attemptDownload('api-key-only');
  }

  if (attempt.outcome === 'auth-rejected') {
    // Should be unreachable for non-dual creds; safety belt.
    yield {
      kind: 'failed' as const,
      reason: 'auth-revoked' as const,
      details: 'Google Drive: API key rejected and no OAuth fallback available',
    };
    return null;
  }

  if (attempt.outcome === 'terminal') {
    yield attempt.failedEvent;
    return null;
  }

  const dlRes = attempt.res;

  // ── Choose final filename AFTER seeing Content-Disposition ───────────────
  //
  // Order of preference:
  //   1. Content-Disposition's filename (sanitized) — server-authoritative.
  //   2. metadata.name (sanitized) — fallback when no CD header.
  //   3. `gdrive-<id>.bin` — last-resort safe default.
  //
  // Crucially we do NOT reserve a metadata-derived name in `usedNames` before
  // this decision. Doing so caused a bug where a CD header echoing the same
  // name as metadata would be treated as a sibling collision and suffixed
  // `_2`. The reservation happens once at the bottom, against the chosen
  // name only. Cross-file dedup (sibling-folder name clashes) still goes
  // through `nextUniqueName`.
  const cdRaw = filenameFromContentDisposition(dlRes.headers.get('content-disposition'));
  const cdSanitized = cdRaw ? sanitizeFilename(cdRaw) : null;
  const metaSanitized = sanitizeFilename(file.name);
  const baseName = cdSanitized ?? metaSanitized ?? `gdrive-${file.id}.bin`;
  const finalName = nextUniqueName(baseName, usedNames);
  usedNames.add(finalName);

  const destPath = path.join(context.stagingDir, finalName);

  try {
    const nodeReadable = Readable.fromWeb(
      dlRes.body as unknown as import('stream/web').ReadableStream<Uint8Array>,
    );
    await streamPipeline(nodeReadable, createWriteStream(destPath));
  } catch (streamErr) {
    await fsp.unlink(destPath).catch(() => {});
    const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: `Google Drive download stream error: ${msg}`,
      error: streamErr,
    };
    return null;
  }

  let size: number | undefined;
  try {
    const stat = await fsp.stat(destPath);
    size = stat.size;
  } catch {
    /* ignore */
  }
  const out: NormalizedItem['files'][number] = {
    stagedPath: destPath,
    suggestedName: finalName,
  };
  if (size !== undefined) out.size = size;
  return out;
}

/**
 * Generate a non-colliding name. If `base` is already used, suffix `_2`,
 * `_3`, … before the extension (or at the end if no extension).
 */
function nextUniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';

  let n = 2;
  let candidate = `${stem}_${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${stem}_${n}${ext}`;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Internal: rate-limit-aware JSON GET helper
//
// Like Sketchfab's helper but the auth carrier (header vs query param) is
// driven by the `RequestAuth` argument, and the helper signals 401/403 in
// two distinct ways depending on `tolerateAuthFailure`:
//   - false → yield terminal failed event, outcome 'terminal'
//   - true  → return outcome 'auth-rejected' WITHOUT yielding (caller cascades)
// ---------------------------------------------------------------------------

type RequestOutcome<T> =
  | { outcome: 'value'; value: T }
  | { outcome: 'auth-rejected' }
  | { outcome: 'terminal' };

async function* requestJsonWithRetries<T>(
  httpFetch: typeof fetch,
  url: string,
  auth: RequestAuth,
  signal: AbortSignal | undefined,
  maxRetries: number,
  retryBaseMs: number | undefined,
  label: string,
  tolerateAuthFailure: boolean,
): AsyncGenerator<ScavengerEvent, RequestOutcome<T>, void> {
  // Merge auth.query into the URL once.
  const finalUrl = withQuery(url, auth.query);

  let attempt = 1;
  while (true) {
    yield {
      kind: 'progress' as const,
      message: `Google Drive ${label} request (attempt ${attempt})`,
    };

    let res: Response;
    try {
      res = await httpFetch(finalUrl, {
        headers: auth.headers,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Google Drive ${label} fetch failed: ${msg}`,
        error: err,
      };
      return { outcome: 'terminal' };
    }

    // Retryable: 429 + any 5xx.
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const ra = res.status === 429 ? res.headers.get('retry-after') : null;
      const retryAfterMs = ra ? parseRetryAfter(ra) : undefined;
      const decision = nextRetry(
        attempt,
        { maxAttempts: maxRetries, baseMs: retryBaseMs },
        retryAfterMs,
      );
      if (!decision.retry) {
        yield {
          kind: 'failed' as const,
          reason: 'rate-limit-exhausted' as const,
          details: `Google Drive ${label} retries exhausted after ${attempt} attempts (last status ${res.status})`,
        };
        return { outcome: 'terminal' };
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
      if (tolerateAuthFailure) {
        return { outcome: 'auth-rejected' };
      }
      yield {
        kind: 'auth-required' as const,
        reason: 'revoked' as const,
        surfaceToUser: `Google Drive rejected credentials (${res.status})`,
      };
      yield {
        kind: 'failed' as const,
        reason: 'auth-revoked' as const,
        details: `Google Drive ${label} responded ${res.status}`,
      };
      return { outcome: 'terminal' };
    }

    if (res.status === 404 || res.status === 410) {
      yield {
        kind: 'failed' as const,
        reason: 'content-removed' as const,
        details: `Google Drive ${label} responded ${res.status}`,
      };
      return { outcome: 'terminal' };
    }

    if (!res.ok) {
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Google Drive ${label} responded ${res.status}`,
      };
      return { outcome: 'terminal' };
    }

    try {
      const value = (await res.json()) as T;
      return { outcome: 'value', value };
    } catch (parseErr) {
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Google Drive ${label} JSON parse failed: ${(parseErr as Error).message}`,
        error: parseErr,
      };
      return { outcome: 'terminal' };
    }
  }
}

// ---------------------------------------------------------------------------
// V2-004 T7 — SubscribableAdapter discovery support
// ---------------------------------------------------------------------------

/**
 * Folder-watch cursor: a snapshot of `{fileId: modifiedTime}` from the prior
 * firing. Each subsequent firing enumerates the folder fresh and emits items
 * whose id is NOT in the snapshot OR whose modifiedTime is newer.
 *
 * V2.0 simplification (per task spec): we re-enumerate every firing rather
 * than using Google's changes API. This is simpler and the watchlist
 * scheduler bounds firing frequency. Change-feed migration is V2-004b.
 *
 * On first fire (no cursor), we emit ALL non-folder, non-Google-native files
 * present in the folder — folder-watch UX expects "subscribe and grab
 * everything that's there". The first-fire backfill cap does NOT apply to
 * folder enumeration; the existing GDriveCaps (maxFiles/maxBytes/maxDepth)
 * are honored instead.
 */
type GdriveFolderCursor = {
  /** Map of fileId → modifiedTime ISO string from the prior firing. */
  lastSeen: Record<string, string>;
};

/**
 * URL-poll cursor: the etag and modifiedTime from the most recent
 * successful 200 response. The next firing sends `If-None-Match: <etag>` and
 * exits early on 304.
 */
type GdriveUrlPollCursor = {
  etag: string;
  modifiedTime?: string;
};

type GdriveDiscoveryEnv = {
  context: DiscoveryContext;
  apiBase: string;
  tokenEndpoint: string;
  httpFetch: typeof fetch;
  maxRetries: number;
  retryBaseMs: number | undefined;
  defaultCaps: ResolvedCaps;
};

function parseFolderCursor(raw: string | undefined): GdriveFolderCursor | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      obj &&
      typeof obj === 'object' &&
      typeof (obj as Record<string, unknown>)['lastSeen'] === 'object' &&
      (obj as Record<string, unknown>)['lastSeen'] !== null
    ) {
      const ls = (obj as Record<string, Record<string, unknown>>)['lastSeen']!;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(ls)) {
        if (typeof v === 'string') out[k] = v;
      }
      return { lastSeen: out };
    }
  } catch {
    // Malformed cursor — first-fire.
  }
  return undefined;
}

function parseUrlPollCursor(raw: string | undefined): GdriveUrlPollCursor | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      obj &&
      typeof obj === 'object' &&
      typeof (obj as Record<string, unknown>)['etag'] === 'string'
    ) {
      const r = obj as Record<string, unknown>;
      const out: GdriveUrlPollCursor = { etag: r['etag'] as string };
      if (typeof r['modifiedTime'] === 'string') out.modifiedTime = r['modifiedTime'] as string;
      return out;
    }
  } catch {
    // Malformed cursor — first-fire.
  }
  return undefined;
}

/**
 * Discovery-side OAuth refresh that yields DiscoveryEvent. Mirrors
 * `maybeRefreshToken` (fetch-side) logic.
 */
async function* maybeRefreshGdriveTokenForDiscovery(
  creds: GDriveCredentials,
  context: DiscoveryContext,
  tokenEndpoint: string,
  httpFetch: typeof fetch,
): AsyncGenerator<DiscoveryEvent, GDriveCredentials | 'failed', void> {
  const oauthBag =
    creds.kind === 'oauth'
      ? creds
      : creds.kind === 'oauth+api-key'
      ? creds.oauth
      : null;
  if (!oauthBag) return creds;

  const remaining = oauthBag.expiresAt - Date.now();
  if (remaining >= TOKEN_REFRESH_LEAD_MS) return creds;

  yield {
    kind: 'progress' as const,
    message: 'Refreshing Google Drive OAuth token',
    itemsSeen: 0,
  };

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: oauthBag.refreshToken,
    client_id: oauthBag.clientId,
    client_secret: oauthBag.clientSecret,
  });

  let res: Response;
  try {
    res = await httpFetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: context.signal,
    });
  } catch (err) {
    yield {
      kind: 'discovery-failed' as const,
      reason: 'network-error' as const,
      details: `google-drive token refresh fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
    };
    return 'failed';
  }

  if (res.status === 400 || res.status === 401) {
    yield {
      kind: 'auth-required' as const,
      reason: 'revoked' as const,
      surfaceToUser:
        'Google Drive refresh token rejected. Reconnect Google in Settings > Sources.',
    };
    yield {
      kind: 'discovery-failed' as const,
      reason: 'auth-revoked' as const,
      details: `google-drive refresh token rejected (HTTP ${res.status})`,
    };
    return 'failed';
  }

  if (!res.ok) {
    yield {
      kind: 'discovery-failed' as const,
      reason: 'network-error' as const,
      details: `google-drive token endpoint responded ${res.status}`,
    };
    return 'failed';
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    yield {
      kind: 'discovery-failed' as const,
      reason: 'network-error' as const,
      details: `google-drive token response parse failed: ${(err as Error).message}`,
      error: err,
    };
    return 'failed';
  }

  const tok = payload as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
  if (typeof tok.access_token !== 'string' || !tok.access_token || typeof tok.expires_in !== 'number') {
    yield {
      kind: 'discovery-failed' as const,
      reason: 'network-error' as const,
      details: 'google-drive token response missing access_token or expires_in',
    };
    return 'failed';
  }
  const newRefreshToken =
    typeof tok.refresh_token === 'string' && tok.refresh_token
      ? tok.refresh_token
      : oauthBag.refreshToken;
  const newExpiresAt = Date.now() + tok.expires_in * 1000;

  let newCreds: GDriveCredentials;
  if (creds.kind === 'oauth') {
    newCreds = {
      kind: 'oauth',
      accessToken: tok.access_token,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt,
      clientId: oauthBag.clientId,
      clientSecret: oauthBag.clientSecret,
    };
  } else {
    const dual = creds as GDriveDualCredentials;
    newCreds = {
      kind: 'oauth+api-key',
      apiKey: dual.apiKey,
      oauth: {
        accessToken: tok.access_token,
        refreshToken: newRefreshToken,
        expiresAt: newExpiresAt,
        clientId: oauthBag.clientId,
        clientSecret: oauthBag.clientSecret,
      },
    };
  }
  if (context.onTokenRefreshed) {
    try {
      await context.onTokenRefreshed(newCreds as unknown as Record<string, unknown>);
    } catch (cbErr) {
      logger.warn(
        { err: cbErr },
        'gdrive: discovery onTokenRefreshed callback failed; continuing with new creds for this request',
      );
    }
  }
  return newCreds;
}

/**
 * Helper: perform a single GET against Google Drive with the standard 429/5xx
 * retry loop and dual-mode auth cascade. Returns the JSON body on 200, or null
 * if a terminal failed/auth event was already yielded.
 *
 * Discovery-side flavour — yields `DiscoveryEvent` (not `ScavengerEvent`).
 */
async function* gdriveDiscoveryGet<T>(
  url: string,
  creds: GDriveCredentials,
  context: DiscoveryContext,
  env: GdriveDiscoveryEnv,
  itemsSeen: number,
  label: string,
  extraHeaders?: Record<string, string>,
): AsyncGenerator<
  DiscoveryEvent,
  { outcome: 'value'; value: T; etag?: string } | { outcome: 'not-modified'; etag?: string } | { outcome: 'terminal' },
  void
> {
  const tryWithMode = async (
    mode: 'oauth-only' | 'api-key-only',
  ): Promise<{ kind: 'value'; value: T; etag?: string } | { kind: 'not-modified'; etag?: string } | { kind: 'auth-rejected' } | { kind: 'retry'; res: Response } | { kind: 'terminal'; event: DiscoveryEvent }> => {
    const auth = selectAuth(creds, mode, undefined);
    const finalUrl = withQuery(url, auth.query);
    const headers = { ...auth.headers, ...(extraHeaders ?? {}) };
    let res: Response;
    try {
      res = await env.httpFetch(finalUrl, { headers, signal: context.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: 'terminal',
        event: {
          kind: 'discovery-failed' as const,
          reason: 'network-error' as const,
          details: `Google Drive ${label} fetch failed: ${msg}`,
          error: err,
        },
      };
    }

    if (res.status === 304) {
      const etag = res.headers.get('etag') ?? undefined;
      const out: { kind: 'not-modified'; etag?: string } = { kind: 'not-modified' };
      if (etag !== undefined) out.etag = etag;
      return out;
    }

    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      return { kind: 'retry', res };
    }

    if (res.status === 401 || res.status === 403) {
      if (creds.kind === 'oauth+api-key' && mode === 'api-key-only') {
        return { kind: 'auth-rejected' };
      }
      return {
        kind: 'terminal',
        event: {
          kind: 'discovery-failed' as const,
          reason: 'auth-revoked' as const,
          details: `Google Drive ${label} responded ${res.status}`,
        },
      };
    }

    if (res.status === 404 || res.status === 410) {
      return {
        kind: 'terminal',
        event: {
          kind: 'discovery-failed' as const,
          reason: 'content-removed' as const,
          details: `Google Drive ${label} responded ${res.status}`,
        },
      };
    }

    if (!res.ok) {
      return {
        kind: 'terminal',
        event: {
          kind: 'discovery-failed' as const,
          reason: 'network-error' as const,
          details: `Google Drive ${label} responded ${res.status}`,
        },
      };
    }

    try {
      const value = (await res.json()) as T;
      const etag = res.headers.get('etag') ?? undefined;
      const out: { kind: 'value'; value: T; etag?: string } = { kind: 'value', value };
      if (etag !== undefined) out.etag = etag;
      return out;
    } catch (parseErr) {
      return {
        kind: 'terminal',
        event: {
          kind: 'discovery-failed' as const,
          reason: 'network-error' as const,
          details: `Google Drive ${label} JSON parse failed: ${(parseErr as Error).message}`,
          error: parseErr,
        },
      };
    }
  };

  // Pick initial mode.
  let mode: 'oauth-only' | 'api-key-only' =
    creds.kind === 'oauth' ? 'oauth-only' : creds.kind === 'api-key' ? 'api-key-only' : 'api-key-only';

  let attempt = 1;
  while (true) {
    yield {
      kind: 'progress' as const,
      message: `Google Drive ${label} request (attempt ${attempt})`,
      itemsSeen,
    };
    const result = await tryWithMode(mode);
    if (result.kind === 'value') {
      const out: { outcome: 'value'; value: T; etag?: string } = { outcome: 'value', value: result.value };
      if (result.etag !== undefined) out.etag = result.etag;
      return out;
    }
    if (result.kind === 'not-modified') {
      const out: { outcome: 'not-modified'; etag?: string } = { outcome: 'not-modified' };
      if (result.etag !== undefined) out.etag = result.etag;
      return out;
    }
    if (result.kind === 'auth-rejected') {
      // Cascade.
      mode = 'oauth-only';
      attempt = 1;
      continue;
    }
    if (result.kind === 'terminal') {
      yield result.event;
      return { outcome: 'terminal' };
    }
    // retry path
    const ra = result.res.status === 429 ? result.res.headers.get('retry-after') : null;
    const retryAfterMs = ra ? parseRetryAfter(ra) : undefined;
    const decision = nextRetry(
      attempt,
      { maxAttempts: env.maxRetries, baseMs: env.retryBaseMs },
      retryAfterMs,
    );
    if (!decision.retry) {
      yield {
        kind: 'discovery-failed' as const,
        reason: 'rate-limit-exhausted' as const,
        details: `Google Drive ${label} retries exhausted (last status ${result.res.status})`,
      };
      return { outcome: 'terminal' };
    }
    yield {
      kind: 'rate-limited' as const,
      retryAfterMs: decision.delayMs,
      attempt,
    };
    await sleep(decision.delayMs, context.signal);
    attempt += 1;
  }
}

type RunGdriveFolderArgs = Omit<GdriveDiscoveryEnv, 'context'> & {
  context: DiscoveryContext;
  folderId: string;
};

function runGdriveEnumerateFolder(args: RunGdriveFolderArgs): AsyncIterable<DiscoveryEvent> {
  const { context, folderId, apiBase, tokenEndpoint, httpFetch, maxRetries, retryBaseMs, defaultCaps } = args;
  const env: GdriveDiscoveryEnv = {
    context,
    apiBase,
    tokenEndpoint,
    httpFetch,
    maxRetries,
    retryBaseMs,
    defaultCaps,
  };

  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<DiscoveryEvent, void, void> {
      try {
        if (context.credentials === undefined || context.credentials === null) {
          yield {
            kind: 'auth-required' as const,
            reason: 'missing' as const,
            surfaceToUser:
              'Google Drive credentials not configured. Add an API key or connect a Google account in Settings > Sources.',
          };
          yield {
            kind: 'discovery-failed' as const,
            reason: 'auth-revoked' as const,
            details: 'google-drive discovery: credentials missing',
          };
          return;
        }

        const credValidation = validateCredentials(context.credentials, defaultCaps);
        if (!credValidation.ok) {
          yield {
            kind: 'discovery-failed' as const,
            reason: 'auth-revoked' as const,
            details: `google-drive discovery: ${credValidation.reason}`,
          };
          return;
        }
        const refreshed = yield* maybeRefreshGdriveTokenForDiscovery(
          credValidation.creds,
          context,
          tokenEndpoint,
          httpFetch,
        );
        if (refreshed === 'failed') return;
        const creds = refreshed;
        const caps = credValidation.caps;

        const priorCursor = parseFolderCursor(context.cursor);
        const lastSeen = priorCursor?.lastSeen ?? {};
        const newSnapshot: Record<string, string> = {};

        // Page through folder children.
        let pageToken: string | undefined;
        let itemsTotal = 0;

        do {
          if (context.signal?.aborted) {
            yield {
              kind: 'discovery-failed' as const,
              reason: 'unknown' as const,
              details: 'gdrive folder enumeration aborted by signal',
            };
            return;
          }
          const baseUrl = `${apiBase}/files`;
          const query: Record<string, string> = {
            q: `'${folderId}' in parents and trashed=false`,
            fields: LIST_FIELDS,
            pageSize: String(FILE_LIST_PAGE_SIZE),
          };
          if (pageToken) query['pageToken'] = pageToken;
          const url = withQuery(baseUrl, query);

          const result = yield* gdriveDiscoveryGet<{
            files?: GDriveFile[];
            nextPageToken?: string;
          }>(url, creds, context, env, itemsTotal, 'folder-list');
          if (result.outcome === 'terminal') return;
          if (result.outcome === 'not-modified') {
            // List endpoint won't 304 in practice; treat as empty-page.
            break;
          }
          const listing = result.value;

          const children = listing.files ?? [];
          for (const child of children) {
            // Skip subfolders (folder watch is shallow per v2.0; recursive
            // enumeration is handled by the ingest-side pipeline if needed).
            if (child.mimeType === FOLDER_MIME) continue;
            // Skip Google-native files — they have no downloadable bytes.
            if (GOOGLE_NATIVE_MIMES.has(child.mimeType)) continue;
            if (typeof child.id !== 'string' || !child.id) continue;

            const mt = typeof child.modifiedTime === 'string' ? child.modifiedTime : '';
            newSnapshot[child.id] = mt;

            const prior = lastSeen[child.id];
            // First-fire (no prior cursor) → emit ALL items.
            // Subsequent fires → emit only NEW items OR items with newer modifiedTime.
            const isNew = priorCursor === undefined ? true : prior === undefined;
            const isUpdated = !isNew && prior !== undefined && mt && mt > prior;
            if (!isNew && !isUpdated) continue;

            const ev: DiscoveryEvent = {
              kind: 'item-discovered' as const,
              sourceItemId: child.id,
            };
            const hint: { title?: string; publishedAt?: Date } = {};
            if (typeof child.name === 'string' && child.name) hint.title = child.name;
            if (mt) {
              const d = new Date(mt);
              if (!Number.isNaN(d.getTime())) hint.publishedAt = d;
            }
            if (hint.title || hint.publishedAt) ev.metadataHint = hint;
            yield ev;
            itemsTotal += 1;

            // Honor caps.maxFiles to bound first-fire emission.
            if (itemsTotal >= caps.maxFiles) {
              yield {
                kind: 'progress' as const,
                message: 'Google Drive: folder enumeration stopped: file-count cap reached',
                itemsSeen: itemsTotal,
              };
              break;
            }
          }

          if (itemsTotal >= caps.maxFiles) break;
          pageToken = listing.nextPageToken;
        } while (pageToken);

        const newCursor: GdriveFolderCursor = { lastSeen: newSnapshot };
        yield {
          kind: 'discovery-completed' as const,
          itemsTotal,
          cursor: JSON.stringify(newCursor),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort =
          (err instanceof Error && err.name === 'AbortError') ||
          context.signal?.aborted === true;
        logger.warn({ err }, 'gdrive: folder enumeration unexpected error');
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

type RunGdriveUrlPollArgs = Omit<GdriveDiscoveryEnv, 'context'> & {
  context: DiscoveryContext;
  url: string;
};

function runGdrivePollUrl(args: RunGdriveUrlPollArgs): AsyncIterable<DiscoveryEvent> {
  const { context, url, apiBase, tokenEndpoint, httpFetch, maxRetries, retryBaseMs, defaultCaps } = args;
  const env: GdriveDiscoveryEnv = {
    context,
    apiBase,
    tokenEndpoint,
    httpFetch,
    maxRetries,
    retryBaseMs,
    defaultCaps,
  };

  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<DiscoveryEvent, void, void> {
      try {
        // Parse the URL to get a fileId. Accept file or folder URL shapes; we
        // only emit url-watch events for `file` shapes — folder URLs should
        // use folder_watch instead.
        const parsed = parseGDriveUrl(url);
        if (!parsed) {
          yield {
            kind: 'discovery-failed' as const,
            reason: 'unknown' as const,
            details: `gdrive pollUrl: could not parse URL: ${url}`,
          };
          return;
        }
        if (parsed.resourceType === 'doc-shaped') {
          yield {
            kind: 'discovery-failed' as const,
            reason: 'no-results' as const,
            details: 'gdrive pollUrl: doc-shaped URLs are Google-native and not pollable',
          };
          return;
        }
        const fileId = parsed.id;

        if (context.credentials === undefined || context.credentials === null) {
          yield {
            kind: 'auth-required' as const,
            reason: 'missing' as const,
            surfaceToUser:
              'Google Drive credentials not configured. Add an API key or connect a Google account in Settings > Sources.',
          };
          yield {
            kind: 'discovery-failed' as const,
            reason: 'auth-revoked' as const,
            details: 'google-drive pollUrl: credentials missing',
          };
          return;
        }

        const credValidation = validateCredentials(context.credentials, defaultCaps);
        if (!credValidation.ok) {
          yield {
            kind: 'discovery-failed' as const,
            reason: 'auth-revoked' as const,
            details: `google-drive pollUrl: ${credValidation.reason}`,
          };
          return;
        }
        const refreshed = yield* maybeRefreshGdriveTokenForDiscovery(
          credValidation.creds,
          context,
          tokenEndpoint,
          httpFetch,
        );
        if (refreshed === 'failed') return;
        const creds = refreshed;

        const priorCursor = parseUrlPollCursor(context.cursor);

        const metaUrl = `${apiBase}/files/${encodeURIComponent(fileId)}`;
        const fullUrl = withQuery(metaUrl, { fields: META_FIELDS });

        const extraHeaders: Record<string, string> = {};
        if (priorCursor?.etag) {
          extraHeaders['If-None-Match'] = priorCursor.etag;
        }

        const result = yield* gdriveDiscoveryGet<GDriveFile>(
          fullUrl,
          creds,
          context,
          env,
          0,
          'pollUrl',
          extraHeaders,
        );
        if (result.outcome === 'terminal') return;

        if (result.outcome === 'not-modified') {
          // 304 Not Modified — preserve prior cursor, emit no item.
          const completed: DiscoveryEvent = {
            kind: 'discovery-completed' as const,
            itemsTotal: 0,
          };
          if (priorCursor) completed.cursor = JSON.stringify(priorCursor);
          yield completed;
          return;
        }

        const meta = result.value;
        const newCursor: GdriveUrlPollCursor = {
          etag: result.etag ?? '',
        };
        if (typeof meta.modifiedTime === 'string') {
          newCursor.modifiedTime = meta.modifiedTime;
        }

        // Determine whether anything changed:
        //   - no prior cursor → emit one item (first-fire).
        //   - prior modifiedTime exists and equals current → no change.
        //   - otherwise → emit one item.
        const changed =
          priorCursor === undefined ||
          priorCursor.modifiedTime === undefined ||
          newCursor.modifiedTime === undefined ||
          newCursor.modifiedTime !== priorCursor.modifiedTime;

        let itemsTotal = 0;
        if (changed) {
          const ev: DiscoveryEvent = {
            kind: 'item-discovered' as const,
            sourceItemId: fileId,
          };
          const hint: { title?: string; publishedAt?: Date } = {};
          if (typeof meta.name === 'string' && meta.name) hint.title = meta.name;
          if (typeof meta.modifiedTime === 'string') {
            const d = new Date(meta.modifiedTime);
            if (!Number.isNaN(d.getTime())) hint.publishedAt = d;
          }
          if (hint.title || hint.publishedAt) ev.metadataHint = hint;
          yield ev;
          itemsTotal += 1;
        }

        yield {
          kind: 'discovery-completed' as const,
          itemsTotal,
          cursor: JSON.stringify(newCursor),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort =
          (err instanceof Error && err.name === 'AbortError') ||
          context.signal?.aborted === true;
        logger.warn({ err }, 'gdrive: pollUrl unexpected error');
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
