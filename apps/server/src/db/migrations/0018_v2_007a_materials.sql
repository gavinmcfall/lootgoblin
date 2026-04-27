-- V2-007a-T1: Materials pillar (Grimoire + Materials + Ledger).
-- Adds materials, mix_recipes, mix_batches, recycle_events plus stub catalog
-- tables (filament_products, resin_products) that v2-007b will expand.
--
-- See apps/server/src/db/schema.materials.ts for the full design rationale,
-- including locked decisions:
--   - Multi-hex color support (1-4 hex colors + color_pattern discriminator)
--   - Catalog awareness via nullable product_id (stub tables today; v2-007b
--     populates them)
--   - Denormalized columns (brand, subtype, colors) over JSON payload for
--     filtering + Drizzle ergonomics; `extra` JSON reserved for kind-specific
--     overflow only
--   - Owner-scoped on user.id ON DELETE CASCADE
--   - No DB CHECK constraints — validation lives at app layer (project pattern)
CREATE TABLE `filament_products` (
	`id` TEXT PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `resin_products` (
	`id` TEXT PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `materials` (
	`id` TEXT PRIMARY KEY,
	`owner_id` TEXT NOT NULL REFERENCES `user`(id) ON DELETE CASCADE,
	`kind` TEXT NOT NULL,
	`product_id` TEXT,
	`brand` TEXT,
	`subtype` TEXT,
	`colors` TEXT,
	`color_pattern` TEXT,
	`color_name` TEXT,
	`density` REAL,
	`initial_amount` REAL NOT NULL,
	`remaining_amount` REAL NOT NULL,
	`unit` TEXT NOT NULL,
	`purchase_data` TEXT,
	`loaded_in_printer_ref` TEXT,
	`active` INTEGER NOT NULL DEFAULT 1,
	`retirement_reason` TEXT,
	`retired_at` INTEGER,
	`extra` TEXT,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `materials_owner_active_idx` ON `materials`(`owner_id`, `active`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `materials_owner_kind_idx` ON `materials`(`owner_id`, `kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `materials_loaded_idx` ON `materials`(`loaded_in_printer_ref`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `materials_product_idx` ON `materials`(`product_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `materials_owner_brand_idx` ON `materials`(`owner_id`, `brand`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `materials_owner_subtype_idx` ON `materials`(`owner_id`, `subtype`);
--> statement-breakpoint
CREATE TABLE `mix_recipes` (
	`id` TEXT PRIMARY KEY,
	`owner_id` TEXT NOT NULL REFERENCES `user`(id) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`components` TEXT NOT NULL,
	`notes` TEXT,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mix_recipes_owner_idx` ON `mix_recipes`(`owner_id`);
--> statement-breakpoint
CREATE TABLE `mix_batches` (
	`id` TEXT PRIMARY KEY,
	`recipe_id` TEXT NOT NULL REFERENCES `mix_recipes`(id) ON DELETE RESTRICT,
	`material_id` TEXT NOT NULL REFERENCES `materials`(id) ON DELETE CASCADE,
	`total_volume` REAL NOT NULL,
	`per_component_draws` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mix_batches_recipe_idx` ON `mix_batches`(`recipe_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mix_batches_material_idx` ON `mix_batches`(`material_id`);
--> statement-breakpoint
CREATE TABLE `recycle_events` (
	`id` TEXT PRIMARY KEY,
	`owner_id` TEXT NOT NULL REFERENCES `user`(id) ON DELETE CASCADE,
	`inputs` TEXT NOT NULL,
	`output_spool_id` TEXT NOT NULL REFERENCES `materials`(id) ON DELETE CASCADE,
	`notes` TEXT,
	`created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `recycle_events_owner_idx` ON `recycle_events`(`owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `recycle_events_output_idx` ON `recycle_events`(`output_spool_id`);
