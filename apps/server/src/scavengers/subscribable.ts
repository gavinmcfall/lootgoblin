/**
 * SubscribableAdapter — discovery-side contract for the Watchlist pillar (V2-004).
 *
 * Why a separate interface (WL-Q1 = b)
 * -------------------------------------
 * The existing `ScavengerAdapter` is the ingest-side contract: given a target
 * (URL / source-item-id / raw blob) it produces a single `NormalizedItem` with
 * staged files. Watchlist's needs are different — it iterates a *feed*
 * (creator uploads, tag listings, saved searches, folder enumerations, URL
 * polling) and emits *candidate* items that the ingest pipeline will fetch
 * separately.
 *
 * Stakeholder choice was a separate interface rather than tacking optional
 * methods onto `ScavengerAdapter`:
 *   - cleaner separation of concerns (ingest vs. discovery)
 *   - lets adapters implement just the side they need
 *   - the registry tracks two parallel maps; an adapter MAY appear in both
 *
 * Relationship to `ScavengerAdapter`
 * ----------------------------------
 * One concrete adapter (e.g. `createMakerWorldAdapter`) MAY implement BOTH
 * interfaces — the same factory exports a value that is both `ScavengerAdapter`
 * and `SubscribableAdapter`. The registry stores them in separate maps. The
 * watchlist worker (T4) discovers items via SubscribableAdapter and enqueues
 * `ingest_jobs` rows whose subsequent processing flows back through the regular
 * `ScavengerAdapter.fetch()` path.
 *
 * Pillar boundary
 * ---------------
 * Consumed exclusively by the V2-004 Watchlist scheduler/worker. The Stash /
 * Loot / Forge pillars MUST NOT call SubscribableAdapter methods directly.
 */

import type { SourceId } from './types';
import type {
  WatchlistSubscriptionKind,
  WatchlistSubscriptionParameters,
} from '../watchlist/types';

// ---------------------------------------------------------------------------
// Discovery event protocol
// ---------------------------------------------------------------------------

/**
 * Events emitted during a discovery run (listCreator / searchByTag / etc).
 *
 * Protocol invariant: every call to a capability method MUST terminate with
 * exactly one `discovery-completed` or `discovery-failed` event as the final
 * item in the async iterable.
 *
 * Adapters MUST NOT throw outside the iterator — surface errors as
 * `discovery-failed`.
 *
 * `item-discovered` carries minimal info — just enough to enqueue an
 * `ingest_jobs` row (`{ kind: 'source-item-id', sourceItemId }` target). The
 * actual metadata + files come later when the ingest worker fetches the item
 * via the regular `ScavengerAdapter.fetch`.
 *
 * `metadataHint` is optional pre-fetch context (e.g. "Title from Cults3D
 * listing"); the ingest pipeline uses it to ditch already-known items earlier.
 */
export type DiscoveryEvent =
  | {
      kind: 'item-discovered';
      sourceItemId: string;
      sourceUrl?: string;
      metadataHint?: { title?: string; publishedAt?: Date };
    }
  | {
      kind: 'progress';
      message: string;
      itemsSeen: number;
    }
  | {
      kind: 'rate-limited';
      retryAfterMs: number;
      attempt: number;
    }
  | {
      kind: 'auth-required';
      reason: 'expired' | 'revoked' | 'missing' | 'rate-limited-backoff';
      surfaceToUser?: string;
    }
  | {
      kind: 'discovery-completed';
      /**
       * Adapter-opaque cursor string. Persisted by the watchlist worker on the
       * `watchlist_subscriptions` row. Adapters define their own cursor format
       * (page token, last-seen id, ETag, content hash, etc).
       */
      cursor?: string;
      itemsTotal: number;
    }
  | {
      kind: 'discovery-failed';
      reason:
        | 'auth-revoked'
        | 'rate-limit-exhausted'
        | 'content-removed'
        | 'no-results'
        | 'network-error'
        | 'unknown';
      details: string;
      /** Original error, if available — for server-side logging only. */
      error?: unknown;
    };

// ---------------------------------------------------------------------------
// Discovery context
// ---------------------------------------------------------------------------

/**
 * Per-run context provided by the watchlist worker to a capability method.
 *
 * Mirrors `FetchContext` for the ingest pipeline, but scoped to discovery —
 * no `stagingDir`, since discovery doesn't write files.
 */
