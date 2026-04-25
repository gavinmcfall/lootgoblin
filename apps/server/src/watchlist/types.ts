/**
 * Watchlist pillar — shared types (V2-004-T1)
 *
 * The schema layer (`schema.watchlist.ts`) stores `kind` and `parameters` as
 * untyped TEXT columns. This file defines the discriminated unions that all
 * application code must use when reading/writing those fields.
 *
 * Future tasks (T2 `SubscribableAdapter`, T6 dispatch) consume
 * `WatchlistSubscriptionParameters` to pick the right adapter call per
 * subscription kind.
 */

// ---------------------------------------------------------------------------
// Subscription kind discriminator
// ---------------------------------------------------------------------------

/**
 * The shape of a Watchlist subscription, controlling which adapter capability
 * is invoked on each firing:
 *
 *   creator      — adapter.listCreator(creatorId)         — track uploads from
 *                  a specific creator on a source.
 *   tag          — adapter.listTag(tag)                   — track a tag/category
 *                  feed (e.g. "miniature" on MakerWorld).
 *   saved_search — adapter.runSearch(query)               — re-run a saved
 *                  search query and ingest new matches.
 *   url_watch    — adapter.checkUrl(url)                  — re-poll a single
 *                  page URL and detect changes (e.g. updated model files).
 *   folder_watch — adapter.listFolder(folderId)           — list a cloud-storage
 *                  folder and ingest new children (GDrive, etc).
 */
export type WatchlistSubscriptionKind =
  | 'creator'
  | 'tag'
  | 'saved_search'
  | 'url_watch'
  | 'folder_watch';

// ---------------------------------------------------------------------------
// Per-kind parameters
// ---------------------------------------------------------------------------

/**
 * Track all uploads from a creator on a given source.
 * `creatorId` is the source-native identifier (e.g. MakerWorld designerId).
 */
export interface WatchlistParametersCreator {
  kind: 'creator';
  creatorId: string;
}

/**
 * Track a tag/category feed on a given source.
 * `tag` is the source-native tag value (URL-safe slug or human label,
 * adapter-specific).
 */
export interface WatchlistParametersTag {
  kind: 'tag';
  tag: string;
}

/**
 * Re-run a saved search query against a given source.
 * `query` is the search string the source's search endpoint accepts.
 */
export interface WatchlistParametersSavedSearch {
  kind: 'saved_search';
  query: string;
}

/**
 * Re-poll a single URL for changes (e.g. an updated model page).
 * `url` is the absolute URL — the adapter's URL-pattern dispatcher decides
 * whether it can handle it.
 */
export interface WatchlistParametersUrlWatch {
  kind: 'url_watch';
  url: string;
}

/**
 * Watch a cloud-storage folder for new children.
 * `folderId` is the source-native folder identifier (e.g. Google Drive
 * folder ID).
 */
export interface WatchlistParametersFolderWatch {
  kind: 'folder_watch';
  folderId: string;
}

/**
 * Discriminated union of all valid `parameters` JSON shapes.
 *
 * `JSON.parse(row.parameters)` should be validated against this union before
 * use — adapter dispatch logic relies on the `kind` discriminator narrowing
 * the rest of the object.
 */
export type WatchlistSubscriptionParameters =
  | WatchlistParametersCreator
  | WatchlistParametersTag
  | WatchlistParametersSavedSearch
  | WatchlistParametersUrlWatch
  | WatchlistParametersFolderWatch;

// ---------------------------------------------------------------------------
// Job status
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a single `watchlist_jobs` row.
 *
 *   queued    — created by scheduler tick; awaiting a worker.
 *   claimed   — atomically picked up by a worker; `claimed_at` set.
 *   running   — worker is executing the discovery phase.
 *   completed — discovery phase succeeded; cursor advanced; children enqueued.
 *   failed    — discovery phase errored; `failure_reason` + `failure_details` set.
 */
export type WatchlistJobStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed';
