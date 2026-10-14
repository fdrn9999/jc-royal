ALTER TABLE `hand_players` ADD `position` text;--> statement-breakpoint
ALTER TABLE `hand_players` ADD `vpip` integer;--> statement-breakpoint
ALTER TABLE `hand_players` ADD `pfr` integer;--> statement-breakpoint
ALTER TABLE `hand_players` ADD `saw_flop` integer;--> statement-breakpoint
ALTER TABLE `hand_players` ADD `pot_won` integer;--> statement-breakpoint
CREATE INDEX `hp_stats_todo_idx` ON `hand_players` (`hand_id`) WHERE pot_won IS NULL;--> statement-breakpoint
-- Fill the new columns for the hands recorded so far (the same statement the game worker runs after each hand).
WITH todo AS (
  SELECT DISTINCT hand_id FROM hand_players WHERE pot_won IS NULL
), logs AS (
  SELECT h.id AS hand_id, h.board,
         CASE WHEN json_valid(h.event_log) THEN CASE WHEN json_type(h.event_log, '$.actions') = 'array' THEN h.event_log END END AS log
  FROM hands h JOIN todo ON todo.hand_id = h.id
), acts AS (
  SELECT l.hand_id, a.key AS k, json_extract(a.value, '$.seatIndex') AS seat, json_extract(a.value, '$.type') AS type,
         json_extract(a.value, '$.amount') AS amount
  FROM logs l, json_each(l.log, '$.actions') a
  WHERE l.log IS NOT NULL AND json_extract(a.value, '$.stage') = 'preflop'
), run AS (
  SELECT hand_id, k, seat, type, amount, SUM(amount) OVER (PARTITION BY hand_id, seat ORDER BY k) AS total FROM acts
), seen AS (
  SELECT hand_id, seat, type, amount, total,
         COALESCE(MAX(total) OVER (PARTITION BY hand_id ORDER BY k ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
  FROM run
), flags AS (
  SELECT hand_id, seat,
         MAX(type NOT IN ('post-sb', 'post-bb') AND amount > 0) AS vpip,
         MAX(type NOT IN ('post-sb', 'post-bb') AND total > before) AS pfr,
         MAX(type IN ('fold', 'timeout-fold')) AS folded,
         MAX(type = 'post-sb') AS sb
  FROM seen GROUP BY hand_id, seat
), hp AS (
  SELECT p.hand_id, p.user_id, p.seat_index AS seat, p.won, p.won - p.net AS put, l.log IS NOT NULL AS ok, l.board,
         f.vpip, f.pfr, f.folded, MAX(CASE WHEN f.sb THEN p.seat_index END) OVER (PARTITION BY p.hand_id) AS sb_seat
  FROM hand_players p JOIN todo ON todo.hand_id = p.hand_id
  LEFT JOIN logs l ON l.hand_id = p.hand_id
  LEFT JOIN flags f ON f.hand_id = p.hand_id AND f.seat = p.seat_index
), ranked AS (
  SELECT hand_id, user_id, won, put, ok, board, vpip, pfr, folded, sb_seat,
         COUNT(*) OVER (PARTITION BY hand_id) AS n,
         ROW_NUMBER() OVER (PARTITION BY hand_id ORDER BY seat < sb_seat, seat) - 1 AS from_sb,
         ROW_NUMBER() OVER (PARTITION BY hand_id ORDER BY put DESC, user_id) AS rk,
         LEAD(put, 1, 0) OVER (PARTITION BY hand_id ORDER BY put DESC, user_id) AS next_put
  FROM hp
), src AS (
  SELECT hand_id, user_id,
         CASE WHEN sb_seat IS NULL THEN NULL
              WHEN n = 2 THEN CASE WHEN from_sb = 0 THEN 'BTN' ELSE 'BB' END
              WHEN from_sb = 0 THEN 'SB'
              WHEN from_sb = 1 THEN 'BB'
              WHEN from_sb = n - 1 THEN 'BTN'
              WHEN from_sb = n - 2 THEN 'CO'
              WHEN (from_sb - 2) * 2 < n - 4 THEN 'EP'
              ELSE 'MP' END AS position,
         CASE WHEN ok THEN COALESCE(vpip, 0) END AS vpip,
         CASE WHEN ok THEN COALESCE(pfr, 0) END AS pfr,
         CASE WHEN ok AND json_valid(board) THEN json_array_length(board) >= 3 AND NOT COALESCE(folded, 0) END AS saw_flop,
         MAX(0, won - CASE WHEN rk = 1 THEN put - next_put ELSE 0 END) AS pot_won
  FROM ranked
)
UPDATE hand_players SET position = src.position, vpip = src.vpip, pfr = src.pfr, saw_flop = src.saw_flop, pot_won = src.pot_won
FROM src WHERE hand_players.hand_id = src.hand_id AND hand_players.user_id = src.user_id;
