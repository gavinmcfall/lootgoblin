-- V2-007a-T14: Add `idempotency_key` columns to materials, mix_recipes,
-- mix_batches, recycle_events, slicer_profiles, and print_settings so the
-- new POST /api/v1/materials/* + /api/v1/grimoire/* endpoints can dedupe
-- replayed creates. Same shape as `ingest_jobs.idempotency_key` (migration
-- 0013) and `watchlist_subscriptions.idempotency_key` (migration 0017):
-- nullable text + partial unique index on (owner_id, idempotency_key)
-- WHERE NOT NULL.
--
-- The routes accept an optional `Idempotency-Key` header. When present, a
-- repeat POST with the same `(owner_id, idempotency_key)` either:
--   - returns the prior row (200, body matched), or
--   - returns 409 (body differed; RFC 7240-style mismatch).
--
-- Rows created without an Idempotency-Key remain unconstrained.
--
-- mix_batches has no direct owner_id column — it inherits ownership via the
-- mix_recipes FK. To keep the partial-unique-index shape consistent we add a
-- denormalised owner_id column for mix_batches, populated by the route layer
-- at insert time (mirrors how recycle_events already carries owner_id).

ALTER TABLE `materials` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `materials_owner_idem_uniq`
  ON `materials`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `mix_recipes` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `mix_recipes_owner_idem_uniq`
  ON `mix_recipes`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `mix_batches` ADD COLUMN `owner_id` TEXT;
--> statement-breakpoint
ALTER TABLE `mix_batches` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `mix_batches_owner_idem_uniq`
  ON `mix_batches`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `recycle_events` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `recycle_events_owner_idem_uniq`
  ON `recycle_events`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `slicer_profiles` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `slicer_profiles_owner_idem_uniq`
  ON `slicer_profiles`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `print_settings` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `print_settings_owner_idem_uniq`
  ON `print_settings`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
