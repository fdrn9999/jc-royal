// What a table's bots remember of the members (opp-stats.ts): only members and only public play — a losing hand the
// table did not see stays unseen in the statistics too — each hand once, and no more than a week or 64 members.
import { dealOrder, emptyCounters, HandEngine, packCounters, stackedDeck, STAT_KEYS, unpackCounters, type ActionRequest, type HandRecord } from '@jc/poker-engine';
import type { Card } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { addHand, OPP_STATS_MAX, OPP_STATS_TTL_MS, readOppStats, statsBySeat, type OppStats } from './opp-stats';

const c = (s: string) => s.split(' ') as Card[];
const BB = 10;
const NOW = 1_800_000_000_000;
let seq = 0;

/**
 * Heads-up: the bot on the button (seat 0, KQ) and a member in the big blind (seat 1, 76) check to the river, where
 * the member bets twice the pot and the bot calls. The member loses with nothing.
 */
async function riverBluff(muck: ReadonlySet<string>): Promise<HandRecord> {
  const holes: Record<number, Card[]> = { 0: c('Ks Qd'), 1: c('7c 6c') };
  const h = HandEngine.start({
    handId: `opp${++seq}`,
    rules: { maxSeats: 2, smallBlind: 5, bigBlind: BB, turnMs: 20_000 },
    seats: [
      { playerId: 'bot', seatIndex: 0, stack: 1000, displayName: 'Bot' },
      { playerId: 'member', seatIndex: 1, stack: 1000, displayName: 'Member' },
    ],
    buttonSeat: 0,
    now: 1_000,
    deck: stackedDeck(dealOrder(2, 0).map((s) => holes[s]!), c('Kh 8d 4c 2s 9h')),
  });
  const steps: [string, ActionRequest['type'], number?][] = [
    ['bot', 'call'],
    ['member', 'check'],
    ['member', 'check'],
    ['bot', 'check'],
    ['member', 'check'],
    ['bot', 'check'],
    ['member', 'bet', 40],
    ['bot', 'call'],
  ];
  for (const [id, type, amount] of steps) {
    const r = await h.act(id, { type, amount }, `i${++seq}`, 2_000 + seq);
    if (!r.ok) throw new Error(`${id} ${type}: ${r.reason}`);
  }
  expect(h.isSettled).toBe(true);
  return h.record(3_000, muck);
}

const isMember = (id: string) => id !== 'bot';
const countersOf = (s: OppStats, id: string) => unpackCounters(s.players[id]!.c);

