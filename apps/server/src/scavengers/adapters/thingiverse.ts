/**
 * thingiverse.ts — Thingiverse ScavengerAdapter (V2-003b-T1)
 *
 * Inherits all OAuth-flow patterns established in T7 (Sketchfab) and T8
 * (Google Drive). Adds Thingiverse-specific:
 *
 *   - Three credential modes via discriminated `kind`:
 *       'api-token'         — legacy "App Token" sent as `Bearer <t>`
 *       'oauth'             — full OAuth 2.0 with refresh-token rotation
 *       'oauth+api-token'   — dual-mode; try API-token first (cheaper),
 *                             fall back to OAuth on 401/403.
 *   - Two-step file enumeration (`/things/:id` + `/things/:id/files`) with
 *     each File downloaded via its `download_url` (CDN redirect — strip
 *     `Authorization` per T7-L3).
 *   - Optional remix-detection round-trip (`/things/:id/ancestors`) when the
 *     metadata flags `is_derivative=true`. Surfaced as
 *     `NormalizedItem.relationships[]` placeholders; v2 does NOT persist these
 *     into `loot_relationships` (Watchlist pillar territory).
 *
 * Patterns shared with T7 + T8:
 *   - TOKEN_REFRESH_LEAD_MS = 60_000 silent refresh
 *   - `parseRetryAfter` whitespace guard (T7-I2 / T9-L7)
 *   - 429 ∪ 5xx unified retry via `nextRetry` + `sleep`
 *   - AbortError → 'network-error' (not 'unknown')
 *   - Discriminated `validateCredentials` return
 *   - Signed CDN URL fetched WITHOUT Authorization (T7-L3)
 *   - `defer-add-to-usedNames` filename pattern (T8-L7)
 *
 * Thingiverse OAuth refresh semantics: historically Thingiverse issues
 * long-lived `access_token` and may NOT include a `refresh_token` in the
 * refresh response. When omitted we preserve the existing one (T8-L5).
 *
 * @see https://www.thingiverse.com/developers
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

/** OAuth credential bag — Bearer-shaped tokens with refresh rotation. */
export type ThingiverseOAuthCredentials = {
  kind: 'oauth';
  accessToken: string;
  refreshToken: string;
  /** UTC ms-since-epoch. Refresh fires when within `TOKEN_REFRESH_LEAD_MS`. */
  expiresAt: number;
  clientId: string;
  clientSecret: string;
};

/** Static App Token — sent as `Authorization: Bearer <token>`. */
export type ThingiverseApiTokenCredentials = {
  kind: 'api-token';
  token: string;
};

/**
 * Dual-mode: try the static App Token first (cheap path), fall back to OAuth
 * on a 401 / 403 from any authenticated request. Mirrors T8's
 * `oauth+api-key` cascade except both modes carry a Bearer header — the
 * differentiation is purely "which token value we sent".
 */
export type ThingiverseDualCredentials = {
  kind: 'oauth+api-token';
  oauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    clientId: string;
    clientSecret: string;
  };
  token: string;
};

export type ThingiverseCredentials =
  | ThingiverseOAuthCredentials
  | ThingiverseApiTokenCredentials
  | ThingiverseDualCredentials;

/** Per-credential cap overrides. */
export type ThingiverseCaps = {
  maxFiles?: number;
  maxBytes?: number;
};

type ResolvedCaps = {
  maxFiles: number;
  maxBytes: number;
};

export type ThingiverseAdapterOptions = {
  /** Override the v1 API base. Default 'https://api.thingiverse.com'. */
  apiBase?: string;
  /** Override the OAuth token endpoint. */
  oauthTokenEndpoint?: string;
  /** Override fetch (test seam). Default globalThis.fetch. */
  httpFetch?: typeof fetch;
  /** Max retry attempts before giving up. Default 6. */
  maxRetries?: number;
  /** Override base backoff delay in ms. Set to 0 in tests. */
  retryBaseMs?: number;
  /** Default caps when credentials don't carry their own. */
  defaultCaps?: ResolvedCaps;
  /**
   * V2-004 T7 — first-fire bounded backfill cap (max 100). Default 20.
   * Honors `WATCHLIST_FIRST_FIRE_BACKFILL` env var.
   */
  firstFireBackfill?: number;
  /** Discovery list per-page count. Default 30. */
  discoveryPerPage?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE = 'https://api.thingiverse.com';
const DEFAULT_OAUTH_TOKEN_ENDPOINT =
  'https://www.thingiverse.com/login/oauth/access_token';
const DEFAULT_MAX_RETRIES = 6;

// V2-004 T7 — discovery defaults shared across capability methods.
const DEFAULT_FIRST_FIRE_BACKFILL = 20;
const FIRST_FIRE_BACKFILL_HARD_CAP = 100;
const DEFAULT_DISCOVERY_PER_PAGE = 30;

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

/** 1-minute safety margin: refresh OAuth tokens this far before expiry. */
const TOKEN_REFRESH_LEAD_MS = 60_000;

const DEFAULT_CAPS: ResolvedCaps = {
  maxFiles: 100,
  maxBytes: 5 * 1024 * 1024 * 1024, // 5 GiB
};

/** Exact-host allowlist (T3-L9). */
const THINGIVERSE_HOSTS = new Set([
  'thingiverse.com',
  'www.thingiverse.com',
]);

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

type ParsedTarget = {
  /** Numeric Thing id, e.g. '12345' from `/thing:12345`. */
  thingId: string;
};

/**
 * Parse a Thingiverse URL into `{ thingId }`. Returns null if the URL doesn't
 * point at a single Thing (collections, user profiles, search, etc).
 *
 * Supported shapes:
 *   - https://www.thingiverse.com/thing:NN
 *   - https://www.thingiverse.com/thing:NN/files
 *   - https://www.thingiverse.com/thing:NN/remixes
 *
 * Explicitly NOT supported (returns null — claimed by future adapters):
 *   - /<username>/collections/<id>      → V2-003c collections
 *   - /<username>                       → user profile
 *   - /search…                          → search
 */
function parseThingiverseUrl(url: string): ParsedTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!THINGIVERSE_HOSTS.has(parsed.host.toLowerCase())) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  // First segment must be `thing:<numericId>` — only single-Thing URLs are
  // owned by this adapter. Case-insensitive: copy-pasted URLs from email /
  // Discord embeds occasionally land as `THING:1234`. The URL parser does NOT
  // case-normalize the pathname, so we accept either casing here.
  const head = parts[0];
  if (!head) return null;
  const m = /^thing:(\d+)$/i.exec(head);
  if (!m || !m[1]) return null;

  // Optional trailing segment must be one of these (case-insensitive),
  // otherwise reject. `/files` and `/remixes` are part of the same Thing —
  // we always fetch the full file list from /things/:id/files regardless.
  if (parts.length > 1) {
    const tail = (parts[1] ?? '').toLowerCase();
    if (tail !== 'files' && tail !== 'remixes' && tail !== 'apps' && tail !== 'comments') {
      return null;
    }
  }

  return { thingId: m[1] };
}

// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

type CredentialValidation =
  | { ok: true; creds: ThingiverseCredentials; caps: ResolvedCaps }
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
  return out;
}

function validateCredentials(
  raw: unknown,
  defaults: ResolvedCaps,
): CredentialValidation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'credentials missing or not an object' };
  }
  const c = raw as Record<string, unknown>;
  const kind = c['kind'];

  // Caps live as a sibling — kind-agnostic.
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
    return { ok: true, creds: c as unknown as ThingiverseOAuthCredentials, caps };
  }

  if (kind === 'api-token') {
    if (typeof c['token'] !== 'string' || !c['token']) {
      return { ok: false, reason: 'api-token credentials missing token' };
    }
    return { ok: true, creds: c as unknown as ThingiverseApiTokenCredentials, caps };
  }

  if (kind === 'oauth+api-token') {
    if (typeof c['token'] !== 'string' || !c['token']) {
      return { ok: false, reason: 'oauth+api-token credentials missing token' };
    }
    if (!isValidOAuthShape(c['oauth'])) {
      return {
        ok: false,
        reason: 'oauth+api-token credentials missing or invalid nested oauth shape',
      };
    }
    return { ok: true, creds: c as unknown as ThingiverseDualCredentials, caps };
  }

  return {
    ok: false,
    reason: `credentials missing or invalid kind discriminator (got ${JSON.stringify(kind)})`,
  };
}

// ---------------------------------------------------------------------------
// Auth header selection
// ---------------------------------------------------------------------------

/**
 * Auth-cascade modes. Thingiverse, unlike GDrive, has no anonymous-+-key-as-
 * query mode: both api-token and oauth paths emit the same `Authorization:
 * Bearer <…>` header shape. The cascade for `oauth+api-token` credentials is
 * therefore strictly binary — try `'api-token-only'` first, fall back to
 * `'oauth-only'` on 401/403. There is no "first" hint distinct from "only".
 */
type AuthMode = 'api-token-only' | 'oauth-only';

type RequestAuth = {
  headers: Record<string, string>;
  /**
   * True when this attempt used the OAuth bearer (so a 401/403 is a real
   * OAuth failure, not "API token didn't help, try OAuth").
   */
  usedOAuth: boolean;
  usedApiToken: boolean;
};

