-- V2-001-T6: instance_identity table for UUID + Ed25519 keypair.
-- Single-row invariant enforced by unique index on the constant `singleton` column.
-- The instance bootstraps this row on first boot via instrumentation.ts.
CREATE TABLE `instance_identity` (
  `id` text PRIMARY KEY NOT NULL,
  `singleton` integer NOT NULL DEFAULT 1,
  `public_key` text NOT NULL,
  `private_key` text NOT NULL,
  `name` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instance_identity_singleton_uniq` ON `instance_identity` (`singleton`);
