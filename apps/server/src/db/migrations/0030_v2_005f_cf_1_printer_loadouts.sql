-- V2-005f-CF-1-T_g1: printer_loadouts + drop materials.loaded_in_printer_ref.
--
-- Replaces the v1 free-text `materials.loaded_in_printer_ref` column with a
-- proper per-slot load-history table. The new shape gives the Forge dispatch
-- worker (T_g4) a stable foreign key into per-slot consumption attribution
-- (V2-005f materials_used JSON) and the Materials UI (T_g3) a real history
-- view ("which printer ate this spool, and when").
--
-- Schema highlights:
--   - `idx_printer_loadouts_current` is a partial UNIQUE index on
--     (printer_id, slot_index) WHERE unloaded_at IS NULL. It enforces the
--     "at most one open loadout per (printer, slot)" invariant. Closed rows
--     (unloaded_at NOT NULL) freely repeat for history.
--   - FK `printer_id` ON DELETE CASCADE — printer removal drops its
--     loadout history (mirrors `printers` ownership of all sub-state).
--   - FK `material_id` ON DELETE RESTRICT — can't delete a material while
--     it's referenced in any loadout row. Belt-and-braces vs the Materials
--     retire flow.
--   - FK `loaded_by_user_id` / `unloaded_by_user_id` ON DELETE SET NULL —
--     deleting a user keeps the audit trail but anonymises the actor.
--
-- Backfill:
--   The `INSERT INTO printer_loadouts ... SELECT FROM materials` block runs
--   BEFORE the column drop. Existing rows where `materials.loaded_in_printer_ref`
--   points at a real `printers.id` carry forward as open loadouts at slot 0
--   (the v1 column had no slot semantics — non-AMS assumption). Orphaned
--   refs (free-text values that don't resolve to a printer row) are dropped;
--   the operator resolves them manually post-migration via the Materials UI.
--
-- App-layer follow-up (out of scope for T_g1):
--   - T_g2 wires `materialLoad` / `materialUnload` against this table with
--     atomic load+unload swap semantics + ledger events
--     (`material.loaded` / `material.unloaded`).
--   - T_g3 adds the HTTP surface (load / unload / get-loadout /
--     loadout-history).
--   - T_g4 teaches the claim worker to fill `dispatch_jobs.materials_used`
--     from the current loadout at claim time.
CREATE TABLE `printer_loadouts` (
	`id` text PRIMARY KEY NOT NULL,
	`printer_id` text NOT NULL,
	`slot_index` integer NOT NULL,
	`material_id` text NOT NULL,
	`loaded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`unloaded_at` integer,
	`loaded_by_user_id` text,
	`unloaded_by_user_id` text,
	`notes` text,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`loaded_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`unloaded_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_printer_loadouts_current` ON `printer_loadouts` (`printer_id`,`slot_index`) WHERE unloaded_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_printer_loadouts_printer_history` ON `printer_loadouts` (`printer_id`,`loaded_at`);--> statement-breakpoint
CREATE INDEX `idx_printer_loadouts_material` ON `printer_loadouts` (`material_id`);--> statement-breakpoint
-- Backfill: carry forward existing v1 load state. Skip orphaned refs (free-text
-- values that don't resolve to a real printers.id row); operator resolves
-- those manually post-migration. Slot defaults to 0 (v1 had no slot semantics).
INSERT INTO printer_loadouts (id, printer_id, slot_index, material_id, loaded_at)
SELECT
  lower(hex(randomblob(16))),
  m.loaded_in_printer_ref,
  0,
  m.id,
  m.created_at
FROM materials m
WHERE m.loaded_in_printer_ref IS NOT NULL
  AND m.loaded_in_printer_ref IN (SELECT id FROM printers);--> statement-breakpoint
DROP INDEX `materials_loaded_idx`;--> statement-breakpoint
ALTER TABLE `materials` DROP COLUMN `loaded_in_printer_ref`;
