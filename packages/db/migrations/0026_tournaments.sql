-- 6-seat Sit & Go tournaments (docs/TOURNAMENT.md): templates (a super admin's structure), tournaments (a copy of the
-- template, its state and the progress its room writes back) and entries (status, seat, tournament chips, place).
-- Tournament chips never touch wallets, the chip ledger or table sessions. tables.room_type gains the value
-- 'tournament' (no CHECK constraint: no table change). Nothing else changes, and an older api or game-worker never reads
-- these tables. Seed: one active template, 6 seats, 1,500 chips, 13 levels of 5 minutes, 20 s turns, the time bank as
-- the time_bank_policies seed, starting by itself when full.
CREATE TABLE `tournament_entries` (
	`tournament_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`seat_index` integer,
	`stack` integer,
	`place` integer,
	`registered_at` integer NOT NULL,
	`eliminated_at` integer,
	`eliminated_hand` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`tournament_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `tournament_entries_user_idx` ON `tournament_entries` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `tournament_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`capacity` integer NOT NULL,
	`min_players` integer NOT NULL,
	`start_stack` integer NOT NULL,
	`levels` text NOT NULL,
	`level_ms` integer NOT NULL,
	`turn_seconds` integer NOT NULL,
	`tb_enabled` integer NOT NULL,
	`tb_initial_ms` integer NOT NULL,
	`tb_max_ms` integer NOT NULL,
	`tb_unit_ms` integer NOT NULL,
	`tb_refill_hands` integer NOT NULL,
	`tb_refill_ms` integer NOT NULL,
	`min_hands` integer DEFAULT 0 NOT NULL,
	`require_verified` integer DEFAULT false NOT NULL,
	`auto_start` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tournament_templates_status_idx` ON `tournament_templates` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `tournaments` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`capacity` integer NOT NULL,
	`min_players` integer NOT NULL,
	`start_stack` integer NOT NULL,
	`levels` text NOT NULL,
	`level_ms` integer NOT NULL,
	`turn_seconds` integer NOT NULL,
	`tb_enabled` integer NOT NULL,
	`tb_initial_ms` integer NOT NULL,
	`tb_max_ms` integer NOT NULL,
	`tb_unit_ms` integer NOT NULL,
	`tb_refill_hands` integer NOT NULL,
	`tb_refill_ms` integer NOT NULL,
	`min_hands` integer NOT NULL,
	`require_verified` integer NOT NULL,
	`auto_start` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`roster` integer DEFAULT 0 NOT NULL,
	`table_id` text,
	`level` integer DEFAULT 0 NOT NULL,
	`level_ends_at` integer,
	`level_left_ms` integer,
	`pause_requested` integer DEFAULT false NOT NULL,
	`pause_changed_at` integer,
	`paused_at` integer,
	`players_left` integer,
	`hands` integer DEFAULT 0 NOT NULL,
	`room_seen_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`cancelled_at` integer,
	`aborted_at` integer,
	`winner_id` text,
	`end_reason` text,
	`end_note` text,
	`ended_by` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tournaments_status_idx` ON `tournaments` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `tournaments_table_idx` ON `tournaments` (`table_id`);
--> statement-breakpoint
INSERT INTO `tournament_templates` (`id`, `name`, `capacity`, `min_players`, `start_stack`, `levels`, `level_ms`, `turn_seconds`, `tb_enabled`, `tb_initial_ms`, `tb_max_ms`, `tb_unit_ms`, `tb_refill_hands`, `tb_refill_ms`, `min_hands`, `require_verified`, `auto_start`) VALUES ('sng-6-default', '6-max SNG', 6, 2, 1500, '[{"sb":10,"bb":20},{"sb":15,"bb":30},{"sb":25,"bb":50},{"sb":50,"bb":100},{"sb":75,"bb":150},{"sb":100,"bb":200},{"sb":150,"bb":300},{"sb":200,"bb":400},{"sb":300,"bb":600},{"sb":400,"bb":800},{"sb":500,"bb":1000},{"sb":750,"bb":1500},{"sb":1000,"bb":2000}]', 300000, 20, 1, 30000, 60000, 10000, 10, 5000, 0, 0, 1);