-- V2-005a-T5: Add `idempotency_key` columns to printers, forge_slicers, and
-- dispatch_jobs so the new POST /api/v1/forge/* endpoints can dedupe replayed
-- creates. Same shape as materials/grimoire (migration 0021),
-- watchlist_subscriptions (0017), and ingest_jobs (0013): nullable text +
-- partial unique index on (owner_id, idempotency_key) WHERE NOT NULL.
--
-- The routes accept an optional `Idempotency-Key` header. When present, a
-- repeat POST with the same `(owner_id, idempotency_key)` either:
--   - returns the prior row (200, body matched), or
--   - returns 409 (body differed; RFC 7240-style mismatch).
--
-- Rows created without an Idempotency-Key remain unconstrained.

ALTER TABLE `printers` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `printers_owner_idem_uniq`
  ON `printers`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `forge_slicers` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_slicers_owner_idem_uniq`
  ON `forge_slicers`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `dispatch_jobs` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `dispatch_jobs_owner_idem_uniq`
  ON `dispatch_jobs`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
