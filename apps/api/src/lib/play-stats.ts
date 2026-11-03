import type { StatRatio } from '@jc/types';

/**
 * The play statistics' columns over hand_players rows, one way for /api/me/stats and a table's HUD (routes/players.ts).
 * vpip, pfr and saw_flop come from HAND_STATS_SQL (packages/db/src/handStats.ts), the 3-bet, c-bet, aggression and big
 * blind columns from the game worker's detail-stats.ts; a row not filled yet is in no figure that needs it, and a flag
 * left NULL (no chance at it) in no denominator, so nothing is estimated.
 */
export const PLAY_STATS_COLUMNS = `COUNT(vpip) AS dealt,
  COALESCE(SUM(vpip), 0) AS vpip,
  COALESCE(SUM(pfr), 0) AS pfr,
  COALESCE(SUM(saw_flop), 0) AS sawFlop,
  COALESCE(SUM(saw_flop AND went_to_showdown), 0) AS wtsd,
  COALESCE(SUM(went_to_showdown AND pot_won IS NOT NULL), 0) AS showdowns,
  COALESCE(SUM(went_to_showdown AND pot_won > 0), 0) AS wsd,
  COUNT(big_blind) AS counted,
  COUNT(three_bet) AS threeBetOf, COALESCE(SUM(three_bet), 0) AS threeBet,
  COUNT(fold_3bet) AS foldTo3BetOf, COALESCE(SUM(fold_3bet), 0) AS foldTo3Bet,
  COUNT(cbet) AS cbetOf, COALESCE(SUM(cbet), 0) AS cbet,
  COUNT(fold_cbet) AS foldToCbetOf, COALESCE(SUM(fold_cbet), 0) AS foldToCbet,
  COALESCE(SUM(post_bets), 0) AS postBets, COALESCE(SUM(post_calls), 0) AS postCalls`;

export type PlayStatsRow = Record<
  | 'dealt' | 'vpip' | 'pfr' | 'sawFlop' | 'wtsd' | 'showdowns' | 'wsd'
  | 'counted' | 'threeBetOf' | 'threeBet' | 'foldTo3BetOf' | 'foldTo3Bet' | 'cbetOf' | 'cbet' | 'foldToCbetOf' | 'foldToCbet' | 'postBets' | 'postCalls',
  number
>;

/** The ratios of a PLAY_STATS_COLUMNS row, each with its denominator. */
export function playRatios(r: PlayStatsRow) {
  const ratio = (n: number, of: number): StatRatio => ({ n, of });
  return {
    vpip: ratio(r.vpip, r.dealt),
    pfr: ratio(r.pfr, r.dealt),
    wtsd: ratio(r.wtsd, r.sawFlop),
    wsd: ratio(r.wsd, r.showdowns),
    counted: r.counted,
    threeBet: ratio(r.threeBet, r.threeBetOf),
    foldTo3Bet: ratio(r.foldTo3Bet, r.foldTo3BetOf),
    cbet: ratio(r.cbet, r.cbetOf),
    foldToCbet: ratio(r.foldToCbet, r.foldToCbetOf),
    aggression: { bets: r.postBets, calls: r.postCalls },
  };
}
