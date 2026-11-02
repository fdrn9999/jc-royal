ALTER TABLE `users` ADD `show_achievements` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `show_stats` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `share_table` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `show_ranking` integer DEFAULT true NOT NULL;
--> statement-breakpoint
-- Achievements already earned (docs/SOCIAL.md "업적"), from the hands and tournaments recorded before this, at the time they happened.
INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at) SELECT hp.user_id, 'play:first_hand', MIN(hp.ended_at) FROM hand_players hp JOIN users u ON u.id = hp.user_id AND u.is_bot = 0 GROUP BY hp.user_id;
--> statement-breakpoint
INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at) SELECT hp.user_id, 'play:first_win', MIN(hp.ended_at) FROM hand_players hp JOIN users u ON u.id = hp.user_id AND u.is_bot = 0 WHERE (hp.pot_won > 0 OR (hp.pot_won IS NULL AND hp.net > 0)) GROUP BY hp.user_id;
--> statement-breakpoint
INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at) SELECT hp.user_id, 'play:' || CASE hp.rank_class WHEN 'full-house' THEN 'full_house' WHEN 'four-of-a-kind' THEN 'quads' ELSE 'straight_flush' END, MIN(hp.ended_at) FROM hand_players hp JOIN users u ON u.id = hp.user_id AND u.is_bot = 0 WHERE hp.rank_class IN ('full-house', 'four-of-a-kind', 'straight-flush') AND (hp.shown = 1 OR (hp.shown IS NULL AND hp.went_to_showdown = 1)) GROUP BY hp.user_id, hp.rank_class;
--> statement-breakpoint
INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at) SELECT user_id, 'play:hands_100', ended_at FROM (
     SELECT hp.user_id, hp.ended_at, ROW_NUMBER() OVER (PARTITION BY hp.user_id ORDER BY hp.ended_at, hp.hand_id) AS n FROM hand_players hp JOIN users u ON u.id = hp.user_id AND u.is_bot = 0
   ) WHERE n = 100;
--> statement-breakpoint
INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at) SELECT t.winner_id, 'play:tournament_win', MIN(t.finished_at) FROM tournaments t JOIN users u ON u.id = t.winner_id AND u.is_bot = 0
    WHERE t.status = 'finished' AND t.finished_at IS NOT NULL GROUP BY t.winner_id;
