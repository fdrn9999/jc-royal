-- Social policy (packages/types/src/social.ts SocialSettings): one row per version, never changed, the newest in force.
-- Quick reactions (on, the gap between two from one player, at most so many in a window) and which staff roles carry
-- their badge next to their name. Rooms read it with their table; the api reads it when a reply would show a staff role.
-- Nothing else changes: an older game-worker or api never reads it and keeps the values seeded here, which are what the
-- service did before (reactions on, 2 s apart, at most 5 in 30 s, SUPER ADMIN and ADMIN badges shown).
CREATE TABLE `social_policies` (
	`version` integer PRIMARY KEY NOT NULL,
	`reactions_enabled` integer NOT NULL,
	`reaction_cooldown_ms` integer NOT NULL,
	`reaction_burst_max` integer NOT NULL,
	`reaction_burst_window_ms` integer NOT NULL,
	`show_super_admin` integer NOT NULL,
	`show_admin` integer NOT NULL,
	`change` text NOT NULL,
	`actor_id` text,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `social_policies` (`version`, `reactions_enabled`, `reaction_cooldown_ms`, `reaction_burst_max`, `reaction_burst_window_ms`, `show_super_admin`, `show_admin`, `change`) VALUES (1, 1, 2000, 5, 30000, 1, 1, 'seed');
