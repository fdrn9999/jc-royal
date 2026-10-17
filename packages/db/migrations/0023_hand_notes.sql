-- Members' own hand bookmarks, tags and memos (apps/api/src/lib/handNotes.ts). Owner-only: the API checks that the member
-- was dealt into the hand (hand_players) before reading or writing, so there is no foreign key here. ended_at is copied
-- from hand_players so lists filtered by bookmark or tag read in order from this table alone. Rows are removed only when
-- the member withdraws (POST /api/auth/me/delete); an emptied row stays so the memo revision keeps counting up.
CREATE TABLE `hand_notes` (
	`user_id` text NOT NULL,
	`hand_id` text NOT NULL,
	`ended_at` integer NOT NULL,
	`bookmarked` integer DEFAULT false NOT NULL,
	`tags` integer DEFAULT 0 NOT NULL,
	`memo` text,
	`rev` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `hand_id`)
);
--> statement-breakpoint
CREATE INDEX `hand_notes_user_idx` ON `hand_notes` (`user_id`,`ended_at`);