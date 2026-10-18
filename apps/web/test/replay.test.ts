import { describe, expect, it } from 'vitest';
import { buildReplay, handedBack, replayParts, replayPhase, replayPots, settledPots, type ReplayInput } from '../src/game/replay';

const a = (seatIndex: number, stage: string, type: string, amount = 0) => ({ seatIndex, stage, type, amount });
const act = (seat: number, type: string, amount = 0) => ({ kind: 'act', seat, type, amount });
const player = (seatIndex: number, o: { stackStart: number; net: number; won: number; holeCards?: string[] | null; rankClass?: string | null; bestFive?: string[] | null }) => ({
  seatIndex,
  nickname: `p${seatIndex}`,
  holeCards: o.holeCards ?? null,
  stackStart: o.stackStart,
  net: o.net,
  won: o.won,
  rankClass: o.rankClass ?? null,
  bestFive: o.bestFive ?? null,
});

/**
 * Three players, button 0. Seat 0 is all in pre-flop for 100; seats 1 and 2 build a side pot, seat 2 bets the flop
 * and seat 1 folds; the board runs out and seat 0 wins the main pot. Seen by seat 1, who folded.
 */
function sidePotHand(): ReplayInput {
  return {
    id: 'h1',
    tableName: 'T',
    handNumber: 7,
    board: ['Ah', 'Kd', '7c', '2s', '9h'],
    potTotal: 900,
    smallBlind: 5,
    bigBlind: 10,
    maxSeats: 6,
    buttonSeat: 0,
    pots: [
      { amount: 300, eligibleSeats: [0, 2], winners: [{ seatIndex: 0, amount: 300 }], uncalled: false },
      { amount: 400, eligibleSeats: [2], winners: [{ seatIndex: 2, amount: 400 }], uncalled: false },
      { amount: 200, eligibleSeats: [2], winners: [{ seatIndex: 2, amount: 200 }], uncalled: true },
    ],
    actions: [
      a(1, 'preflop', 'post-sb', 5),
      a(2, 'preflop', 'post-bb', 10),
      a(0, 'preflop', 'allin', 100),
      a(1, 'preflop', 'call', 95),
      a(2, 'preflop', 'raise', 290),
      a(1, 'preflop', 'call', 200),
      a(1, 'flop', 'check'),
      a(2, 'flop', 'bet', 200),
      a(1, 'flop', 'fold'),
    ],
    players: [
      player(0, { stackStart: 100, net: 200, won: 300, holeCards: ['As', 'Ac'], rankClass: 'three_of_a_kind', bestFive: ['As', 'Ac', 'Ah', 'Kd', '9h'] }),
      player(1, { stackStart: 1000, net: -300, won: 0, holeCards: ['Qs', 'Jc'] }),
      player(2, { stackStart: 1000, net: 100, won: 600, holeCards: ['Kh', 'Ks'], rankClass: 'three_of_a_kind', bestFive: ['Kh', 'Ks', 'Kd', 'Ah', '9h'] }),
    ],
  };
}

describe('replayPots', () => {
  it('keeps one pot, folded chips included, while nobody is all in', () => {
    expect(replayPots(new Map([[0, 30], [1, 5], [2, 30]]), new Set([1]), new Set())).toEqual([{ id: 'pot-0', amount: 65, eligibleSeats: [0, 2] }]);
  });

  it('splits at each all-in level and joins levels with the same contenders', () => {
    const pots = replayPots(new Map([[0, 100], [1, 300], [2, 500]]), new Set([1]), new Set([0]));
    expect(pots).toEqual([
      { id: 'pot-0', amount: 300, eligibleSeats: [0, 2] },
      { id: 'pot-1', amount: 600, eligibleSeats: [2] },
    ]);
  });
});