describe('what the bots count', () => {
  it('counts the members of a hand, never the table bots', async () => {
    const s = addHand(null, await riverBluff(new Set()), BB, isMember, NOW)!;
    expect(Object.keys(s.players)).toEqual(['member']);
    expect(s.keys).toBe(STAT_KEYS.length);
    const m = countersOf(s, 'member');
    expect(m.hands).toBe(1);
    expect(m.overbets).toBe(1);
    expect(m.showdowns).toBe(1);
    expect(s.players.member!.at).toBe(NOW);
  });

  it('sees a losing hand only when the table saw it: an auto-mucked bluff is not counted as one', async () => {
    const seen = await riverBluff(new Set());
    const mucked = await riverBluff(new Set(['member']));
    // The precondition: the same hand, the member's cards shown once and mucked once.
    expect(seen.players.find((p) => p.playerId === 'member')!.shown).toBe(true);
    expect(mucked.players.find((p) => p.playerId === 'member')!.shown).toBe(false);
    const a = countersOf(addHand(null, seen, BB, isMember, NOW)!, 'member');
    const b = countersOf(addHand(null, mucked, BB, isMember, NOW)!, 'member');
    expect([a.bigBetsShown, a.bigBetBluffsShown]).toEqual([1, 1]);
    expect([b.bigBetsShown, b.bigBetBluffsShown]).toEqual([0, 0]);
    // What everybody saw (the overbet, the showdown) counts the same either way.
    expect(b.overbets).toBe(1);
    expect(b.showdowns).toBe(1);
  });

  it('adds a hand once: the hand last added is refused, the next one adds up', async () => {
    const rec = await riverBluff(new Set(['member']));
    const once = addHand(null, rec, BB, isMember, NOW)!;
    expect(addHand(once, rec, BB, isMember, NOW + 1)).toBeNull();
    const twice = addHand(once, await riverBluff(new Set(['member'])), BB, isMember, NOW + 1)!;
    expect(countersOf(twice, 'member').hands).toBe(2);
    expect(countersOf(twice, 'member').overbets).toBe(2);
    expect(twice.players.member!.at).toBe(NOW + 1);
  });

  it('forgets members not seen for a week and keeps at most the 64 seen last', async () => {
    const one = packCounters({ ...emptyCounters(), hands: 1 });
    const players: OppStats['players'] = {};
    for (let i = 0; i < OPP_STATS_MAX + 10; i++) players[`old${i}`] = { c: one, at: NOW - 1_000 - i };
    players.stale = { c: one, at: NOW - OPP_STATS_TTL_MS };
    const s = addHand({ keys: STAT_KEYS.length, handId: 'earlier', players }, await riverBluff(new Set()), BB, isMember, NOW)!;
    expect(Object.keys(s.players)).toHaveLength(OPP_STATS_MAX);
    expect(s.players.stale).toBeUndefined();
    expect(s.players.member).toBeDefined();
    // The newest stay: the hand's member, then old0 … old62.
    expect(s.players[`old${OPP_STATS_MAX - 2}`]).toBeDefined();
    expect(s.players[`old${OPP_STATS_MAX - 1}`]).toBeUndefined();
  });

  it('starts a member over who comes back after a week away, instead of adding to what was forgotten', async () => {
    const before = packCounters({ ...emptyCounters(), hands: 99, vpipOpp: 99, vpip: 90 });
    const back = async (at: number) => addHand({ keys: STAT_KEYS.length, handId: 'earlier', players: { member: { c: before, at } } }, await riverBluff(new Set()), BB, isMember, NOW)!;
    expect(countersOf(await back(NOW - OPP_STATS_TTL_MS), 'member')).toMatchObject({ hands: 1, vpipOpp: 1, vpip: 0 });
    // A day short of a week, the member is still remembered.
    expect(countersOf(await back(NOW - OPP_STATS_TTL_MS + 86_400_000), 'member')).toMatchObject({ hands: 100, vpipOpp: 100, vpip: 90 });
  });
});

describe('what the bots read back', () => {
  it('reads nothing from storage that is missing, malformed or of another layout', () => {
    expect(readOppStats(undefined)).toBeNull();
    expect(readOppStats('oppStats')).toBeNull();
    expect(readOppStats({ keys: STAT_KEYS.length })).toBeNull();
    expect(readOppStats({ keys: STAT_KEYS.length - 1, handId: 'h', players: {} })).toBeNull();
    expect(readOppStats({ keys: STAT_KEYS.length, handId: 7, players: {} })).toEqual({ keys: STAT_KEYS.length, handId: null, players: {} });
  });

  it('gives the bots the fresh counters of the members seated, nobody else, and repairs broken numbers', () => {
    const stats: OppStats = {
      keys: STAT_KEYS.length,
      handId: 'h',
      players: {
        a: { c: packCounters({ ...emptyCounters(), hands: 12, vpip: 5 }), at: NOW - 1_000 },
        old: { c: packCounters({ ...emptyCounters(), hands: 3 }), at: NOW - OPP_STATS_TTL_MS },
        bot1: { c: packCounters({ ...emptyCounters(), hands: 9 }), at: NOW },
        broken: { c: [-4, 'x', Number.NaN, 2.7] as unknown as number[], at: NOW },
      },
    };
    const seats = [{ userId: 'bot1', bot: 'hard' }, { userId: 'a' }, null, { userId: 'old' }, { userId: 'unknown' }, { userId: 'broken' }];
    const m = statsBySeat(stats, seats, NOW);
    expect([...m.keys()]).toEqual([1, 5]);
    expect(m.get(1)).toMatchObject({ hands: 12, vpip: 5 });
    expect(m.get(5)).toMatchObject({ hands: 0, vpipOpp: 0, vpip: 0, pfr: 2 });
    expect(statsBySeat(null, seats, NOW).size).toBe(0);
  });
});
