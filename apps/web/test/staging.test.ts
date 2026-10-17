import type { ActionType, Card, HandStage, TableCue, TableView } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { FreeSession } from '../src/academy/practice/free';
import { BUDGET, boundaries, collected, dealDelays, MAX_CUES, plan, quickSounds, sig, stagedAt, type Plan, type StageCue } from '../src/game/staging';

interface SeatIn {
  bet?: number;
  stack?: number;
  cards?: boolean;
  hole?: Card[];
}

/** Six seats (unlisted ones empty); `seats` by seat index. */
function view(o: { id?: string; seq?: number; stage?: HandStage; board?: Card[]; potTotal?: number; button?: number; seats: Record<number, SeatIn>; winners?: { seatIndex: number; amount: number; potIds: string[] }[] }): TableView {
  return {
    version: o.seq ?? 1,
    seats: Array.from({ length: 6 }, (_, i) => {
      const x = o.seats[i];
      return x
        ? { seatIndex: i, state: 'active', stack: x.stack ?? 1000, streetBet: x.bet ?? 0, hasCards: x.cards ?? true, holeCards: x.hole ?? null, connected: true }
        : { seatIndex: i, state: 'empty', stack: 0, streetBet: 0, hasCards: false, connected: false };
    }),
    hand: {
      id: o.id ?? 'h-1',
      seq: o.seq ?? 1,
      stage: o.stage ?? 'flop',
      board: o.board ?? [],
      potTotal: o.potTotal ?? 0,
      buttonSeat: o.button ?? 0,
      pots: [],
      result: o.winners ? { winners: o.winners, showdown: [] } : null,
    },
  } as unknown as TableView;
}

let cueId = 0;
const batch = (...cues: TableCue[]): StageCue[] => cues.map((cue) => ({ id: ++cueId, cue }));
const act = (seatIndex: number, type: ActionType, amount = 0): TableCue => ({ kind: 'action', seatIndex, type, amount });
const FLOP: Card[] = ['Ah', 'Kd', '7c'];

