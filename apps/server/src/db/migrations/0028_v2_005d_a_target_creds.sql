-- V2-005d-a-T_da1: forge_target_credentials.
--
-- Per-printer encrypted credentials for the dispatcher / target adapters.
-- One row per printer (UNIQUE on printer_id); CASCADE on the FK so deleting
-- a printer drops its credential atomically. encrypted_blob holds the
-- base64(nonce||ct||tag) envelope produced by apps/server/src/crypto.ts
-- encrypt(); T_da2 adds the CRUD layer that encrypts on write / decrypts on
-- read. The same table is reused by V2-005d-{b,c,d} (Bambu LAN, SDCP,
-- OctoPrint) — see schema.forge.ts FORGE_TARGET_CREDENTIAL_KINDS for the
-- discriminator values + their plaintext shapes.
--
-- See apps/server/src/db/schema.forge.ts (V2-005d-a block) for full design
-- rationale. No DB CHECK constraint on `kind` (project pattern; app-layer
-- validates against FORGE_TARGET_CREDENTIAL_KINDS).

CREATE TABLE `forge_target_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`printer_id` text NOT NULL,
	`kind` text NOT NULL,
	`encrypted_blob` blob NOT NULL,
	`label` text,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_target_credentials_printer_id_unique` ON `forge_target_credentials` (`printer_id`);