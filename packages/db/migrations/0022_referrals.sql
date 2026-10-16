-- Referral rewards (apps/api/src/lib/referral.ts): each member's code, one row per signup made with a code (both
-- sides' reward status and their chip_ledger rows), and policy versions (never changed; the newest applies).
-- chip_ledger.type is not constrained in SQL, so the new type 'referral' needs no change there. Version 1 is off and
-- pays nothing: the amounts are an operating decision made from the admin console, not by this migration. The caps,
-- hand condition and review threshold below are only starting values for that form.
CREATE TABLE `referral_codes` (
	`user_id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_codes_code_unique` ON `referral_codes` (`code`);--> statement-breakpoint
CREATE TABLE `referral_policies` (
	`version` integer PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`referrer_amount` integer NOT NULL,
	`invitee_amount` integer NOT NULL,
	`daily_cap` integer NOT NULL,
	`total_cap` integer NOT NULL,
	`min_hands` integer NOT NULL,
	`burst_limit` integer NOT NULL,
	`change` text NOT NULL,
	`actor_id` text,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `referrals` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`referrer_id` text NOT NULL,
	`invitee_id` text NOT NULL,
	`status` text NOT NULL,
	`referrer_status` text NOT NULL,
	`invitee_status` text NOT NULL,
	`policy_version` integer NOT NULL,
	`referrer_amount` integer NOT NULL,
	`invitee_amount` integer NOT NULL,
	`min_hands` integer NOT NULL,
	`referrer_ledger_id` text,
	`invitee_ledger_id` text,
	`referrer_paid_at` integer,
	`invitee_paid_at` integer,
	`email_hash` text NOT NULL,
	`ip_hash` text,
	`same_ip` integer DEFAULT false NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`failure_code` text,
	`reviewed_by` text,
	`review_reason` text,
	`reviewed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referrals_invitee_id_unique` ON `referrals` (`invitee_id`);--> statement-breakpoint
CREATE INDEX `referrals_referrer_idx` ON `referrals` (`referrer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `referrals_status_idx` ON `referrals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `referrals_email_idx` ON `referrals` (`email_hash`);
--> statement-breakpoint
INSERT INTO `referral_policies` (`version`, `enabled`, `paused`, `referrer_amount`, `invitee_amount`, `daily_cap`, `total_cap`, `min_hands`, `burst_limit`, `change`) VALUES (1, 0, 0, 0, 0, 5, 50, 1, 3, 'seed');