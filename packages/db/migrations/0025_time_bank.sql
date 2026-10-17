-- Time bank policy (packages/types/src/timebank.ts): one row per version, never changed, the newest in force. Rooms read
-- it with their table and apply it from their next hand; members' banks are kept by the rooms, not here. Nothing else
-- changes: rooms of an older game-worker never read it. Seed: on at official tables and member rooms, 30 s to start,
-- at most 60 s, 10 s per use, 5 s back every 10 hands.
CREATE TABLE `time_bank_policies` (
	`version` integer PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`member_rooms` integer NOT NULL,
	`initial_ms` integer NOT NULL,
	`max_ms` integer NOT NULL,
	`unit_ms` integer NOT NULL,
	`refill_hands` integer NOT NULL,
	`refill_ms` integer NOT NULL,
	`change` text NOT NULL,
	`actor_id` text,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `time_bank_policies` (`version`, `enabled`, `member_rooms`, `initial_ms`, `max_ms`, `unit_ms`, `refill_hands`, `refill_ms`, `change`) VALUES (1, 1, 1, 30000, 60000, 10000, 10, 5000, 'seed');
