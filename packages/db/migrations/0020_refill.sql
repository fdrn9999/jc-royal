-- Free chip refill (apps/api/src/lib/refill.ts): policy versions (never changed; the newest applies) and the refills
-- paid (one per chip_ledger row of type free_refill, never changed). chip_ledger.type is not constrained in SQL, so
-- the new type needs no change there. Version 1 is the starting policy, changed later from the admin console: below
-- 1,000 chips in total (wallet + tables), 2,000 chips, once every 6 hours.
CREATE TABLE `refill_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`policy_version` integer NOT NULL,
	`amount` integer NOT NULL,
	`wallet` integer NOT NULL,
	`table_chips` integer NOT NULL,
	`next_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refill_claims_user_seq_uq` ON `refill_claims` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `refill_claims_created_idx` ON `refill_claims` (`created_at`);--> statement-breakpoint
CREATE TABLE `refill_policies` (
	`version` integer PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`below` integer NOT NULL,
	`amount` integer NOT NULL,
	`cooldown_ms` integer NOT NULL,
	`change` text NOT NULL,
	`actor_id` text,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `refill_policies` (`version`, `enabled`, `paused`, `below`, `amount`, `cooldown_ms`, `change`) VALUES (1, 1, 0, 1000, 2000, 21600000, 'seed');
