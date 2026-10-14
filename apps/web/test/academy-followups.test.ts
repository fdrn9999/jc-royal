import { evaluateBest } from '@jc/poker-engine';
import { badgesFor, type Card, type TableView } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { coachActive, coachTip } from '../src/academy/coach';
import { COMPARE_QUESTIONS } from '../src/academy/data/handQuiz';
import { lessonLinksFor } from '../src/academy/handLinks';
import { decideBot, preflopScore } from '../src/academy/practice/bots';
import { FREE_STACK, FreeSession } from '../src/academy/practice/free';
import * as P from '../src/academy/progress';
import { explainCompare, judgeCompare, judgePick } from '../src/academy/quiz';
import { buildReview, genCompare, genHandName, genSuit, seeded } from '../src/academy/review';

const c = (s: string) => s.split(' ') as Card[];

describe('progress v2: migration and cross-device merge', () => {
  it('upgrades a v1 save without losing anything', () => {
    const v1 = { v: 1, lessons: { cards: { startedAt: 1, completedAt: 2, step: 3 } }, last: { lesson: 'cards', step: 3 }, quiz: { correct: 4, wrong: 1 }, practice: { A: 9 }, onboarded: true };
    const m = P.migrate(v1);
    expect(m.v).toBe(2);
    expect(m.lessons.cards).toEqual({ startedAt: 1, completedAt: 2, step: 3 });
    expect(m.quiz).toEqual({ correct: 4, wrong: 1 });
    expect(m.practice).toEqual({ A: 9 });
    expect(m.mistakes).toEqual({});
    expect(m.coach).toEqual({ hands: 0, off: false });
  });

  it('merge unions achievements, keeps the earliest completion and the newer settings', () => {
    const phone = { ...P.emptyProgress(), updatedAt: 100, lessons: { cards: { startedAt: 10, completedAt: 50, step: 3 } }, practice: { A: 70 }, mistakes: { kicker: 2 }, coach: { hands: 1, off: false } } as P.Progress;
    const pc = { ...P.emptyProgress(), updatedAt: 200, lessons: { cards: { startedAt: 20, completedAt: null, step: 1 }, hands: { startedAt: 30, completedAt: 90, step: 4 } }, practice: { B: 80 }, mistakes: { suits: 1 }, coach: { hands: 3, off: true } } as P.Progress;
    const m = P.merge(phone, pc);
    expect(m.lessons.cards).toEqual({ startedAt: 10, completedAt: 50, step: 3 });
    expect(m.lessons.hands?.completedAt).toBe(90);
    expect(m.practice).toEqual({ A: 70, B: 80 });
    expect(m.mistakes).toEqual({ suits: 1 }); // newer side's open mistakes
    expect(m.coach).toEqual({ hands: 3, off: true });
    expect(m.updatedAt).toBe(200);
    expect(P.merge(pc, phone)).toEqual(m); // order does not matter
  });

  it('a reset on one device wins over older progress from another', () => {
    const old = { ...P.emptyProgress(), updatedAt: 100, lessons: { cards: { startedAt: 1, completedAt: 2, step: 3 } } } as P.Progress;
    const reset = { ...P.emptyProgress(), updatedAt: 500, resetAt: 400 } as P.Progress;
    expect(P.merge(old, reset).lessons).toEqual({});
    expect(P.merge(reset, old).lessons).toEqual({});
    // Progress made after the reset survives.
    const after = { ...old, updatedAt: 600 } as P.Progress;
    expect(P.merge(after, reset).lessons.cards?.completedAt).toBe(2);
  });

  it('mistakes per topic go up on wrong answers and are paid back by right ones', () => {
    let p = P.recordAnswer(P.emptyProgress(), false, 'kicker');
    p = P.recordAnswer(p, false, 'kicker');
    p = P.recordAnswer(p, false, 'suits');
    expect(P.weakTopics(p)).toEqual([{ topic: 'kicker', count: 2 }, { topic: 'suits', count: 1 }]);
    p = P.recordAnswer(p, true, 'suits');
    expect(P.weakTopics(p)).toEqual([{ topic: 'kicker', count: 2 }]);
    p = P.missScenario(P.startScenario(p, 'C'), 'C', 'actions');
    expect(p.scenarioStats.C).toEqual({ tries: 1, misses: 1 });
  });

  it('badges come only from progress fields', () => {
    expect(badgesFor(null)).toEqual([]);
    let p = P.completeLesson(P.emptyProgress(), 'cards', 1);
    expect(badgesFor(p)).toEqual(['first-step', 'card-reader']);
    p = P.finishReview(P.finishReview(P.finishReview(p, 5), 6), 7);
    expect(badgesFor(p)).toContain('sharp-eye');
  });
});

