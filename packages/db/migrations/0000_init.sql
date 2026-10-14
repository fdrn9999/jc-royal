CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail` text,
	`ip` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `admin_audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `admin_recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recovery_user_idx` ON `admin_recovery_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `chip_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`table_id` text,
	`ref_id` text,
	`idempotency_key` text NOT NULL,
	`actor_id` text,
	`memo` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_idem_uq` ON `chip_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `ledger_user_idx` ON `chip_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `hand_players` (
	`hand_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seat_index` integer NOT NULL,
	`hole_cards` text NOT NULL,
	`stack_start` integer NOT NULL,
	`stack_end` integer NOT NULL,
	`net` integer NOT NULL,
	`won` integer NOT NULL,
	`rank_class` text,
	`rank_value` integer,
	`best_five` text,
	`went_to_showdown` integer NOT NULL,
	`ended_at` integer NOT NULL,
	PRIMARY KEY(`hand_id`, `user_id`),
	FOREIGN KEY (`hand_id`) REFERENCES `hands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hp_user_idx` ON `hand_players` (`user_id`,`ended_at`);--> statement-breakpoint
CREATE TABLE `hands` (
	`id` text PRIMARY KEY NOT NULL,
	`table_id` text NOT NULL,
	`hand_number` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`board` text NOT NULL,
	`pot_total` integer NOT NULL,
	`engine_version` text NOT NULL,
	`event_log` text NOT NULL,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hands_table_idx` ON `hands` (`table_id`,`ended_at`);--> statement-breakpoint
CREATE TABLE `password_resets` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reconciliation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject_id` text NOT NULL,
	`expected` integer NOT NULL,
	`actual` integer NOT NULL,
	`detail` text,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`mfa_verified_at` integer,
	`reauth_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `table_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`table_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seat_index` integer NOT NULL,
	`buy_in` integer NOT NULL,
	`cash_out` integer,
	`status` text DEFAULT 'seated' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tsess_open_user_uq` ON `table_sessions` (`table_id`,`user_id`) WHERE status = 'seated';--> statement-breakpoint
CREATE INDEX `tsess_user_idx` ON `table_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `tables` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`max_seats` integer NOT NULL,
	`small_blind` integer NOT NULL,
	`big_blind` integer NOT NULL,
	`min_buy_in` integer NOT NULL,
	`max_buy_in` integer NOT NULL,
	`turn_seconds` integer DEFAULT 20 NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`join_code_hash` text,
	`allow_spectators` integer DEFAULT true NOT NULL,
	`entry_blocked` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`live_seated` integer DEFAULT 0 NOT NULL,
	`live_playing` integer DEFAULT false NOT NULL,
	`live_waitlist` integer DEFAULT 0 NOT NULL,
	`live_spectators` integer DEFAULT 0 NOT NULL,
	`live_connections` integer DEFAULT 0 NOT NULL,
	`hands_played` integer DEFAULT 0 NOT NULL,
	`last_issue` text,
	`live_updated_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`nickname` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`avatar_url` text,
	`locale` text DEFAULT 'ko' NOT NULL,
	`suspended_reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_nickname_uq` ON `users` (lower("nickname"));--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`purpose` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webauthn_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`nickname` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webauthn_user_idx` ON `webauthn_credentials` (`user_id`);