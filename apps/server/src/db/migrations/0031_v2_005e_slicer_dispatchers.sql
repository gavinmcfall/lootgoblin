-- V2-005e-T_e1: forge_inboxes + loot.parent_loot_id + forge_pending_pairings.
--
-- Adds the schema scaffolding for the V2-005e slicer-dispatcher pillar:
--
--   1. `forge_inboxes` — per-user watched filesystem drops. The Forge inbox
--      watcher (T_e2) tails each `path`, classifies arrivals as slicer outputs
--      (gcode / .3mf-with-gcode / .ctb / .pwmx / etc.), runs the source-
--      association heuristic (T_e3) to stamp `loot.parent_loot_id`, and
--      optionally enqueues a dispatch_jobs row targeting `default_printer_id`
--      when set.
--
--      FK behaviour:
--        - `owner_id` ON DELETE CASCADE — owner removal drops their inboxes.
--        - `default_printer_id` ON DELETE SET NULL — removing the printer
--          leaves the inbox in watch-only mode rather than deleting it.
--
--   2. `loot.parent_loot_id` — slice → source fast-path FK. When a Loot row is
--      a sliced-output artifact ingested via the inbox watcher, this column
--      points at the source-model Loot it was sliced from. Every slice has at
--      most one source; ON DELETE SET NULL preserves the slice row when its
--      source is removed.
--
--      Distinct from the `loot_relationships` m:n graph (V3+ remix /
--      derivative edges) — this is a single, indexed FK for the dispatch-time
--      lookup "given this slice, what's the source it came from?".
--
--   3. `forge_pending_pairings` — backstop queue for slice Loot rows whose
--      source the heuristic couldn't confidently identify. The pairing UI
--      lets the user pick the source manually; resolving the row stamps
--      `loot.parent_loot_id` and sets `resolved_at` / `resolved_to_loot_id`.
--      The partial UNIQUE index `idx_pending_pairings_slice` enforces "at
--      most one open pending row per slice"; closed rows freely repeat for
--      audit.
--
-- App-layer follow-ups (out of scope for T_e1):
--   - T_e2: Inbox CRUD + chokidar watcher + slicer-output classifier.
--   - T_e3: Three-tier source-Loot association (sidecar + heuristic + queue).
--   - T_e4: Slicer launch registry + GET /forge/slicers/launch-uri.
CREATE TABLE `forge_inboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`default_printer_id` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_forge_inboxes_owner` ON `forge_inboxes` (`owner_id`,`active`);--> statement-breakpoint
CREATE TABLE `forge_pending_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`slice_loot_id` text NOT NULL,
	`source_filename_hint` text,
	`ingested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer,
	`resolved_to_loot_id` text,
	FOREIGN KEY (`slice_loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_to_loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pending_pairings_slice` ON `forge_pending_pairings` (`slice_loot_id`) WHERE resolved_at IS NULL;--> statement-breakpoint
ALTER TABLE `loot` ADD `parent_loot_id` text REFERENCES loot(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `idx_loot_parent` ON `loot` (`parent_loot_id`);