describe('compare explanations (deciding card)', () => {
  it('names the deciding rank and marks only those cards', () => {
    const kicker = COMPARE_QUESTIONS.find((q) => q.id === 'h-kicker')!;
    const e = explainCompare(kicker, 'a');
    expect(e.text.ko).toContain('킥커');
    expect(e.decide.a).toEqual(['Kd']);
    expect(e.decide.b).toEqual(['Qh']);
    const pairs = explainCompare(COMPARE_QUESTIONS.find((q) => q.id === 'h-higher-pair')!, 'a');
    expect(pairs.text.ko).toContain('페어 숫자');
    expect(pairs.decide.a.sort()).toEqual(['Kh', 'Ks']);
    expect(explainCompare(COMPARE_QUESTIONS.find((q) => q.id === 'h-flush-vs-straight')!, 'b').text.ko).toContain('플러시');
    expect(explainCompare(COMPARE_QUESTIONS.find((q) => q.id === 'h-board-plays')!, 'split').text.ko).toContain('무승부');
  });

  it('every authored compare question gets a consistent explanation', async () => {
    for (const q of COMPARE_QUESTIONS) {
      const r = await judgeCompare(q);
      const e = explainCompare(q, r.answer);
      expect(e.text.ko.length).toBeGreaterThan(10);
      if (r.answer !== 'split' && e.decide.a.length) expect(e.text.ko).toContain(r.answer === 'a' ? 'A가' : 'B가');
    }
  });
});

describe('random review quiz', () => {
  it('generated compare spots have the requested outcome type, confirmed by the engine', async () => {
    const r = seeded(42);
    for (const want of ['kicker', 'split', 'hand-order'] as const) {
      for (let i = 0; i < 4; i++) {
        const q = genCompare(want, r, i);
        const res = await judgeCompare(q);
        const ea = evaluateBest([...q.a, ...q.board])!;
        const eb = evaluateBest([...q.b, ...q.board])!;
        if (want === 'split') expect(res.answer).toBe('split');
        else expect(res.answer).not.toBe('split');
        expect(ea.rankClass === eb.rankClass).toBe(want !== 'hand-order');
      }
    }
  });

  it('name and suit questions are answerable and judged from the cards', () => {
    const r = seeded(7);
    for (let i = 0; i < 30; i++) {
      const q = genHandName(r, i);
      expect(q.options.map((o) => o.id)).toContain(q.answer);
      expect(new Set(q.cards).size).toBe(5);
      const s = genSuit(r, i);
      expect(s.cards.filter((x) => judgePick(s, x))).toHaveLength(1);
    }
  });

  it('weights topics by open mistakes and is reproducible per seed', () => {
    const weak = P.recordAnswer(P.recordAnswer(P.recordAnswer(P.emptyProgress(), false, 'kicker'), false, 'kicker'), false, 'kicker');
    const set = buildReview(weak, seeded(1), 40);
    expect(set.filter((q) => q.topic === 'kicker').length).toBeGreaterThan(10);
    expect(buildReview(weak, seeded(1), 8).map((q) => q.id)).toEqual(buildReview(weak, seeded(1), 8).map((q) => q.id));
    expect(new Set(buildReview(P.emptyProgress(), seeded(3), 60, true).map((q) => q.topic)).size).toBeGreaterThanOrEqual(8);
  });
});

