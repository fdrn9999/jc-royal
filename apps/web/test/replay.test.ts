import { describe, expect, it } from 'vitest';
import { buildReplay, replayPots, type ReplayInput } from '../src/game/replay';

const a = (seatIndex: number, stage: string, type: string, amount = 0) => ({ seatIndex, stage, type, amount });
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
    expect(res.hand!.result).toEqual({ winners: [{ seatIndex: 0, amount: 40, potIds: ['pot-0'] }], showdown: [] });
    expect(res.seats.map((s) => s.stack)).toEqual([510, 490]);
    expect(res.seats[0]!.holeCards).toBeNull();
  });

  it('replays hands recorded before pots and the button were stored from the per-player totals', () => {
    const h = { ...sidePotHand(), pots: null, buttonSeat: null };
    const res = buildReplay(h, 1).at(-1)!.view;
    expect(res.hand!.buttonSeat).toBe(-1);
    expect(res.hand!.result!.winners).toEqual([
      { seatIndex: 0, amount: 300, potIds: [] },
      { seatIndex: 2, amount: 600, potIds: [] },
    ]);
  });
});
