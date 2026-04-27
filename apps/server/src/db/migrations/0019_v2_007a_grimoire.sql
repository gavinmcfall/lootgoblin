-- V2-007a-T2: Grimoire pillar (slicer profiles + per-model print settings +
-- attachments linking them to Loot).
--
-- See apps/server/src/db/schema.grimoire.ts for the full design rationale,
-- including locked decisions:
--   - Manual JSON entry only in v2-007a; native-format slicer config import
--     (Bambu/Orca/Prusa) is a separate future feature. `opaque_unsupported`
--     anticipates that path; v2-007a entries always have it = false.
--   - Owner-scoped on user.id ON DELETE CASCADE
--   - grimoire_attachments is a m:n link from loot to (slicer_profile XOR
--     print_setting). The XOR invariant is enforced at the app layer (no DB
--     CHECK per project pattern).
--   - Cascade rules: deleting the user, the loot, the profile, or the setting
--     removes the attachment row.
--   - No DB CHECK constraints — slicer/printer/material kind enums validated
--     at the app layer (project pattern, mirrors materials).
CREATE TABLE `slicer_profiles` (
	`id` TEXT PRIMARY KEY,
	`owner_id` TEXT NOT NULL REFERENCES `user`(id) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`slicer_kind` TEXT NOT NULL,
	`printer_kind` TEXT NOT NULL,
	`material_kind` TEXT NOT NULL,
	`settings_payload` TEXT NOT NULL,
	`opaque_unsupported` INTEGER NOT NULL DEFAULT 0,
	`notes` TEXT,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slicer_profiles_owner_idx` ON `slicer_profiles`(`owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slicer_profiles_owner_printer_idx` ON `slicer_profiles`(`owner_id`, `printer_kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slicer_profiles_slicer_kind_idx` ON `slicer_profiles`(`slicer_kind`);
--> statement-breakpoint
CREATE TABLE `print_settings` (
	`id` TEXT PRIMARY KEY,
	`owner_id` TEXT NOT NULL REFERENCES `user`(id) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`settings_payload` TEXT NOT NULL,
	`notes` TEXT,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `print_settings_owner_idx` ON `print_settings`(`owner_id`);
--> statement-breakpoint
CREATE TABLE `grimoire_attachments` (
	`id` TEXT PRIMARY KEY,
	`loot_id` TEXT NOT NULL REFERENCES `loot`(id) ON DELETE CASCADE,
	`slicer_profile_id` TEXT REFERENCES `slicer_profiles`(id) ON DELETE CASCADE,
	`print_setting_id` TEXT REFERENCES `print_settings`(id) ON DELETE CASCADE,
	`note` TEXT,
	`owner_id` TEXT NOT NULL REFERENCES `user`(id) ON DELETE CASCADE,
	`attached_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `grimoire_attachments_loot_idx` ON `grimoire_attachments`(`loot_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `grimoire_attachments_profile_idx` ON `grimoire_attachments`(`slicer_profile_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `grimoire_attachments_setting_idx` ON `grimoire_attachments`(`print_setting_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `grimoire_attachments_owner_idx` ON `grimoire_attachments`(`owner_id`);
