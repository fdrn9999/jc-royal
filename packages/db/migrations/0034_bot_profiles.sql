CREATE TABLE `bot_profiles` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`level` text,
	`style` text,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tables` ADD `bot_style` text DEFAULT 'auto' NOT NULL;