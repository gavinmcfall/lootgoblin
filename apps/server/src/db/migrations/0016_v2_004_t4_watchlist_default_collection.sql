-- V2-004-T4: Watchlist subscriptions need a `default_collection_id` so that
-- discovered items can be enqueued as child ingest_jobs targeted at a known
-- destination. The watchlist worker requires this value at firing time;
-- without it the job fails fast with a clear "subscription missing
-- default_collection_id" error.
--
-- Nullable on purpose. T1 shipped without this column; existing rows (if any)
-- would block a NOT NULL constraint. Validation is enforced at the
-- application layer:
--   * subscription-creation HTTP API (T9) rejects missing default_collection_id
--   * watchlist worker fails the firing if the column is NULL at run time
--
-- ON DELETE SET NULL — deleting a collection must not cascade-delete the
-- subscription history. The subscription is paused at firing time instead
-- (worker logs + marks watchlist_job failed) and the user gets a chance to
-- re-target it from the UI.
ALTER TABLE `watchlist_subscriptions`
  ADD COLUMN `default_collection_id` TEXT REFERENCES `collections`(id) ON DELETE SET NULL;
