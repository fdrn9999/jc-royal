/** The achievement statements (achievementsSql.ts, where the rules are explained), bound for D1. */
import { ACHIEVEMENT_HAND_SQL, ACHIEVEMENT_STREAK_SQL, ACHIEVEMENT_TOURNAMENT_SQL } from './achievementsSql';

/** For one recorded hand (`handId`), in one batch. */
export function achievementsForHand(d1: D1Database, handId: string): D1PreparedStatement[] {
  return ACHIEVEMENT_HAND_SQL.map((sql) => d1.prepare(sql).bind(handId));
}

/** For the winner of a finished tournament. */
export function achievementForTournament(d1: D1Database, tournamentId: string): D1PreparedStatement {
  return d1.prepare(ACHIEVEMENT_TOURNAMENT_SQL).bind(tournamentId);
}

/** Seven days in a row of use, for every member; `dayMs`, `offsetMs`: stats.ts's day length and time zone offset. */
export function streakAchievements(d1: D1Database, dayMs: number, offsetMs: number): D1PreparedStatement {
  return d1.prepare(ACHIEVEMENT_STREAK_SQL).bind(dayMs, offsetMs);
}
