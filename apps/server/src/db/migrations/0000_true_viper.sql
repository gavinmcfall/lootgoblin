CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`scope` text DEFAULT 'extension_pairing' NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `hoard_libraries` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`packager` text NOT NULL,
	`credential_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `scout_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `instance_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton` integer DEFAULT 1 NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instance_identity_singleton_uniq` ON `instance_identity` (`singleton`);--> statement-breakpoint
CREATE TABLE `item_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`source_item_id` text NOT NULL,
	`content_type` text NOT NULL,
	`source_url` text NOT NULL,
	`snapshot` text,
	`hoard_id` text,
	`credential_id` text,
	`status` text NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`output_path` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`hoard_id`) REFERENCES `hoard_libraries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `scout_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_done_unique` ON `items` (`source_id`,`source_item_id`) WHERE status = 'done';--> statement-breakpoint
CREATE INDEX `items_status_idx` ON `items` (`status`);--> statement-breakpoint
CREATE TABLE `scout_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`scout_id` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`encrypted_blob` blob NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scout_cred_label_uniq` ON `scout_credentials` (`scout_id`,`label`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'admin' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT true,
	`rate_limit_time_window` integer DEFAULT 86400000,
	`rate_limit_max` integer DEFAULT 10,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `apikey_configId_idx` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_referenceId_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_uidx` ON `organization` (`slug`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`active_organization_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `config_provenance` (
	`key` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`resolved_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`source_detail` text
);
--> statement-breakpoint
CREATE TABLE `instance_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`path_template` text NOT NULL,
	`stash_root_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stash_root_id`) REFERENCES `stash_roots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collections_owner_id_idx` ON `collections` (`owner_id`);--> statement-breakpoint
CREATE INDEX `collections_stash_root_id_idx` ON `collections` (`stash_root_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_owner_name_uniq` ON `collections` (`owner_id`,`name`);--> statement-breakpoint
CREATE TABLE `loot` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`tags` text DEFAULT (json('[]')) NOT NULL,
	`creator` text,
	`license` text,
	`source_item_id` text,
	`content_summary` text,
	`file_missing` integer DEFAULT false NOT NULL,
	`parent_loot_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `loot_collection_id_idx` ON `loot` (`collection_id`);--> statement-breakpoint
