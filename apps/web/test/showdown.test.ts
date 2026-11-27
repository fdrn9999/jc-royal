import type { Card, HandStage, TableCue, TableView } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { seatSpot, showdownSeats, winningCards } from '../src/game/showdown';
import { BUDGET, boundaries, plan, SHOWDOWN_BUDGET, stagedAt, type CinePhase, type Plan, type StageCue } from '../src/game/staging';

/**
 * The showdown's scene: that only the server's showdown starts it (never a pot won by a fold, never a hand found
 * already settled), once a hand, in its order; that it lights every pot's winner and only hands the server turned
 * over; and that nothing of it outlasts its plan.
 */
type Shown = { seatIndex: number; cards: Card[]; rankClass: string; bestFive: Card[] };
interface SeatIn {
  bet?: number;
  stack?: number;
  hole?: Card[];
  state?: string;
}
function view(o: {
  id?: string;
  seq?: number;
  stage?: HandStage;
  board?: Card[];
  potTotal?: number;
  seats: Record<number, SeatIn>;
  winners?: { seatIndex: number; amount: number; potIds: string[] }[];
  showdown?: Shown[];
}): TableView {
  return {
    version: o.seq ?? 1,
    seats: Array.from({ length: 6 }, (_, i) => {
      const x = o.seats[i];
      return x
        ? { seatIndex: i, state: x.state ?? 'active', userId: `u-${i}`, stack: x.stack ?? 1000, streetBet: x.bet ?? 0, hasCards: true, holeCards: x.hole ?? null, connected: true }
        : { seatIndex: i, state: 'empty', stack: 0, streetBet: 0, hasCards: false, connected: false };
    }),
    hand: {
      id: o.id ?? 'h-1',
      seq: o.seq ?? 1,
      stage: o.stage ?? 'river',
      board: o.board ?? [],
      potTotal: o.potTotal ?? 0,
      buttonSeat: 0,
      pots: [],
      result: o.winners ? { winners: o.winners, showdown: o.showdown ?? [] } : null,
    },
  } as unknown as TableView;
}

let cueId = 0;
const batch = (...cues: TableCue[]): StageCue[] => cues.map((cue) => ({ id: ++cueId, cue }));
const BOARD: Card[] = ['Ah', 'Kd', '7c', '2s', '9d'];
/** The scene's phases in the order a plan passes through them. */
const phases = (p: Plan, v: TableView) => {
  const out: (CinePhase | null)[] = [];
  for (const t of [0, ...boundaries(p)]) {
    const ph = stagedAt(p, t, v)?.cine ?? null;
    if (out[out.length - 1] !== ph) out.push(ph);
  }
  return out;
};

/** Heads up on the river, 200 in the middle: both check, seat 0 wins at showdown. */
function headsUp() {
  const prev = view({ seq: 3, board: BOARD, potTotal: 200, seats: { 0: {}, 4: {} } });
  const winners = [{ seatIndex: 0, amount: 200, potIds: ['pot-main-0'] }];
  const showdown: Shown[] = [
    { seatIndex: 0, cards: ['As', 'Ad'], rankClass: 'three_of_a_kind', bestFive: ['As', 'Ad', 'Ah', 'Kd', '9d'] },
    { seatIndex: 4, cards: ['Ks', 'Qh'], rankClass: 'pair', bestFive: ['Ks', 'Kd', 'Ah', 'Qh', '9d'] },
  ];
  const next = view({ seq: 6, stage: 'settled', board: BOARD, potTotal: 200, seats: { 0: { stack: 1200, hole: ['As', 'Ad'] }, 4: { hole: ['Ks', 'Qh'] } }, winners, showdown });
  const cues = batch({ kind: 'action', seatIndex: 0, type: 'check', amount: 0 }, { kind: 'action', seatIndex: 4, type: 'check', amount: 0 }, { kind: 'showdown' }, { kind: 'payout', seatIndex: 0, amount: 200 }, { kind: 'handEnd' });
  return { prev, next, cues };
}

