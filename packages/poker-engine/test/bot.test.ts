import type { Card, LegalOption } from '@jc/types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BOT_LEVELS, botView, cardCode, decideBot, estimateEquity, evaluateBest, HandEngine, legalize, quickScore, readHand, standardDeck, startingScore, type BotLevel, type BotView, type MaxSeats } from '../src';

const c = (s: string) => s.split(' ') as Card[];

/** Seeded [0, 1) numbers, so a failing case can be replayed. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VIEW_KEYS = ['actions', 'aggressors', 'bigBlind', 'board', 'buttonSeat', 'hole', 'legal', 'opponents', 'position', 'pot', 'seat', 'seats', 'stack', 'stage', 'streetBet', 'toCall'];

const tableArb = fc.constantFrom<MaxSeats>(2, 6, 9).chain((maxSeats) =>
  fc.record({
    maxSeats: fc.constant(maxSeats),
    players: fc.uniqueArray(fc.integer({ min: 0, max: maxSeats - 1 }), { minLength: 2, maxLength: maxSeats }),
    stacks: fc.array(fc.integer({ min: 1, max: 4000 }), { minLength: maxSeats, maxLength: maxSeats }),
    levels: fc.array(fc.constantFrom<BotLevel>(...BOT_LEVELS), { minLength: maxSeats, maxLength: maxSeats }),
    button: fc.integer({ min: 0, max: maxSeats - 1 }),
    seed: fc.integer(),
  }),
);

describe('table bots', () => {
  it('only ever take a legal action, from a view holding nothing but their own cards and the public table', async () => {
    let actions = 0;
    await fc.assert(
      fc.asyncProperty(tableArb, async (t) => {
        const rand = seeded(t.seed);
        const seats = t.players.map((seatIndex, i) => ({ playerId: `b${seatIndex}`, seatIndex, stack: t.stacks[i]!, displayName: `B${seatIndex}` }));
        const total = seats.reduce((a, s) => a + s.stack, 0);
        const h = HandEngine.start({ handId: 'bots', rules: { maxSeats: t.maxSeats, smallBlind: 5, bigBlind: 10, turnMs: 20_000 }, seats, buttonSeat: t.button, now: 1 });
        for (let step = 0; !h.isSettled; step++) {
          expect(step).toBeLessThan(400);
          if (h.isStalled()) {
            expect(botView(h, h.actorId() ?? '', 10)).toBeNull();
            await h.resolveStall(10 + step);
            continue;
          }
          const actor = h.actorId()!;
          const v = botView(h, actor, 10)!;
          expect(Object.keys(v).sort()).toEqual(VIEW_KEYS);
          expect(v.hole).toEqual(h.holeCardsOf(actor));
          expect(v.board).toEqual(h.handView().board);
          // No other player's cards and no card still in the deck appear anywhere in it.
          const text = JSON.stringify(v);
          for (const s of seats) if (s.playerId !== actor) for (const card of h.holeCardsOf(s.playerId) ?? []) expect(text).not.toContain(`"${card}"`);
          expect(text.match(/"[2-9TJQKA][cdhs]"/g)!.length).toBe(2 + v.board.length);
          // Nobody but the player to act gets a view.
          for (const s of seats) if (s.playerId !== actor) expect(botView(h, s.playerId, 10)).toBeNull();
          const level = t.levels[seats.findIndex((s) => s.playerId === actor)]!;
          const req = decideBot(level, v, rand);
          if (req.type === 'fold') expect(v.legal.some((o) => o.type === 'check')).toBe(false);
          const r = await h.act(actor, req, `i${step}`, 10 + step);
          expect(r.ok, JSON.stringify({ level, req, legal: v.legal })).toBe(true);
          expect(h.totalChips()).toBe(total);
          actions++;
        }
      }),
      { numRuns: 300 },
    );
    expect(actions).toBeGreaterThan(600);
  }, 300_000);

  it('read their hand from their own cards: the board alone is nobody’s hand', () => {
    expect(readHand(c('Ah Kd'), c('Ac 7s 2d'))).toEqual({ made: 2, outs: 0 });
    expect(readHand(c('Qh Qd'), c('Jc 7s 2d'))).toMatchObject({ made: 2 });
    expect(readHand(c('7h 6d'), c('Ac 7s 2d'))).toMatchObject({ made: 1 });
    expect(readHand(c('Ah Kd'), c('9c 9s 2d'))).toMatchObject({ made: 0 });
    expect(readHand(c('8h 8d'), c('8c 9s 2d'))).toMatchObject({ made: 3 });
    expect(readHand(c('Ah 2d'), c('Kc Ks Qd Qh 3c'))).toMatchObject({ made: 0 });
    expect(readHand(c('Ah 5h'), c('Kh 9h 2d'))).toEqual({ made: 0, outs: 9 });
    expect(readHand(c('8h 7d'), c('6c 5s Kd'))).toEqual({ made: 0, outs: 8 });
    expect(readHand(c('8h 6d'), c('5c 4s Kd'))).toEqual({ made: 0, outs: 4 });
    expect(readHand(c('Ah Kd'), c('Qc Js 2d 4h 7c'))).toEqual({ made: 0, outs: 0 });
    expect(startingScore(c('As Ah'))).toBe(20);
    expect(startingScore(c('7c 2d'))).toBeLessThan(1);
    expect(startingScore(c('Ac Kc'))).toBe(12);
  });

  it('score 5 to 7 cards exactly as the engine’s evaluator does', () => {
    const pack = (s: readonly number[]) => [1, 2, 3, 4, 5].reduce((v, i) => v * 16 + (s[i] ?? 0), s[0]!);
    fc.assert(
      fc.property(fc.shuffledSubarray(standardDeck(), { minLength: 5, maxLength: 7 }), (cards) => {
        expect(quickScore(cards.map(cardCode))).toBe(pack(evaluateBest(cards)!.score));
      }),
      { numRuns: 20_000 },
    );
    // Hands a random draw rarely makes.
    for (const h of ['As Ks Qs Js Ts 2d 3c', '5h 4h 3h 2h Ah Kd Kc', 'Ac Ad Ah As Kd 2c 3c', 'Kc Kd Kh Qs Qd Qh 2c', 'Ac 2d 3h 4s 5c 9d Jh', '9c 9d 9h 7s 7c 2d 2h', 'Ac Ad Kh Ks Qc Qd 2h'])
      expect(quickScore(c(h).map(cardCode))).toBe(pack(evaluateBest(c(h))!.score));
  });

  it('estimate equity from the cards they cannot see', () => {
    const rand = seeded(7);
    expect(estimateEquity(c('As Ah'), [], 1, 3000, rand)).toBeGreaterThan(0.8);
    expect(estimateEquity(c('7c 2d'), [], 1, 3000, rand)).toBeLessThan(0.4);
    // The nuts on the river cannot lose.
    expect(estimateEquity(c('As Ks'), c('Qs Js Ts 2d 3h'), 3, 200, rand)).toBe(1);
  });

  const view = (over: Partial<BotView>): BotView => ({
    hole: c('As Ah'),
    board: [],
    stage: 'preflop',
    legal: [{ type: 'fold' }, { type: 'call', amount: 10 }, { type: 'raise', min: 20, max: 1000 }, { type: 'allin', amount: 1000 }],
    pot: 15,
    toCall: 10,
    streetBet: 0,
    stack: 1000,
    bigBlind: 10,
    opponents: 1,
    position: 1,
    aggressors: 0,
    ...over,
  });

  it('play their level: strong hands raise, rubbish folds to a big bet, and nobody folds when checking is free', () => {
    for (const level of BOT_LEVELS) {
      const raises = Array.from({ length: 40 }, (_, i) => decideBot(level, view({}), seeded(i)).type).filter((t) => t === 'raise' || t === 'allin').length;
      expect(raises, level).toBeGreaterThan(level === 'easy' ? 5 : 30);
    }
    const bigRaise = view({ hole: c('7c 2d'), toCall: 300, legal: [{ type: 'fold' }, { type: 'call', amount: 300 }, { type: 'raise', min: 610, max: 1000 }, { type: 'allin', amount: 1000 }], pot: 325, aggressors: 1 });
    for (const level of ['normal', 'hard'] as const) for (let i = 0; i < 20; i++) expect(decideBot(level, bigRaise, seeded(i)).type).toBe('fold');
    const free = view({ hole: c('7c 2d'), board: c('Kh Qd 9s'), stage: 'flop', toCall: 0, pot: 40, legal: [{ type: 'check' }, { type: 'bet', min: 10, max: 1000 }, { type: 'allin', amount: 1000 }] });
    for (const level of BOT_LEVELS) for (let i = 0; i < 20; i++) expect(decideBot(level, free, seeded(i)).type).not.toBe('fold');
    // The nuts on the river bets or raises at Normal and Hard.
    const nuts = view({ hole: c('As Ks'), board: c('Qs Js Ts 2d 3h'), stage: 'river', toCall: 0, pot: 200, legal: [{ type: 'check' }, { type: 'bet', min: 10, max: 900 }, { type: 'allin', amount: 900 }], stack: 900 });
    for (const level of ['normal', 'hard'] as const) expect(['bet', 'allin']).toContain(decideBot(level, nuts, seeded(1)).type);
  });

  it('turn any wish into a legal request, with amounts inside the range', () => {
    const legal: LegalOption[] = [{ type: 'fold' }, { type: 'call', amount: 40 }, { type: 'raise', min: 80, max: 300 }];
    expect(legalize({ legal }, { type: 'raise', amount: 5000 })).toEqual({ type: 'raise', amount: 300 });
    expect(legalize({ legal }, { type: 'raise', amount: 12.5 })).toEqual({ type: 'raise', amount: 80 });
    expect(legalize({ legal }, { type: 'check' })).toEqual({ type: 'fold' });
    expect(legalize({ legal: [{ type: 'check' }, { type: 'bet', min: 10, max: 50 }] }, { type: 'call' })).toEqual({ type: 'check' });
    expect(legalize({ legal: [{ type: 'fold' }, { type: 'allin', amount: 30 }] }, { type: 'call' })).toEqual({ type: 'allin' });
  });

  it('decide quickly enough to run inside a table room (Hard samples the most)', () => {
    const rand = seeded(3);
    const spots = [view({}), view({ hole: c('Jh Td'), board: c('9c 8s 2d'), stage: 'flop', opponents: 5 }), view({ hole: c('Kh Qh'), board: c('Ah 7h 2s 9d'), stage: 'turn', opponents: 2 })];
    const t0 = performance.now();
    let n = 0;
    for (let k = 0; k < 10; k++) for (const s of spots) {
      decideBot('hard', s, rand);
      n++;
    }
    const ms = (performance.now() - t0) / n;
    console.log(`hard decision ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(20);
  });
});
