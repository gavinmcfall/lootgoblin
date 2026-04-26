-- V2-003-T9: Add `idempotency_key` to `ingest_jobs` for HTTP surface idempotency.
-- Also adds the (owner_id, created_at) compound index that the new
-- GET /api/v1/ingest list endpoint walks for owner-scoped, time-ordered listing.
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
--> statement-breakpoint
-- Compound index for GET /api/v1/ingest — filter by owner_id, order by created_at.
-- The pre-T9 single-column owner index forces a scan + re-sort for listing.
CREATE INDEX `ingest_jobs_owner_created_idx`
  ON `ingest_jobs`(`owner_id`, `created_at`);
