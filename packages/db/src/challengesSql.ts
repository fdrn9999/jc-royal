/**
 * Challenges (CHALLENGES in @jc/types, docs/CHALLENGES.md): rows of challenge_completions, given by the server from what
 * it recorded and never from anything a client says. A progress figure only: nothing here touches chips or the ledger.
 * Each completion is INSERT OR IGNORE on the (member, code, period) key, so running it again, or for a hand recorded
 * twice, changes nothing, and the time kept is that of the event that reached the target. Table bots never get one.
 *
 * - After each recorded hand (apps/game-worker/src/settlement.ts, best-effort like the achievements): the hand's
 *   members, for the day and week the hand ended in.
 * - When a member opens their challenges (GET /api/me/challenges): that member, for this day and week, in case a hand's
 *   statements failed or a tournament started without a hand yet.
 *
 * Periods are Korean days (stats.ts) and weeks from Monday; the caller binds their numbers and bounds. Like
 * achievementsSql.ts, the statements live apart from challenges.ts so the tests can run them on the real migrations.
 */
import { dayStart, STATS_DAY, statsDay } from './days';

/** A Korean day or week (Monday to Sunday) by number, with its first moment and the next one's. */
export interface ChallengeWindow {
  key: number;
  from: number;
  to: number;
}

/** Day 0 (1970-01-01) was a Thursday: three days after its week's Monday. */
export const challengeWeek = (day: number) => Math.floor((day + 3) / 7);

/** The day and week a moment falls in. */
export function challengeWindows(at: number): Record<'day' | 'week', ChallengeWindow> {
  const day = statsDay(at);
  const week = challengeWeek(day);
  return {
    day: { key: day, from: dayStart(day), to: dayStart(day + 1) },
    week: { key: week, from: dayStart(week * 7 - 3), to: dayStart(week * 7 + 4) },
  };
}

/** What the statements need of a challenge (CHALLENGES in @jc/types has these and more). */
export interface ChallengeRule {
  code: string;
  counts: 'hands' | 'showdowns' | 'days' | 'tournaments';
  target: number;
  points: number;
}

/** A tournament the member took part in: they were seated when it started (whatever happened after). */
const PLAYED = `te.status IN ('playing', 'eliminated', 'won', 'stopped')`;

/**
 * One member's events of a kind in a period, as `at` (their time), for `user` (an SQL expression) between `from` and
 * `to` (placeholders). A day with a hand is its first hand: each of the period's seven days is one lookup on
 * hand_players' (user_id, ended_at) index, never a read of every hand of the week.
 */
function events(counts: ChallengeRule['counts'], user: string, from: string, to: string): string {
  switch (counts) {
    case 'hands':
      return `SELECT x.ended_at AS at FROM hand_players x WHERE x.user_id = ${user} AND x.ended_at >= ${from} AND x.ended_at < ${to}`;
    case 'showdowns':
      return `SELECT x.ended_at AS at FROM hand_players x WHERE x.user_id = ${user} AND x.ended_at >= ${from} AND x.ended_at < ${to} AND x.went_to_showdown = 1`;
    case 'days':
      return `SELECT at FROM (
        SELECT (SELECT MIN(x.ended_at) FROM hand_players x
                 WHERE x.user_id = ${user} AND x.ended_at >= ${from} + k.column1 * ${STATS_DAY} AND x.ended_at < MIN(${to}, ${from} + (k.column1 + 1) * ${STATS_DAY})) AS at
          FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) k
      ) WHERE at IS NOT NULL`;
    case 'tournaments':
      // A private tournament is no official record (docs/TOURNAMENT.md "비공개 대회"), so it does not count here either.
      return `SELECT t.started_at AS at FROM tournament_entries te JOIN tournaments t ON t.id = te.tournament_id
               WHERE te.user_id = ${user} AND ${PLAYED} AND t.is_private = 0 AND t.started_at >= ${from} AND t.started_at < ${to}`;
  }
}

/** Who a statement is for: the human members of a recorded hand (`?1`, its id), or one member (`?1`, their id). */
const MEMBERS = {
  hand: 'SELECT hp.user_id FROM hand_players hp JOIN users u ON u.id = hp.user_id AND u.is_bot = 0 WHERE hp.hand_id = ?1',
  user: 'SELECT u.id AS user_id FROM users u WHERE u.id = ?1 AND u.is_bot = 0',
} as const;
export type ChallengeSubject = keyof typeof MEMBERS;

/**
 * A challenge completed in a period, for a hand's members or one member (`?1`): `?2` the period's number, `?3` its
 * first moment and `?4` the next period's. Nothing is counted for a member who already has it for that period.
 */
export function challengeCompletionSql(c: ChallengeRule, of: ChallengeSubject): string {
  return `INSERT OR IGNORE INTO challenge_completions (user_id, code, period, points, completed_at)
    SELECT user_id, '${c.code}', ?2, ${c.points}, at FROM (
      SELECT m.user_id, (SELECT at FROM (${events(c.counts, 'm.user_id', '?3', '?4')}) ORDER BY at LIMIT 1 OFFSET ${c.target - 1}) AS at
        FROM (${MEMBERS[of]}) m
       WHERE NOT EXISTS (SELECT 1 FROM challenge_completions cc WHERE cc.user_id = m.user_id AND cc.code = '${c.code}' AND cc.period = ?2)
    ) WHERE at IS NOT NULL`;
}

/** One member's (`?1`) progress in a period from `?2` to `?3`: a column per challenge, named by its code, never above its target. */
export function challengeProgressSql(rules: readonly ChallengeRule[]): string {
  const cols = rules.map((c) => `(SELECT COUNT(*) FROM (${events(c.counts, '?1', '?2', '?3')} LIMIT ${c.target})) AS "${c.code}"`);
  return `SELECT ${cols.join(', ')}`;
}

/**
 * The `challenges_10` achievement (ACHIEVEMENTS in @jc/types), for a hand's members or one member (`?1`): given at the
 * tenth challenge completed, whichever and whenever.
 */
export function challengeAchievementSql(of: ChallengeSubject, at: number): string {
  return `INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at)
    SELECT user_id, 'play:challenges_${at}', done FROM (
      SELECT m.user_id, (SELECT cc.completed_at FROM challenge_completions cc WHERE cc.user_id = m.user_id ORDER BY cc.completed_at LIMIT 1 OFFSET ${at - 1}) AS done
        FROM (${MEMBERS[of]}) m
       WHERE NOT EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = m.user_id AND b.badge = 'play:challenges_${at}')
    ) WHERE done IS NOT NULL`;
}
