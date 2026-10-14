CREATE TABLE `email_verifications` (
	`email` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`proof_hash` text,
	`verified_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `birth_date` text;--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `privacy_consent_version` text;--> statement-breakpoint
ALTER TABLE `users` ADD `privacy_consent_at` integer;