-- V2-001-T5: add scope and expires_at columns to api_keys table.
-- scope replaces the free-form scopes CSV with a typed single value.
-- expires_at enables per-scope expiration enforcement at validation time.
-- Existing rows backfilled to extension_pairing (the only scope used by T4).
ALTER TABLE `api_keys` ADD COLUMN `scope` text NOT NULL DEFAULT 'extension_pairing';
--> statement-breakpoint
ALTER TABLE `api_keys` ADD COLUMN `expires_at` integer;