function selectAuth(creds: ThingiverseCredentials, mode: AuthMode): RequestAuth {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (creds.kind === 'oauth') {
    headers['Authorization'] = `Bearer ${creds.accessToken}`;
    return { headers, usedOAuth: true, usedApiToken: false };
  }

  if (creds.kind === 'api-token') {
    headers['Authorization'] = `Bearer ${creds.token}`;
    return { headers, usedOAuth: false, usedApiToken: true };
  }

  // 'oauth+api-token' — strict binary cascade driven by `mode`.
  if (mode === 'oauth-only') {
    headers['Authorization'] = `Bearer ${creds.oauth.accessToken}`;
    return { headers, usedOAuth: true, usedApiToken: false };
  }
  headers['Authorization'] = `Bearer ${creds.token}`;
  return { headers, usedOAuth: false, usedApiToken: true };
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

/**
 * Generate a non-colliding name. If `base` is already used, suffix `-1`,
 * `-2`, … before the extension (or at the end if no extension).
 *
 * Uses `-N` (not `_N`) to match the "README.txt + README-1.txt" pattern
 * referenced in the plan; gdrive uses `_N` — both are valid styles, the
 * choice is per-adapter.
 */
function nextUniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';

  let n = 1;
  let candidate = `${stem}-${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Thingiverse API shapes
// ---------------------------------------------------------------------------

type ThingMetadata = {
  id?: number;
  name?: string;
  description?: string;
  license?: string;
  is_derivative?: boolean;
  public_url?: string;
  added?: string;
  creator?: { name?: string; first_name?: string; last_name?: string; thingiverse_username?: string };
  tags?: Array<{ name?: string } | string>;
};

type ThingFile = {
  id?: number;
  name?: string;
  size?: number;
  download_url?: string;
};

type ThingAncestor = {
  id?: number;
  name?: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createThingiverseAdapter(
  options?: ThingiverseAdapterOptions,
): ScavengerAdapter & SubscribableAdapter {
  const apiBase = (options?.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const oauthTokenEndpoint = options?.oauthTokenEndpoint ?? DEFAULT_OAUTH_TOKEN_ENDPOINT;
  const httpFetch = options?.httpFetch ?? globalThis.fetch;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = options?.retryBaseMs;
  const defaultCaps = options?.defaultCaps ?? DEFAULT_CAPS;
  const firstFireBackfill = resolveFirstFireBackfill(options?.firstFireBackfill);
  const discoveryPerPage = options?.discoveryPerPage ?? DEFAULT_DISCOVERY_PER_PAGE;

  return {
    id: 'thingiverse' as const,

    metadata: {
      displayName: 'Thingiverse',
      authMethods: ['oauth', 'api-key'],
      supports: { url: true, sourceItemId: true, raw: false },
      rateLimitPolicy: { baseMs: 1000, maxMs: 60_000, maxRetries: DEFAULT_MAX_RETRIES },
    },

    // V2-004 T7 — SubscribableAdapter capabilities.
    capabilities: new Set<WatchlistSubscriptionKind>(['creator', 'tag', 'saved_search']),

    listCreator(context: DiscoveryContext, creatorId: string): AsyncIterable<DiscoveryEvent> {
      return runThingiverseDiscovery({
        context,
        mode: { kind: 'creator', username: creatorId },
        apiBase,
        oauthTokenEndpoint,
        httpFetch,
        maxRetries,
        retryBaseMs,
        firstFireBackfill,
        perPage: discoveryPerPage,
        defaultCaps,
      });
    },

    searchByTag(context: DiscoveryContext, tag: string): AsyncIterable<DiscoveryEvent> {
      return runThingiverseDiscovery({
        context,
        mode: { kind: 'tag', tag },
        apiBase,
        oauthTokenEndpoint,
        httpFetch,
        maxRetries,
        retryBaseMs,
        firstFireBackfill,
        perPage: discoveryPerPage,
        defaultCaps,
      });
    },

    search(context: DiscoveryContext, query: string): AsyncIterable<DiscoveryEvent> {
      return runThingiverseDiscovery({
        context,
        mode: { kind: 'search', query },
        apiBase,
        oauthTokenEndpoint,
        httpFetch,
        maxRetries,
        retryBaseMs,
        firstFireBackfill,
        perPage: discoveryPerPage,
        defaultCaps,
      });
    },

    /**
     * Returns true for `thingiverse.com` and `www.thingiverse.com` URLs whose
     * path matches a single-Thing shape. Collections, user profiles, search
     * pages explicitly return false (T3-L9 + T8-L8 URL-shape pre-checks).
     */
    supports(url: string): boolean {
      try {
        const parsed = new URL(url);
        if (!THINGIVERSE_HOSTS.has(parsed.host.toLowerCase())) return false;
        return parseThingiverseUrl(url) !== null;
      } catch {
        return false;
      }
    },

    fetch(context: FetchContext, target: FetchTarget): AsyncIterable<ScavengerEvent> {
      return {
        [Symbol.asyncIterator]: async function* () {
          try {
            // ── 1. Resolve thingId from target ───────────────────────────────

            let thingId: string;

            if (target.kind === 'raw') {
              yield {
                kind: 'failed' as const,
                reason: 'unknown' as const,
                details:
                  'thingiverse adapter only accepts url or source-item-id targets',
              };
              return;
            }

            if (target.kind === 'source-item-id') {
              thingId = target.sourceItemId;
            } else {
              const parsed = parseThingiverseUrl(target.url);
              if (!parsed) {
                yield {
                  kind: 'failed' as const,
                  reason: 'unknown' as const,
                  details: `thingiverse adapter could not parse URL: ${target.url}`,
                };
                return;
              }
              thingId = parsed.thingId;
            }

            // ── 2. Validate credentials ──────────────────────────────────────

            const credValidation = validateCredentials(context.credentials, defaultCaps);
            if (!credValidation.ok) {
              yield {
                kind: 'failed' as const,
                reason: 'auth-revoked' as const,
                details: `thingiverse adapter: ${credValidation.reason}`,
              };
              return;
            }

            let creds: ThingiverseCredentials = credValidation.creds;
            const caps = credValidation.caps;

            // ── 3. Refresh OAuth token if near expiry ────────────────────────

            const refreshed = yield* maybeRefreshToken(
              creds,
              context,
              oauthTokenEndpoint,
              httpFetch,
            );
            if (refreshed === 'failed') return;
            if (refreshed) creds = refreshed;

            // ── 4. Fetch metadata (with dual-mode cascade) ───────────────────

            const env: RequestEnv = {
              httpFetch,
              apiBase,
              maxRetries,
              retryBaseMs,
            };

            const metaResult = yield* fetchThingMetadata(
              thingId,
              creds,
              context.signal,
              env,
            );
            if (!metaResult) return;
            const metadata = metaResult;

            // ── 5. Fetch file list ───────────────────────────────────────────

            const filesResult = yield* fetchThingFiles(
              thingId,
              creds,
              context.signal,
              env,
            );
            if (!filesResult) return;

            const validFiles = filesResult.filter(
              (f): f is ThingFile & { download_url: string } =>
                typeof f.download_url === 'string' && f.download_url.length > 0,
            );

            if (validFiles.length === 0) {
              yield {
                kind: 'failed' as const,
                reason: 'no-downloadable-formats' as const,
                details: `Thingiverse thing ${thingId} has no downloadable files`,
              };
              return;
            }

            // ── 6. Stream files to staging (cap-respecting) ──────────────────

            const usedNames = new Set<string>();
            const fileDescriptors: NormalizedItem['files'] = [];
            let totalBytes = 0;
            let capHit = false;

            for (const file of validFiles) {
              if (capHit) break;

              if (fileDescriptors.length >= caps.maxFiles) {
                yield {
                  kind: 'progress' as const,
                  message: 'Thingiverse: stopped: file-count cap reached',
                };
                capHit = true;
                break;
              }

              const childBytes = typeof file.size === 'number' ? file.size : 0;
              if (totalBytes + childBytes > caps.maxBytes) {
                yield {
                  kind: 'progress' as const,
                  message: 'Thingiverse: stopped: byte cap reached',
                };
                capHit = true;
                break;
              }

              yield {
                kind: 'progress' as const,
                message: `Thingiverse: downloading ${file.name ?? file.id ?? 'file'}`,
              };

              const result = yield* downloadFile(
                file as ThingFile & { download_url: string },
                thingId,
                usedNames,
                creds,
                context,
                env,
              );
              if (result === null) return; // terminal failure already yielded

              fileDescriptors.push(result);
              totalBytes += result.size ?? childBytes;
            }

            if (fileDescriptors.length === 0) {
              // Reachable when the very first file's `size` already exceeds
              // `maxBytes` — the byte-cap guard fires before any download
              // attempt and we exit the loop with zero descriptors. We treat
              // that as no-downloadable-formats so the user gets a coherent
              // error rather than a silently-empty Loot row.
              yield {
                kind: 'failed' as const,
                reason: 'no-downloadable-formats' as const,
                details: `Thingiverse thing ${thingId} produced no downloadable files (caps too small for first file)`,
              };
              return;
            }

            // ── 7. Optional: fetch ancestors for remix metadata ──────────────
            //
            // Files are already staged at this point. Ancestor metadata is a
            // best-effort enrichment surfaced as `NormalizedItem.relationships`
            // — v2 stores it data-only (Watchlist V2-004 territory). A failed
            // /ancestors lookup MUST NOT abort the ingest. We pass
            // `tolerateTerminalFailure=true` through the cascade so
            // 404/auth/rate-limit failures return null instead of yielding a
            // `failed` event, and we log a `progress` event noting the drop.

            let relationships: NormalizedItem['relationships'] | undefined;
            if (metadata.is_derivative === true) {
              const ancestors = yield* fetchAncestors(
                thingId,
                creds,
                context.signal,
                env,
              );
              if (ancestors === null) {
                yield {
                  kind: 'progress' as const,
                  message:
                    'Thingiverse: ancestors fetch failed; relationships dropped (files unaffected)',
                };
              } else if (ancestors.length > 0) {
                relationships = ancestors
                  .filter((a): a is ThingAncestor & { id: number } => typeof a.id === 'number')
                  .map((a) => {
                    const out: { kind: 'remix-of'; sourceId: 'thingiverse'; sourceItemId: string; label?: string } = {
                      kind: 'remix-of',
                      sourceId: 'thingiverse',
                      sourceItemId: String(a.id),
                    };
                    if (typeof a.name === 'string' && a.name) out.label = a.name;
                    return out;
                  });
                if (relationships.length === 0) relationships = undefined;
              }
            }

            // ── 8. Build NormalizedItem ──────────────────────────────────────

            const titleForFile =
              metadata.name && metadata.name.trim()
                ? metadata.name.trim()
                : `thingiverse-${thingId}`;

            const creator =
              metadata.creator?.name?.trim() ||
              [metadata.creator?.first_name, metadata.creator?.last_name]
                .filter((s): s is string => typeof s === 'string' && !!s.trim())
                .join(' ')
                .trim() ||
              metadata.creator?.thingiverse_username?.trim() ||
              undefined;

            const tags = Array.isArray(metadata.tags)
              ? metadata.tags
                  .map((t) => (typeof t === 'string' ? t : t?.name ?? null))
                  .filter((t): t is string => typeof t === 'string' && t.length > 0)
              : undefined;

            const sourceUrl =
              typeof metadata.public_url === 'string' && metadata.public_url
                ? metadata.public_url
                : `https://www.thingiverse.com/thing:${thingId}`;

            const sourcePublishedAt =
              typeof metadata.added === 'string' ? new Date(metadata.added) : undefined;

            const item: NormalizedItem = {
              sourceId: 'thingiverse' as const,
              sourceItemId: typeof metadata.id === 'number' ? String(metadata.id) : thingId,
              sourceUrl,
              title: titleForFile,
              files: fileDescriptors,
            };
            // NormalizedItem contract: "All string fields are trimmed UTF-8".
            // Thingiverse descriptions occasionally arrive with leading/
            // trailing whitespace (markdown trailing newlines, indented
            // template fragments); trim to satisfy the contract.
            if (typeof metadata.description === 'string') {
              const trimmed = metadata.description.trim();
              if (trimmed) item.description = trimmed;
            }
            if (creator) item.creator = creator;
            if (typeof metadata.license === 'string') item.license = metadata.license;
            if (tags && tags.length > 0) item.tags = tags;
            if (sourcePublishedAt && !isNaN(sourcePublishedAt.getTime())) {
              item.sourcePublishedAt = sourcePublishedAt;
            }
            if (relationships) item.relationships = relationships;

            yield { kind: 'completed' as const, item };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isAbort =
              (err instanceof Error && err.name === 'AbortError') ||
              context.signal?.aborted === true;
            if (isAbort) {
              logger.warn({ err }, 'thingiverse: aborted');
              yield {
                kind: 'failed' as const,
                reason: 'network-error' as const,
                details: `thingiverse aborted: ${msg}`,
                error: err,
              };
              return;
            }
            logger.warn({ err }, 'thingiverse: unexpected error');
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
// Internal: token refresh
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
 *   - `false` literal: no refresh was needed.
 *   - new credential bag: refresh succeeded; use this for subsequent calls.
 *   - `'failed'`: a terminal failed/auth-required event was yielded; caller
 *     should return.
 */
async function* maybeRefreshToken(
  creds: ThingiverseCredentials,
  context: FetchContext,
  tokenEndpoint: string,
  httpFetch: typeof fetch,
): AsyncGenerator<ScavengerEvent, ThingiverseCredentials | false | 'failed', void> {
  const oauthBag =
    creds.kind === 'oauth'
      ? creds
      : creds.kind === 'oauth+api-token'
      ? creds.oauth
      : null;
  if (!oauthBag) return false;

  const remaining = oauthBag.expiresAt - Date.now();
  if (remaining >= TOKEN_REFRESH_LEAD_MS) return false;

  yield {
    kind: 'progress' as const,
    message: 'Refreshing Thingiverse OAuth token',
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
      details: `thingiverse token refresh fetch failed: ${msg}`,
      error: err,
    };
    return 'failed';
  }

  // Auth-failure status codes from the token endpoint:
  //   400 — invalid_grant (refresh token no longer valid)
  //   401 — invalid_client (rare here; Thingiverse usually returns 400)
  //   403 — revoked client_secret, suspended app, IP block on the OAuth host
  // All three are credential-side issues; surfacing as 'network-error' would
  // hide them in the wrong UI bucket and prevent the pipeline pausing for
  // user re-authentication.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    yield {
      kind: 'auth-required' as const,
      reason: 'revoked' as const,
      surfaceToUser:
        'Thingiverse refresh token rejected. Reconnect Thingiverse in Settings > Sources.',
    };
    yield {
      kind: 'failed' as const,
      reason: 'auth-revoked' as const,
      details: `thingiverse refresh token rejected (HTTP ${res.status})`,
    };
    return 'failed';
  }

  if (!res.ok) {
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: `thingiverse token endpoint responded ${res.status}`,
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
      details: `thingiverse token response parse failed: ${(err as Error).message}`,
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
      details: 'thingiverse token response missing access_token or expires_in',
    };
    return 'failed';
  }

  // Thingiverse historically may NOT rotate refresh tokens — preserve the
  // existing one when omitted (T8-L5 pattern).
  const newRefreshToken =
    typeof tok.refresh_token === 'string' && tok.refresh_token
      ? tok.refresh_token
      : oauthBag.refreshToken;

  const newExpiresAt = Date.now() + tok.expires_in * 1000;

  let newCreds: ThingiverseCredentials;
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
    // oauth+api-token: preserve token + clientId/secret, swap nested oauth.
    const dual = creds as ThingiverseDualCredentials;
    newCreds = {
      kind: 'oauth+api-token',
      token: dual.token,
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
        'thingiverse: onTokenRefreshed callback failed; continuing with new creds for this request',
      );
    }
  }

  return newCreds;
}