describe('buildReplay', () => {
  it('steps through the deal, every action, each street of the run-out, the showdown and the payout', () => {
    const steps = buildReplay(sidePotHand(), 1);
    expect(steps.map((s) => `${s.kind}:${s.stage}`)).toEqual([
      'deal:preflop',
      'action:preflop',
      'action:preflop',
      'action:preflop',
      'action:preflop',
      'street:flop',
      'action:flop',
      'action:flop',
      'action:flop',
      'street:turn',
      'street:river',
      'showdown:showdown',
      'result:settled',
    ]);
    expect(steps.map((s) => s.view.hand!.board.length)).toEqual([0, 0, 0, 0, 0, 3, 3, 3, 3, 4, 5, 5, 5]);
    expect(steps.map((s) => s.view.hand!.potTotal)).toEqual([15, 115, 210, 500, 700, 700, 700, 900, 900, 900, 900, 900, 900]);
  });

  it('shows stacks, street bets, plate actions and pots as they were after each step', () => {
    const steps = buildReplay(sidePotHand(), 1);
    const deal = steps[0]!.view;
    expect(deal.seats.slice(0, 3).map((s) => [s.stack, s.streetBet])).toEqual([[100, 0], [995, 5], [990, 10]]);
    expect(deal.seats[1]!.lastAction).toBeNull();
    expect(deal.hand).toMatchObject({ buttonSeat: 0, sbSeat: 1, bbSeat: 2, actorSeat: null });
    const allIn = steps[1]!.view;
    expect(allIn.seats[0]).toMatchObject({ state: 'allin', stack: 0, streetBet: 100, lastAction: { type: 'allin', amount: 100 } });
    expect(allIn.hand!.actorSeat).toBe(0);
    const preflopEnd = steps[4]!.view;
    expect(preflopEnd.hand!.pots).toEqual([
      { id: 'pot-0', amount: 300, eligibleSeats: [0, 1, 2] },
      { id: 'pot-1', amount: 400, eligibleSeats: [1, 2] },
    ]);
    const flop = steps[5]!.view;
    expect(flop.seats.slice(0, 3).map((s) => [s.streetBet, s.lastAction ?? null])).toEqual([[0, null], [0, null], [0, null]]);
    expect(flop.hand!.board).toEqual(['Ah', 'Kd', '7c']);
    const fold = steps[8]!.view;
    expect(fold.seats[1]).toMatchObject({ state: 'folded', hasCards: false, stack: 700 });
    expect(fold.hand!.pots).toEqual([
      { id: 'pot-0', amount: 300, eligibleSeats: [0, 2] },
      { id: 'pot-1', amount: 600, eligibleSeats: [2] },
    ]);
  });

  it("shows the viewer's own cards from the deal and nobody else's before the showdown", () => {
    const steps = buildReplay(sidePotHand(), 1);
    for (const s of steps.slice(0, 11)) {
      expect(s.view.seats[1]!.holeCards).toEqual(['Qs', 'Jc']);
      expect(s.view.seats[0]!.holeCards).toBeNull();
      expect(s.view.seats[2]!.holeCards).toBeNull();
    }
    const sd = steps[11]!.view;
    expect(sd.seats[0]!.holeCards).toEqual(['As', 'Ac']);
    expect(sd.seats[2]!.holeCards).toEqual(['Kh', 'Ks']);
    expect(sd.hand!.result).toMatchObject({ winners: [], showdown: [{ seatIndex: 0, rankClass: 'three_of_a_kind' }, { seatIndex: 2 }] });
  });

  it('pays out the final stacks and counts an uncalled bet handed back as no win', () => {
    const res = buildReplay(sidePotHand(), 1).at(-1)!.view;
    expect(res.seats.slice(0, 3).map((s) => s.stack)).toEqual([300, 700, 1100]);
    expect(res.seats.slice(0, 3).map((s) => s.streetBet)).toEqual([0, 0, 0]);
    expect(res.hand!.pots).toEqual([]);
    expect(res.hand!.potTotal).toBe(900);
    expect(res.hand!.result!.winners).toEqual([
      { seatIndex: 0, amount: 300, potIds: ['pot-0'] },
      { seatIndex: 2, amount: 400, potIds: ['pot-1'] },
    ]);
    expect(res.seats[3]).toMatchObject({ state: 'empty' });
    expect(res.table.maxSeats).toBe(6);
  });

  it('never shows a card the record does not show: a mucked hand keeps its backs', () => {
    const h = sidePotHand();
    h.players[2] = { ...h.players[2]!, holeCards: null, rankClass: null, bestFive: null };
    const steps = buildReplay(h, 0);
    for (const s of steps) expect(s.view.seats[2]!.holeCards).toBeNull();
    const sd = steps.find((s) => s.kind === 'showdown')!.view;
    expect(sd.seats[2]).toMatchObject({ hasCards: true, holeCards: null });
    expect(sd.hand!.result!.showdown.map((x) => x.seatIndex)).toEqual([0]);
    expect(steps.find((s) => s.kind === 'showdown')!.line).toEqual([{ kind: 'shows', seat: 0, rankClass: 'three_of_a_kind', bestFive: ['As', 'Ac', 'Ah', 'Kd', '9h'] }]);
  });

  it('says what each step did: bets, raises and all-ins as the street total they reach, calls and blinds as what went in', () => {
    const steps = buildReplay(sidePotHand(), 1);
    expect(steps.map((s) => s.line)).toEqual([
      [{ kind: 'deal' }, act(1, 'post-sb', 5), act(2, 'post-bb', 10)],
      [act(0, 'allin', 100)],
      [act(1, 'call', 95)],
      [act(2, 'raise', 300)],
      [act(1, 'call', 200)],
      [{ kind: 'board', cards: ['Ah', 'Kd', '7c'] }],
      [act(1, 'check')],
      [act(2, 'bet', 200)],
      [act(1, 'fold')],
      [{ kind: 'board', cards: ['2s'] }],
      [{ kind: 'board', cards: ['9h'] }],
      [
        { kind: 'shows', seat: 0, rankClass: 'three_of_a_kind', bestFive: ['As', 'Ac', 'Ah', 'Kd', '9h'] },
        { kind: 'shows', seat: 2, rankClass: 'three_of_a_kind', bestFive: ['Kh', 'Ks', 'Kd', 'Ah', '9h'] },
      ],
      // The uncalled 200 handed back to seat 2 is no win.
      [
        { kind: 'wins', seat: 0, amount: 300 },
        { kind: 'wins', seat: 2, amount: 400 },
      ],
    ]);
  });

  it('marks the part of the hand each step is in, and where each part the hand reached starts and ends', () => {
    const steps = buildReplay(sidePotHand(), 1);
    expect(steps.map((s) => replayPhase(s))).toEqual(['preflop', 'preflop', 'preflop', 'preflop', 'preflop', 'flop', 'flop', 'flop', 'flop', 'turn', 'river', 'showdown', 'result']);
    expect(replayParts(steps)).toEqual([
      { phase: 'preflop', first: 0, last: 4 },
      { phase: 'flop', first: 5, last: 8 },
      { phase: 'turn', first: 9, last: 9 },
      { phase: 'river', first: 10, last: 10 },
      { phase: 'showdown', first: 11, last: 11 },
      { phase: 'result', first: 12, last: 12 },
    ]);
  });

  it('ends without a showdown when everyone else folds', () => {
    const h: ReplayInput = {
      id: 'h2',
      tableName: 'T',
      handNumber: 1,
      board: [],
      potTotal: 40,
      smallBlind: 5,
      bigBlind: 10,
      maxSeats: 2,
      buttonSeat: 0,
      pots: [{ amount: 40, eligibleSeats: [0], winners: [{ seatIndex: 0, amount: 40 }], uncalled: false }],
      actions: [a(0, 'preflop', 'post-sb', 5), a(1, 'preflop', 'post-bb', 10), a(0, 'preflop', 'raise', 25), a(1, 'preflop', 'timeout-fold')],
      players: [player(0, { stackStart: 500, net: 10, won: 40, holeCards: null }), player(1, { stackStart: 500, net: -10, won: 0, holeCards: ['2c', '7d'] })],
    };
    const steps = buildReplay(h, 1);
    expect(steps.map((s) => s.kind)).toEqual(['deal', 'action', 'action', 'result']);
    expect(steps[2]!.view.seats[1]!.lastAction).toEqual({ type: 'fold', amount: 0 });
    const res = steps.at(-1)!.view;
    // The 20 of the raise nobody called comes back to seat 0 and is no win: it wins its own 10 called and the big blind's 10.
    expect(res.hand!.result).toEqual({ winners: [{ seatIndex: 0, amount: 20, potIds: ['pot-0'] }], showdown: [] });
    expect(res.seats.map((s) => s.stack)).toEqual([510, 490]);
    expect(res.seats[0]!.holeCards).toBeNull();
    // A raise from the small blind reads as the total it reaches; a time-out as stored; no street, showdown or board.
    expect(steps.map((s) => s.line)).toEqual([[{ kind: 'deal' }, act(0, 'post-sb', 5), act(1, 'post-bb', 10)], [act(0, 'raise', 30)], [act(1, 'timeout-fold')], [{ kind: 'wins', seat: 0, amount: 20 }]]);
    expect(replayParts(steps)).toEqual([
      { phase: 'preflop', first: 0, last: 2 },
      { phase: 'result', first: 3, last: 3 },
    ]);
  });

  it('replays hands recorded before pots and the button were stored from the per-player totals', () => {
    const h = { ...sidePotHand(), pots: null, buttonSeat: null };
    const res = buildReplay(h, 1).at(-1)!.view;
    expect(res.hand!.buttonSeat).toBe(-1);
    // Seat 2's total of 600 holds the 200 nobody called, which it put in above seat 1's 300.
    expect(res.hand!.result!.winners).toEqual([
      { seatIndex: 0, amount: 300, potIds: [] },
      { seatIndex: 2, amount: 400, potIds: [] },
    ]);
  });
});

