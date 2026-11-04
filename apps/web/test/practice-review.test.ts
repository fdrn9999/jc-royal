import { HandEngine, stackedDeck, styleFor, type HandRecord } from '@jc/poker-engine';
import type { Card } from '@jc/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreeSession, type FreeConfig } from '../src/academy/practice/free';
import { repeatedPatterns, replayOf, reviewHand, wonAtShowdown, type PracticeDecision } from '../src/academy/practice/review';
import { botId, HERO_ID } from '../src/academy/practice/runner';
import { seeded } from '../src/academy/review';

const c = (s: string) => s.split(' ') as Card[];
// A real generator: the table bots deal runouts from it until a card is free, which a sequence that settles on one
// value never gives.
const lcg = (seed: number) => seeded(Math.round(seed * 1e6));

/** Plays `hands` hands with random legal hero actions; every hand pays out exactly what was dealt. */
async function play(s: FreeSession, rand: () => number, hands: number, atStart?: (s: FreeSession) => void) {
  for (let hand = 0; hand < hands; hand++) {
    atStart?.(s);
    for (let guard = 0; guard < 400 && !s.settled; guard++) {
      if (await s.step()) continue;
      if (s.isHeroTurn()) {
        const legal = s.heroLegal();
        const o = legal[Math.floor(rand() * legal.length)]!;
        expect(await s.heroAct(o.type, 'min' in o ? o.min : undefined)).toBe(true);
      }
    }
    expect(s.settled).toBe(true);
    const rec = s.engine.record(0);
    expect(rec.players.reduce((a, p) => a + p.stackEnd, 0)).toBe(rec.players.reduce((a, p) => a + p.stackStart, 0));
    if (hand < hands - 1) s.newHand();
  }
}

/** A heads-up hand dealt from a fixed deck, played as scripted: [seat, type, amount?] in turn. */
async function scripted(button: 0 | 1, holes: [string, string], board: string, script: [number, string, number?][]): Promise<HandRecord> {
  const e = HandEngine.start({
    handId: 'h',
    rules: { maxSeats: 2, smallBlind: 5, bigBlind: 10, turnMs: 600_000 },
    seats: [
      { playerId: HERO_ID, seatIndex: 0, stack: 1000, displayName: 'You' },
      { playerId: botId(1), seatIndex: 1, stack: 1000, displayName: 'Mia' },
    ],
    buttonSeat: button,
    now: 1,
    // Dealt from the seat after the button.
    deck: stackedDeck(button === 1 ? [c(holes[0]), c(holes[1])] : [c(holes[1]), c(holes[0])], c(board)),
  });
  let now = 2;
  for (const [seat, type, amount] of script) {
    const r = await e.act(seat === 0 ? HERO_ID : botId(1), { type: type as never, amount }, `k${now}`, ++now);
    expect(r.ok, `${seat} ${type}`).toBe(true);
  }
  expect(e.isSettled).toBe(true);
  return e.record(++now);
}

afterEach(() => vi.unstubAllGlobals());

describe('free practice: table bots, options and topics', () => {
  it('table bots at every level play hand after hand, conserving the practice chips, offline', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const rand = lcg(0.61);
    for (const level of ['easy', 'normal', 'hard', 'expert'] as const)
      for (const bots of [1, 2, 5] as const) {
        const s = new FreeSession({ bots, style: 'mixed', level }, 'You', rand);
        await play(s, rand, 6);
        expect(s.hands).toBe(6);
      }
    expect(fetch).not.toHaveBeenCalled();
  }, 60_000);

  it('gives auto-styled bots their own style as a table would, a chosen style to all', () => {
    const auto = new FreeSession({ bots: 5, style: 'mixed', level: 'normal', tableStyle: 'auto' }, 'You');
    for (const [seat, style] of auto.tableStyles) expect(style).toBe(styleFor(botId(seat)));
    const lag = new FreeSession({ bots: 5, style: 'mixed', level: 'hard', tableStyle: 'lag' }, 'You');
    expect([...lag.tableStyles.values()]).toEqual(['lag', 'lag', 'lag', 'lag', 'lag']);
    // The beginner bots, as before, when no level is chosen.
    expect(new FreeSession({ bots: 2, style: 'mixed' }, 'You').tableStyles.size).toBe(0);
  });

  it('deals the chosen blinds and stacks', () => {
    const s = new FreeSession({ bots: 2, style: 'tight', blinds: [25, 50], stackBb: 50 }, 'You');
    expect(s.view().table).toMatchObject({ smallBlind: 25, bigBlind: 50 });
    expect(s.shape.seats.map((x) => x.stack)).toEqual([2500, 2500, 2500]);
  });

  it('defending the big blind deals the hero the big blind every hand, at any table size', async () => {
    const rand = lcg(0.2);
    for (const bots of [1, 2, 5] as const) {
      const s = new FreeSession({ bots, style: 'mixed', topic: 'bbDefense' }, 'You', rand);
      await play(s, rand, 5, (x) => expect(x.engine.handView().bbSeat).toBe(0));
    }
  });

  it('heads-up deals one bot whatever the count; short stack deals the hero 20 big blinds each hand', async () => {
    const rand = lcg(0.45);
    const hu = new FreeSession({ bots: 5, style: 'mixed', topic: 'headsUp' }, 'You', rand);
    expect(hu.shape.size).toBe(2);
    await play(hu, rand, 4);
    expect(hu.decisions.length).toBeGreaterThan(0);
    for (const x of hu.decisions) expect(x.topics).toContain('headsUp');

    const short = new FreeSession({ bots: 2, style: 'mixed', level: 'normal', topic: 'shortStack', stackBb: 100 }, 'You', rand);
    await play(short, rand, 6, (x) => {
      expect(x.heroStack()).toBe(200);
    });
    for (const x of short.decisions) expect(x.topics).toContain('shortStack');
  });

  it('counts every seat for its HUD over the hands settled, each ratio within its chances', async () => {
    const rand = lcg(0.33);
    const s = new FreeSession({ bots: 5, style: 'mixed', level: 'hard' }, 'You', rand);
    await play(s, rand, 8);
    for (const seat of [0, 1, 2, 3, 4, 5]) {
      const h = s.hud(seat);
      expect(h.hands).toBe(8);
      expect(h.vpip.of).toBe(8);
      for (const r of [h.vpip, h.pfr, h.wtsd, h.wsd, h.threeBet, h.foldTo3Bet, h.cbet, h.foldToCbet]) expect(r.n).toBeLessThanOrEqual(r.of);
    }
    // Every hero decision reviewed, each a decision of the free topic.
    expect(s.decisions.length).toBeGreaterThan(0);
    for (const x of s.decisions) expect(x.topics[0]).toBe('free');
  });
});