// ---------------------------------------------------------------------------
// Internal: metadata + files + ancestors fetchers (dual-mode cascade)
// ---------------------------------------------------------------------------

async function* fetchThingMetadata(
  thingId: string,
  creds: ThingiverseCredentials,
  signal: AbortSignal | undefined,
  env: RequestEnv,
): AsyncGenerator<ScavengerEvent, ThingMetadata | null, void> {
  const url = `${env.apiBase}/things/${encodeURIComponent(thingId)}`;
  return yield* requestJsonWithCascade<ThingMetadata>(url, creds, signal, env, 'metadata');
}

async function* fetchThingFiles(
  thingId: string,
  creds: ThingiverseCredentials,
  signal: AbortSignal | undefined,
  env: RequestEnv,
): AsyncGenerator<ScavengerEvent, ThingFile[] | null, void> {
  const url = `${env.apiBase}/things/${encodeURIComponent(thingId)}/files`;
  const result = yield* requestJsonWithCascade<ThingFile[]>(url, creds, signal, env, 'files');
  if (!result) return null;
  if (!Array.isArray(result)) {
    // Treat shape-of-payload errors as transport-layer failures, matching
    // the JSON-parse failure branch in `requestJsonWithRetries`. The user-
    // facing meaning is "the source returned something we can't read".
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: `Thingiverse files endpoint for thing ${thingId} returned non-array payload`,
    };
    return null;
  }
  return result;
}

