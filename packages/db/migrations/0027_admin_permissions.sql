-- Per-administrator feature switches (apps/api/src/lib/permissions.ts GRANTS): a plain administrator may use a route only
-- when the role allows it AND its feature is on for the account; a missing row or feature is off. Super admins need no
-- row. Nothing else changes, and an older api never reads it.
-- Seed: administrators who already hold the role keep what they can do today (every feature on), so the deploy locks no
-- one out; a super admin narrows it from the console. Anyone made an administrator after this starts with nothing.
CREATE TABLE `admin_permissions` (
	`user_id` text PRIMARY KEY NOT NULL,
	`grants` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `admin_permissions` (`user_id`, `grants`, `version`, `updated_by`)
SELECT `id`, '["dashboard","members","sanctions","disconnect","reports","board","notices","messages","tables","tableControl","chips","ledger","economy","stats","referral","bots","tournaments","refill","hands","reconcile","settings","resetLinks","maintenance"]', 1, 'migration'
  FROM `users` WHERE `role` = 'admin';
