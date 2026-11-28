import { RESULT_HOLD_MS, resultHoldMs, SCENE_MS, sceneMs, showdownGapMs, wentToShowdown, type Card, type HandEnding, type TableCue, type TableView } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { SEAT_HOLD_MS } from '../src/game/CueLayer';
import { outcomeFor, winBanner, winTier } from '../src/game/showdown';
import { BUDGET, holdSeats, plan, RUNOUT_BUDGET, SHOWDOWN_BUDGET, type StageCue } from '../src/game/staging';

/**
 * A hand's end read at leisure: the result's time (pace.ts), the scene's modes, the seat of a player the room stood up,
 * and what the banner and the loss note say, from the server's result alone.
 */
const end = (o: Partial<HandEnding>): HandEnding => ({ hands: 2, allIn: 0, runout: false, bust: false, ...o });

describe('pace of a hand’s end', () => {
  it('holds a result by how the hand ended', () => {
    expect(RESULT_HOLD_MS).toEqual({ fold: 2_000, showdown: 4_000, allIn: 5_000, multiway: 6_000, bust: 6_000 });
    expect(resultHoldMs(end({ hands: 1 }))).toBe(2_000);
    expect(resultHoldMs(end({}))).toBe(4_000);
    expect(resultHoldMs(end({ allIn: 1 }))).toBe(5_000);
    expect(resultHoldMs(end({ hands: 3, allIn: 2 }))).toBe(6_000);
    expect(resultHoldMs(end({ allIn: 2, bust: true }))).toBe(6_000);
    // Three hands at a showdown nobody was all in for is a showdown like another.
    expect(resultHoldMs(end({ hands: 3 }))).toBe(4_000);
  });

  it('counts the hold from the end of the scene, the longest the scene can take', () => {
    expect(wentToShowdown(end({ hands: 1 }))).toBe(false);
    expect(sceneMs(end({ hands: 1 }))).toBe(SCENE_MS.plain);
    expect(sceneMs(end({}))).toBe(SCENE_MS.showdown);
    expect(sceneMs(end({ allIn: 2, runout: true }))).toBe(SCENE_MS.runout);
    expect(showdownGapMs(end({}))).toBe(SCENE_MS.showdown + 4_000);
    expect(showdownGapMs(end({ allIn: 2, runout: true, bust: true }))).toBe(SCENE_MS.runout + 6_000);
    // The screen's scene never runs past what the room counted for it.
    expect([BUDGET, SHOWDOWN_BUDGET, RUNOUT_BUDGET]).toEqual([SCENE_MS.plain, SCENE_MS.showdown, SCENE_MS.runout]);
    // A seat is kept for the longest of them, and no longer.
    expect(SEAT_HOLD_MS).toBe(SCENE_MS.runout + RESULT_HOLD_MS.bust);
  });
});

type Shown = { seatIndex: number; cards: Card[]; rankClass: string; bestFive: Card[] };
interface SeatIn {
  bet?: number;
  stack?: number;
  hole?: Card[];
  state?: string;
  user?: string;
}
function view(o: { id?: string; seq?: number; stage?: string; board?: Card[]; potTotal?: number; seats: Record<number, SeatIn>; winners?: { seatIndex: number; amount: number; potIds: string[] }[]; showdown?: Shown[] }): TableView {
  return {
    version: o.seq ?? 1,
    seats: Array.from({ length: 6 }, (_, i) => {
      const x = o.seats[i];
      return x
        ? { seatIndex: i, state: x.state ?? 'active', userId: x.user ?? `u-${i}`, stack: x.stack ?? 1000, streetBet: x.bet ?? 0, hasCards: true, holeCards: x.hole ?? null, connected: true }
        : { seatIndex: i, state: 'empty', stack: 0, streetBet: 0, hasCards: false, connected: false };
    }),
    hand: { id: o.id ?? 'h-1', seq: o.seq ?? 1, stage: o.stage ?? 'river', board: o.board ?? [], potTotal: o.potTotal ?? 0, buttonSeat: 0, pots: [], result: o.winners ? { winners: o.winners, showdown: o.showdown ?? [] } : null },
  } as unknown as TableView;
}
let cueId = 0;
const batch = (...cues: TableCue[]): StageCue[] => cues.map((cue) => ({ id: ++cueId, cue }));
const BOARD: Card[] = ['Ah', 'Kd', '7c', '2s', '9d'];
const SHOWN: Shown[] = [
  { seatIndex: 0, cards: ['As', 'Ad'], rankClass: 'three-of-a-kind', bestFive: ['As', 'Ad', 'Ah', 'Kd', '9d'] },
  { seatIndex: 4, cards: ['Ks', 'Qh'], rankClass: 'pair', bestFive: ['Ks', 'Kd', 'Ah', 'Qh', '9d'] },
];

