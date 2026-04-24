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
export interface ScavengerAdapter {
  /** Unique stable identifier for this source. Must match a SourceId value. */
  readonly id: SourceId;

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