describe('staging: chips', () => {
  it('slides each street bet into the pot with its own amount (never a fixed chip), after the call lands', () => {
    // Flop: seat 1 bet 50 into a pot of 100, seat 2 calls; the turn comes.
    const prev = view({ seq: 5, board: FLOP, potTotal: 150, seats: { 1: { bet: 50 }, 2: {} } });
    const next = view({ seq: 7, stage: 'turn', board: [...FLOP, '2s'], potTotal: 200, seats: { 1: {}, 2: {} } });
    const p = plan(prev, batch(act(2, 'call', 50), { kind: 'street', stage: 'turn', cards: ['2s'] }), next, 2)!;
    expect(p).not.toBeNull();
    expect(p.flights.map((f) => [f.kind, f.seat, f.amount])).toEqual([
      ['bet', 2, 50],
      ['sweep', 1, 50],
      ['sweep', 2, 50],
    ]);
    const call = p.flights[0]!;
    const sweep = p.flights[1]!;
    // The call shows in front of seat 2 only once it lands, and both bets leave before the pot counts them.
    expect(stagedAt(p, 0, next)!).toMatchObject({ bets: { 1: 50, 2: 0 }, pot: 100, board: 3 });
    expect(stagedAt(p, call.at + call.dur, next)!.bets[2]).toBe(50);
    expect(stagedAt(p, sweep.at, next)!).toMatchObject({ bets: { 1: 0, 2: 0 }, pot: 100 });
    expect(stagedAt(p, sweep.at + sweep.dur, next)!.pot).toBe(200);
    expect(p.board!.at[0]).toBeGreaterThanOrEqual(sweep.at + sweep.dur);
    expect(stagedAt(p, p.end, next)).toBeNull();
    expect(p.sounds.map((x) => x.id)).toEqual(['call', 'flip']);
  });

  it('pays each winner once, with what they won, side pots first; the pot empties as they leave', () => {
    // River: seat 3 (short) all in for 100 earlier; seats 1 and 2 bet 300 each this street. Seat 3 wins the main pot,
    // seat 1 the side pot.
    const prev = view({ seq: 9, stage: 'river', board: [...FLOP, '2s', '9d'], potTotal: 900, seats: { 1: { bet: 300 }, 2: {}, 3: { stack: 0 } } });
    const winners = [
      { seatIndex: 3, amount: 300, potIds: ['pot-main-0'] },
      { seatIndex: 1, amount: 900, potIds: ['pot-side-1'] },
    ];
    const next = view({ seq: 11, stage: 'settled', board: prev.hand!.board, potTotal: 1200, seats: { 1: { stack: 1600 }, 2: { stack: 700 }, 3: { stack: 300 } }, winners });
    const cues = batch(act(2, 'call', 300), { kind: 'showdown' }, { kind: 'payout', seatIndex: 3, amount: 300 }, { kind: 'payout', seatIndex: 1, amount: 900 }, { kind: 'handEnd' });
    const p = plan(prev, cues, next, 2)!;
    expect(p).not.toBeNull();
    const pays = p.flights.filter((f) => f.kind === 'payout');
    expect(pays.map((f) => [f.seat, f.amount])).toEqual([
      [1, 900],
      [3, 300],
    ]);
    expect(pays[1]!.at).toBeGreaterThan(pays[0]!.at);
    const lastPay = pays[1]!;
    expect(stagedAt(p, pays[0]!.at, next)!.pot).toBe(300);
    expect(stagedAt(p, lastPay.at, next)!.pot).toBe(0);
    // A winner's stack waits for its chips; the others' never change.
    expect(stagedAt(p, p.result, next)!.stacks).toEqual({ 1: 700, 3: 0 });
    expect(stagedAt(p, lastPay.at + lastPay.dur, next)!.stacks).toEqual({});
    // The hands show before the result, the result before the chips.
    expect(p.reveal).toBeGreaterThan(0);
    expect(p.result).toBeGreaterThan(p.reveal);
    expect(pays[0]!.at).toBeGreaterThan(p.result);
    // Not my seat: no win sound, a chip sound per payout.
    expect(p.sounds.filter((x) => x.id === 'win')).toEqual([]);
    expect(p.sounds.filter((x) => x.id === 'chip')).toHaveLength(2);
  });

  it('splits a pot one winner after another, each with their share', () => {
    const prev = view({ seq: 3, stage: 'river', board: [...FLOP, '2s', '9d'], potTotal: 200, seats: { 0: {}, 4: {} } });
    const winners = [
      { seatIndex: 0, amount: 100, potIds: ['pot-main-0'] },
      { seatIndex: 4, amount: 100, potIds: ['pot-main-0'] },
    ];
    const next = view({ seq: 6, stage: 'settled', board: prev.hand!.board, potTotal: 200, seats: { 0: { stack: 1100 }, 4: { stack: 1100 } }, winners });
    const p = plan(prev, batch(act(0, 'check'), act(4, 'check'), { kind: 'showdown' }, { kind: 'payout', seatIndex: 0, amount: 100 }, { kind: 'payout', seatIndex: 4, amount: 100 }), next, 0)!;
    expect(p.flights.map((f) => [f.kind, f.seat, f.amount])).toEqual([
      ['payout', 0, 100],
      ['payout', 4, 100],
    ]);
    expect(p.sounds.filter((x) => x.id === 'win')).toHaveLength(1);
  });

  it('a fold ends the hand: the bets go in, then the one payout, with no showdown', () => {
    const prev = view({ seq: 4, stage: 'preflop', potTotal: 15, seats: { 0: { bet: 5 }, 1: { bet: 10 } } });
    const next = view({ seq: 5, stage: 'settled', potTotal: 15, seats: { 0: { stack: 995, cards: false }, 1: { stack: 1005 } }, winners: [{ seatIndex: 1, amount: 15, potIds: ['pot-main-0'] }] });
    const p = plan(prev, batch(act(0, 'fold'), { kind: 'payout', seatIndex: 1, amount: 15 }, { kind: 'handEnd' }), next, 1)!;
    expect(p.flights.map((f) => [f.kind, f.seat, f.amount])).toEqual([
      ['sweep', 0, 5],
      ['sweep', 1, 10],
      ['payout', 1, 15],
    ]);
    expect(p.reveal).toBe(0);
    expect(p.sounds.map((x) => x.id)).toEqual(['fold', 'win']);
  });

  it('shows the server state at once when a batch does not add up to it', () => {
    const prev = view({ seq: 5, board: FLOP, potTotal: 150, seats: { 1: { bet: 50 }, 2: {} } });
    // A state was missed: the pot is bigger than these cues explain.
    const next = view({ seq: 9, stage: 'turn', board: [...FLOP, '2s'], potTotal: 400, seats: { 1: {}, 2: {} } });
    expect(plan(prev, batch(act(2, 'call', 50), { kind: 'street', stage: 'turn', cards: ['2s'] }), next, 2)).toBeNull();
    // Or a street with the wrong number of cards.
    const short = view({ seq: 7, stage: 'turn', board: FLOP, potTotal: 200, seats: { 1: {}, 2: {} } });
    expect(plan(prev, batch(act(2, 'call', 50), { kind: 'street', stage: 'turn', cards: ['2s'] }), short, 2)).toBeNull();
  });

  it('stages nothing for a hand already over, another hand, too many cues or a first sight', () => {
    const settled = view({ seq: 5, stage: 'settled', potTotal: 15, seats: { 0: { stack: 1015 }, 1: {} }, winners: [{ seatIndex: 0, amount: 15, potIds: ['pot-main-0'] }] });
    expect(plan(settled, batch({ kind: 'payout', seatIndex: 0, amount: 15 }), settled, 0)).toBeNull();
    const other = view({ id: 'h-2', seq: 7, potTotal: 0, seats: { 0: {}, 1: {} } });
    expect(plan(settled, batch(act(0, 'check')), other, 0)).toBeNull();
    const prev = view({ seq: 5, seats: { 0: {}, 1: {} } });
    expect(plan(prev, batch(...Array.from({ length: MAX_CUES + 1 }, () => act(0, 'check'))), prev, 0)).toBeNull();
    expect(plan(null, batch(act(0, 'check')), prev, 0)).toBeNull();
    // Seats taken or left are not the scene's to stage.
    expect(plan(prev, batch({ kind: 'seat', seatIndex: 3, nickname: 'x' }), prev, 0)).toBeNull();
  });

  it('a stack held for its payout shows at once once something else changed it (a top-up)', () => {
    const prev = view({ seq: 4, stage: 'preflop', potTotal: 15, seats: { 0: { bet: 5 }, 1: { bet: 10 } } });
    const next = view({ seq: 5, stage: 'settled', potTotal: 15, seats: { 0: { stack: 995, cards: false }, 1: { stack: 1005 } }, winners: [{ seatIndex: 1, amount: 15, potIds: ['pot-main-0'] }] });
    const p = plan(prev, batch(act(0, 'fold'), { kind: 'payout', seatIndex: 1, amount: 15 }), next, 1)!;
    expect(stagedAt(p, p.result, next)!.stacks).toEqual({ 1: 990 });
    const toppedUp = view({ seq: 6, stage: 'settled', potTotal: 15, seats: { 0: { stack: 995 }, 1: { stack: 2000 } } });
    expect(stagedAt(p, p.result, toppedUp)!.stacks).toEqual({});
  });
});