/**
 * Optional ancestors fetch. NEVER aborts the parent ingest:
 *
 *   - Returns the ancestors array on success.
 *   - Returns null on ANY failure (404, 401/403, rate-limit-exhausted, 5xx,
 *     parse error, network error). The caller is expected to log a `progress`
 *     event noting the degradation and continue with `relationships=undefined`.
 *
 * Files have already been staged by the time we call this; the spec calls
 * relationships "data-only placeholders, not activated in v2", so a failed
 * lookup MUST NOT prevent the user's downloaded files from being persisted.
 */
async function* fetchAncestors(
  thingId: string,
  creds: ThingiverseCredentials,
  signal: AbortSignal | undefined,
  env: RequestEnv,
): AsyncGenerator<ScavengerEvent, ThingAncestor[] | null, void> {
  const url = `${env.apiBase}/things/${encodeURIComponent(thingId)}/ancestors`;
  const result = yield* requestJsonWithCascade<ThingAncestor[]>(
    url,
    creds,
    signal,
    env,
    'ancestors',
    true, // tolerateTerminalFailure — never block completion on this
  );
  if (result === null) return null;
  if (!Array.isArray(result)) return null;
  return result;
}

/**
 * Helper that wraps `requestJsonWithRetries` with the dual-mode cascade for
 * `oauth+api-token` credentials: try API-token first, fall back to OAuth on
 * 401/403. Single-mode credentials skip the cascade.
 *
 * When `tolerateTerminalFailure=true` the helper passes the flag through so
 * non-success terminal statuses (404 / 5xx-exhausted / non-ok / parse-fail)
 * become a `'tolerated-failure'` cascade outcome that returns null WITHOUT
 * yielding a `failed` event. The caller can then decide whether to log a
 * `progress` event and continue (e.g. ancestors metadata) or surface the
 * absence to the user.
 */
async function* requestJsonWithCascade<T>(
  url: string,
  creds: ThingiverseCredentials,
  signal: AbortSignal | undefined,
  env: RequestEnv,
  label: string,
  tolerateTerminalFailure = false,
): AsyncGenerator<ScavengerEvent, T | null, void> {
  if (creds.kind === 'oauth+api-token') {
    const apiAttempt = yield* requestJsonWithRetries<T>(
      env.httpFetch,
      url,
      selectAuth(creds, 'api-token-only'),
      signal,
      env.maxRetries,
      env.retryBaseMs,
      label,
      true, // tolerateAuthFailure → caller cascades to OAuth
      tolerateTerminalFailure,
    );
    if (apiAttempt.outcome === 'value') return apiAttempt.value;
    if (apiAttempt.outcome === 'tolerated-failure') return null;
    if (apiAttempt.outcome === 'auth-rejected') {
      // Fall through to OAuth attempt below.
    } else {
      return null;
    }
    const oauthAttempt = yield* requestJsonWithRetries<T>(
      env.httpFetch,
      url,
      selectAuth(creds, 'oauth-only'),
      signal,
      env.maxRetries,
      env.retryBaseMs,
      label,
      false,
      tolerateTerminalFailure,
    );
    if (oauthAttempt.outcome === 'value') return oauthAttempt.value;
    return null;
  }

  const auth = selectAuth(
    creds,
    creds.kind === 'oauth' ? 'oauth-only' : 'api-token-only',
  );
  const attempt = yield* requestJsonWithRetries<T>(
    env.httpFetch,
    url,
    auth,
    signal,
    env.maxRetries,
    env.retryBaseMs,
    label,
    false,
    tolerateTerminalFailure,
  );
  if (attempt.outcome === 'value') return attempt.value;
  return null;
}

// ---------------------------------------------------------------------------
// Internal: file download with redirect-strip-Authorization (T7-L3)
// ---------------------------------------------------------------------------

