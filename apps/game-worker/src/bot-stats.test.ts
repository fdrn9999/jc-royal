// The bots' play counted for the admin console (bot-stats.ts): per level, from the public play only, never a member's,
// and moved into a hand's record every few hands, at a new day, after a hand without bots and when the table closes.
import { BOT_SLOW_MS, BOT_STAT_KEYS, dayStart, STATS_DAY, statsDay } from '@jc/db';
import { dealOrder, HandEngine, stackedDeck, type ActionRequest, type HandRecord } from '@jc/poker-engine';
import type { BotLevel, Card } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { BOT_STATS_FLUSH_HANDS, countHand, countMove, type BotStatsAcc } from './bot-stats';

const c = (s: string) => s.split(' ') as Card[];
const BB = 10;
const NOW = 1_800_000_000_000;
let seq = 0;

async function play(seats: string[], holes: string[], steps: [string, ActionRequest['type'], number?][]): Promise<HandRecord> {
  const h = HandEngine.start({
    handId: `bs${++seq}`,
    rules: { maxSeats: seats.length === 2 ? 2 : 6, smallBlind: 5, bigBlind: BB, turnMs: 20_000 },
    seats: seats.map((playerId, seatIndex) => ({ playerId, seatIndex, stack: 1000, displayName: playerId })),
    buttonSeat: 0,
    now: 1_000,
    deck: stackedDeck(dealOrder(seats.length, 0).map((s) => c(holes[s]!)), c('Kh 8d 4c 2s 9h')),
  });
  for (const [id, type, amount] of steps) {
    const r = await h.act(id, { type, amount }, `i${++seq}`, 2_000 + seq);
    if (!r.ok) throw new Error(`${id} ${type}: ${r.reason}`);
  }
  expect(h.isSettled).toBe(true);
  return h.record(3_000, new Set());
}

/** Heads-up: the bot on the button limps, both check to the river, the member bets twice the pot and the bot calls. */
const riverOverbet = () =>
  play(['bot', 'member'], ['Ks Qd', '7c 6c'], [
    ['bot', 'call'],
    ['member', 'check'],
    ['member', 'check'],
    ['bot', 'check'],
    ['member', 'check'],
    ['bot', 'check'],
    ['member', 'bet', 40],
    ['bot', 'call'],
  ]);

/** Three-handed: the member on the button raises, the small blind bot and the big blind bot fold. */
const steal = () =>
  play(['member', 'sb', 'bb'], ['As Kd', '7c 2d', '8h 3s'], [
    ['member', 'raise', 25],
    ['sb', 'fold'],
    ['bb', 'fold'],
  ]);

const levels: Record<string, BotLevel> = { bot: 'hard', sb: 'easy', bb: 'hard' };
const levelOf = (id: string) => levels[id];

