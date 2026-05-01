-- V2-005f-T_dcf1: dispatch_status_events + dispatch_jobs status/material columns.
--
-- Adds the per-protocol live-status audit trail that the V2-005f status
-- subscribers (T_dcf3..T_dcf8) and lifecycle worker (T_dcf9) write into, plus
-- three cache columns on dispatch_jobs:
--
--   materials_used    JSON [{slot_index, material_id, estimated_grams,
--                     measured_grams|null}, ...] — single-element for non-AMS
--                     printers, multi-element for AMS-class systems. Populated
--                     by T_dcf2 (slicer estimate) + T_dcf6 (Bambu measured).
--   last_status_at    Cache of the latest event's ingested_at — cheap UI/SSE
--                     read without scanning dispatch_status_events.
--   progress_pct      Cache of the latest progress event's pct (0–100).
--
-- See apps/server/src/db/schema.forge.ts (V2-005f block) for full design
-- rationale. No DB CHECK constraints on event_kind or source_protocol
-- (project pattern; app-layer validates against STATUS_EVENT_KINDS /
-- STATUS_SOURCE_PROTOCOLS).

CREATE TABLE `dispatch_status_events` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_job_id` text NOT NULL,
	`event_kind` text NOT NULL,
	`event_data` text NOT NULL,
	`source_protocol` text NOT NULL,
	`occurred_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ingested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`dispatch_job_id`) REFERENCES `dispatch_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dispatch_status_events_job` ON `dispatch_status_events` (`dispatch_job_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_dispatch_status_events_kind` ON `dispatch_status_events` (`event_kind`);--> statement-breakpoint
ALTER TABLE `dispatch_jobs` ADD `materials_used` text;--> statement-breakpoint
ALTER TABLE `dispatch_jobs` ADD `last_status_at` integer;--> statement-breakpoint
ALTER TABLE `dispatch_jobs` ADD `progress_pct` integer;