describe('showdown modes', () => {
  const prev = view({ seq: 3, board: BOARD, potTotal: 200, seats: { 0: {}, 4: {} } });
  const winners = [{ seatIndex: 0, amount: 200, potIds: ['pot-main-0'] }];
  const next = view({ seq: 6, stage: 'settled', board: BOARD, potTotal: 200, seats: { 0: { stack: 1200, hole: ['As', 'Ad'] }, 4: { hole: ['Ks', 'Qh'] } }, winners, showdown: SHOWN });
  const cues = () => batch({ kind: 'showdown' }, { kind: 'payout', seatIndex: 0, amount: 200 }, { kind: 'handEnd' });

  it('cinematic is the default; standard plays the same hand without the title and the dimming, and sooner', () => {
    const cine = plan(prev, cues(), next, 0)!;
    const same = plan(prev, cues(), next, 0, 'cinematic')!;
    const std = plan(prev, cues(), next, 0, 'standard')!;
    expect(cine.cine).not.toBeNull();
    expect(same.end).toBe(cine.end);
    expect(std.cine).toBeNull();
    expect(std.reveal).toBeLessThan(cine.reveal);
    expect(std.end).toBeLessThan(cine.end);
    // The showdown still sounds, and the same chips are paid.
    expect(std.sounds.map((x) => x.id)).toContain('showdown');
    expect(std.flights.filter((f) => f.kind === 'payout').map((f) => f.amount)).toEqual(cine.flights.filter((f) => f.kind === 'payout').map((f) => f.amount));
  });

  it('an all-in run-out has its own, longer budget, and the river waits a moment more', () => {
    const before = view({ seq: 2, stage: 'preflop', potTotal: 2000, seats: { 0: { stack: 0, state: 'allin' }, 4: { stack: 0, state: 'allin' } } });
    const after = view({ seq: 9, stage: 'settled', board: BOARD, potTotal: 2000, seats: { 0: { stack: 2000, hole: ['As', 'Ad'] }, 4: { stack: 0, hole: ['Ks', 'Qh'] } }, winners: [{ seatIndex: 0, amount: 2000, potIds: ['pot-main-0'] }], showdown: SHOWN });
    const run = () =>
      batch({ kind: 'street', stage: 'flop', cards: BOARD.slice(0, 3) }, { kind: 'street', stage: 'turn', cards: [BOARD[3]!] }, { kind: 'street', stage: 'river', cards: [BOARD[4]!] }, { kind: 'showdown' }, { kind: 'payout', seatIndex: 0, amount: 2000 }, { kind: 'handEnd' });
    const p = plan(before, run(), after, 0)!;
    expect(p).not.toBeNull();
    expect(p.end).toBeGreaterThan(SHOWDOWN_BUDGET);
    expect(p.end).toBeLessThanOrEqual(RUNOUT_BUDGET);
    expect(p.end).toBeGreaterThan(plan(before, run(), after, 0, 'standard')!.end);
  });
});

