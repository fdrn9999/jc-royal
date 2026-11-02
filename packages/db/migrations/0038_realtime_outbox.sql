CREATE TABLE `realtime_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`recipients` text,
	`event` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer,
	`expires_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`done_at` integer
);
--> statement-breakpoint
CREATE INDEX `realtime_outbox_due_idx` ON `realtime_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `realtime_outbox_done_idx` ON `realtime_outbox` (`done_at`);