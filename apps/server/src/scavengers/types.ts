/**
 * Core types for the Scavengers ingest layer.
 *
 * These types form the contract between:
 *   - ScavengerAdapter implementations (T4-T10)
 *   - The shared Ingest pipeline (T2)
 *   - V2-002's Stash placement logic (downstream of pipeline)
 *
 * No DB, HTTP, or filesystem imports here — pure types only.
 */

// ---------------------------------------------------------------------------
// Source identifiers
// ---------------------------------------------------------------------------

/**
 * One-per-source identifier. Lowercase kebab-case, used in DB column values,
 * log fields, and API responses. Add new ids here before implementing adapters.
 */
export type SourceId =
  | 'upload'
  | 'cults3d'
  | 'thingiverse' // deferred to V2-003b but reserved
  | 'patreon' // deferred to V2-003b but reserved
  | 'google-drive'
  | 'sketchfab'
  | 'makerworld'
  | 'printables'
  | 'extension-capture'
  | 'mega' // reserved for V2-003b — no adapter yet
  | 'mymini-factory'; // reserved for V2-003b — no adapter yet

// ---------------------------------------------------------------------------
// Normalized item — the common schema every adapter produces
// ---------------------------------------------------------------------------

/**
 * Normalized metadata produced by an adapter — shape independent of source.
 * The downstream Ingest pipeline hands this to V2-002's Stash placement logic.
 *
 * All string fields are trimmed UTF-8. Adapters MUST NOT include raw HTML.
 */
