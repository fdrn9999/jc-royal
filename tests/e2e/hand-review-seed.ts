import type { Page } from '@playwright/test';
import { sql } from './analytics-helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const idOf = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);

/**
 * Four finished hands of `hero` (with `villain` in each) on a closed 5/10 table, stored the way the game worker stores
 * them. A: the newest, on the button, called pre-flop and on the flop, folded to the turn bet (the villain's cards stay
 * hidden): the replay's pot odds are 3 : 1 (25%), 2 : 1 (33%) and, at the fold, 2.5 : 1 (29%). B: big blind, +200, a 40 BB pot. C: button, +50, a
 * 120 BB pot. D: 40 days ago, small blind, −20, a 10 BB pot. Returns the hands' ids.
 */
export function seedHands(hero: string, villain: string) {
  const key = `e2e-hn-${hero.slice(0, 8)}`;
  const now = Date.now();
  const ids = { A: `${key}-a`, B: `${key}-b`, C: `${key}-c`, D: `${key}-d` };
  const actions = [
    [0, 'preflop', 'post-sb', 5],
    [1, 'preflop', 'post-bb', 10],
    [0, 'preflop', 'call', 5],
    [1, 'preflop', 'check', 0],
    [1, 'flop', 'bet', 20],
    [0, 'flop', 'call', 20],
    [1, 'turn', 'bet', 40],
    [0, 'turn', 'fold', 0],
  ].map(([seatIndex, stage, type, amount]) => ({ seatIndex, stage, type, amount }));
  const logA = JSON.stringify({
    actions,
    button: 0,
    pots: [
      { amount: 60, eligibleSeats: [1], winners: [{ seatIndex: 1, amount: 60 }], uncalled: false },
      { amount: 40, eligibleSeats: [1], winners: [{ seatIndex: 1, amount: 40 }], uncalled: true },
    ],
  });
  const hands: [keyof typeof ids, number, string, number, number, string, string][] = [
    // hand, ended, hero's position, hero's net, pot, board, log
    ['A', now - HOUR, 'BTN', -30, 100, '["Js","8d","3c","Qh"]', logA],
    ['B', now - 2 * HOUR, 'BB', 200, 400, '["2c","3d","4h","5s","6c"]', '{"actions":[]}'],
    ['C', now - 3 * HOUR, 'BTN', 50, 1200, '["2c","3d","4h","5s","6c"]', '{"actions":[]}'],
    ['D', now - 40 * DAY, 'SB', -20, 100, '["2c","3d","4h","5s","6c"]', '{"actions":[]}'],
  ];
  const player = (h: string, user: string, seat: number, cards: string, pos: string, net: number, won: number, at: number) =>
    `('${h}', '${user}', ${seat}, '${cards}', 1000, ${1000 + net}, ${net}, ${won}, NULL, NULL, NULL, 0, ${at}, '${pos}', 0, 0, 0, ${won})`;
  sql(
    `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, room_type) VALUES ('${key}', 'E2E Hand Review', 2, 5, 10, 100, 1000, 'closed', 'official');` +
      `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ` +
      hands.map(([h, at, , , pot, board, log], i) => `('${ids[h]}', '${key}', ${i + 1}, ${at - 60_000}, ${at}, '${board}', ${pot}, 'e2e', '${log}')`).join(', ') +
      ';' +
      `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, rank_class, rank_value, best_five, went_to_showdown, ended_at, position, vpip, pfr, saw_flop, pot_won) VALUES ` +
      hands
        .flatMap(([h, at, pos, net, pot]) => [
          player(ids[h], hero, 0, '["Ah","5d"]', pos, net, net > 0 ? pot : 0, at),
          player(ids[h], villain, 1, '["Kc","Qc"]', pos === 'BB' ? 'BTN' : 'BB', -net, net > 0 ? 0 : pot, at),
        ])
        .join(', ') +
      ';',
  );
  return ids;
}