describe('a seat kept for its hand’s result', () => {
  const winners = [{ seatIndex: 1, amount: 200, potIds: ['pot-main-0'] }];
  const settled = view({ seq: 5, stage: 'settled', potTotal: 200, seats: { 0: { stack: 0, state: 'allin' }, 1: { stack: 1100 }, 2: { state: 'sitting_out' } }, winners });

  it('keeps the player the room stood up, out of chips, until the next deal', () => {
    const left = view({ seq: 5, stage: 'settled', potTotal: 200, seats: { 1: { stack: 1100 }, 2: { state: 'sitting_out' } }, winners });
    const held = holdSeats(settled, left, true);
    expect(held.seats[0]).toBe(settled.seats[0]);
    expect(held.seats[1]).toBe(left.seats[1]);
    // The next hand: nothing is kept.
    const dealt = view({ id: 'h-2', seq: 1, stage: 'preflop', seats: { 1: { stack: 1100 } } });
    expect(holdSeats(settled, dealt, true)).toBe(dealt);
  });

  it('gives the seat to whoever takes it, and keeps nobody who was not dealt in', () => {
    const taken = view({ seq: 5, stage: 'settled', potTotal: 200, seats: { 0: { stack: 500, user: 'u-new' }, 1: { stack: 1100 }, 2: { state: 'sitting_out' } }, winners });
    expect(holdSeats(settled, taken, true)).toBe(taken);
    // A player sitting out who leaves is simply gone.
    const gone = view({ seq: 5, stage: 'settled', potTotal: 200, seats: { 0: { stack: 0, state: 'allin' }, 1: { stack: 1100 } }, winners });
    expect(holdSeats(settled, gone, true)).toBe(gone);
  });
});

describe('the winner’s banner', () => {
  it('names the biggest winner’s hand as the server judged it; a pot won by a fold has none', () => {
    const r = { winners: [{ seatIndex: 0, amount: 200, potIds: ['pot-main-0'] }], showdown: SHOWN } as never;
    expect(winBanner(r, [{ seatIndex: 0, amount: 200, potIds: ['pot-main-0'] }])).toEqual({ winners: [{ seatIndex: 0, amount: 200 }], hand: SHOWN[0], split: false });
    const fold = { winners: [{ seatIndex: 3, amount: 90, potIds: ['pot-main-0'] }], showdown: [] } as never;
    expect(winBanner(fold, [{ seatIndex: 3, amount: 90, potIds: ['pot-main-0'] }])).toMatchObject({ hand: null, split: false });
    expect(winBanner(null, [])).toBeNull();
    expect(winBanner(fold, [])).toBeNull();
  });

  it('tells a split pot from a main pot and a side pot', () => {
    const split = [
      { seatIndex: 0, amount: 100, potIds: ['pot-main-0'] },
      { seatIndex: 4, amount: 100, potIds: ['pot-main-0'] },
    ];
    expect(winBanner({ winners: split, showdown: SHOWN } as never, split)!.split).toBe(true);
    const side = [
      { seatIndex: 4, amount: 100, potIds: ['pot-side-1'] },
      { seatIndex: 0, amount: 300, potIds: ['pot-main-0'] },
    ];
    const b = winBanner({ winners: side, showdown: SHOWN } as never, side)!;
    expect(b.split).toBe(false);
    expect(b.winners.map((w) => w.seatIndex)).toEqual([0, 4]);
    expect(b.hand).toBe(SHOWN[0]);
  });

  it('only the three rarest hands have an effect of their own', () => {
    expect(winTier({ rankClass: 'four-of-a-kind', bestFive: ['As', 'Ad', 'Ah', 'Ac', '9d'] })).toBe('quads');
    expect(winTier({ rankClass: 'straight-flush', bestFive: ['9h', '8h', '7h', '6h', '5h'] })).toBe('straight-flush');
    expect(winTier({ rankClass: 'straight-flush', bestFive: ['Ah', 'Kh', 'Qh', 'Jh', 'Th'] })).toBe('royal');
    // The wheel holds an ace and is no royal flush.
    expect(winTier({ rankClass: 'straight-flush', bestFive: ['5h', '4h', '3h', '2h', 'Ah'] })).toBe('straight-flush');
    expect(winTier({ rankClass: 'full-house', bestFive: ['As', 'Ad', 'Ah', 'Kc', 'Kd'] })).toBeNull();
    expect(winTier(null)).toBeNull();
  });
});

