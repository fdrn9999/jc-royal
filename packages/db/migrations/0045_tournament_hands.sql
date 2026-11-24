ALTER TABLE `hand_players` ADD `tournament_id` text;--> statement-breakpoint
ALTER TABLE `hands` ADD `tournament_id` text;--> statement-breakpoint
ALTER TABLE `hands` ADD `tournament` text;--> statement-breakpoint
ALTER TABLE `tournaments` ADD `record_hands` integer DEFAULT false NOT NULL;