CREATE INDEX `loot_file_missing_idx` ON `loot` (`file_missing`);--> statement-breakpoint
CREATE INDEX `idx_loot_parent` ON `loot` (`parent_loot_id`);--> statement-breakpoint
CREATE TABLE `loot_files` (
	`id` text PRIMARY KEY NOT NULL,
	`loot_id` text NOT NULL,
	`path` text NOT NULL,
	`format` text NOT NULL,
	`size` integer NOT NULL,
	`hash` text NOT NULL,
	`origin` text NOT NULL,
	`provenance` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `loot_files_loot_id_idx` ON `loot_files` (`loot_id`);--> statement-breakpoint
CREATE INDEX `loot_files_hash_idx` ON `loot_files` (`hash`);--> statement-breakpoint
CREATE TABLE `loot_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_loot_id` text NOT NULL,
	`child_loot_id` text NOT NULL,
	`relationship` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`parent_loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `loot_source_records` (
	`id` text PRIMARY KEY NOT NULL,
	`loot_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`source_identifier` text,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `loot_source_records_loot_id_idx` ON `loot_source_records` (`loot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `loot_source_records_loot_type_id_uniq` ON `loot_source_records` (`loot_id`,`source_type`,`source_identifier`);--> statement-breakpoint
CREATE TABLE `quarantine_items` (
	`id` text PRIMARY KEY NOT NULL,
	`stash_root_id` text NOT NULL,
	`path` text NOT NULL,
	`reason` text NOT NULL,
	`details` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`stash_root_id`) REFERENCES `stash_roots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `quarantine_items_stash_root_id_idx` ON `quarantine_items` (`stash_root_id`);--> statement-breakpoint
CREATE INDEX `quarantine_items_resolved_at_idx` ON `quarantine_items` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `stash_roots` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `inbox_pending_items` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_path` text NOT NULL,
	`classification` text NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`reason` text NOT NULL,
	`detected_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_pending_items_inbox_path_unique` ON `inbox_pending_items` (`inbox_path`);--> statement-breakpoint
CREATE INDEX `inbox_pending_items_detected_idx` ON `inbox_pending_items` (`detected_at`);--> statement-breakpoint
CREATE TABLE `inbox_triage_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`filename_pattern` text NOT NULL,
	`min_confidence` real NOT NULL,
	`collection_id` text NOT NULL,
	`mode` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_triage_rules_owner_idx` ON `inbox_triage_rules` (`owner_id`);--> statement-breakpoint
CREATE INDEX `inbox_triage_rules_priority_idx` ON `inbox_triage_rules` (`priority`);--> statement-breakpoint
CREATE TABLE `loot_thumbnails` (
	`loot_id` text PRIMARY KEY NOT NULL,
	`thumbnail_path` text,
	`status` text NOT NULL,
	`source_kind` text,
	`error` text,
	`generated_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `loot_thumbnails_status_idx` ON `loot_thumbnails` (`status`);--> statement-breakpoint
CREATE TABLE `ledger_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`actor_user_id` text,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`related_resources` text,
	`payload` text,
	`provenance_class` text,
	`occurred_at` integer,
	`ingested_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_events_subject_idx` ON `ledger_events` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `ledger_events_ingested_idx` ON `ledger_events` (`ingested_at`);--> statement-breakpoint
CREATE INDEX `ledger_events_kind_idx` ON `ledger_events` (`kind`);--> statement-breakpoint
CREATE INDEX `ledger_events_actor_user_idx` ON `ledger_events` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `ledger_events_occurred_idx` ON `ledger_events` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `gdrive_watch_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`address` text NOT NULL,
	`token` text NOT NULL,
	`expiration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error_reason` text,
	`refreshed_at` integer,
	`last_message_number` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `watchlist_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gdrive_watch_channels_subscription_idx` ON `gdrive_watch_channels` (`subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `gdrive_watch_channels_channel_id_uniq` ON `gdrive_watch_channels` (`channel_id`);--> statement-breakpoint
CREATE INDEX `gdrive_watch_channels_expiration_idx` ON `gdrive_watch_channels` (`expiration_ms`);--> statement-breakpoint
CREATE INDEX `gdrive_watch_channels_status_idx` ON `gdrive_watch_channels` (`status`);--> statement-breakpoint
CREATE TABLE `watchlist_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`items_discovered` integer DEFAULT 0 NOT NULL,
	`items_enqueued` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`failure_details` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `watchlist_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `watchlist_jobs_status_idx` ON `watchlist_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `watchlist_jobs_sub_created_idx` ON `watchlist_jobs` (`subscription_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `watchlist_jobs_status_claimed_idx` ON `watchlist_jobs` (`status`,`claimed_at`);--> statement-breakpoint
CREATE TABLE `watchlist_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_adapter_id` text NOT NULL,
	`parameters` text NOT NULL,
	`cadence_seconds` integer DEFAULT 3600 NOT NULL,
	`last_fired_at` integer,
	`cursor_state` text,
	`active` integer DEFAULT 1 NOT NULL,
	`error_streak` integer DEFAULT 0 NOT NULL,
	`default_collection_id` text,
	`idempotency_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `watchlist_subs_owner_active_idx` ON `watchlist_subscriptions` (`owner_id`,`active`);--> statement-breakpoint
CREATE INDEX `watchlist_subs_active_source_idx` ON `watchlist_subscriptions` (`active`,`source_adapter_id`);--> statement-breakpoint
CREATE INDEX `watchlist_subs_active_fired_idx` ON `watchlist_subscriptions` (`active`,`last_fired_at`);--> statement-breakpoint
CREATE TABLE `ingest_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_payload` text NOT NULL,
	`collection_id` text,
	`status` text NOT NULL,
	`loot_id` text,
	`quarantine_item_id` text,
	`failure_reason` text,
	`failure_details` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`idempotency_key` text,
	`parent_subscription_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`quarantine_item_id`) REFERENCES `quarantine_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_subscription_id`) REFERENCES `watchlist_subscriptions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ingest_jobs_owner_idx` ON `ingest_jobs` (`owner_id`);--> statement-breakpoint
CREATE INDEX `ingest_jobs_status_idx` ON `ingest_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `ingest_jobs_source_idx` ON `ingest_jobs` (`source_id`);--> statement-breakpoint
CREATE INDEX `ingest_jobs_owner_created_idx` ON `ingest_jobs` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ingest_jobs_owner_idem_uniq` ON `ingest_jobs` (`owner_id`,`idempotency_key`) WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ingest_jobs_parent_sub_idx` ON `ingest_jobs` (`parent_subscription_id`) WHERE parent_subscription_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `oauth_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`state` text NOT NULL,
	`code_verifier` text,
	`redirect_uri` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_state_user_idx` ON `oauth_state` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_state_state_uniq` ON `oauth_state` (`state`);--> statement-breakpoint
CREATE INDEX `oauth_state_expires_idx` ON `oauth_state` (`expires_at`);--> statement-breakpoint
CREATE TABLE `filament_products` (
	`id` text PRIMARY KEY NOT NULL,
	`brand` text NOT NULL,
	`product_line` text,
	`subtype` text NOT NULL,
	`colors` text NOT NULL,
	`color_pattern` text NOT NULL,
	`color_name` text,
	`default_temps` text,
	`diameter_mm` real,
	`density` real,
	`spool_weight_g` real,
	`empty_spool_weight_g` real,
	`finish` text,
	`pattern` text,
	`is_glow` integer,
	`is_translucent` integer,
	`retail_url` text,
	`slicer_id` text,
	`owner_id` text,
	`source` text NOT NULL,
	`source_ref` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `filament_products_brand_idx` ON `filament_products` (`brand`);--> statement-breakpoint
CREATE INDEX `filament_products_subtype_idx` ON `filament_products` (`subtype`);--> statement-breakpoint
CREATE INDEX `filament_products_brand_subtype_idx` ON `filament_products` (`brand`,`subtype`);--> statement-breakpoint
CREATE INDEX `filament_products_owner_idx` ON `filament_products` (`owner_id`);--> statement-breakpoint
CREATE INDEX `filament_products_source_idx` ON `filament_products` (`source`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`product_id` text,
	`brand` text,
	`subtype` text,
	`colors` text,
	`color_pattern` text,
	`color_name` text,
	`density` real,
	`initial_amount` real NOT NULL,
	`remaining_amount` real NOT NULL,
	`unit` text NOT NULL,
	`purchase_data` text,
	`active` integer DEFAULT true NOT NULL,
	`retirement_reason` text,
	`retired_at` integer,
	`extra` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `materials_owner_active_idx` ON `materials` (`owner_id`,`active`);--> statement-breakpoint
CREATE INDEX `materials_owner_kind_idx` ON `materials` (`owner_id`,`kind`);--> statement-breakpoint
CREATE INDEX `materials_product_idx` ON `materials` (`product_id`);--> statement-breakpoint
CREATE INDEX `materials_owner_brand_idx` ON `materials` (`owner_id`,`brand`);--> statement-breakpoint
CREATE INDEX `materials_owner_subtype_idx` ON `materials` (`owner_id`,`subtype`);--> statement-breakpoint
CREATE TABLE `mix_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`material_id` text NOT NULL,
	`total_volume` real NOT NULL,
	`per_component_draws` text NOT NULL,
	`owner_id` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `mix_recipes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mix_batches_recipe_idx` ON `mix_batches` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `mix_batches_material_idx` ON `mix_batches` (`material_id`);--> statement-breakpoint
CREATE TABLE `mix_recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`components` text NOT NULL,
	`notes` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mix_recipes_owner_idx` ON `mix_recipes` (`owner_id`);--> statement-breakpoint
CREATE TABLE `recycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`inputs` text NOT NULL,
	`output_spool_id` text NOT NULL,
	`notes` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`output_spool_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recycle_events_owner_idx` ON `recycle_events` (`owner_id`);--> statement-breakpoint
CREATE INDEX `recycle_events_output_idx` ON `recycle_events` (`output_spool_id`);--> statement-breakpoint
CREATE TABLE `resin_products` (
	`id` text PRIMARY KEY NOT NULL,
	`brand` text NOT NULL,
	`product_line` text,
	`subtype` text NOT NULL,
	`colors` text,
	`color_name` text,
	`default_exposure` text,
	`density_g_ml` real,
	`viscosity_cps` real,
	`bottle_volume_ml` real,
	`compatibility` text,
	`material_class` text,
	`retail_url` text,
	`owner_id` text,
	`source` text NOT NULL,
	`source_ref` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resin_products_brand_idx` ON `resin_products` (`brand`);--> statement-breakpoint
CREATE INDEX `resin_products_subtype_idx` ON `resin_products` (`subtype`);--> statement-breakpoint
CREATE INDEX `resin_products_class_idx` ON `resin_products` (`material_class`);--> statement-breakpoint
CREATE INDEX `resin_products_owner_idx` ON `resin_products` (`owner_id`);--> statement-breakpoint
CREATE INDEX `resin_products_source_idx` ON `resin_products` (`source`);--> statement-breakpoint
CREATE TABLE `grimoire_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`loot_id` text NOT NULL,
	`slicer_profile_id` text,
	`print_setting_id` text,
	`note` text,
	`owner_id` text NOT NULL,
	`attached_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`slicer_profile_id`) REFERENCES `slicer_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`print_setting_id`) REFERENCES `print_settings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `grimoire_attachments_loot_idx` ON `grimoire_attachments` (`loot_id`);--> statement-breakpoint
CREATE INDEX `grimoire_attachments_profile_idx` ON `grimoire_attachments` (`slicer_profile_id`);--> statement-breakpoint
CREATE INDEX `grimoire_attachments_setting_idx` ON `grimoire_attachments` (`print_setting_id`);--> statement-breakpoint
CREATE INDEX `grimoire_attachments_owner_idx` ON `grimoire_attachments` (`owner_id`);--> statement-breakpoint
CREATE TABLE `print_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`settings_payload` text NOT NULL,
	`notes` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `print_settings_owner_idx` ON `print_settings` (`owner_id`);--> statement-breakpoint
CREATE TABLE `slicer_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`slicer_kind` text NOT NULL,
	`printer_kind` text NOT NULL,
	`material_kind` text NOT NULL,
	`settings_payload` text NOT NULL,
	`opaque_unsupported` integer DEFAULT false NOT NULL,
	`notes` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `slicer_profiles_owner_idx` ON `slicer_profiles` (`owner_id`);--> statement-breakpoint
CREATE INDEX `slicer_profiles_owner_printer_idx` ON `slicer_profiles` (`owner_id`,`printer_kind`);--> statement-breakpoint
CREATE INDEX `slicer_profiles_slicer_kind_idx` ON `slicer_profiles` (`slicer_kind`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`pair_credential_ref` text,
	`last_seen_at` integer,
	`reachable_lan_hint` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_kind_idx` ON `agents` (`kind`);--> statement-breakpoint
CREATE INDEX `agents_last_seen_idx` ON `agents` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `dispatch_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`loot_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text NOT NULL,
	`converted_file_id` text,
	`sliced_file_id` text,
	`claim_marker` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`failure_reason` text,
	`failure_details` text,
	`idempotency_key` text,
	`materials_used` text,
	`last_status_at` integer,
	`progress_pct` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`converted_file_id`) REFERENCES `loot_files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sliced_file_id`) REFERENCES `loot_files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claim_marker`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `dispatch_jobs_owner_idx` ON `dispatch_jobs` (`owner_id`);--> statement-breakpoint
CREATE INDEX `dispatch_jobs_status_idx` ON `dispatch_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `dispatch_jobs_claim_marker_idx` ON `dispatch_jobs` (`claim_marker`);--> statement-breakpoint
CREATE INDEX `dispatch_jobs_loot_idx` ON `dispatch_jobs` (`loot_id`);--> statement-breakpoint
CREATE INDEX `dispatch_jobs_target_idx` ON `dispatch_jobs` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `dispatch_status_events` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_job_id` text NOT NULL,
	`event_kind` text NOT NULL,
	`event_data` text NOT NULL,
	`source_protocol` text NOT NULL,
	`occurred_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ingested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`dispatch_job_id`) REFERENCES `dispatch_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dispatch_status_events_job` ON `dispatch_status_events` (`dispatch_job_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_dispatch_status_events_kind` ON `dispatch_status_events` (`event_kind`);--> statement-breakpoint
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
CREATE INDEX `idx_dispatch_warnings_job` ON `dispatch_warnings` (`dispatch_job_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `forge_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_job_id` text NOT NULL,
	`kind` text NOT NULL,
	`storage_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`mime_type` text,
	`metadata_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`dispatch_job_id`) REFERENCES `dispatch_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `forge_artifacts_dispatch_idx` ON `forge_artifacts` (`dispatch_job_id`);--> statement-breakpoint
CREATE INDEX `forge_artifacts_kind_idx` ON `forge_artifacts` (`kind`);--> statement-breakpoint
CREATE TABLE `forge_inboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`default_printer_id` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_forge_inboxes_owner` ON `forge_inboxes` (`owner_id`,`active`);--> statement-breakpoint
CREATE TABLE `forge_pending_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`slice_loot_id` text NOT NULL,
	`source_filename_hint` text,
	`ingested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer,
	`resolved_to_loot_id` text,
	FOREIGN KEY (`slice_loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_to_loot_id`) REFERENCES `loot`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pending_pairings_slice` ON `forge_pending_pairings` (`slice_loot_id`) WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE TABLE `forge_slicer_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`slicer_kind` text NOT NULL,
	`installed_version` text,
	`binary_path` text,
	`install_root` text,
	`install_status` text NOT NULL,
	`last_update_check_at` integer,
	`available_version` text,
	`update_available` integer DEFAULT false NOT NULL,
	`installed_at` integer,
	`sha256` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_slicer_installs_slicer_kind_unique` ON `forge_slicer_installs` (`slicer_kind`);--> statement-breakpoint
CREATE TABLE `forge_slicer_profile_materializations` (
	`id` text PRIMARY KEY NOT NULL,
	`slicer_profile_id` text NOT NULL,
	`slicer_kind` text NOT NULL,
	`config_path` text NOT NULL,
	`source_profile_hash` text NOT NULL,
	`sync_required` integer DEFAULT false NOT NULL,
	`materialized_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`slicer_profile_id`) REFERENCES `slicer_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `forge_profile_mat_profile_idx` ON `forge_slicer_profile_materializations` (`slicer_profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `forge_profile_mat_unique` ON `forge_slicer_profile_materializations` (`slicer_profile_id`,`slicer_kind`);--> statement-breakpoint
CREATE TABLE `forge_slicers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`device_id` text,
	`invocation_method` text NOT NULL,
	`name` text NOT NULL,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `forge_slicers_owner_idx` ON `forge_slicers` (`owner_id`);--> statement-breakpoint
CREATE INDEX `forge_slicers_kind_idx` ON `forge_slicers` (`kind`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `forge_target_credentials_printer_id_unique` ON `forge_target_credentials` (`printer_id`);--> statement-breakpoint
CREATE TABLE `printer_acls` (
	`id` text PRIMARY KEY NOT NULL,
	`printer_id` text NOT NULL,
	`user_id` text NOT NULL,
	`level` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `printer_acls_printer_user_idx` ON `printer_acls` (`printer_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `printer_acls_user_idx` ON `printer_acls` (`user_id`);--> statement-breakpoint
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
CREATE TABLE `printer_reachable_via` (
	`printer_id` text NOT NULL,
	`agent_id` text NOT NULL,
	FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `printer_reachable_via_pk` ON `printer_reachable_via` (`printer_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `printer_reachable_via_agent_idx` ON `printer_reachable_via` (`agent_id`);--> statement-breakpoint
CREATE TABLE `printers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`connection_config` text NOT NULL,
	`status_last_seen` integer,
	`active` integer DEFAULT true NOT NULL,
	`idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `printers_owner_idx` ON `printers` (`owner_id`);--> statement-breakpoint
CREATE INDEX `printers_owner_active_idx` ON `printers` (`owner_id`,`active`);--> statement-breakpoint
CREATE INDEX `printers_kind_idx` ON `printers` (`kind`);--> statement-breakpoint
CREATE TABLE `slicer_acls` (
	`id` text PRIMARY KEY NOT NULL,
	`slicer_id` text NOT NULL,
	`user_id` text NOT NULL,
	`level` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`slicer_id`) REFERENCES `forge_slicers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `slicer_acls_slicer_user_idx` ON `slicer_acls` (`slicer_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `slicer_acls_user_idx` ON `slicer_acls` (`user_id`);--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS loot_fts USING fts5(loot_id UNINDEXED, title, creator, description, tags, formats, tokenize='porter unicode61');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `filament_products_primary_color_idx` ON `filament_products` (json_extract(`colors`, '$[0]'));