async function* downloadFile(
  file: ThingFile & { download_url: string },
  thingId: string,
  usedNames: Set<string>,
  creds: ThingiverseCredentials,
  context: FetchContext,
  env: RequestEnv,
): AsyncGenerator<ScavengerEvent, NormalizedItem['files'][number] | null, void> {
  // Thingiverse `download_url` for non-public Things requires the same
  // Authorization header as the JSON API — the bare URL returns 401 without
  // it. The URL typically 302s to a signed CDN host, where the
  // Authorization header would be wrongly echoed back to a third-party
  // host (and rejected — T7-L3). So:
  //
  //   1. Initial fetch: carry Authorization (Bearer per credential kind).
  //      For dual creds we use the OAuth bearer here — the api-token path is
  //      already exercised by metadata + files, and the file-list endpoint
  //      having succeeded means OAuth is valid. Sending api-token for
  //      `oauth+api-token` would also work; OAuth is the more general path.
  //   2. Redirect target: re-fetch with NO Authorization header.
  const initialAuth = selectAuth(
    creds,
    creds.kind === 'api-token' ? 'api-token-only' : 'oauth-only',
  );
  // `selectAuth` returns Accept: application/json by default; downloads are
  // binary — drop Accept so we don't mis-cue a JSON-aware origin.
  const initialHeaders: Record<string, string> = {};
  if (initialAuth.headers['Authorization']) {
    initialHeaders['Authorization'] = initialAuth.headers['Authorization'];
  }

  let res: Response;
  try {
    res = await env.httpFetch(file.download_url, {
      headers: initialHeaders,
      signal: context.signal,
      redirect: 'manual',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: `Thingiverse download fetch failed: ${msg}`,
      error: err,
    };
    return null;
  }

  // Manual redirect handling. Some `download_url` values are direct CDN
  // links (no redirect); some redirect 302 → CDN. Both shapes work here.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) {
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Thingiverse download responded ${res.status} with no Location header`,
      };
      return null;
    }
    try {
      res = await env.httpFetch(location, { signal: context.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Thingiverse download redirect fetch failed: ${msg}`,
        error: err,
      };
      return null;
    }
  }

  if (res.status === 404 || res.status === 410) {
    yield {
      kind: 'failed' as const,
      reason: 'content-removed' as const,
      details: `Thingiverse download responded ${res.status}`,
    };
    return null;
  }

  if (res.status === 401 || res.status === 403) {
    yield {
      kind: 'auth-required' as const,
      reason: 'revoked' as const,
      surfaceToUser: `Thingiverse rejected credentials (${res.status})`,
    };
    yield {
      kind: 'failed' as const,
      reason: 'auth-revoked' as const,
      details: `Thingiverse download responded ${res.status}`,
    };
    return null;
  }

  if (!res.ok) {
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: `Thingiverse download responded ${res.status}`,
    };
    return null;
  }

  if (!res.body) {
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: 'Thingiverse download returned no body',
    };
    return null;
  }

  // ── Choose final filename AFTER seeing Content-Disposition (T8-L7) ──────
  //
  // Order of preference:
  //   1. Content-Disposition's filename (sanitized) — server-authoritative.
  //   2. metadata.name (sanitized) — fallback when no CD header.
  //   3. `thingiverse-<thingId>-<fileId>.bin` — last-resort safe default.
  //
  // We do NOT reserve a metadata-derived name in `usedNames` until AFTER the
  // chosen name is decided — otherwise CD echoes of the metadata name would
  // be flagged as collisions and suffixed unnecessarily.
  const cdRaw = filenameFromContentDisposition(res.headers.get('content-disposition'));
  const cdSanitized = cdRaw ? sanitizeFilename(cdRaw) : null;
  const metaSanitized = file.name ? sanitizeFilename(file.name) : null;
  const fallback = `thingiverse-${thingId}-${file.id ?? 'file'}.bin`;
  const baseName = cdSanitized ?? metaSanitized ?? fallback;
  const finalName = nextUniqueName(baseName, usedNames);
  usedNames.add(finalName);

  const destPath = path.join(context.stagingDir, finalName);

  try {
    const nodeReadable = Readable.fromWeb(
      res.body as unknown as import('stream/web').ReadableStream<Uint8Array>,
    );
    await streamPipeline(nodeReadable, createWriteStream(destPath));
  } catch (streamErr) {
    await fsp.unlink(destPath).catch(() => {});
    const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    yield {
      kind: 'failed' as const,
      reason: 'network-error' as const,
      details: `Thingiverse download stream error: ${msg}`,
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

// ---------------------------------------------------------------------------
// Internal: rate-limit-aware JSON GET helper (T7+T8 pattern)
// ---------------------------------------------------------------------------

/**
 * Outcomes from `requestJsonWithRetries`. Three tolerated-failure shapes
 * keep the helper composable:
 *
 *   - `'value'`            — request succeeded, payload returned.
 *   - `'auth-rejected'`    — 401/403 hit AND `tolerateAuthFailure=true`.
 *                            Caller cascades (e.g. api-token → oauth fallback).
 *   - `'tolerated-failure'`— any non-success terminal status hit AND
 *                            `tolerateTerminalFailure=true`. Caller treats the
 *                            request as "give up on this optional metadata"
 *                            and continues. NO `failed` event was yielded,
 *                            so the parent stream stays clean for `completed`.
 *   - `'terminal'`         — a terminal `failed` event was already yielded;
 *                            caller should bail out.
 *
 * Tolerance flags are independent: an ancestors fetch sets BOTH so a 401 OR
 * a 404 OR rate-limit-exhaustion all return without dirtying the stream.
 */
type RequestOutcome<T> =
  | { outcome: 'value'; value: T }
  | { outcome: 'auth-rejected' }
  | { outcome: 'tolerated-failure' }
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
  tolerateTerminalFailure = false,
): AsyncGenerator<ScavengerEvent, RequestOutcome<T>, void> {
  let attempt = 1;
  while (true) {
    yield {
      kind: 'progress' as const,
      message: `Thingiverse ${label} request (attempt ${attempt})`,
    };

    let res: Response;
    try {
      res = await httpFetch(url, {
        headers: auth.headers,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (tolerateTerminalFailure) {
        return { outcome: 'tolerated-failure' };
      }
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Thingiverse ${label} fetch failed: ${msg}`,
        error: err,
      };
      return { outcome: 'terminal' };
    }

    // Retryable: 429 + any 5xx. Thingiverse rate-limit headers are
    // X-RateLimit-Remaining and X-RateLimit-Reset (Unix epoch). On 429 we
    // prefer Retry-After if present, then fall back to exponential backoff.
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const ra = res.status === 429 ? res.headers.get('retry-after') : null;
      const retryAfterMs = ra ? parseRetryAfter(ra) : undefined;
      const decision = nextRetry(
        attempt,
        { maxAttempts: maxRetries, baseMs: retryBaseMs },
        retryAfterMs,
      );
      if (!decision.retry) {
        if (tolerateTerminalFailure) {
          return { outcome: 'tolerated-failure' };
        }
        yield {
          kind: 'failed' as const,
          reason: 'rate-limit-exhausted' as const,
          details: `Thingiverse ${label} retries exhausted after ${attempt} attempts (last status ${res.status})`,
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
      if (tolerateTerminalFailure) {
        return { outcome: 'tolerated-failure' };
      }
      yield {
        kind: 'auth-required' as const,
        reason: 'revoked' as const,
        surfaceToUser: `Thingiverse rejected credentials (${res.status})`,
      };
      yield {
        kind: 'failed' as const,
        reason: 'auth-revoked' as const,
        details: `Thingiverse ${label} responded ${res.status}`,
      };
      return { outcome: 'terminal' };
    }

    if (res.status === 404 || res.status === 410) {
      if (tolerateTerminalFailure) {
        return { outcome: 'tolerated-failure' };
      }
      yield {
        kind: 'failed' as const,
        reason: 'content-removed' as const,
        details: `Thingiverse ${label} responded ${res.status}`,
      };
      return { outcome: 'terminal' };
    }

    if (!res.ok) {
      if (tolerateTerminalFailure) {
        return { outcome: 'tolerated-failure' };
      }
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Thingiverse ${label} responded ${res.status}`,
      };
      return { outcome: 'terminal' };
    }

    try {
      const value = (await res.json()) as T;
      return { outcome: 'value', value };
    } catch (parseErr) {
      if (tolerateTerminalFailure) {
        return { outcome: 'tolerated-failure' };
      }
      yield {
        kind: 'failed' as const,
        reason: 'network-error' as const,
        details: `Thingiverse ${label} JSON parse failed: ${(parseErr as Error).message}`,
        error: parseErr,
      };
      return { outcome: 'terminal' };
    }
  }
}

// ---------------------------------------------------------------------------
// V2-004 T7 — SubscribableAdapter discovery support
// ---------------------------------------------------------------------------

type ThingiverseCursor = {
  /** Numeric thing.id of the most recent thing yielded by the prior firing. */
  firstSeenSourceItemId?: string;
};

type ThingiverseDiscoveryMode =
  | { kind: 'creator'; username: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'search'; query: string };

type RunThingiverseDiscoveryArgs = {
  context: DiscoveryContext;
  mode: ThingiverseDiscoveryMode;
  apiBase: string;
  oauthTokenEndpoint: string;
  httpFetch: typeof fetch;
  maxRetries: number;
  retryBaseMs: number | undefined;
  firstFireBackfill: number;
  perPage: number;
  defaultCaps: ResolvedCaps;
};

function parseThingiverseCursor(raw: string | undefined): ThingiverseCursor | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object') {
      const r = obj as Record<string, unknown>;
      const out: ThingiverseCursor = {};
      if (typeof r['firstSeenSourceItemId'] === 'string') {
        out.firstSeenSourceItemId = r['firstSeenSourceItemId'];
      }
      return out;
    }
  } catch {
    // Malformed cursor — first-fire.
  }
  return undefined;
}

