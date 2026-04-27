-- V2-005a-T1: Forge pillar schema.
--
-- Adds: agents, printers, printer_reachable_via, forge_slicers, printer_acls,
--       slicer_acls, dispatch_jobs.
--
-- See apps/server/src/db/schema.forge.ts for full design rationale, including
-- locked decisions:
--   - SQLite-native atomic claim (UPDATE-with-WHERE, V2-003 worker pattern)
--   - reachable_via as m:n table (NOT JSON) for indexed JOINs in the claim loop
--   - target_kind / target_id as poly-FK at app layer (no DB FK enforcement)
--   - converted_file_id / sliced_file_id FK loot_files with SET NULL
--   - Agent delete SETs NULL on dispatch_jobs.claim_marker (preserve history)
--   - No DB CHECK constraints on enums (project pattern)
--
-- Order matters: agents and printers come before any table that FKs them.
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`pair_credential_ref` text,
	`last_seen_at` integer,
	`reachable_lan_hint` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agents_kind_idx` ON `agents` (`kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agents_last_seen_idx` ON `agents` (`last_seen_at`);
--> statement-breakpoint
CREATE TABLE `printers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`connection_config` text NOT NULL,
	`status_last_seen` integer,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `printers_owner_idx` ON `printers` (`owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `printers_owner_active_idx` ON `printers` (`owner_id`,`active`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `printers_kind_idx` ON `printers` (`kind`);
--> statement-breakpoint
CREATE TABLE `printer_reachable_via` (
	`printer_id` text NOT NULL,
	`agent_id` text NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `printer_reachable_via_pk` ON `printer_reachable_via` (`printer_id`,`agent_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `printer_reachable_via_agent_idx` ON `printer_reachable_via` (`agent_id`);
--> statement-breakpoint
CREATE TABLE `forge_slicers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`device_id` text,
	`invocation_method` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_slicers_owner_idx` ON `forge_slicers` (`owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_slicers_kind_idx` ON `forge_slicers` (`kind`);
--> statement-breakpoint
CREATE TABLE `printer_acls` (
	`id` text PRIMARY KEY NOT NULL,
	`printer_id` text NOT NULL,
	`user_id` text NOT NULL,
	`level` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `printer_acls_printer_user_idx` ON `printer_acls` (`printer_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `printer_acls_user_idx` ON `printer_acls` (`user_id`);
--> statement-breakpoint
CREATE TABLE `slicer_acls` (
	`id` text PRIMARY KEY NOT NULL,
	`slicer_id` text NOT NULL,
	`user_id` text NOT NULL,
	`level` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`slicer_id`) REFERENCES `forge_slicers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slicer_acls_slicer_user_idx` ON `slicer_acls` (`slicer_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slicer_acls_user_idx` ON `slicer_acls` (`user_id`);
--> statement-breakpoint
CREATE TABLE `dispatch_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`loot_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text NOT NULL,
	`converted_file_id` text,
	`sliced_file_id` text,
	`claim_marker` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`failure_reason` text,
	`failure_details` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`converted_file_id`) REFERENCES `loot_files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sliced_file_id`) REFERENCES `loot_files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claim_marker`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dispatch_jobs_owner_idx` ON `dispatch_jobs` (`owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dispatch_jobs_status_idx` ON `dispatch_jobs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dispatch_jobs_claim_marker_idx` ON `dispatch_jobs` (`claim_marker`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dispatch_jobs_loot_idx` ON `dispatch_jobs` (`loot_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dispatch_jobs_target_idx` ON `dispatch_jobs` (`target_kind`,`target_id`);