describe('showdown scene: when it plays', () => {
  it('the server’s showdown starts it: grey, the title, the hands, the winning cards, the chips, the colour back, in that order', () => {
    const { prev, next, cues } = headsUp();
    const p = plan(prev, cues, next, 0)!;
    expect(p.cine).not.toBeNull();
    expect(phases(p, next)).toEqual([null, 'dimming', 'title', 'reveal', 'highlight', 'settlement', 'restore', null]);
    const c = p.cine!;
    // Unhurried (the plan fits its budget): the table greys for 180 ms, the title shows for 570 ms, until the hands turn.
    expect(c.title - c.dim).toBe(180);
    expect(p.reveal - c.title).toBe(570);
    // The hands turn before the result shows, the result before the chips are paid, and the colour is back at the end.
    expect(p.result).toBeGreaterThan(p.reveal);
    const pay = p.flights.find((f) => f.kind === 'payout')!;
    expect(c.settle).toBe(pay.at);
    expect(c.restore).toBe(pay.at + pay.dur);
    expect(p.end).toBeGreaterThan(c.restore);
    expect(p.end).toBeLessThanOrEqual(SHOWDOWN_BUDGET);
    // The cards stay face down, and nobody is named a winner, until the scene gets there.
    expect(stagedAt(p, c.title, next)).toMatchObject({ reveal: false, result: false, cine: 'title' });
    expect(stagedAt(p, p.reveal, next)).toMatchObject({ reveal: true, result: false, cine: 'reveal' });
    // Its sound comes with the title.
    expect(p.sounds.find((x) => x.id === 'showdown')!.at).toBe(c.title);
  });

  it('a pot won by a fold has none, though the hand is settled just the same', () => {
    const prev = view({ seq: 4, stage: 'turn', board: BOARD.slice(0, 4), potTotal: 250, seats: { 1: { bet: 150 }, 2: {} } });
    const winners = [{ seatIndex: 1, amount: 250, potIds: ['pot-main-0'] }];
    const next = view({ seq: 6, stage: 'settled', board: BOARD.slice(0, 4), potTotal: 250, seats: { 1: { stack: 1250 }, 2: { state: 'folded' } }, winners });
    const p = plan(prev, batch({ kind: 'action', seatIndex: 2, type: 'fold', amount: 0 }, { kind: 'returned', seatIndex: 1, amount: 150 }, { kind: 'payout', seatIndex: 1, amount: 100 }, { kind: 'handEnd' }), next, 2)!;
    expect(p).not.toBeNull();
    expect(p.cine).toBeNull();
    expect(p.end).toBeLessThanOrEqual(BUDGET);
    for (const t of [0, ...boundaries(p)]) expect(stagedAt(p, t, next)?.cine ?? null).toBeNull();
    expect(p.sounds.map((x) => x.id)).not.toContain('showdown');
  });

  it('never twice for a hand: a settled hand seen again (a reload, a reconnect, its cues sent again) plans nothing', () => {
    const { prev, next, cues } = headsUp();
    expect(plan(prev, cues, next, 0)!.cine).not.toBeNull();
    // The page now holds the settled state: the same cues over it, or over nothing (a page just loaded), stage nothing.
    expect(plan(next, cues, next, 0)).toBeNull();
    expect(plan(null, cues, next, 0)).toBeNull();
    // What follows a showdown in the same hand (a card shown after it) carries no showdown cue: no scene.
    expect(plan(next, batch({ kind: 'handEnd' }), next, 0)).toBeNull();
  });

  it('an all-in run-out keeps its order inside the scene: the hands first, each street in turn, then the result', () => {
    const prev = view({ seq: 2, stage: 'preflop', potTotal: 500, seats: { 1: { bet: 500, stack: 0 }, 3: { stack: 500 } } });
    const winners = [{ seatIndex: 3, amount: 1000, potIds: ['pot-main-0'] }];
    const next = view({ seq: 9, stage: 'settled', board: BOARD, potTotal: 1000, seats: { 1: { stack: 0 }, 3: { stack: 1000 } }, winners });
    const cues = batch(
      { kind: 'action', seatIndex: 3, type: 'call', amount: 500 },
      { kind: 'street', stage: 'flop', cards: BOARD.slice(0, 3) },
      { kind: 'street', stage: 'turn', cards: [BOARD[3]!] },
      { kind: 'street', stage: 'river', cards: [BOARD[4]!] },
      { kind: 'showdown' },
      { kind: 'payout', seatIndex: 3, amount: 1000 },
      { kind: 'handEnd' },
    );
    const p = plan(prev, cues, next, 1)!;
    expect(p.cine).not.toBeNull();
    expect(p.end).toBeLessThanOrEqual(SHOWDOWN_BUDGET);
    const [flop, , , turn, river] = p.board!.at;
    expect(p.cine!.dim).toBeLessThan(p.cine!.title);
    expect(p.cine!.title).toBeLessThan(p.reveal);
    expect(p.reveal).toBeLessThan(flop!);
    expect(flop!).toBeLessThan(turn!);
    expect(turn!).toBeLessThan(river!);
    expect(river!).toBeLessThan(p.result);
    // The whole run-out plays with the hands face up and the table grey; nobody has won yet.
    expect(stagedAt(p, turn!, next)).toMatchObject({ cine: 'reveal', board: 4, result: false });
    expect(phases(p, next)).toEqual([null, 'dimming', 'title', 'reveal', 'highlight', 'settlement', 'restore', null]);
  });

  it('nothing outlasts its plan: over at the end, at once for another hand, and its every change is a redraw', () => {
    const { prev, next, cues } = headsUp();
    const p = plan(prev, cues, next, 0)!;
    expect(stagedAt(p, p.end, next)).toBeNull();
    // The next hand's state: the scene is gone with the plan, whatever the moment.
    const other = view({ id: 'h-2', seq: 1, stage: 'preflop', seats: { 0: {}, 4: {} } });
    expect(stagedAt(p, p.cine!.title, other)).toBeNull();
    // The scene changes only at moments the page is redrawn at.
    const b = boundaries(p);
    for (const at of [p.cine!.dim, p.cine!.title, p.reveal, p.result, p.cine!.settle, p.cine!.restore, p.end]) expect(b).toContain(at);
  });
});