describe('why the hand ended as it did for me', () => {
  const won = [{ seatIndex: 0, amount: 200, potIds: ['pot-main-0'] }];
  const r = { winners: won, showdown: SHOWN } as never;

  it('a showdown lost: my hand and the winning one, as the server named them', () => {
    expect(outcomeFor(r, won, 4, 'active')).toEqual({ kind: 'lost', winner: 0, hand: SHOWN[0], mine: SHOWN[1], sameRank: false });
    expect(outcomeFor(r, won, 4, 'allin')).toMatchObject({ kind: 'lost' });
  });

  it('the same hand name on both sides: the kicker decided', () => {
    const pairs: Shown[] = [
      { seatIndex: 0, cards: ['As', 'Kc'], rankClass: 'pair', bestFive: ['As', 'Ah', 'Kd', 'Kc', '9d'] },
      { seatIndex: 4, cards: ['Ad', 'Qh'], rankClass: 'pair', bestFive: ['Ad', 'Ah', 'Kd', 'Qh', '9d'] },
    ];
    expect(outcomeFor({ winners: won, showdown: pairs } as never, won, 4, 'active')).toMatchObject({ kind: 'lost', sameRank: true });
  });

  it('names the hand that beat mine: the winner of the main pot, not of a larger side pot I had no part in', () => {
    // Stacks 100/500/500/100: seat 0's straight takes the main pot (400), seat 1's pair the side pot (800) seats 0 and 4
    // could not reach. Seat 4 lost to the straight, not to the pair.
    const shown: Shown[] = [
      { seatIndex: 0, cards: ['9s', '8c'], rankClass: 'straight', bestFive: ['9s', '8c', '7d', '6h', '5d'] },
      { seatIndex: 1, cards: ['As', 'Ac'], rankClass: 'pair', bestFive: ['As', 'Ac', '7d', '6h', '5d'] },
      { seatIndex: 4, cards: ['7s', '7c'], rankClass: 'three-of-a-kind', bestFive: ['7s', '7c', '7d', '6h', '5d'] },
    ];
    const paid = [
      { seatIndex: 1, amount: 800, potIds: ['side-1'] },
      { seatIndex: 0, amount: 400, potIds: ['main'] },
    ];
    expect(outcomeFor({ winners: paid, showdown: shown } as never, paid, 4, 'allin')).toEqual({ kind: 'lost', winner: 0, hand: shown[0], mine: shown[2], sameRank: false });
  });

  it('never names a hand the showdown did not turn over', () => {
    // I kept my losing hand face down: it is not in the result, and is not named.
    const mucked = { winners: won, showdown: [SHOWN[0]] } as never;
    expect(outcomeFor(mucked, won, 4, 'active')).toEqual({ kind: 'lost', winner: 0, hand: SHOWN[0], mine: null, sameRank: false });
    // Won by a fold: the winner's hand was never shown.
    const fold = { winners: won, showdown: [] } as never;
    expect(outcomeFor(fold, won, 4, 'folded')).toEqual({ kind: 'folded', winner: 0, hand: null });
  });

  it('a split pot and a side pot say so; the whole pot, or a hand I was not in, says nothing', () => {
    const split = [
      { seatIndex: 0, amount: 100, potIds: ['pot-main-0'] },
      { seatIndex: 4, amount: 100, potIds: ['pot-main-0'] },
    ];
    expect(outcomeFor({ winners: split, showdown: SHOWN } as never, split, 4, 'active')).toEqual({ kind: 'split', amount: 100, others: [0] });
    const side = [
      { seatIndex: 0, amount: 300, potIds: ['pot-main-0'] },
      { seatIndex: 4, amount: 100, potIds: ['pot-side-1'] },
    ];
    expect(outcomeFor({ winners: side, showdown: SHOWN } as never, side, 4, 'active')).toEqual({ kind: 'side', amount: 100, others: [0] });
    expect(outcomeFor(r, won, 0, 'active')).toBeNull();
    expect(outcomeFor(r, won, null, undefined)).toBeNull();
    expect(outcomeFor(r, won, 2, 'sitting_out')).toBeNull();
    expect(outcomeFor(null, [], 4, 'active')).toBeNull();
  });
});