describe('practice review: the hero’s cards only, topics and habits', () => {
  it('reads a defended big blind facing a c-bet, the hero folding a nut flush draw at a cheap price', async () => {
    // Hero (BB) calls Mia's raise to 30, checks the flop and folds to a 15-chip c-bet: 15 to win 75, 17%.
    const rec = await scripted(1, ['Ah 5h', 'Qs Qd'], 'Kh 9h 2c 7d 3s', [
      [1, 'raise', 30],
      [0, 'call'],
      [0, 'check'],
      [1, 'bet', 15],
      [0, 'fold'],
    ]);
    const replay = replayOf(rec, 0, 1, 2);
    expect(replay.players.find((p) => p.seatIndex === 1)!.holeCards).toBeNull();
    expect(replay.players.find((p) => p.seatIndex === 0)!.holeCards).toEqual(c('Ah 5h'));
    const ds = reviewHand(rec, 0, 1, 2);
    expect(ds.map((x) => x.d.stage)).toEqual(['preflop', 'flop', 'flop']);
    expect(ds[0]!.topics).toEqual(['free', 'preflop', 'bbDefense', 'headsUp']);
    expect(ds[2]!.topics).toEqual(['free', 'cbet', 'headsUp']);
    expect(ds[2]!.patterns).toEqual(['drawFold']);
    for (const x of ds) expect(x.d.cards).toEqual(c('Ah 5h'));
  });

  it('marks a river checked back last with a set, never one the board alone makes', async () => {
    const check = (hole: string, board: string) =>
      scripted(0, [hole, '2d 2h'], board, [
        [0, 'call'],
        [1, 'check'],
        ...(['flop', 'turn', 'river'] as const).flatMap((): [number, string][] => [
          [1, 'check'],
          [0, 'check'],
        ]),
      ]);
    const set = reviewHand(await check('7c 7d', '7h Kd 3s 9c 4h'), 0, 1, 2);
    expect(set.at(-1)!.d.stage).toBe('river');
    expect(set.at(-1)!.patterns).toEqual(['riverCheckStrong']);
    // Quads on the board: everyone's, nothing to bet for.
    const board = reviewHand(await check('Ac Kd', '9h 9d 9s 9c 4h'), 0, 1, 2);
    expect(board.at(-1)!.patterns).toEqual([]);
  });

  it('shows a habit once it came back, not the first time', () => {
    const at = (hand: number, patterns: PracticeDecision['patterns']) => ({ hand, bigBlind: 10, d: {} as never, topics: ['free' as const], patterns });
    expect(repeatedPatterns([at(1, ['cheapFold']), at(2, [])])).toEqual([]);
    expect(repeatedPatterns([at(1, ['cheapFold']), at(3, ['cheapFold', 'openLimp']), at(3, ['openLimp']), at(4, ['openLimp'])])).toEqual([
      { id: 'openLimp', count: 3, hands: [3, 4] },
      { id: 'cheapFold', count: 2, hands: [1, 3] },
    ]);
  });

  it('counts a showdown won only where chips were won past what nobody called', async () => {
    const rec = await scripted(0, ['Ac Ad', 'Kc Kd'], '2h 7s 9d 3c 4h', [
      [0, 'call'],
      [1, 'check'],
      ...(['flop', 'turn', 'river'] as const).flatMap((): [number, string][] => [
        [1, 'check'],
        [0, 'check'],
      ]),
    ]);
    expect([...wonAtShowdown(rec)]).toEqual([0]);
  });

  it('keeps the existing beginner sessions as they were', () => {
    const cfg: FreeConfig = { bots: 2, style: 'mixed' };
    const s = new FreeSession(cfg, 'You');
    expect(s.level).toBeNull();
    expect(s.topic).toBe('free');
    expect(s.shape.blinds).toEqual([5, 10]);
    expect(s.shape.seats.map((x) => x.stack)).toEqual([1000, 1000, 1000]);
  });
});
