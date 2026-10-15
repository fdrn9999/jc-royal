/**
 * Fills the statistics columns of hand_players from each hand's public action log (hands.event_log.actions, written
 * by the game worker) for every hand that still has rows where pot_won IS NULL. It is idempotent: the game worker
 * runs it after recording a hand (which also picks up rows written by an older worker), and migration 0010 ran the
 * same statement (see below) once for the hands recorded before it. Actions are matched to players by seat index.
 *
 * - position: by seat order from the small blind among the players dealt in. Heads-up the button posts the small
 *   blind and is BTN. Otherwise SB, BB, then the seats before CO (the second to last) and BTN (the last): the first
 *   half (rounded up) EP, the rest MP.
 * - vpip: put chips in preflop by choice (call, raise, bet, all-in); posting a blind is not.
 * - pfr: a preflop action that took the player's total above everyone's before it (a raise, or an all-in over the
 *   highest bet).
 * - saw_flop: the board reached the flop and the player hadn't folded preflop.
 * - pot_won: won, minus the uncalled chips handed back to the player who put in the most (that player's amount above
 *   the second largest).
 * vpip, pfr, saw_flop and position stay NULL when the log can't be read; pot_won is always set.
 *
 * It runs after every hand, so it reads only the hands still to do: `todo CROSS JOIN hands` and `todo CROSS JOIN
 * hand_players` make SQLite start from todo (CROSS JOIN fixes the join order) and look hands and players up by id, and
 * the UPDATE is narrowed to todo's hands. Without these, a run could pass over every recorded hand and player row
 * (measured on local D1 for one pending 4-player hand: 1,035 rows read with 200 player rows and 8,235 with 2,000,
 * against 255 for either now). Migration 0010 has the older text; the result is the same.
 */
export const HAND_STATS_SQL = `WITH todo AS (
  SELECT DISTINCT hand_id FROM hand_players WHERE pot_won IS NULL
), logs AS (
  SELECT h.id AS hand_id, h.board,
         CASE WHEN json_valid(h.event_log) THEN CASE WHEN json_type(h.event_log, '$.actions') = 'array' THEN h.event_log END END AS log
  FROM todo CROSS JOIN hands h ON h.id = todo.hand_id
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
  FROM todo CROSS JOIN hand_players p ON p.hand_id = todo.hand_id
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
FROM src WHERE hand_players.hand_id = src.hand_id AND hand_players.user_id = src.user_id AND hand_players.hand_id IN (SELECT hand_id FROM todo)`;
