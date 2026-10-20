import { describe, expect, it } from 'vitest';
import { lessonLinksFor, type ReviewedHand } from '../src/academy/handLinks';
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
    // The call and the fold both faced a bet, so the pot-odds topic comes before the practice.
    expect(mine.map((x) => x.id)).toEqual(['no-showdown', 'pot-odds', 'call', 'fold']);
    expect(mine.find((x) => x.id === 'call')!.to).toBe('/academy/practice/B');
    const theirs = lessonLinksFor({ board: [], actions: [{ seatIndex: 0, stage: 'flop', type: 'bet', amount: 100 }, { seatIndex: 1, stage: 'flop', type: 'call', amount: 100 }], players });
    expect(theirs.map((x) => x.id)).not.toContain('call');
  });
});

describe('hand review study topics, from the public actions alone', () => {
  // Seat 0 posts the small blind, seat 1 the big blind; preflop goes 2, 3, 0, 1.
  type R = [seat: number, type: string, amount: number, stage?: string];
  const review = (acts: R[], hero: number, stacks: Record<number, number> = { 0: 1000, 1: 1000, 2: 1000, 3: 1000 }): ReviewedHand => ({
    board: [],
    actions: acts.map(([seatIndex, type, amount, stage = 'preflop']) => ({ seatIndex, stage, type, amount })),
    players: Object.entries(stacks).map(([s, stackStart]) => ({ seatIndex: Number(s), isYou: Number(s) === hero, won: 0, rankClass: null, stackStart })),
  });
  const blinds: R[] = [[0, 'post-sb', 5], [1, 'post-bb', 10]];
  const ids = (acts: R[], hero: number) => lessonLinksFor(review(acts, hero)).map((x) => x.id);
  const to = (acts: R[], hero: number, id: string) => lessonLinksFor(review(acts, hero)).find((x) => x.id === id)?.to;

  it('links a call or fold facing a bet to the pot-odds calculator, and nothing else to it', () => {
    expect(to([...blinds, [2, 'raise', 30], [3, 'call', 30], [0, 'fold', 0], [1, 'fold', 0], [2, 'bet', 50, 'flop'], [3, 'fold', 0, 'flop']], 3, 'pot-odds')).toBe('/academy/gto/math?step=0');
    // The viewer opened and took it down, or checked a limped pot through, or only someone else called: no bet faced.
    expect(ids([...blinds, [2, 'raise', 30], [3, 'fold', 0], [0, 'fold', 0], [1, 'fold', 0]], 2)).not.toContain('pot-odds');
    expect(ids([...blinds, [2, 'fold', 0], [3, 'fold', 0], [0, 'call', 5], [1, 'check', 0], [0, 'check', 0, 'flop'], [1, 'check', 0, 'flop']], 1)).not.toContain('pot-odds');
    expect(ids([...blinds, [2, 'fold', 0], [3, 'fold', 0], [0, 'call', 5], [1, 'check', 0], [1, 'bet', 10, 'flop'], [0, 'call', 10, 'flop']], 1)).not.toContain('pot-odds');
  });

  it('a raise raised again preflop is a 3-bet; limps, blinds and an all-in that only calls are not', () => {
    const threeBet: R[] = [...blinds, [2, 'raise', 30], [3, 'raise', 90], [0, 'fold', 0], [1, 'fold', 0], [2, 'call', 60]];
    expect(ids(threeBet, 2)).toEqual(['three-bet', 'pot-odds', 'call']);
    expect(to(threeBet, 3, 'three-bet')).toBe('/academy/gto/ranges?step=1');
    // Anyone still in when it came sees it, the blinds who then folded too.
    expect(ids(threeBet, 0)).toContain('three-bet');
    // A limped pot, and limps with one raise, are no 3-bet: the big blind is no raise.
    expect(ids([...blinds, [2, 'call', 10], [3, 'call', 10], [0, 'call', 5], [1, 'check', 0]], 1)).not.toContain('three-bet');
    expect(ids([...blinds, [2, 'call', 10], [3, 'call', 10], [0, 'call', 5], [1, 'raise', 40], [2, 'call', 30]], 2)).not.toContain('three-bet');
    expect(ids([...blinds, [2, 'raise', 30], [3, 'allin', 30]], 2)).not.toContain('three-bet');
    expect(ids([...blinds, [2, 'raise', 30], [3, 'allin', 200]], 2)).toContain('three-bet');
    // A raise on the flop over a bet is no preflop 3-bet.
    expect(ids([...blinds, [2, 'raise', 30], [1, 'call', 20], [1, 'bet', 50, 'flop'], [2, 'raise', 150, 'flop']], 1)).not.toContain('three-bet');
    // The viewer folded before it came.
    expect(ids([...blinds, [2, 'raise', 30], [3, 'fold', 0], [0, 'raise', 100], [1, 'fold', 0], [2, 'call', 70]], 3)).not.toContain('three-bet');
  });

  it('the big blind facing one open raise nobody called is big blind defence, whatever it chose', () => {
    const open: R[] = [...blinds, [2, 'raise', 30], [3, 'fold', 0], [0, 'fold', 0]];
    expect(ids([...open, [1, 'call', 20]], 1)).toEqual(['bb-defense', 'pot-odds', 'call']);
    expect(to([...open, [1, 'call', 20]], 1, 'bb-defense')).toBe('/academy/gto/hands?id=bb-86s');
    expect(ids([...open, [1, 'fold', 0]], 1)).toEqual(['bb-defense', 'pot-odds', 'fold']);
    expect(ids([...open, [1, 'raise', 90]], 1)).toEqual(['bb-defense', 'three-bet']);
    // Blind against blind: the small blind opens, the big blind decides.
    expect(ids([...blinds, [2, 'fold', 0], [3, 'fold', 0], [0, 'raise', 25], [1, 'call', 20]], 1)).toContain('bb-defense');
    // Not from the small blind, nor once someone called or limped, nor facing two raises, nor on a timeout.
    expect(ids([...blinds, [2, 'raise', 30], [3, 'fold', 0], [0, 'call', 25], [1, 'fold', 0]], 0)).not.toContain('bb-defense');
    expect(ids([...blinds, [2, 'raise', 30], [3, 'call', 30], [0, 'fold', 0], [1, 'call', 20]], 1)).not.toContain('bb-defense');
    expect(ids([...blinds, [2, 'call', 10], [3, 'raise', 40], [0, 'fold', 0], [1, 'call', 30]], 1)).not.toContain('bb-defense');
    expect(ids([...blinds, [2, 'raise', 30], [3, 'raise', 90], [0, 'fold', 0], [1, 'fold', 0]], 1)).not.toContain('bb-defense');
    expect(ids([...open, [1, 'timeout-fold', 0]], 1)).not.toContain('bb-defense');
    // Not a big blind facing no raise at all.
    expect(ids([...blinds, [2, 'call', 10], [3, 'fold', 0], [0, 'fold', 0], [1, 'check', 0]], 1)).not.toContain('bb-defense');
  });

  it('keeps the events first, then the study topics, and shows six at most', () => {
    // The big blind 3-bets an open from a short stack that then goes all in on the flop and splits the pot.
    const h = review([...blinds, [2, 'raise', 30], [3, 'fold', 0], [0, 'fold', 0], [1, 'raise', 80], [2, 'call', 60], [1, 'check', 0, 'flop'], [2, 'allin', 210, 'flop'], [1, 'call', 210, 'flop']], 1, { 0: 1000, 1: 1000, 2: 300, 3: 1000 });
    h.players[1] = { ...h.players[1]!, won: 300, rankClass: 'pair' };
    h.players[2] = { ...h.players[2]!, won: 300, rankClass: 'pair' };
    expect(lessonLinksFor(h).map((x) => x.id)).toEqual(['side-pot', 'split', 'showdown', 'bb-defense', 'three-bet', 'pot-odds']);
  });

  it('names study topics, never a solver’s or the correct answer', () => {
    const all = [
      ...lessonLinksFor(review([...blinds, [2, 'raise', 30], [3, 'fold', 0], [0, 'fold', 0], [1, 'raise', 80], [2, 'raise', 240], [1, 'call', 180]], 1)),
      ...lessonLinksFor(review([...blinds, [2, 'raise', 30], [3, 'fold', 0], [0, 'fold', 0], [1, 'fold', 0]], 1)),
    ];
    expect(new Set(all.map((x) => x.id))).toEqual(new Set(['bb-defense', 'three-bet', 'pot-odds', 'call', 'fold']));
    for (const x of all) for (const s of [x.title.ko, x.title.en, x.why.ko, x.why.en]) expect(s).not.toMatch(/정답|솔버|최적|solver|correct|optimal|GTO/i);
  });
});