describe("the bots' play for the admin console", () => {
  it("counts the bots' seats by level from the public play, and nothing of a member", async () => {
    const one = countHand(null, await riverOverbet(), BB, levelOf, NOW, false);
    expect(one.flush).toEqual([]);
    expect(one.acc).toEqual({
      day: statsDay(NOW),
      hands: 1,
      n: { bt_hard_hands: 1, bt_hard_vpipOpp: 1, bt_hard_vpip: 1, bt_hard_foldToOverbetOpp: 1 },
    });
    const two = countHand(one.acc, await steal(), BB, levelOf, NOW, false);
    expect(two.acc!.hands).toBe(2);
    expect(two.acc!.n).toEqual({
      bt_hard_hands: 2,
      bt_hard_vpipOpp: 2,
      bt_hard_vpip: 1,
      bt_hard_foldToOverbetOpp: 1,
      bt_hard_threeBetOpp: 1,
      bt_hard_bbStealOpp: 1,
      bt_hard_bbFoldToSteal: 1,
      bt_easy_hands: 1,
      bt_easy_vpipOpp: 1,
      bt_easy_threeBetOpp: 1,
    });
    // Only the reported keys, per level: never a member, a bot's id or a seat.
    const keys = new Set<string>(BOT_STAT_KEYS);
    for (const m of Object.keys(two.acc!.n)) expect(keys.has(m.replace(/^bt_(easy|hard)_/, ''))).toBe(true);
    // What was kept is not changed: the room keeps the result.
    expect(one.acc!.hands).toBe(1);
  });

  it('counts each move: how late, fallen back, refused, slow', () => {
    let a = countMove(null, NOW, 'expert', { lagMs: 300, fallback: false, failed: false });
    a = countMove(a, NOW, 'expert', { lagMs: BOT_SLOW_MS + 1, fallback: true, failed: true });
    a = countMove(a, NOW, 'easy', { lagMs: -50, fallback: true, failed: false });
    expect(a).toEqual({
      day: statsDay(NOW),
      hands: 0,
      n: { bt_expert_decisions: 2, bt_expert_lagMs: 300 + BOT_SLOW_MS + 1, bt_expert_fallbacks: 1, bt_expert_failures: 1, bt_expert_slow: 1, bt_easy_decisions: 1, bt_easy_fallbacks: 1 },
    });
  });

  it(`moves the sum into a record every ${BOT_STATS_FLUSH_HANDS} hands, at a new day, after a hand without bots, and when the table closes`, async () => {
    const rec = await riverOverbet();
    let acc: BotStatsAcc | null = countMove(null, NOW, 'hard', { lagMs: 10, fallback: false, failed: false });
    for (let i = 1; i < BOT_STATS_FLUSH_HANDS; i++) {
      const r = countHand(acc, rec, BB, levelOf, NOW, false);
      expect(r.flush).toEqual([]);
      acc = r.acc;
    }
    const full = countHand(acc, rec, BB, levelOf, NOW, false);
    expect(full.acc).toBeNull();
    expect(full.flush).toEqual([{ day: statsDay(NOW), n: expect.objectContaining({ bt_hard_hands: BOT_STATS_FLUSH_HANDS, bt_hard_decisions: 1, bt_hard_lagMs: 10 }) }]);

    // A new day: the old day's sum goes out with this hand, which starts the new day's.
    const old = countHand(null, rec, BB, levelOf, NOW, false).acc;
    const next = countHand(old, rec, BB, levelOf, NOW + STATS_DAY, false);
    expect(next.flush).toEqual([{ day: statsDay(NOW), n: old!.n }]);
    expect(next.acc).toMatchObject({ day: statsDay(NOW) + 1, hands: 1 });

    // A hand without bots sends what is left; with nothing left it sends nothing.
    const none = () => undefined;
    const after = countHand(old, rec, BB, none, NOW, false);
    expect(after).toEqual({ acc: null, flush: [{ day: statsDay(NOW), n: old!.n }] });
    expect(countHand(null, rec, BB, none, NOW, false)).toEqual({ acc: null, flush: [] });

    // The table's last hand sends everything, itself included.
    const last = countHand(old, rec, BB, levelOf, NOW, true);
    expect(last.acc).toBeNull();
    expect(last.flush).toEqual([{ day: statsDay(NOW), n: expect.objectContaining({ bt_hard_hands: 2 }) }]);
  });

  it('counts a move after midnight for the new day, and the day before still goes out with the next hand', async () => {
    const day = statsDay(NOW);
    const midnight = dayStart(day + 1);
    let a = countMove(null, midnight - 1_000, 'hard', { lagMs: 10, fallback: false, failed: false });
    a = countMove(a, midnight + 1_000, 'hard', { lagMs: 20, fallback: true, failed: false });
    expect(a).toMatchObject({ day: day + 1, hands: 0, n: { bt_hard_decisions: 1, bt_hard_lagMs: 20, bt_hard_fallbacks: 1 } });
    const r = countHand(a, await riverOverbet(), BB, levelOf, midnight + 2_000, false);
    expect(r.flush).toEqual([{ day, n: { bt_hard_decisions: 1, bt_hard_lagMs: 10 } }]);
    expect(r.acc).toEqual({ day: day + 1, hands: 1, n: expect.objectContaining({ bt_hard_decisions: 1, bt_hard_lagMs: 20, bt_hard_fallbacks: 1, bt_hard_hands: 1 }) });
    // Sent once: the next hand has nothing of the day before.
    expect(countHand(r.acc, await riverOverbet(), BB, levelOf, midnight + 3_000, false).flush).toEqual([]);
  });
});
