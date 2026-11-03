import { sql } from './analytics-helpers';

const DAY = 86_400_000;
const KST = 9 * 3_600_000;

/**
 * `n` hands of `uid` earlier today (Korean time), on a closed table of their own, stored the way the game worker stores
 * them: enough for the day's hand challenges, which the server judges when the member opens them.
 */
export function seedTodayHands(uid: string, n: number) {
  const key = `e2e-ch-${uid.slice(0, 8)}`;
  const now = Date.now();
  const from = Math.max(now - 60_000, Math.floor((now + KST) / DAY) * DAY - KST);
  const times = Array.from({ length: n }, (_, i) => from + i);
  sql(
    `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, room_type) VALUES ('${key}', 'E2E Challenges', 2, 5, 10, 100, 1000, 'closed', 'official');` +
      `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ` +
      times.map((at, i) => `('${key}-${i}', '${key}', ${i + 1}, ${at - 1000}, ${at}, '[]', 20, 'e2e', '{"actions":[]}')`).join(', ') +
      ';' +
      `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) VALUES ` +
      times.map((at, i) => `('${key}-${i}', '${uid}', 0, '["Ah","5d"]', 1000, 1000, 0, 0, 0, ${at})`).join(', ') +
      ';',
  );
}