export type DiscoveryContext = {
  /** User id — for credential lookup, attribution. */
  userId: string;

  /**
   * Adapter-resolvable credential bag (same shape as `FetchContext.credentials`).
   * The watchlist worker resolves this from the same `source_credentials` row
   * the ingest pipeline uses.
   */
  credentials?: Record<string, unknown>;

  /**
   * Last-known cursor for this subscription; opaque string per adapter.
   * Adapters parse + use to fetch only items newer than the cursor.
   * `undefined` indicates a first-run / cold-start discovery.
   */
  cursor?: string;

  /**
   * Optional callback when the adapter refreshes auth tokens mid-discovery.
   * The watchlist worker (T4) wires this to persist refreshed credentials —
   * same contract as `ScavengerAdapter.fetch`'s `onTokenRefreshed`. Adapters
   * MUST call this with the complete refreshed credential bag, not just the
   * changed fields.
   */
  onTokenRefreshed?: (newCredentials: Record<string, unknown>) => Promise<void> | void;

  /**
   * AbortSignal — fires if the user pauses the subscription or the worker
   * shuts down. Adapters MUST honor.
   */
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// SubscribableAdapter interface
// ---------------------------------------------------------------------------

/**
 * Discovery-side contract for adapters that can power Watchlist subscriptions.
 *
 * All capability methods are OPTIONAL — adapters declare the kinds they
 * support by populating `capabilities` AND implementing the matching method.
 * The watchlist worker uses both: `capabilities.has(kind)` for catalog
 * filtering and `typeof adapter.listCreator === 'function'` for runtime
 * dispatch (belt-and-suspenders; see `hasCapability` below).
 *
 * Adapters MUST:
 *   - Honor `context.signal` and stop promptly when aborted.
 *   - Terminate the async iterable with exactly one `discovery-completed` or
 *     `discovery-failed` event.
 *   - Never throw outside the iterator.
 *   - Use `context.cursor` to discover only items newer than the last run
 *     when possible. First-run (no cursor) MAY return a bounded recent window.
 *
 * Adapters MUST NOT:
 *   - Stage files or fetch full metadata — that's the ingest pipeline's job.
 *   - Persist cursor state themselves — yield it on `discovery-completed`.
 */
export interface SubscribableAdapter {
  /** Must match a `SourceId` value — same as the corresponding `ScavengerAdapter`. */
  readonly id: SourceId;

  /**
   * Capability declaration — what kinds this adapter supports.
   * Used by the registry to filter "what's subscribable as X".
   *
   * Each kind in this set MUST have its corresponding method implemented;
   * `hasCapability` validates both conditions defensively.
   */
  readonly capabilities: ReadonlySet<WatchlistSubscriptionKind>;

  /** List items by a creator/user/profile id. Optional. */
  listCreator?(
    context: DiscoveryContext,
    creatorId: string,
  ): AsyncIterable<DiscoveryEvent>;

  /** Search by tag/category. Optional. */
  searchByTag?(
    context: DiscoveryContext,
    tag: string,
  ): AsyncIterable<DiscoveryEvent>;

  /** Free-form search query. Optional. */
  search?(
    context: DiscoveryContext,
    query: string,
  ): AsyncIterable<DiscoveryEvent>;

  /** Enumerate a folder/collection. Optional (Google Drive primary use case). */
  enumerateFolder?(
    context: DiscoveryContext,
    folderId: string,
  ): AsyncIterable<DiscoveryEvent>;

  /**
   * Poll a single URL, emit `item-discovered` ONLY if the resource has changed
   * since last fetch (ETag, content hash, etc — adapter-specific).
   * Optional.
   */
  pollUrl?(
    context: DiscoveryContext,
    url: string,
  ): AsyncIterable<DiscoveryEvent>;
}

// ---------------------------------------------------------------------------
// Type guards / dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Map each subscription kind to its implementing method name.
 * Single source of truth for both `hasCapability` and `dispatchDiscovery`.
 */
const KIND_METHOD: Record<WatchlistSubscriptionKind, keyof SubscribableAdapter> = {
  creator: 'listCreator',
  tag: 'searchByTag',
  saved_search: 'search',
  folder_watch: 'enumerateFolder',
  url_watch: 'pollUrl',
};

/**
 * Returns `true` IFF the adapter declares the capability AND has a callable
 * method for it. Belt-and-suspenders: catches mismatches between the declared
 * `capabilities` set and the actually-implemented methods.
 */
export function hasCapability(
  adapter: SubscribableAdapter,
  kind: WatchlistSubscriptionKind,
): boolean {
  if (!adapter.capabilities.has(kind)) return false;
  const methodName = KIND_METHOD[kind];
  return typeof (adapter as unknown as Record<string, unknown>)[methodName] === 'function';
}

/**
 * Picks the right capability method based on `params.kind`, casts `params` to
 * the matching discriminated-union variant, and returns the resulting async
 * iterable. Saves the watchlist worker (T4) from writing a switch statement.
 *
 * Throws if the adapter doesn't have the capability — callers should gate on
 * `hasCapability` first when uncertainty is possible.
 */
export function dispatchDiscovery(
  adapter: SubscribableAdapter,
  kind: WatchlistSubscriptionKind,
  context: DiscoveryContext,
  params: WatchlistSubscriptionParameters,
): AsyncIterable<DiscoveryEvent> {
  if (params.kind !== kind) {
    throw new Error(
      `dispatchDiscovery: kind mismatch — expected '${kind}', got params.kind='${params.kind}'`,
    );
  }
  if (!hasCapability(adapter, kind)) {
    throw new Error(
      `dispatchDiscovery: adapter '${adapter.id}' does not implement capability '${kind}'`,
    );
  }

  switch (params.kind) {
    case 'creator':
      // Non-null assertion is safe — hasCapability verified the method exists.
      return adapter.listCreator!(context, params.creatorId);
    case 'tag':
      return adapter.searchByTag!(context, params.tag);
    case 'saved_search':
      return adapter.search!(context, params.query);
    case 'folder_watch':
      return adapter.enumerateFolder!(context, params.folderId);
    case 'url_watch':
      return adapter.pollUrl!(context, params.url);
  }
}
