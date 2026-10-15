CREATE TABLE `report_events` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`from_value` text,
	`to_value` text,
	`body` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `report_events_report_idx` ON `report_events` (`report_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `reports` ADD `severity` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `assignee_id` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `assigned_at` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `notice_reporter` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `notice_target` integer;--> statement-breakpoint
CREATE INDEX `reports_assignee_idx` ON `reports` (`assignee_id`,`status`);--> statement-breakpoint
CREATE INDEX `reports_created_idx` ON `reports` (`created_at`);--> statement-breakpoint
CREATE INDEX `users_staff_idx` ON `users` (`role`,`status`) WHERE role != 'user';