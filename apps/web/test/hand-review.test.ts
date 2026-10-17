import { describe, expect, it } from 'vitest';
import { lessonLinksFor } from '../src/academy/handLinks';
import { oddsRatio, potOddsFor, type PotOddsInput } from '../src/game/potOdds';

type A = [seat: number, stage: string, type: string, amount: number];
const hand = (acts: A[], stacks: Record<number, number> = { 0: 1000, 1: 1000, 2: 1000 }, hero = 0): PotOddsInput => ({
  actions: acts.map(([seatIndex, stage, type, amount]) => ({ seatIndex, stage, type, amount })),
  players: Object.entries(stacks).map(([s, stackStart]) => ({ seatIndex: Number(s), isYou: Number(s) === hero, stackStart })),
});

describe('pot odds of a finished hand', () => {
  it('counts the call against the pot before it, bet included, street by street', () => {
    const h = hand([
      [0, 'preflop', 'post-sb', 50],
      [1, 'preflop', 'post-bb', 100],
      [0, 'preflop', 'call', 50],
      [1, 'preflop', 'check', 0],
      [1, 'flop', 'bet', 200],
      [0, 'flop', 'call', 200],
      [1, 'turn', 'bet', 250],
      [0, 'turn', 'fold', 0],
    ]);
    const o = potOddsFor(h);
    expect([...o.keys()]).toEqual([2, 5, 7]);
    expect(o.get(2)).toEqual({ toCall: 50, pot: 150, need: 25 });
    expect(oddsRatio(o.get(2)!)).toBe('3 : 1');
    // The pot keeps every street's chips; what is owed counts only this street's bets.
    expect(o.get(5)).toEqual({ toCall: 200, pot: 400, need: 33 });
    expect(o.get(7)).toEqual({ toCall: 250, pot: 850, need: 23 });
    expect(oddsRatio(o.get(7)!)).toBe('3.4 : 1');
  });

  it('owes only the difference after a raise over the viewer’s own bet', () => {
    const o = potOddsFor(
      hand([
        [0, 'flop', 'bet', 100],
        [1, 'flop', 'raise', 300],
        [0, 'flop', 'call', 200],
      ]),
    );
    expect(o.get(2)).toEqual({ toCall: 200, pot: 400, need: 33 });
  });

  it('leaves out what the record cannot settle, and other players’ calls', () => {
    // A short all-in plays for part of the pot only.
    expect(potOddsFor(hand([[1, 'flop', 'bet', 500], [0, 'flop', 'allin', 300]], { 0: 300, 1: 1000 })).size).toBe(0);
    // An all-in that raises is not a call; one for exactly the call with every chip left is.
    expect(potOddsFor(hand([[1, 'flop', 'bet', 200], [0, 'flop', 'allin', 800]], { 0: 800, 1: 1000 })).size).toBe(0);
    expect(potOddsFor(hand([[1, 'flop', 'bet', 200], [0, 'flop', 'allin', 200]], { 0: 200, 1: 1000 })).get(1)).toEqual({ toCall: 200, pot: 200, need: 50 });
    // A call whose amount is not what the bet asked for is not trusted.
    expect(potOddsFor(hand([[1, 'flop', 'bet', 200], [0, 'flop', 'call', 150]])).size).toBe(0);
    // Nothing to call, a timeout, a check, someone else's call, or no seat of the viewer's.
    expect(potOddsFor(hand([[0, 'flop', 'fold', 0]])).size).toBe(0);
    expect(potOddsFor(hand([[1, 'flop', 'bet', 200], [0, 'flop', 'timeout-fold', 0]])).size).toBe(0);
    expect(potOddsFor(hand([[0, 'flop', 'bet', 200], [1, 'flop', 'call', 200]])).size).toBe(0);
    expect(potOddsFor({ ...hand([[1, 'flop', 'bet', 200], [0, 'flop', 'call', 200]]), players: [{ seatIndex: 0, isYou: false, stackStart: 1000 }] }).size).toBe(0);
  });
});

describe('hand review lesson link for a call', () => {
  const players = [
    { seatIndex: 0, isYou: true, won: 0, rankClass: null, stackStart: 1000 },
    { seatIndex: 1, isYou: false, won: 300, rankClass: null, stackStart: 1000 },
  ];
  it('links the viewer’s own call to the calling practice, not someone else’s', () => {
    const mine = lessonLinksFor({ board: [], actions: [{ seatIndex: 1, stage: 'flop', type: 'bet', amount: 100 }, { seatIndex: 0, stage: 'flop', type: 'call', amount: 100 }, { seatIndex: 0, stage: 'turn', type: 'fold', amount: 0 }], players });
    expect(mine.map((x) => x.id)).toEqual(['no-showdown', 'call', 'fold']);
    expect(mine.find((x) => x.id === 'call')!.to).toBe('/academy/practice/B');
    const theirs = lessonLinksFor({ board: [], actions: [{ seatIndex: 0, stage: 'flop', type: 'bet', amount: 100 }, { seatIndex: 1, stage: 'flop', type: 'call', amount: 100 }], players });
    expect(theirs.map((x) => x.id)).not.toContain('call');
  });
});
