ALTER TABLE `tables` ADD `tournament_id` text;--> statement-breakpoint
CREATE INDEX `tables_tournament_idx` ON `tables` (`tournament_id`) WHERE tournament_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `tournament_entries` ADD `table_id` text;--> statement-breakpoint
ALTER TABLE `tournament_templates` ADD `format` text DEFAULT 'sng' NOT NULL;--> statement-breakpoint
ALTER TABLE `tournament_templates` ADD `table_seats` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tournaments` ADD `format` text DEFAULT 'sng' NOT NULL;--> statement-breakpoint
ALTER TABLE `tournaments` ADD `table_seats` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tournaments` ADD `tables_left` integer;--> statement-breakpoint
ALTER TABLE `tournaments` ADD `is_private` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tournaments` ADD `host_id` text;--> statement-breakpoint
ALTER TABLE `tournaments` ADD `join_code_hash` text;--> statement-breakpoint
CREATE INDEX `tournaments_host_idx` ON `tournaments` (`host_id`,`status`) WHERE host_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tournaments_code_idx` ON `tournaments` (`join_code_hash`) WHERE join_code_hash IS NOT NULL;