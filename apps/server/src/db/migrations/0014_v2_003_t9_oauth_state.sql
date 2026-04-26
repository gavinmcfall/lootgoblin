-- V2-003-T9: oauth_state — short-lived state + PKCE verifier rows for the
-- /api/v1/source-auth/:sourceId/oauth/start + /oauth/callback endpoints.
CREATE TABLE `oauth_state` (
	`id` TEXT PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user`(id) ON DELETE CASCADE,
	`source_id` TEXT NOT NULL,
	`state` TEXT NOT NULL,
	`code_verifier` TEXT,
	`redirect_uri` TEXT,
	`created_at` INTEGER NOT NULL,
	`expires_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_state_user_idx` ON `oauth_state`(`user_id`);
--> statement-breakpoint
-- UNIQUE: single state per active flow; defends against replay races at the schema layer.
CREATE UNIQUE INDEX `oauth_state_state_uniq` ON `oauth_state`(`state`);
--> statement-breakpoint
CREATE INDEX `oauth_state_expires_idx` ON `oauth_state`(`expires_at`);
