-- V2-005f-CF-5a-T_a1: dispatch_warnings — per-job warning dedup table.
--
-- Adds the `dispatch_warnings` table for fast O(1) dedup of repeating protocol
-- warnings on a single dispatch job. Designed primarily for Bambu HMS spam
-- (advisory codes that fire on every MQTT poll while a condition persists) but
-- applies equally to SDCP / Moonraker advisory codes.
--
-- Design:
--   Rather than appending a row per occurrence to `dispatch_status_events`, the
--   T_a6 status-event handler UPSERTs into this table:
--     - First occurrence → INSERT a row (count = 1, first_seen_at = now).
--     - Subsequent occurrences → UPDATE last_seen_at + count++ (ON CONFLICT on
--       `idx_dispatch_warnings_unique`).
--   This keeps the audit event stream clean and provides O(1) dedup semantics.
--
-- Schema:
--   - `id`              surrogate primary key (ulid/uuid from app layer)
--   - `dispatch_job_id` FK → dispatch_jobs.id ON DELETE CASCADE
--   - `error_code`      protocol-native code (e.g. Bambu HMS code, SDCP
--                       ErrorStatusReason). Not globally unique — unique per
--                       (dispatch_job_id, protocol, error_code) tuple.
--   - `protocol`        STATUS_SOURCE_PROTOCOLS discriminator
--   - `severity`        'info' | 'warning' | 'error' (app-layer validated)
--   - `message`         operator-readable description, may be NULL
--   - `first_seen_at`   timestamp of first occurrence (unixepoch * 1000)
--   - `last_seen_at`    timestamp of most recent occurrence (updated on dedup)
--   - `count`           total occurrence count
--
-- Indexes:
--   - `idx_dispatch_warnings_unique` UNIQUE on (dispatch_job_id, protocol,
--     error_code) — the T_a6 ON CONFLICT dedup target. `protocol` is part of
--     the key because numeric error-code spaces overlap across protocols
--     (Bambu HMS vs SDCP ErrorStatusReason); today each dispatch_job → one
--     printer → one protocol so it can't collide, but the schema enforces its
--     own invariant.
--   - `idx_dispatch_warnings_job` on (dispatch_job_id, last_seen_at) — "all
--     active warnings for job X, newest first" UI / SSE hot path.
--
-- App-layer follow-ups (out of scope for T_a1):
--   - T_a2–T_a5: per-protocol subscriber rewrites to emit 'cancelled',
--     'firmware_error', 'warning' events with errorCode/errorMessage/severity.
--   - T_a6: status-event-handler dedup logic (INSERT … ON CONFLICT UPDATE).
--   - T_a7: HTTP API /status warnings array + ops doc.
CREATE TABLE `dispatch_warnings` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_job_id` text NOT NULL,
	`error_code` text NOT NULL,
	`protocol` text NOT NULL,
	`severity` text NOT NULL,
	`message` text,
	`first_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`dispatch_job_id`) REFERENCES `dispatch_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dispatch_warnings_unique` ON `dispatch_warnings` (`dispatch_job_id`,`protocol`,`error_code`);--> statement-breakpoint
CREATE INDEX `idx_dispatch_warnings_job` ON `dispatch_warnings` (`dispatch_job_id`,`last_seen_at`);