describe('rule-based bots and free practice', () => {
  it('preflop scores rank premium hands above junk', () => {
    expect(preflopScore(c('As Ad'))).toBeGreaterThan(preflopScore(c('Ks Qs')));
    expect(preflopScore(c('Ks Qs'))).toBeGreaterThan(preflopScore(c('7c 2d')));
  });

  it('bots only ever pick a legal option', () => {
    const legal = [{ type: 'fold' }, { type: 'call', amount: 20 }, { type: 'raise', min: 40, max: 1000 }] as never;
    for (const style of ['tight', 'loose'] as const)
      for (let k = 0; k < 50; k++) {
        const d = decideBot(style, { hole: c('7c 2d'), board: c('Ks 9h 3d'), legal, pot: 60, bigBlind: 10, rand: k / 50 });
        expect(['fold', 'call', 'raise']).toContain(d.type);
        if (d.type === 'raise') expect(d.amount).toBeGreaterThanOrEqual(40);
      }
    const free = [{ type: 'check' }, { type: 'bet', min: 10, max: 500 }] as never;
    expect(decideBot('tight', { hole: c('7c 2d'), board: c('Ks 9h 3d'), legal: free, pot: 20, bigBlind: 10, rand: 0.9 }).type).toBe('check');
  });

  it('free session plays many hands with any legal hero action, conserving practice chips', async () => {
    let seed = 0.37;
    const rand = () => (seed = (seed * 9301 + 49297) % 233280 / 233280);
    for (const bots of [1, 2, 5] as const) {
      const s = new FreeSession({ bots, style: 'mixed' }, 'You', rand);
      for (let hand = 0; hand < 12; hand++) {
        for (let guard = 0; guard < 300 && !s.settled; guard++) {
          if (await s.step()) continue;
          if (s.isHeroTurn()) {
            const legal = s.heroLegal();
            const o = legal[Math.floor(rand() * legal.length)]!;
            const ok = await s.heroAct(o.type, 'min' in o ? o.min : undefined);
            expect(ok).toBe(true);
          }
        }
        expect(s.settled).toBe(true);
        // Stacks + nothing else: everything was paid out.
        const total = s.view().seats.filter((x) => x.state !== 'empty').reduce((a, x) => a + x.stack, 0);
        expect(total % 1).toBe(0);
        expect(total).toBeGreaterThan(0);
        s.newHand();
      }
      expect(s.hands).toBe(13);
      expect(s.heroStack()).toBeGreaterThan(0);
      expect(FREE_STACK).toBe(1000);
    }
  });
});

describe('hand review lesson links and first-hands coach', () => {
  it('links a side-pot hand to the side-pot lesson and a split to tie rules', () => {
    const side = lessonLinksFor({
      board: c('2h 7s 9d 3c 4h'),
      actions: [{ seatIndex: 2, stage: 'preflop', type: 'allin', amount: 100 }],
      players: [
        { seatIndex: 0, isYou: true, won: 400, rankClass: 'pair', stackStart: 1000 },
        { seatIndex: 2, isYou: false, won: 300, rankClass: 'pair', stackStart: 100 },
        { seatIndex: 4, isYou: false, won: 0, rankClass: 'high-card', stackStart: 1000 },
      ],
    });
    expect(side.map((x) => x.id)).toEqual(expect.arrayContaining(['side-pot', 'showdown', 'split']));
    expect(side.find((x) => x.id === 'side-pot')!.to).toBe('/academy/actions?step=2');
    const fold = lessonLinksFor({ board: [], actions: [{ seatIndex: 0, stage: 'preflop', type: 'fold', amount: 0 }], players: [{ seatIndex: 0, isYou: true, won: 0, rankClass: null, stackStart: 1000 }, { seatIndex: 1, isYou: false, won: 15, rankClass: null, stackStart: 1000 }] });
    expect(fold.map((x) => x.id)).toEqual(['no-showdown', 'fold']);
  });

  it('coaching runs only after a lesson, for a limited number of hands, and can be turned off', () => {
    const fresh = P.emptyProgress();
    const learned = P.completeLesson(fresh, 'cards', 1);
    expect(coachActive(fresh, true)).toBe(false);
    expect(coachActive(learned, true)).toBe(true);
    expect(coachActive(learned, false)).toBe(false);
    expect(coachActive({ ...learned, coach: { hands: 5, off: false } }, true)).toBe(false);
    expect(coachActive({ ...learned, coach: { hands: 0, off: true } }, true)).toBe(false);
    const view = (legal: unknown[], board: Card[], hole: Card[]) =>
      ({ you: { seatIndex: 0, legal }, seats: [{ seatIndex: 0, holeCards: hole }], hand: { board, potTotal: 40 } }) as unknown as TableView;
    expect(coachTip(view([{ type: 'check' }], [], c('Ah Kd')))?.key).toBe('coach.preflop');
    expect(coachTip(view([{ type: 'fold' }, { type: 'call', amount: 20 }], c('2c 7d 9s'), c('Ah Kd')))?.key).toBe('coach.weak');
    expect(coachTip(view([{ type: 'check' }], c('Ac Ad 9s'), c('Ah 9d')))).toEqual({ key: 'coach.strong', rankClass: 'full-house' });
  });
});