describe('showdown scene: what it lights', () => {
  const result = {
    winners: [
      { seatIndex: 3, amount: 300, potIds: ['pot-main-0'] },
      { seatIndex: 1, amount: 500, potIds: ['pot-side-1'] },
      { seatIndex: 2, amount: 200, potIds: ['pot-side-2'] },
      { seatIndex: 5, amount: 200, potIds: ['pot-side-2'] },
    ],
    showdown: [
      { seatIndex: 3, cards: ['As', 'Ad'], rankClass: 'three_of_a_kind', bestFive: ['As', 'Ad', 'Ah', 'Kd', '9d'] },
      { seatIndex: 1, cards: ['Ks', 'Kc'], rankClass: 'three_of_a_kind', bestFive: ['Ks', 'Kc', 'Kd', 'Ah', '9d'] },
      { seatIndex: 2, cards: ['9s', '7d'], rankClass: 'two_pair', bestFive: ['9s', '9d', '7d', '7c', 'Ah'] },
      { seatIndex: 5, cards: ['9h', '7h'], rankClass: 'two_pair', bestFive: ['9h', '9d', '7h', '7c', 'Ah'] },
    ],
  } as unknown as NonNullable<NonNullable<TableView['hand']>['result']>;

  it('every pot’s winner: the main pot’s, each side pot’s and both halves of a split, not the first one’s only', () => {
    const lit = winningCards(result, result.winners.map((w) => w.seatIndex));
    for (const x of result.showdown) for (const c of x.bestFive) expect(lit).toContain(c);
    expect(new Set(lit).size).toBe(lit.length);
    // One winner alone: only that hand's five.
    expect([...winningCards(result, [1])].sort()).toEqual(['9d', 'Ah', 'Kc', 'Kd', 'Ks']);
    expect(winningCards(null, [1])).toEqual([]);
  });

  it('only hands the server turned over: a loser who kept their hand face down is no part of the scene', () => {
    // Seat 4 lost and mucked: the server's showdown list leaves it out, and nothing here knows its cards.
    const seats = showdownSeats(result);
    expect([...seats].sort()).toEqual([1, 2, 3, 5]);
    expect(seats.has(4)).toBe(false);
    expect(seatSpot('reveal', seats.has(4))).toBe('out');
    expect(seatSpot('highlight', seats.has(4))).toBe('out');
    // A winner who did not show (nothing in the list for them) lights no card.
    expect(winningCards(result, [4])).toEqual([]);
    expect(showdownSeats(null).size).toBe(0);
  });

  it('a seat is grey until the hands turn, then in colour only if it is in the showdown, and itself again after', () => {
    expect(seatSpot(null, true)).toBeNull();
    for (const ph of ['dimming', 'title'] as const) expect([seatSpot(ph, true), seatSpot(ph, false)]).toEqual(['out', 'out']);
    for (const ph of ['reveal', 'highlight', 'settlement'] as const) expect([seatSpot(ph, true), seatSpot(ph, false)]).toEqual(['in', 'out']);
    expect([seatSpot('restore', true), seatSpot('restore', false)]).toEqual([null, null]);
  });
});
