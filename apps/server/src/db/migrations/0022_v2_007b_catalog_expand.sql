-- V2-007b T_B1: Expand the filament_products + resin_products catalog tables
-- from the V2-007a stubs (id PK only) to the full catalog schema documented
-- in planning/odad/research/v2-007b-catalog-seed.md (Q6).
--
-- Why ALTER TABLE rather than recreate: V2-007a deliberately shipped the
-- stub tables so this expansion can be a clean additive migration in place,
-- preserving the existing FK target for materials.product_id.
--
-- SQLite ADD COLUMN constraint: SQLite cannot add a NOT NULL column without a
-- DEFAULT (and SQLite expressions are limited as defaults). Both stub tables
-- are empty in production (V2-007a never populated them — they were stubs),
-- so we ADD all new columns as nullable here. NOT NULL is enforced at the
-- Drizzle ORM layer in apps/server/src/db/schema.materials.ts: every code
-- path that writes catalog rows goes through Drizzle, which generates
-- compile-time-checked queries that honour the TS-side notNull declarations.
-- Raw-SQL writers MUST honour the same invariants — see the schema module's
-- table doc-comments for the full contract.
--
-- Indexes: brand / subtype / brand+subtype compound / owner_id / source on
-- both tables. Plus an expression index on json_extract(colors, '$[0]') for
-- primary-color filter (declared here only — Drizzle's index() builder does
-- not support SQLite expression indexes).

-- ---------------------------------------------------------------------------
-- filament_products
-- ---------------------------------------------------------------------------

ALTER TABLE `filament_products` ADD COLUMN `brand` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `product_line` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `subtype` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `colors` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `color_pattern` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `color_name` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `default_temps` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `diameter_mm` REAL;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `density` REAL;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `spool_weight_g` REAL;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `empty_spool_weight_g` REAL;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `finish` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `pattern` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `is_glow` INTEGER;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `is_translucent` INTEGER;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `retail_url` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `slicer_id` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `owner_id` TEXT REFERENCES `user`(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `source` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `source_ref` TEXT;
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `created_at` INTEGER DEFAULT (unixepoch() * 1000);
--> statement-breakpoint
ALTER TABLE `filament_products` ADD COLUMN `updated_at` INTEGER DEFAULT (unixepoch() * 1000);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `filament_products_brand_idx` ON `filament_products`(`brand`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `filament_products_subtype_idx` ON `filament_products`(`subtype`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `filament_products_brand_subtype_idx` ON `filament_products`(`brand`, `subtype`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `filament_products_owner_idx` ON `filament_products`(`owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `filament_products_source_idx` ON `filament_products`(`source`);
--> statement-breakpoint
-- Expression index on the primary (first) color in the colors JSON array.
-- SQLite expression indexes work on json_extract output for filtering
-- WHERE json_extract(colors, '$[0]') = '#RRGGBB'.
CREATE INDEX IF NOT EXISTS `filament_products_primary_color_idx`
  ON `filament_products`(json_extract(`colors`, '$[0]'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- resin_products
-- ---------------------------------------------------------------------------

ALTER TABLE `resin_products` ADD COLUMN `brand` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `product_line` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `subtype` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `colors` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `color_name` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `default_exposure` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `density_g_ml` REAL;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `viscosity_cps` REAL;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `bottle_volume_ml` REAL;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `compatibility` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `material_class` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `retail_url` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `owner_id` TEXT REFERENCES `user`(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `source` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `source_ref` TEXT;
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `created_at` INTEGER DEFAULT (unixepoch() * 1000);
--> statement-breakpoint
ALTER TABLE `resin_products` ADD COLUMN `updated_at` INTEGER DEFAULT (unixepoch() * 1000);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `resin_products_brand_idx` ON `resin_products`(`brand`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `resin_products_subtype_idx` ON `resin_products`(`subtype`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `resin_products_class_idx` ON `resin_products`(`material_class`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `resin_products_owner_idx` ON `resin_products`(`owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `resin_products_source_idx` ON `resin_products`(`source`);
