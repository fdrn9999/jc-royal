CREATE TABLE `ops_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`table_id` text,
	`summary` text NOT NULL,
	`detail` text,
	`first_seen_at` integer NOT NULL,
	`confirmed_at` integer,
	`last_seen_at` integer NOT NULL,
	`seen` integer DEFAULT 1 NOT NULL,
	`resolved_at` integer,
	`handling` text DEFAULT 'new' NOT NULL,
	`handled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ops_alerts_open_uq` ON `ops_alerts` (`dedupe_key`) WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX `ops_alerts_resolved_idx` ON `ops_alerts` (`resolved_at`);--> statement-breakpoint
CREATE INDEX `ops_alerts_table_idx` ON `ops_alerts` (`table_id`,`first_seen_at`);--> statement-breakpoint
CREATE INDEX `ops_alerts_seen_idx` ON `ops_alerts` (`first_seen_at`);--> statement-breakpoint
CREATE TABLE `ops_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`table_id` text,
	`summary` text NOT NULL,
	`alert_id` text,
	`correlation_id` text
);
--> statement-breakpoint
CREATE INDEX `ops_events_at_idx` ON `ops_events` (`at`);--> statement-breakpoint
CREATE INDEX `ops_events_table_idx` ON `ops_events` (`table_id`,`at`);--> statement-breakpoint
CREATE INDEX `ops_events_alert_idx` ON `ops_events` (`alert_id`);--> statement-breakpoint
CREATE TABLE `ops_watch` (
	`id` integer PRIMARY KEY NOT NULL,
	`checked_at` integer NOT NULL,
	`took_ms` integer NOT NULL,
	`rooms` integer NOT NULL,
	`unanswered` integer NOT NULL,
	`skipped` integer NOT NULL
);