export type NormalizedItem = {
  sourceId: SourceId;
  /**
   * The source's own stable id for this item — e.g. Cults3D's GraphQL node id,
   * Thingiverse thing id. Used for metadata-related dedup in the pipeline.
   */
  sourceItemId: string;
  /** Canonical URL of this item on the source. */
  sourceUrl?: string;
  title: string;
  description?: string;
  creator?: string;
  license?: string;
  tags?: string[];
  /**
   * File descriptors — the adapter has already staged all files to disk.
   * The pipeline validates, hashes, deduplicates, and routes them into Stash.
   */
  files: Array<{
    /** Absolute path on disk where the adapter staged this file. */
    stagedPath: string;
    /** Caller-facing filename (not necessarily matching the staged path basename). */
    suggestedName: string;
    /** Size in bytes, if known at stage time. Pipeline re-measures if absent. */
    size?: number;
    /**
     * File extension detected by the adapter (e.g. 'stl', '3mf', 'zip').
     * Pipeline validates against magic bytes; adapters SHOULD populate this.
     */
    format?: string;
  }>;
  /**
   * Timestamp from the source, not ingest time. T2 pipeline maps this to
   * `lootSourceRecords.capturedAt` or `loot.provenance` — placement decided
   * by T2, not by the adapter.
   */
  sourcePublishedAt?: Date;
  /**
   * Optional relationships to other items (remix-of, fork-of, etc).
   *
   * Adapters MAY emit relationships when the source exposes them — e.g.
   * Thingiverse derivatives via `is_derivative` + `ancestors[]`, or future
   * GitHub-style forks. The shape stores both the local source kind and the
   * source's id for the related item; the consumer is responsible for
   * resolving these into Loot rows when the corresponding pillar lands.
   *
   * v2 NOTE: relationships are persisted as data-only — the pipeline does
   * NOT create rows in `loot_relationships`. Future Watchlist (V2-004) and
   * Grimoire pillars will activate the relationship surface. For now,
   * adapters set the field; downstream silently passes through.
   */
  relationships?: Array<{
    kind: 'remix-of' | 'fork-of';
    sourceId: SourceId;
    sourceItemId: string;
    label?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Failure reasons
// ---------------------------------------------------------------------------

/**
 * Structured reason codes for adapter fetch failures. Adapter implementations
 * MUST use the narrowest applicable reason rather than falling back to 'unknown'.
 */
export type AdapterFailureReason =
  | 'auth-expired' // Token/cookie expired, user must reauth
  | 'auth-revoked' // Credential permanently invalidated
  | 'rate-limit-exhausted' // All retry attempts consumed
  | 'content-removed' // HTTP 404 / 410 — item gone from source
  | 'anti-bot-challenge' // Cloudflare Turnstile, CAPTCHA, etc
  | 'format-unsupported' // Adapter received a file type it cannot handle
  | 'network-error' // TCP-level or DNS failure
  /**
   * The source has metadata for the item but no downloadable formats are
   * available to this caller. Distinct from `content-removed` (item gone)
   * and from `auth-revoked` (caller can't access). Used by adapters such as
   * Sketchfab where source-file-only models exist with no public download.
   */
  | 'no-downloadable-formats'
  | 'unknown'; // Catch-all — log `details` for diagnostics

// ---------------------------------------------------------------------------
// Event protocol — discriminated union emitted by adapter.fetch()
// ---------------------------------------------------------------------------

/**
 * Discriminated union of events an adapter emits during fetch().
 *
 * The pipeline consumes via `for await (const evt of adapter.fetch(...))`.
 *
 * Protocol invariant: every call to fetch() MUST terminate with exactly one
 * `completed` or `failed` event as the final item in the async iterable.
 * Adapters MUST NOT throw outside the iterator — surface errors as `failed`.
 */
export type ScavengerEvent =
  | {
      kind: 'progress';
      message: string;
      completedBytes?: number;
      totalBytes?: number;
    }
  | {
      kind: 'auth-required';
      /**
       * Why auth is required.
       * - 'expired'            — token/cookie silently expired; pipeline can trigger refresh
       * - 'revoked'            — credential was invalidated; user must reauthenticate
       * - 'missing'            — no credential configured at all
       * - 'rate-limited-backoff' — auth endpoint itself is rate-limited
       */
      reason: 'expired' | 'revoked' | 'missing' | 'rate-limited-backoff';
      /** Human-readable hint surfaced to the user in the UI. */
      surfaceToUser?: string;
    }
  | {
      kind: 'rate-limited';
      /** How long until the adapter should retry, in milliseconds. */
      retryAfterMs: number;
      /** Which retry attempt this is (1-based). */
      attempt: number;
    }
  | {
      kind: 'completed';
      item: NormalizedItem;
    }
  | {
      kind: 'failed';
      reason: AdapterFailureReason;
      /** Human-readable diagnostic detail. Never expose raw stack traces to callers. */
      details: string;
      /** Original error, if available — for server-side logging only. */
      error?: unknown;
    };

// ---------------------------------------------------------------------------
// Fetch context — provided by the pipeline to each adapter.fetch() call
// ---------------------------------------------------------------------------

/**
 * Per-fetch context provided by the Ingest pipeline.
 * Adapters use it to access per-user auth material and to stage files.
 * The pipeline creates this, provides the stagingDir, and cleans it up
 * after placement (or quarantine) is complete.
 */
export type FetchContext = {
  /** User id — for attribution and credential lookup in the DB. */
  userId: string;
  /**
   * Adapter-resolvable credential bag. The adapter decides how to interpret
   * this opaque record (e.g. read `credentials['apiKey']` or `credentials['sessionCookie']`).
   * The pipeline never inspects credential values.
   */
  credentials?: Record<string, unknown>;
  /**
   * Directory where the adapter MUST stage all downloaded files.
   * The pipeline provides this path and guarantees it exists and is writable.
   * The adapter MUST NOT write outside this directory.
   */
  stagingDir: string;
  /**
   * Optional callback fired when the adapter successfully refreshes an OAuth
   * token (or any other credential material). The pipeline persists the new
   * credentials to source_credentials. Adapters MUST call this with the
   * complete refreshed credential bag, not just the changed fields.
   *
   * If the caller does not provide this, the adapter still refreshes for the
   * current request but the new tokens are NOT persisted — callers without
   * a persistence story should accept this trade-off.
   */
  onTokenRefreshed?: (newCredentials: Record<string, unknown>) => Promise<void> | void;
  /**
   * AbortSignal — may fire if the user removes the job or the server is
   * shutting down. Adapters SHOULD check `signal.aborted` before each
   * network call and SHOULD pass it to fetch() calls.
   */
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Fetch target — what the adapter should retrieve
// ---------------------------------------------------------------------------

/**
 * The fetch target describes what the adapter should retrieve.
 * Three shapes allow the pipeline to route different trigger types:
 *
 * - 'url'            — user pasted a URL; the adapter verifies it owns the URL
 *                      via `supports()` before fetch is called.
 * - 'source-item-id' — pipeline or Watchlist already resolved the id from a
 *                      prior lookup; adapter bypasses URL parsing.
 * - 'raw'            — adapter-specific payload (e.g. extension-capture blob,
 *                      upload multipart metadata). The adapter casts `payload`.
 */
export type FetchTarget =
  | { kind: 'url'; url: string }
  | { kind: 'source-item-id'; sourceItemId: string }
  | { kind: 'raw'; payload: unknown }; // adapter-specific; e.g. extension-capture payload

// ---------------------------------------------------------------------------
// ScavengerAdapter interface
// ---------------------------------------------------------------------------

/**
 * Contract every source adapter must implement.
 *
 * Adapters are registered in the `ScavengerRegistry` at startup and are
 * invoked by the Ingest pipeline (V2-003-T2). Each adapter encapsulates
 * all source-specific concerns: auth, rate limiting, pagination, anti-bot
 * handling, metadata normalization, and file staging.
 *
 * Adapters MUST:
 * - Honor `context.signal` and stop promptly when aborted.
 * - Stage all files to `context.stagingDir`.
 * - Terminate the async iterable with exactly one `completed` or `failed` event.
 * - Never throw outside the iterator.
 *
 * Adapters MUST NOT:
 * - Import DB or filesystem modules (those are owned by the pipeline).
 * - Perform Stash placement or dedup logic.
 * - Write outside `context.stagingDir`.
 */
/**
 * Auth-method discriminator used by the public source catalog (GET /api/v1/sources).
 * One adapter may declare multiple methods (e.g. Sketchfab supports both
 * `oauth` and `api-key`). `none` means the adapter requires no credentials
 * (e.g. the upload adapter — files come from the multipart form body).
 */
export type ScavengerAuthMethod = 'oauth' | 'api-key' | 'extension' | 'none';

/**
 * Public adapter metadata exposed via GET /api/v1/sources.
 *
 * Adapters set these fields once at construction time. The catalog route
 * exposes them so UI clients (and downstream automation) can render the
 * appropriate auth controls per source without hard-coding adapter-specific
 * knowledge.
 */
export type ScavengerMetadata = {
  /** Human-readable display name (e.g. "Cults3D", "Google Drive"). */
  displayName: string;
  /** Which auth flows this adapter accepts. One adapter MAY support several. */
  authMethods: ScavengerAuthMethod[];
  /** Which kinds of `FetchTarget` the adapter accepts. */
  supports: { url: boolean; sourceItemId: boolean; raw: boolean };
  /** Optional adapter-level rate-limit hints surfaced to the UI. */
  rateLimitPolicy?: { baseMs: number; maxMs: number; maxRetries: number };
};

export interface ScavengerAdapter {
  /** Unique stable identifier for this source. Must match a SourceId value. */
  readonly id: SourceId;

  /**
   * Public adapter metadata. Used by the source catalog route to render UI
   * affordances. Optional for backwards-compatibility with adapters predating
   * V2-003-T9; adapters added in T9+ MUST populate this field.
   */
  readonly metadata?: ScavengerMetadata;

  /**
   * Returns true if this adapter handles the given URL.
   * Used by the registry to route URL-paste ingests.
   *
   * Implementation SHOULD be synchronous and cheap (URL parsing only).
   * MUST return false for URLs that belong to other adapters.
   */
  supports(url: string): boolean;

  /**
   * Fetches the target item, emitting a stream of ScavengerEvents.
   *
   * The final event in the stream MUST be either `completed` (with a
   * populated `NormalizedItem`) or `failed` (with a reason + details).
   *
   * The pipeline drives the iterator. Yielding `rate-limited` does NOT
   * automatically pause — the adapter must `await sleep(retryAfterMs)` if
   * it wants to back off before continuing. The event is informational so
   * the pipeline can record it and surface it to the UI.
   */
  fetch(context: FetchContext, target: FetchTarget): AsyncIterable<ScavengerEvent>;
}
