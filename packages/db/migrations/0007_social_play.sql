ALTER TABLE `direct_messages` ADD `kind` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `direct_messages` ADD `table_id` text REFERENCES tables(id);--> statement-breakpoint
ALTER TABLE `tables` ADD `room_type` text DEFAULT 'official' NOT NULL;--> statement-breakpoint
CREATE INDEX `tables_status_idx` ON `tables` (`status`);--> statement-breakpoint
CREATE INDEX `tables_creator_idx` ON `tables` (`created_by`,`status`);