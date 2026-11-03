/**
 * A member's challenges (docs/CHALLENGES.md, packages/db/src/challengesSql.ts): judged again for this day and week first,
 * in case a hand's statements failed or a tournament started without a hand yet, then counted from what the server
 * recorded. Nothing here touches chips or the ledger.
 */
import { challengeProgressSql, challengeStatements, challengeWindows } from '@jc/db';
import {
  CHALLENGE_ACHIEVEMENT_AT,
  CHALLENGE_PERIODS,
  CHALLENGES,
  type ChallengeCode,
  type ChallengeCompletionDto,
  type ChallengeDef,
  type ChallengeDto,
  type ChallengesDto,
  type ChallengeSummaryDto,
} from '@jc/types';

const BY_CODE = new Map<string, ChallengeDef>(CHALLENGES.map((c) => [c.code, c]));

/** Completions in all and their points (a completion of a challenge no longer offered still counts). */
export const CHALLENGE_TOTALS_SQL = 'SELECT COALESCE(SUM(points), 0) AS points, COUNT(*) AS completed FROM challenge_completions WHERE user_id = ?1';

export async function challengesFor(d1: D1Database, uid: string, now: number): Promise<ChallengesDto> {
  const w = challengeWindows(now);
  const judge = challengeStatements(d1, CHALLENGES, 'user', uid, now, CHALLENGE_ACHIEVEMENT_AT);
  const results = await d1.batch([
    ...judge,
    ...CHALLENGE_PERIODS.map((p) => d1.prepare(challengeProgressSql(CHALLENGES.filter((c) => c.period === p))).bind(uid, w[p].from, w[p].to)),
    d1.prepare('SELECT code, period, completed_at AS at FROM challenge_completions WHERE user_id = ?1 AND period IN (?2, ?3)').bind(uid, w.day.key, w.week.key),
    d1.prepare(CHALLENGE_TOTALS_SQL).bind(uid),
    d1.prepare('SELECT code, points, completed_at AS at FROM challenge_completions WHERE user_id = ?1 ORDER BY completed_at DESC LIMIT 10').bind(uid),
  ]);
  const [dayR, weekR, doneR, totalR, recentR] = results.slice(judge.length);
  const progress = { day: (dayR!.results[0] ?? {}) as Record<string, number>, week: (weekR!.results[0] ?? {}) as Record<string, number> };
  // This day's completions and this week's: a code is of one period, so its row is the one of that period's number.
  const done = new Map<string, number>();
  for (const r of doneR!.results as { code: string; period: number; at: number }[]) {
    const c = BY_CODE.get(r.code);
    if (c && r.period === w[c.period].key) done.set(r.code, r.at);
  }
  const items: ChallengeDto[] = CHALLENGES.map((c) => {
    const at = done.get(c.code) ?? null;
    return {
      code: c.code,
      period: c.period,
      target: c.target,
      // Done is done: the count can fall short later only if a record were taken away, and the completion stays.
      progress: at === null ? Math.min(Number(progress[c.period][c.code] ?? 0), c.target) : c.target,
      done: at !== null,
      completedAt: at,
      points: c.points,
    };
  });
  const total = (totalR!.results[0] ?? { points: 0, completed: 0 }) as ChallengeSummaryDto;
  const recent: ChallengeCompletionDto[] = (recentR!.results as { code: string; points: number; at: number }[]).flatMap((r) => {
    const c = BY_CODE.get(r.code);
    return c ? [{ code: c.code as ChallengeCode, period: c.period, completedAt: r.at, points: r.points }] : [];
  });
  return {
    periods: CHALLENGE_PERIODS.map((p) => ({ period: p, key: w[p].key, startsAt: w[p].from, endsAt: w[p].to })),
    items,
    points: Number(total.points),
    completed: Number(total.completed),
    recent,
  };
}
