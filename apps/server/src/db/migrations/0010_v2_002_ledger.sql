-- V2-002-T13: Ledger events table.
-- Adds: ledger_events (append-only audit trail for stash operations)
-- Indexed by resource, kind, and created_at for common query patterns.
CREATE TABLE `ledger_events` (
	`id` TEXT PRIMARY KEY,
	`kind` TEXT NOT NULL,
	`actor_id` TEXT,
	`resource_type` TEXT NOT NULL,
	`resource_id` TEXT NOT NULL,
	`payload` TEXT,
	`created_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_events_resource_idx` ON `ledger_events` (`resource_type`, `resource_id`);
--> statement-breakpoint
CREATE INDEX `ledger_events_created_idx` ON `ledger_events` (`created_at`);
--> statement-breakpoint
CREATE INDEX `ledger_events_kind_idx` ON `ledger_events` (`kind`);
