-- V2-007a-T3: ledger_events expansion + rename for cross-pillar use.
--
-- Renames the V2-002-T13 columns to a clearer, pillar-agnostic shape so the
-- table can record events from Materials, Grimoire, Forge, Watchlist, etc:
--
--   actor_id        → actor_user_id     (user id is the only kind of actor today)
--   resource_type   → subject_type      ("subject" matches the audit-trail vocabulary)
--   resource_id     → subject_id
--   created_at      → ingested_at       (distinguishes ingest-time from event-time)
--
-- Adds three columns:
--   related_resources  — JSON array of {kind, id, role} for multi-resource events
--                        (e.g. a mix event with N source bottles + 1 output batch)
--   provenance_class   — measured/entered/estimated/derived/computed/system;
--                        NULL when the event has no provenance-relevant numerics
--   occurred_at        — when the event actually happened (NULL ⇒ equal to
--                        ingested_at). Diverges for late-reported events.
--
-- Order matters: ALTER COLUMN add must come before DROP INDEX (which removes
-- references to the old column names), then RENAME COLUMN, then CREATE INDEX
-- with the new names.
ALTER TABLE `ledger_events` ADD COLUMN `related_resources` TEXT;
--> statement-breakpoint
ALTER TABLE `ledger_events` ADD COLUMN `provenance_class` TEXT;
--> statement-breakpoint
ALTER TABLE `ledger_events` ADD COLUMN `occurred_at` INTEGER;
--> statement-breakpoint
DROP INDEX IF EXISTS `ledger_events_resource_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `ledger_events_created_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `ledger_events_actor_idx`;
--> statement-breakpoint
ALTER TABLE `ledger_events` RENAME COLUMN `actor_id` TO `actor_user_id`;
--> statement-breakpoint
ALTER TABLE `ledger_events` RENAME COLUMN `resource_type` TO `subject_type`;
--> statement-breakpoint
ALTER TABLE `ledger_events` RENAME COLUMN `resource_id` TO `subject_id`;
--> statement-breakpoint
ALTER TABLE `ledger_events` RENAME COLUMN `created_at` TO `ingested_at`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ledger_events_subject_idx` ON `ledger_events` (`subject_type`, `subject_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ledger_events_ingested_idx` ON `ledger_events` (`ingested_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ledger_events_actor_user_idx` ON `ledger_events` (`actor_user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ledger_events_occurred_idx` ON `ledger_events` (`occurred_at`);
