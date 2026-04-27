-- V2-005c-T_c1: Slicer-runner schema additions.
--
-- Adds three tables that support runtime-installed slicers (PrusaSlicer /
-- OrcaSlicer / Bambu Studio downloaded on demand to /data/forge-tools/),
-- gcode + slice-metadata artifact storage, and Grimoire-profile-to-on-disk
-- materialization with drift detection via source-profile hash.
--
-- See apps/server/src/db/schema.forge.ts (V2-005c block) for full design
-- rationale, including:
--   - forge_artifacts vs loot_files split (machine-facing vs user-facing)
--   - one install per slicer kind (UNIQUE on slicer_kind)
--   - one materialization per (profile, slicer-kind) (composite UNIQUE)
--   - CASCADE from dispatch_jobs → forge_artifacts (artifacts are job-scoped)
--   - CASCADE from slicer_profiles → forge_slicer_profile_materializations
--   - No DB CHECK constraints on enums (project pattern, app-layer validates)

CREATE TABLE `forge_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_job_id` text NOT NULL,
	`kind` text NOT NULL,
	`storage_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`mime_type` text,
	`metadata_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`dispatch_job_id`) REFERENCES `dispatch_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_artifacts_dispatch_idx` ON `forge_artifacts` (`dispatch_job_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_artifacts_kind_idx` ON `forge_artifacts` (`kind`);
--> statement-breakpoint
CREATE TABLE `forge_slicer_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`slicer_kind` text NOT NULL,
	`installed_version` text,
	`binary_path` text,
	`install_root` text,
	`install_status` text NOT NULL,
	`last_update_check_at` integer,
	`available_version` text,
	`update_available` integer DEFAULT 0 NOT NULL,
	`installed_at` integer,
	`sha256` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `forge_slicer_installs_slicer_kind_unique` ON `forge_slicer_installs` (`slicer_kind`);
--> statement-breakpoint
CREATE TABLE `forge_slicer_profile_materializations` (
	`id` text PRIMARY KEY NOT NULL,
	`slicer_profile_id` text NOT NULL,
	`slicer_kind` text NOT NULL,
	`config_path` text NOT NULL,
	`source_profile_hash` text NOT NULL,
	`sync_required` integer DEFAULT 0 NOT NULL,
	`materialized_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`slicer_profile_id`) REFERENCES `slicer_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_profile_mat_profile_idx` ON `forge_slicer_profile_materializations` (`slicer_profile_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `forge_profile_mat_unique` ON `forge_slicer_profile_materializations` (`slicer_profile_id`,`slicer_kind`);
