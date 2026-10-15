-- Daily operations statistics (packages/db/src/stats.ts). WITHOUT ROWID: the primary key is the table itself, so a
-- marker or a counter writes one row and no separate index.
CREATE TABLE `active_days` (
	`day` integer NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`day`, `user_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `daily_stats` (
	`day` integer NOT NULL,
	`metric` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `metric`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `tsess_closed_idx` ON `table_sessions` (`closed_at`) WHERE closed_at IS NOT NULL;
