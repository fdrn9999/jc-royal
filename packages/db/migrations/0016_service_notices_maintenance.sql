CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`block_login` integer DEFAULT false NOT NULL,
	`message_ko` text,
	`message_en` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`ended_at` integer,
	`cancelled_at` integer
);
--> statement-breakpoint
CREATE INDEX `maintenance_windows_ends_idx` ON `maintenance_windows` (`ends_at`);--> statement-breakpoint
CREATE TABLE `service_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title_ko` text NOT NULL,
	`title_en` text NOT NULL,
	`body_ko` text,
	`body_en` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`post_id` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `service_notices_live_idx` ON `service_notices` (`deleted_at`,`starts_at`);