/**
 * Discovery-side OAuth refresh that yields DiscoveryEvent rather than
 * ScavengerEvent. Mirrors `maybeRefreshToken` (fetch-side) logic.
 */
async function* maybeRefreshThingiverseTokenForDiscovery(
  creds: ThingiverseCredentials,
  context: DiscoveryContext,
  oauthTokenEndpoint: string,
  httpFetch: typeof fetch,
): AsyncGenerator<DiscoveryEvent, ThingiverseCredentials | 'failed', void> {
  const oauthBag =
    creds.kind === 'oauth'
      ? creds
      : creds.kind === 'oauth+api-token'
      ? creds.oauth
      : null;
  if (!oauthBag) return creds;

  const remaining = oauthBag.expiresAt - Date.now();
  if (remaining >= TOKEN_REFRESH_LEAD_MS) return creds;

  yield {
    kind: 'progress' as const,
    message: 'Refreshing Thingiverse OAuth token',
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
    res = await httpFetch(oauthTokenEndpoint, {
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
      details: `thingiverse token refresh fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
    };
    return 'failed';
  }

  if (res.status === 400 || res.status === 401) {
    yield {
      kind: 'auth-required' as const,
      reason: 'revoked' as const,
      surfaceToUser:
        'Thingiverse refresh token rejected. Reconnect Thingiverse in Settings > Sources.',
    };
    yield {
      kind: 'discovery-failed' as const,
      reason: 'auth-revoked' as const,
      details: `thingiverse refresh token rejected (HTTP ${res.status})`,
    };
    return 'failed';
  }

  if (!res.ok) {
    yield {
      kind: 'discovery-failed' as const,
      reason: 'network-error' as const,
      details: `thingiverse token endpoint responded ${res.status}`,
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
      details: `thingiverse token response parse failed: ${(err as Error).message}`,
      error: err,
    };
    return 'failed';
  }

  const tok = payload as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
  if (typeof tok.access_token !== 'string' || !tok.access_token || typeof tok.expires_in !== 'number') {
    yield {
      kind: 'discovery-failed' as const,
      reason: 'network-error' as const,
      details: 'thingiverse token response missing access_token or expires_in',
    };
    return 'failed';
  }
  const newRefreshToken =
    typeof tok.refresh_token === 'string' && tok.refresh_token
      ? tok.refresh_token
      : oauthBag.refreshToken;
  const newExpiresAt = Date.now() + tok.expires_in * 1000;

  let newCreds: ThingiverseCredentials;
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
    const dual = creds as ThingiverseDualCredentials;
    newCreds = {
      kind: 'oauth+api-token',
      token: dual.token,
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
        'thingiverse: discovery onTokenRefreshed callback failed; continuing with new creds for this request',
      );
    }
  }
  return newCreds;
}

function runThingiverseDiscovery(args: RunThingiverseDiscoveryArgs): AsyncIterable<DiscoveryEvent> {
  const { context, mode, apiBase, oauthTokenEndpoint, httpFetch, maxRetries, retryBaseMs, firstFireBackfill, perPage, defaultCaps } = args;

  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<DiscoveryEvent, void, void> {
      try {
        const credValidation = validateCredentials(context.credentials, defaultCaps);
        if (!credValidation.ok) {
          yield {
            kind: 'discovery-failed' as const,
            reason: 'auth-revoked' as const,
            details: `thingiverse discovery: ${credValidation.reason}`,
          };
          return;
        }

        const refreshed = yield* maybeRefreshThingiverseTokenForDiscovery(
          credValidation.creds,
          context,
          oauthTokenEndpoint,
          httpFetch,
        );
        if (refreshed === 'failed') return;
        const creds = refreshed;

        const priorCursor = parseThingiverseCursor(context.cursor);
        const isFirstFire = priorCursor === undefined;
        const cap = isFirstFire ? firstFireBackfill : Number.MAX_SAFE_INTEGER;

        let itemsTotal = 0;
        let firstSeenIdThisRun: string | undefined;
        let stop = false;
        let page = 1;

        while (!stop) {
          if (context.signal?.aborted) {
            yield {
              kind: 'discovery-failed' as const,
              reason: 'unknown' as const,
              details: 'thingiverse discovery aborted by signal',
            };
            return;
          }

          // Build URL for this page.
          let url: string;
          if (mode.kind === 'creator') {
            const u = new URL(`${apiBase}/users/${encodeURIComponent(mode.username)}/things`);
            u.searchParams.set('per_page', String(perPage));
            u.searchParams.set('page', String(page));
            url = u.toString();
          } else if (mode.kind === 'tag') {
            const u = new URL(`${apiBase}/things`);
            u.searchParams.set('tag', mode.tag);
            u.searchParams.set('per_page', String(perPage));
            u.searchParams.set('page', String(page));
            u.searchParams.set('sort', 'newest');
            url = u.toString();
          } else {
            const u = new URL(`${apiBase}/things`);
            u.searchParams.set('q', mode.query);
            u.searchParams.set('per_page', String(perPage));
            u.searchParams.set('page', String(page));
            u.searchParams.set('sort', 'newest');
            url = u.toString();
          }

          // Auth selection: cascade api-token-only → oauth-only on 401/403 for dual creds.
          const useApiTokenFirst = creds.kind === 'oauth+api-token';
          const initialAuth = selectAuth(creds, useApiTokenFirst ? 'api-token-only' : (creds.kind === 'oauth' ? 'oauth-only' : 'api-token-only'));

          let attempt = 1;
          let pageJson: unknown;
          let cascadedToOauth = false;
          let currentAuth = initialAuth;

          while (true) {
            yield {
              kind: 'progress' as const,
              message: `Thingiverse ${mode.kind} discovery page ${page} (attempt ${attempt})`,
              itemsSeen: itemsTotal,
            };
            let res: Response;
            try {
              res = await httpFetch(url, { headers: currentAuth.headers, signal: context.signal });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              yield {
                kind: 'discovery-failed' as const,
                reason: 'network-error' as const,
                details: `Thingiverse discovery fetch failed: ${msg}`,
                error: err,
              };
              return;
            }

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
                  kind: 'discovery-failed' as const,
                  reason: 'rate-limit-exhausted' as const,
                  details: `Thingiverse discovery retries exhausted (last status ${res.status})`,
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
              if (creds.kind === 'oauth+api-token' && !cascadedToOauth) {
                // Cascade to oauth-only.
                cascadedToOauth = true;
                currentAuth = selectAuth(creds, 'oauth-only');
                attempt = 1;
                continue;
              }
              yield {
                kind: 'auth-required' as const,
                reason: 'revoked' as const,
                surfaceToUser: `Thingiverse rejected credentials (${res.status})`,
              };
              yield {
                kind: 'discovery-failed' as const,
                reason: 'auth-revoked' as const,
                details: `Thingiverse discovery rejected (${res.status})`,
              };
              return;
            }

            if (res.status === 404 || res.status === 410) {
              yield {
                kind: 'discovery-failed' as const,
                reason: 'content-removed' as const,
                details: `Thingiverse discovery responded ${res.status}`,
              };
              return;
            }

            if (!res.ok) {
              yield {
                kind: 'discovery-failed' as const,
                reason: 'network-error' as const,
                details: `Thingiverse discovery responded ${res.status}`,
              };
              return;
            }

            try {
              pageJson = await res.json();
            } catch (parseErr) {
              yield {
                kind: 'discovery-failed' as const,
                reason: 'network-error' as const,
                details: `Thingiverse discovery JSON parse failed: ${(parseErr as Error).message}`,
                error: parseErr,
              };
              return;
            }
            break;
          }

          // Thingiverse list endpoints return either an array directly or an
          // object with a `hits` field (varies by route). Normalise both shapes.
          let things: Array<{ id?: number | string; name?: string; added?: string }>;
          if (Array.isArray(pageJson)) {
            things = pageJson as Array<{ id?: number | string; name?: string; added?: string }>;
          } else if (pageJson && typeof pageJson === 'object') {
            const obj = pageJson as Record<string, unknown>;
            things = Array.isArray(obj['hits'])
              ? (obj['hits'] as Array<{ id?: number | string; name?: string; added?: string }>)
              : [];
          } else {
            things = [];
          }

          if (things.length === 0) break;

          for (const t of things) {
            if (t.id === undefined || t.id === null) continue;
            const idStr = String(t.id);
            if (priorCursor?.firstSeenSourceItemId && idStr === priorCursor.firstSeenSourceItemId) {
              stop = true;
              break;
            }
            if (itemsTotal >= cap) {
              stop = true;
              break;
            }
            const ev: DiscoveryEvent = { kind: 'item-discovered' as const, sourceItemId: idStr };
            const hint: { title?: string; publishedAt?: Date } = {};
            if (typeof t.name === 'string' && t.name) hint.title = t.name;
            if (typeof t.added === 'string') {
              const d = new Date(t.added);
              if (!Number.isNaN(d.getTime())) hint.publishedAt = d;
            }
            if (hint.title || hint.publishedAt) ev.metadataHint = hint;
            yield ev;
            itemsTotal += 1;
            if (firstSeenIdThisRun === undefined) firstSeenIdThisRun = idStr;
          }

          if (stop) break;
          // If we got fewer items than perPage on this page, we've hit the end.
          if (things.length < perPage) break;
          page += 1;
        }

        const newCursor: ThingiverseCursor | undefined = firstSeenIdThisRun
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
        logger.warn({ err }, 'thingiverse: discovery unexpected error');
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
