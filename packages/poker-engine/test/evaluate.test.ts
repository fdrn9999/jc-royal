import { handLabelKey, type Card } from '@jc/types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareScores, dealOrder, evaluateBest, evaluateKnown, judgeShowdown, standardDeck, stackedDeck } from '../src';

const c = (s: string) => s.split(' ') as Card[];

describe('evaluateBest (5–7 cards)', () => {
  const cases: [string, string, string][] = [
    ['As Ks Qs Js Ts 2c 3d', 'straight-flush', 'royal-flush'],
    ['5h 4h 3h 2h Ah Kc Kd', 'straight-flush', 'straight-flush'],
    ['Qc Qd Qh Qs 7c 4d 2h', 'four-of-a-kind', 'four-of-a-kind'],
    ['Jc Jd Jh 7s 7c 4d 2h', 'full-house', 'full-house'],
    ['Ac 9c Qc 7c 4c 3d 2h', 'flush', 'flush'],
    ['9d 8s 7h 6c 5d Kc 2s', 'straight', 'straight'],
    ['Ad 2s 3h 4c 5d Kc Ks', 'straight', 'straight'],
    ['7d 7s 7h Qc 4d 3s 2h', 'three-of-a-kind', 'three-of-a-kind'],
    ['Kc Qd Kh Qs 7d 3s 2h', 'two-pair', 'two-pair'],
    ['Ac 9d As 7c 5d 3s 2h', 'pair', 'pair'],
    ['Ac Jd 8s 6c 4d 3s 2h', 'high-card', 'high-card'],
  ];
  for (const [cards, rankClass, label] of cases) {
    it(`${label}: ${cards}`, () => {
      const ev = evaluateBest(c(cards))!;
      expect(ev.rankClass).toBe(rankClass);
      expect(handLabelKey(ev.rankClass, ev.bestFive)).toBe(label);
      expect(ev.bestFive).toHaveLength(5);
    });
  }

  it('wheel straight is 5-high and loses to a 6-high straight', () => {
    const wheel = evaluateBest(c('Ad 2s 3h 4c 5d'))!;
    const six = evaluateBest(c('2s 3h 4c 5d 6h'))!;
    expect(wheel.score).toEqual([4, 5]);
    expect(compareScores(six.score, wheel.score)).toBe(1);
  });

  it('full house compares the three of a kind first', () => {
    const a = evaluateBest(c('Kc Kd Kh 2s 2c'))!;
    const b = evaluateBest(c('Qc Qd Qh As Ac'))!;
    expect(compareScores(a.score, b.score)).toBe(1);
  });

  it('kickers decide equal pairs; identical ranks tie regardless of suit', () => {
    const a = evaluateBest(c('Ac Ad Kc 7s 2h'))!;
    const b = evaluateBest(c('Ah As Qc 7d 2c'))!;
    expect(compareScores(a.score, b.score)).toBe(1);
    expect(compareScores(evaluateBest(c('Ac Ad Kc 7s 2h'))!.score, evaluateBest(c('Ah As Kd 7c 2s'))!.score)).toBe(0);
  });

  it('known cards: preflop pairs and high cards, nothing with 3-4 cards', () => {
    expect(evaluateKnown(c('9c 9d'))!.rankClass).toBe('pair');
    expect(evaluateKnown(c('Ac Kd'))!.rankClass).toBe('high-card');
    expect(evaluateKnown(c('Ac Kd Qh'))).toBeNull();
    expect(() => evaluateBest(c('Ac Ac Kd Qh Js'))).toThrow();
  });
});

describe('agrees with the engine showdown', () => {
  it('fixed spots: winners and split pots come from the engine', async () => {
    // Board plays: both players split.
    const split = await judgeShowdown([c('2c 3d'), c('2h 3s')], c('As Ks Qs Js Ts'));
    expect(split.winners).toEqual([0, 1]);
    // Kicker: A-K beats A-Q on an ace-high board.
    const kick = await judgeShowdown([c('Ah Kd'), c('Ac Qd')], c('As 9c 7h 4d 2s'));
    expect(kick.winners).toEqual([0]);
    expect(kick.hands.map((h) => h.rankClass)).toEqual(['pair', 'pair']);
  });

  it('property: rank class and winner match HandEngine for random 2–3 player spots', async () => {
    const deck = standardDeck();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 3 }), fc.shuffledSubarray(deck, { minLength: 11, maxLength: 11 }), async (n, cards) => {
        const holes = Array.from({ length: n }, (_, i) => cards.slice(i * 2, i * 2 + 2));
        const board = cards.slice(6, 11);
        const out = await judgeShowdown(holes, board);
        const evs = holes.map((h) => evaluateBest([...h, ...board])!);
        for (const h of out.hands) expect(h.rankClass).toBe(evs[h.seatIndex]!.rankClass);
        const best = evs.reduce((m, e) => (compareScores(e.score, m.score) > 0 ? e : m));
        const mine = evs.map((e, i) => (compareScores(e.score, best.score) === 0 ? i : -1)).filter((i) => i >= 0);
        expect(out.winners).toEqual(mine);
      }),
      { numRuns: 150 },
    );
  });

  it('stackedDeck/dealOrder: holes reach the intended seats', () => {
    expect(dealOrder(3, 0)).toEqual([1, 2, 0]);
    const d = stackedDeck([c('Ac Ad'), c('Kc Kd')], c('2c 3c 4c 5h 7s'));
    expect(new Set(d).size).toBe(52);
    expect(d.slice(0, 4)).toEqual(c('Ac Ad Kc Kd'));
  });
});
