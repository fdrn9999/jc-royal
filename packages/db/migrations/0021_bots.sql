CREATE TABLE `bot_events` (
	`id` text PRIMARY KEY NOT NULL,
	`table_id` text NOT NULL,
	`bot_id` text,
	`kind` text NOT NULL,
	`code` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bot_events_created_idx` ON `bot_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `bot_events_table_idx` ON `bot_events` (`table_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_fund` (
	`id` integer PRIMARY KEY NOT NULL,
	`issued` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_policies` (
	`version` integer PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`fund_limit` integer NOT NULL,
	`max_bots` integer NOT NULL,
	`change` text NOT NULL,
	`actor_id` text,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `hands` ADD `bots` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `live_bots` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `bots_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `bot_level` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `bot_min_humans` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `bot_max` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `bot_fill_to` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `tables` ADD `bot_yield` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `is_bot` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `users_bot_idx` ON `users` (`status`) WHERE is_bot = 1;--> statement-breakpoint
INSERT INTO `bot_policies` (`version`, `enabled`, `fund_limit`, `max_bots`, `change`) VALUES (1, 0, 0, 0, 'seed');--> statement-breakpoint
INSERT INTO `bot_fund` (`id`, `issued`) VALUES (1, 0);
