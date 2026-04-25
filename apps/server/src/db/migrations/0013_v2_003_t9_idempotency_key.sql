-- V2-003-T9: Add `idempotency_key` to `ingest_jobs` for HTTP surface idempotency.
--
-- The POST /api/v1/ingest route accepts an optional `Idempotency-Key` header.
-- When present, the route looks up `(owner_id, idempotency_key)` and either
-- returns the prior job (body match) or 409 (body mismatch). The partial
-- unique index below enforces uniqueness only when the column is non-NULL,
-- so jobs created without an Idempotency-Key remain unconstrained.
ALTER TABLE `ingest_jobs` ADD COLUMN `idempotency_key` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `ingest_jobs_owner_idem_uniq`
  ON `ingest_jobs`(`owner_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
