ALTER TABLE `users` ADD `vip_color` text;--> statement-breakpoint
ALTER TABLE `users` ADD `vip_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `vip_changed_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `vip_changed_by` text;--> statement-breakpoint
CREATE INDEX `users_vip_idx` ON `users` (`status`) WHERE vip_color IS NOT NULL;