describe('staging: cards', () => {
  it('an all-in run-out shows the hands first, then each street in turn, then the result, within the budget', () => {
    const prev = view({ seq: 3, stage: 'preflop', potTotal: 1010, seats: { 0: { bet: 1000, stack: 0 }, 1: { bet: 10, stack: 990 } } });
    const board: Card[] = [...FLOP, '2s', '9d'];
    const next = view({ seq: 9, stage: 'settled', board, potTotal: 2000, seats: { 0: { stack: 2000 }, 1: { stack: 0 } }, winners: [{ seatIndex: 0, amount: 2000, potIds: ['pot-main-0'] }] });
    const cues = batch(
      act(1, 'call', 990),
      { kind: 'street', stage: 'flop', cards: FLOP },
      { kind: 'street', stage: 'turn', cards: ['2s'] },
      { kind: 'street', stage: 'river', cards: ['9d'] },
      { kind: 'showdown' },
      { kind: 'payout', seatIndex: 0, amount: 2000 },
      { kind: 'handEnd' },
    );
    const p = plan(prev, cues, next, 1)!;
    expect(p).not.toBeNull();
    expect(p.end).toBeLessThanOrEqual(BUDGET);
    const [f1, f2, f3, turn, river] = p.board!.at;
    expect(p.board!.from).toBe(0);
    expect(p.reveal).toBeLessThan(f1!);
    expect(f1! < f2! && f2! < f3! && f3! < turn! && turn! < river!).toBe(true);
    // Streets of a run-out come well apart, the cards of one street close together.
    expect(turn! - f3!).toBeGreaterThan(f2! - f1!);
    expect(p.result).toBeGreaterThan(river!);
    expect(stagedAt(p, p.reveal - 1, next)!).toMatchObject({ board: 0, reveal: false, result: false });
    expect(stagedAt(p, turn!, next)!).toMatchObject({ board: 4, reveal: true, result: false });
    expect(stagedAt(p, p.result, next)!).toMatchObject({ board: 5, result: true });
    // The next state for the hand (a seat left) does not change where it ends; the timers redraw at each step.
    expect(sig(next)).toBe(p.final);
    expect(boundaries(p)).toContain(p.result);
    expect(boundaries(p).at(-1)).toBe(p.end);
  });

  it('deals clockwise from the seat after the button, a round of first cards then the second, within a second', () => {
    const v = view({ stage: 'preflop', button: 3, seats: { 0: {}, 1: { cards: false }, 3: {}, 4: {}, 5: {} } });
    const d = dealDelays(v);
    expect(Object.keys(d).map(Number)).toEqual(expect.arrayContaining([0, 3, 4, 5]));
    expect(d[1]).toBeUndefined();
    const order = Object.entries(d).sort((a, b) => a[1][0] - b[1][0]).map(([k]) => Number(k));
    expect(order).toEqual([4, 5, 0, 3]);
    const last = Math.max(...Object.values(d).map((x) => x[1]));
    expect(last).toBeLessThan(1000);
    expect(Math.min(...Object.values(d).map((x) => x[1]))).toBeGreaterThan(Math.max(...Object.values(d).map((x) => x[0])));
    const p = plan(null, batch({ kind: 'handStart', handNumber: 2 }, { kind: 'deal' }), v, 0)!;
    expect(p.flights).toEqual([]);
    expect(p.sounds.map((x) => x.id)).toEqual(['deal', 'deal']);
    expect(stagedAt(p, 0, v)!).toMatchObject({ bets: {}, pot: null, board: null, reveal: true, result: true });
  });
});

