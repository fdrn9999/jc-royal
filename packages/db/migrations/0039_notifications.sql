CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`actor_id` text,
	`ref` text,
	`params` text,
	`count` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`read_at` integer,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_key_uq` ON `notifications` (`user_id`,`key`);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `notifications_expires_idx` ON `notifications` (`expires_at`);