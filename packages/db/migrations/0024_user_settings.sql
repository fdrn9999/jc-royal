-- Members' account settings (apps/api/src/lib/settings.ts): table look and aids and favourite tables, the same on every
-- device. Values are JSON with when each was changed and the revision that changed it; an administrator can reset them
-- (never edit them) and undo the reset until the member changes something (prev). No foreign key: the API writes a row
-- only for an account that is not withdrawn, and withdrawal (POST /api/auth/me/delete) deletes it. Read by primary key.
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`prefs` text DEFAULT '{}' NOT NULL,
	`fav` text DEFAULT '{}' NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`synced_at` integer,
	`reset_at` integer,
	`reset_by` text,
	`reset_rev` integer,
	`prev` text,
	`restored_at` integer
);
