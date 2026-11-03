/** The challenge statements (challengesSql.ts, where the rules and periods are explained), bound for D1. */
import { challengeAchievementSql, challengeCompletionSql, challengeWindows, type ChallengeRule, type ChallengeSubject } from './challengesSql';

export interface ChallengeRuleIn extends ChallengeRule {
  period: 'day' | 'week';
}

/**
 * Every challenge's completion, and the achievement for completing `achievementAt` of them, for the members of a
 * recorded hand (`of` 'hand', `id` its id) or one member (`of` 'user'), in the day and week of `at`.
 */
export function challengeStatements(d1: D1Database, rules: readonly ChallengeRuleIn[], of: ChallengeSubject, id: string, at: number, achievementAt: number): D1PreparedStatement[] {
  const w = challengeWindows(at);
  return [
    ...rules.map((c) => d1.prepare(challengeCompletionSql(c, of)).bind(id, w[c.period].key, w[c.period].from, w[c.period].to)),
    d1.prepare(challengeAchievementSql(of, achievementAt)).bind(id),
  ];
}
