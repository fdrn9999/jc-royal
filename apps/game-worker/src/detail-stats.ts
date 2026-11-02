/**
 * The 3-bet, fold to 3-bet, c-bet, fold to c-bet, aggression and big blind columns of a recorded hand's hand_players
 * rows (packages/db/src/schema.ts), counted with the engine's `handCounters` — the one the bots read their opponents
 * with — over the hand's public actions only. settlement.ts runs it after recording the hand; the integration test
 * hand-stats.test.ts runs the same statement on the real migrations.
 */
import { handCounters, handFactsOf, type HandRecord } from '@jc/poker-engine';

/** Only rows not counted yet are written (`big_blind IS NULL`), so writing the hand again changes nothing. */
export const DETAIL_STATS_SQL = `UPDATE hand_players SET three_bet = ?3, fold_3bet = ?4, cbet = ?5, fold_cbet = ?6, post_bets = ?7, post_calls = ?8, big_blind = ?9
WHERE hand_id = ?1 AND user_id = ?2 AND big_blind IS NULL`;

/**
 * The values of DETAIL_STATS_SQL for each player of the hand. A flag is NULL when the player had no chance at it, 1 when
 * they took it, 0 when not. None for a record without its blinds.
 */
export function detailStatsBinds(rec: HandRecord): (string | number | null)[][] {
  const bb = rec.blinds?.bb;
  if (!bb) return [];
  const counted = handCounters(handFactsOf(rec, bb));
  const flag = (opp: number, n: number) => (opp > 0 ? (n > 0 ? 1 : 0) : null);
  return rec.players.flatMap((p) => {
    const c = counted.get(p.seatIndex);
    return c
      ? [[rec.handId, p.playerId, flag(c.threeBetOpp, c.threeBet), flag(c.foldTo3BetOpp, c.foldTo3Bet), flag(c.cbetOpp, c.cbet), flag(c.foldToCbetOpp, c.foldToCbet), c.postBets, c.postCalls, bb]]
      : [];
  });
}
