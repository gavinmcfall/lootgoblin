CREATE TABLE `courier_pair_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`consumed_at` integer NOT NULL,
	`agent_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `courier_pair_nonces_agent_idx` ON `courier_pair_nonces` (`agent_id`);--> statement-breakpoint
ALTER TABLE `printer_reachable_via` ADD `reachable_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `printer_reachable_via` ADD `last_checked_at` integer;--> statement-breakpoint
ALTER TABLE `printer_reachable_via` ADD `detail` text;