describe('handedBack and settledPots', () => {
  const raiseFold = (): ReplayInput => ({
    ...sidePotHand(),
    board: [],
    potTotal: 450,
    pots: [{ amount: 450, eligibleSeats: [0], winners: [{ seatIndex: 0, amount: 450 }], uncalled: false }],
    actions: [a(1, 'preflop', 'post-sb', 50), a(2, 'preflop', 'post-bb', 100), a(0, 'preflop', 'raise', 300), a(1, 'preflop', 'fold'), a(2, 'preflop', 'fold')],
    players: [player(0, { stackStart: 10_000, net: 150, won: 450 }), player(1, { stackStart: 10_000, net: -50, won: 0 }), player(2, { stackStart: 10_000, net: -100, won: 0 })],
  });

  it('takes a raise everyone folded to out of the one pot that holds it: what the raiser put in above the next most', () => {
    const h = raiseFold();
    expect(handedBack(h)).toEqual({ seatIndex: 0, amount: 200 });
    expect(settledPots(h)).toEqual([
      { amount: 250, eligibleSeats: [0], winners: [{ seatIndex: 0, amount: 250 }], uncalled: false },
      { amount: 200, eligibleSeats: [0], winners: [{ seatIndex: 0, amount: 200 }], uncalled: true },
    ]);
    const res = buildReplay(h, 0).at(-1)!;
    expect(res.view.hand!.result!.winners).toEqual([{ seatIndex: 0, amount: 250, potIds: ['pot-0'] }]);
    expect(res.line).toEqual([{ kind: 'wins', seat: 0, amount: 250 }]);
    // The stacks are the record's: nothing comes or goes.
    expect(res.view.seats.slice(0, 3).map((s) => s.stack)).toEqual([10_150, 9_950, 9_900]);
  });

  it('leaves the pots as stored when they already hold the handed-back bet, or nobody put in more than the rest', () => {
    expect(handedBack(sidePotHand())).toBeNull();
    expect(settledPots(sidePotHand())).toEqual(sidePotHand().pots);
    const called = { ...raiseFold(), players: [player(0, { stackStart: 10_000, net: 350, won: 650 }), player(1, { stackStart: 10_000, net: -50, won: 0 }), player(2, { stackStart: 10_000, net: -300, won: 0 })] };
    called.pots = [{ amount: 650, eligibleSeats: [0, 2], winners: [{ seatIndex: 0, amount: 650 }], uncalled: false }];
    expect(handedBack(called)).toBeNull();
    expect(settledPots(called)).toEqual(called.pots);
  });

  it('finds the handed-back chips in the last pot the bettor won when an all-in split the pots and a folded player shares that pot', () => {
    // Seat 0 is all in for 100; seat 1 puts in 500; seat 2 puts in 300 and folds. One side pot holds seat 1's 400 and
    // seat 2's 200 above the all-in: 200 of it is seat 1's own, nobody called.
    const h: ReplayInput = {
      ...sidePotHand(),
      potTotal: 900,
      pots: [
        { amount: 300, eligibleSeats: [0, 1], winners: [{ seatIndex: 0, amount: 300 }], uncalled: false },
        { amount: 600, eligibleSeats: [1], winners: [{ seatIndex: 1, amount: 600 }], uncalled: false },
      ],
      players: [player(0, { stackStart: 100, net: 200, won: 300 }), player(1, { stackStart: 1000, net: 100, won: 600 }), player(2, { stackStart: 1000, net: -300, won: 0 })],
    };
    expect(handedBack(h)).toEqual({ seatIndex: 1, amount: 200 });
    expect(settledPots(h)!.map((p) => [p.amount, p.uncalled, p.winners])).toEqual([
      [300, false, [{ seatIndex: 0, amount: 300 }]],
      [400, false, [{ seatIndex: 1, amount: 400 }]],
      [200, true, [{ seatIndex: 1, amount: 200 }]],
    ]);
  });

  it('shows the handed-back chips for hands recorded before pots were stored, from the per-player totals', () => {
    const h = { ...raiseFold(), pots: null };
    expect(handedBack(h)).toEqual({ seatIndex: 0, amount: 200 });
    expect(settledPots(h)).toBeNull();
    expect(buildReplay(h, 0).at(-1)!.view.hand!.result!.winners).toEqual([{ seatIndex: 0, amount: 250, potIds: [] }]);
  });
});
