CREATE TABLE `notification_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`agreed` integer NOT NULL,
	`policy_version` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_consents_user_idx` ON `notification_consents` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`coalesce_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_dedupe_uq` ON `notification_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notification_events_due_idx` ON `notification_events` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `notification_events_user_idx` ON `notification_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`service` integer DEFAULT false NOT NULL,
	`night` integer DEFAULT false NOT NULL,
	`dm` integer DEFAULT true NOT NULL,
	`invite` integer DEFAULT true NOT NULL,
	`friend_request` integer DEFAULT true NOT NULL,
	`friend_accepted` integer DEFAULT true NOT NULL,
	`tournament_start` integer DEFAULT true NOT NULL,
	`tournament_cancel` integer DEFAULT true NOT NULL,
	`tournament_result` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`service_at` integer,
	`night_at` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`endpoint_hash` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_success_at` integer,
	`last_failure_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_uq` ON `push_subscriptions` (`endpoint_hash`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_session_idx` ON `push_subscriptions` (`session_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `presence_mode` text DEFAULT 'auto' NOT NULL;