/**
 * Achievements (ACHIEVEMENTS in @jc/types): rows of user_badges with `play:` codes, given by the server from what it
 * recorded and never from anything a client says. Decorative only: nothing here touches chips or the ledger. Each
 * statement is INSERT OR IGNORE on the (user, code) key, so running it again, or for a hand recorded twice, changes
 * nothing, and the time kept is when it happened (the hand's or tournament's end). Table bots never get one.
 *
 * - After each recorded hand (apps/game-worker/src/settlement.ts, best-effort like the hand statistics): the hand's
 *   members only, from their row of that hand. A made hand counts only when it was face up for the table (shown, or a
 *   showdown recorded before mucking existed): a mucked hand stays private.
 * - After a tournament's finish (apps/game-worker/src/tournament.ts): its winner.
 * - Daily (apps/api/src/lib/housekeeping.ts, before old active days are deleted): seven days in a row of use.
 * - Migration 0042 gave the same for the hands and tournaments recorded before.
 *
 * The statements live here, apart from achievements.ts, so the tests can run them on the real migrations.
 */

const INSERT = 'INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at)';
const MEMBER = 'JOIN users u ON u.id = hp.user_id AND u.is_bot = 0';

/** The hand's row was face up for the table. */
const FACE_UP = '(hp.shown = 1 OR (hp.shown IS NULL AND hp.went_to_showdown = 1))';

/** A pot won: chips from the pot (pot_won), or before that was counted, a hand that ended ahead. */
const WON = '(hp.pot_won > 0 OR (hp.pot_won IS NULL AND hp.net > 0))';

/** The code a made hand gives, by the engine's rank class. */
const MADE_CODE = `'play:' || CASE hp.rank_class WHEN 'full-house' THEN 'full_house' WHEN 'four-of-a-kind' THEN 'quads' ELSE 'straight_flush' END`;
const MADE = `hp.rank_class IN ('full-house', 'four-of-a-kind', 'straight-flush') AND ${FACE_UP}`;

/** For one recorded hand, each bound to the hand's id (`?1`): first hand, first pot won, a full house or better face up, 100 hands. */
export const ACHIEVEMENT_HAND_SQL: readonly string[] = [
  `${INSERT} SELECT hp.user_id, 'play:first_hand', hp.ended_at FROM hand_players hp ${MEMBER} WHERE hp.hand_id = ?1`,
  `${INSERT} SELECT hp.user_id, 'play:first_win', hp.ended_at FROM hand_players hp ${MEMBER} WHERE hp.hand_id = ?1 AND ${WON}`,
  `${INSERT} SELECT hp.user_id, ${MADE_CODE}, hp.ended_at FROM hand_players hp ${MEMBER} WHERE hp.hand_id = ?1 AND ${MADE}`,
  // Counted only until it is there, and never more than 100 rows a member.
  `${INSERT} SELECT hp.user_id, 'play:hands_100', hp.ended_at FROM hand_players hp ${MEMBER}
    WHERE hp.hand_id = ?1 AND NOT EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = hp.user_id AND b.badge = 'play:hands_100')
      AND (SELECT COUNT(*) FROM (SELECT 1 FROM hand_players x WHERE x.user_id = hp.user_id LIMIT 100)) >= 100`,
];

/** The winner of a finished tournament (`?1`); not of a private one, which is no official record (docs/TOURNAMENT.md "비공개 대회"). */
export const ACHIEVEMENT_TOURNAMENT_SQL = `${INSERT}
  SELECT t.winner_id, 'play:tournament_win', t.finished_at FROM tournaments t JOIN users u ON u.id = t.winner_id AND u.is_bot = 0
   WHERE t.id = ?1 AND t.status = 'finished' AND t.finished_at IS NOT NULL AND t.is_private = 0`;

/**
 * Seven days in a row of use (active_days, Korean days), for every member, from the first such run still kept: given
 * at the start of its seventh day. `?1`, `?2`: stats.ts's day length and time zone offset. The six days after each day
 * are looked up one by one on the (day, user_id) key: a range of days there would read every member of those days for
 * each row (2,000 members a day for 60 days took a minute in SQLite, this a quarter of a second).
 */
export const ACHIEVEMENT_STREAK_SQL = `${INSERT}
  SELECT a.user_id, 'play:streak_7', (MIN(a.day) + 6) * ?1 - ?2 FROM active_days a JOIN users u ON u.id = a.user_id AND u.is_bot = 0
   WHERE NOT EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = a.user_id AND b.badge = 'play:streak_7')
     AND (SELECT COUNT(*) FROM active_days d WHERE d.user_id = a.user_id AND d.day IN (a.day + 1, a.day + 2, a.day + 3, a.day + 4, a.day + 5, a.day + 6)) = 6
   GROUP BY a.user_id`;

/** Migration 0042: the same for every hand and tournament recorded before (the first time each happened). */
export const ACHIEVEMENT_BACKFILL_SQL: readonly string[] = [
  `${INSERT} SELECT hp.user_id, 'play:first_hand', MIN(hp.ended_at) FROM hand_players hp ${MEMBER} GROUP BY hp.user_id`,
  `${INSERT} SELECT hp.user_id, 'play:first_win', MIN(hp.ended_at) FROM hand_players hp ${MEMBER} WHERE ${WON} GROUP BY hp.user_id`,
  `${INSERT} SELECT hp.user_id, ${MADE_CODE}, MIN(hp.ended_at) FROM hand_players hp ${MEMBER} WHERE ${MADE} GROUP BY hp.user_id, hp.rank_class`,
  `${INSERT} SELECT user_id, 'play:hands_100', ended_at FROM (
     SELECT hp.user_id, hp.ended_at, ROW_NUMBER() OVER (PARTITION BY hp.user_id ORDER BY hp.ended_at, hp.hand_id) AS n FROM hand_players hp ${MEMBER}
   ) WHERE n = 100`,
  `${INSERT} SELECT t.winner_id, 'play:tournament_win', MIN(t.finished_at) FROM tournaments t JOIN users u ON u.id = t.winner_id AND u.is_bot = 0
    WHERE t.status = 'finished' AND t.finished_at IS NOT NULL GROUP BY t.winner_id`,
];