describe('staging: sounds without a plan', () => {
  it('keeps the two that matter most, once each', () => {
    const cues = batch(act(1, 'call', 10), act(2, 'call', 10), act(3, 'raise', 40), { kind: 'street', stage: 'flop', cards: FLOP }, { kind: 'payout', seatIndex: 0, amount: 10 });
    expect(quickSounds(cues, 0)).toEqual(['win', 'raise']);
    expect(quickSounds(batch(act(1, 'check'), act(2, 'check')), 0)).toEqual(['check']);
    expect(quickSounds(batch({ kind: 'seat', seatIndex: 1, nickname: 'x' }), 0)).toEqual([]);
  });
});

describe('staging: real hands', () => {
  /** Every batch of real hands (engine, bots, all-ins, side pots) adds up: staged from where it starts to where it ends. */
  it('plans every batch of 80 six-handed hands and lands on the server state', async () => {
    let seed = 7;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const s = new FreeSession({ bots: 5, style: 'mixed' }, 'Hero', rand);
    let prev = s.view();
    let seen = 0;
    const kinds = new Set<string>();
    const check = (p: Plan | null, before: TableView, cues: StageCue[], after: TableView) => {
      const staged = cues.filter((c) => !['seat', 'leave'].includes(c.cue.kind));
      if (!staged.length) return;
      expect(p, JSON.stringify(cues.map((c) => c.cue))).not.toBeNull();
      if (staged.some((c) => c.cue.kind === 'handStart')) return;
      seen++;
      expect(p!.end).toBeLessThanOrEqual(BUDGET);
      const first = stagedAt(p!, 0, after)!;
      for (const x of before.seats) expect(first.bets[x.seatIndex] ?? (after.hand!.stage === 'settled' ? 0 : x.streetBet)).toBe(x.streetBet);
      expect(first.pot ?? collected(after)).toBe(collected(before));
      const lastT = p!.end - 1;
      const end = stagedAt(p!, lastT, after)!;
      // As TableScene draws them: no bets once the hand is settled.
      const settled = after.hand!.stage === 'settled';
      for (const x of after.seats) expect(end.bets[x.seatIndex] ?? (settled ? 0 : x.streetBet), `bet ${x.seatIndex}`).toBe(settled ? 0 : x.streetBet);
      expect(end.pot ?? collected(after)).toBe(collected(after));
      expect(end.stacks).toEqual({});
      const pays = cues.filter((c) => c.cue.kind === 'payout').map((c) => c.cue as { seatIndex: number; amount: number });
      const flown = p!.flights.filter((f) => f.kind === 'payout');
      expect(flown.map((f) => f.amount).sort()).toEqual(pays.map((x) => x.amount).sort());
      for (const f of p!.flights) expect(f.amount).toBeGreaterThan(0);
      for (const c of cues) kinds.add(c.cue.kind === 'action' ? `action:${c.cue.type}` : c.cue.kind);
      if (pays.length > 1) kinds.add('multi-payout');
      if (after.seats.some((x) => x.state === 'allin')) kinds.add('allin');
      if (cues.some((c) => c.cue.kind === 'showdown') && cues.some((c) => c.cue.kind === 'street')) kinds.add('runout');
    };
    for (let hand = 0; hand < 80; hand++) {
      for (let guard = 0; guard < 200 && !s.settled; guard++) {
        const from = s.cues.length ? s.cues[s.cues.length - 1]!.id : 0;
        if (s.isHeroTurn()) {
          const legal = s.heroLegal();
          const has = (t: ActionType) => legal.find((o) => o.type === t);
          const r = rand();
          // Now and then all in (a raise to the most, when the engine offers no separate all-in), to get side pots.
          const shove = has('allin') ?? has('raise') ?? has('bet');
          if (r < 0.15 && shove) await s.heroAct(shove.type, shove.type === 'allin' ? undefined : (shove as { max: number }).max);
          else await s.heroAct(has('check') ? 'check' : r < 0.6 && has('call') ? 'call' : 'fold');
        } else if (!(await s.step())) break;
        const next = s.view();
        const cues = s.cues.filter((c) => c.id > from);
        check(plan(prev, cues, next, 0), prev, cues, next);
        prev = next;
      }
      const from = s.cues.length ? s.cues[s.cues.length - 1]!.id : 0;
      s.newHand();
      const next = s.view();
      const cues = s.cues.filter((c) => c.id > from);
      check(plan(prev, cues, next, 0), prev, cues, next);
      prev = next;
      s.consumeCues(Number.MAX_SAFE_INTEGER);
    }
    expect(seen).toBeGreaterThan(200);
    expect([...kinds]).toEqual(expect.arrayContaining(['action:fold', 'action:call', 'action:raise', 'street', 'showdown', 'payout', 'multi-payout', 'allin', 'runout']));
  });
});
