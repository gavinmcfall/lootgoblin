-- V2-004-T9: Add `idempotency_key` to `watchlist_subscriptions` so the new
-- POST /api/v1/watchlist/subscriptions endpoint can dedupe replayed creates.
-- Same shape as `ingest_jobs.idempotency_key` (migration 0013): nullable text
-- + partial unique index on (owner_id, idempotency_key) WHERE NOT NULL.
--
-- The route accepts an optional `Idempotency-Key` header. When present, a
-- repeat POST with the same `(owner_id, idempotency_key)` either:
--   - returns the prior subscription (200, body matched), or
--   - returns 409 (body differed; RFC 7240-style mismatch).
--
-- Subscriptions created without an Idempotency-Key remain unconstrained.
ALTER TABLE `watchlist_subscriptions` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_subs_owner_idem_uniq`
  ON `watchlist_subscriptions`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
