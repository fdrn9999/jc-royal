import { evaluateBest, HandEngine, judgeShowdown } from '@jc/poker-engine';
import { handLabelKey, type Card } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { cardName, currentHand, describeHand } from '../src/academy/content';
import { CARD_QUESTIONS } from '../src/academy/data/cards';
import { COMPARE_QUESTIONS, HAND_SORT, NAME_QUESTIONS } from '../src/academy/data/handQuiz';
import { HAND_RANKS } from '../src/academy/data/hands';
import { actingOrder, BOARD_PLAYS, positionNames, WALKTHROUGH } from '../src/academy/data/holdem';
import { buildScenarios } from '../src/academy/practice/scenarios';
import { HERO_ID, PracticeSession } from '../src/academy/practice/runner';
import * as P from '../src/academy/progress';
import { judgeChoice, judgeCompare, judgePick, judgeSort, type PickQuestion, type SortQuestion } from '../src/academy/quiz';

const c = (s: string) => s.split(' ') as Card[];
const KO = (k: string) => ({ 'hand.pair': '원페어', 'hand.flush': '플러시', 'hand.two-pair': '투페어', 'hand.full-house': '풀하우스', 'hand.high-card': '하이카드', 'hand.royal-flush': '로열 플러시' })[k] ?? k;

describe('Lesson 1 — card questions', () => {
  const pick = (id: string) => CARD_QUESTIONS.find((q) => q.id === id) as PickQuestion;
  it('identifies suits and ranks from card data', () => {
    expect(judgePick(pick('c-heart'), '7h')).toBe(true);
    expect(judgePick(pick('c-heart'), 'As')).toBe(false);
    expect(judgePick(pick('c-ace-spades'), 'As')).toBe(true);
    expect(judgePick(pick('c-ace-spades'), 'Ah')).toBe(false);
    expect(judgePick(pick('c-k-vs-q'), 'Kc')).toBe(true);
    expect(judgePick(pick('c-diamond'), '5d')).toBe(true);
    expect(judgePick(pick('c-highest'), 'Ac')).toBe(true);
    expect(judgePick(pick('c-highest'), 'Ts')).toBe(false);
  });
  it('every pick question has exactly one correct card and explains wrong ones', () => {
    for (const q of CARD_QUESTIONS.filter((x): x is PickQuestion => x.kind === 'pick')) {
      expect(q.cards.filter((x) => q.isCorrect(x))).toHaveLength(1);
      for (const x of q.cards.filter((y) => !q.isCorrect(y))) expect(q.why(x).ko.length).toBeGreaterThan(5);
    }
  });
  it('suits have no ranking', () => {
    const q = CARD_QUESTIONS.find((x) => x.id === 'c-suits-equal');
    expect(q?.kind === 'choice' && judgeChoice(q, 'eq')).toBe(true);
  });
  it('sort questions accept only strongest-first orders', () => {
    const q = CARD_QUESTIONS.find((x) => x.id === 'c-sort-faces') as SortQuestion; // Jd As Qc Kh
    expect(judgeSort(q, [1, 3, 2, 0])).toBe(true);
    expect(judgeSort(q, [3, 1, 2, 0])).toBe(false);
    expect(judgeSort(q, [1, 3, 2])).toBe(false);
    expect(judgeSort(q, [1, 1, 2, 0])).toBe(false);
  });
});

describe('Lesson 2 — hand rankings', () => {
  it('lists ten ranks strongest first; every example evaluates to its rank', () => {
    expect(HAND_RANKS.map((h) => h.key)).toEqual(['royal-flush', 'straight-flush', 'four-of-a-kind', 'full-house', 'flush', 'straight', 'three-of-a-kind', 'two-pair', 'pair', 'high-card']);
    let prev = Infinity;
    for (const h of HAND_RANKS) {
      const ev = evaluateBest(h.cards)!;
      expect(handLabelKey(ev.rankClass, ev.bestFive)).toBe(h.key);
      const s = ev.score[0]! * 100 + (h.key === 'royal-flush' ? 99 : ev.score[1]!);
      expect(s).toBeLessThan(prev);
      prev = s;
      // Highlight groups are made of equal ranks (pairs/trips/quads).
      for (const g of [h.main, h.second ?? []]) if (g.length > 1 && g.length < 5) expect(new Set(g.map((i) => h.cards[i]![0])).size).toBe(1);
    }
  });

  it('compare questions: the engine verdict matches the written explanation', async () => {
    for (const q of COMPARE_QUESTIONS) {
      const r = await judgeCompare(q);
      expect(r.answer, q.id).toBe(q.expect);
    }
  });

  it('name-this-hand answers come from the evaluator and are among the options', () => {
    for (const q of NAME_QUESTIONS) expect(q.options.map((o) => o.id)).toContain(q.answer);
    expect(NAME_QUESTIONS.map((q) => q.answer)).toEqual(['full-house', 'straight', 'flush']);
  });

  it('hand sort: full house > flush > straight > two pair', () => {
    // items: straight, full house, two pair, flush
    expect(judgeSort(HAND_SORT, [1, 3, 0, 2])).toBe(true);
    expect(judgeSort(HAND_SORT, [3, 1, 0, 2])).toBe(false);
  });
});

describe('Lesson 3 — hold’em flow and positions', () => {
  it('walkthrough: hero wins with a pair of Kings (engine)', async () => {
    const out = await judgeShowdown([WALKTHROUGH.hero, WALKTHROUGH.villain], WALKTHROUGH.board);
    expect(out.winners).toEqual([0]);
    expect(out.hands[0]!.rankClass).toBe('pair');
  });
  it('board plays: hole cards are not required', () => {
    expect(evaluateBest([...BOARD_PLAYS.hole, ...BOARD_PLAYS.board])!.bestFive.sort()).toEqual([...BOARD_PLAYS.board].sort());
  });
  it('position names', () => {
    expect(positionNames(2)).toEqual(['BTN/SB', 'BB']);
    expect(positionNames(3)).toEqual(['BTN', 'SB', 'BB']);
    expect(positionNames(6)).toEqual(['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']);
    expect(positionNames(9)).toEqual(['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO']);
  });
  for (const n of [2, 3, 6, 9]) {
    it(`${n} players: acting order matches the engine preflop and postflop`, async () => {
      const size = n === 2 ? 2 : n <= 6 ? 6 : 9;
      const h = HandEngine.start({
        handId: `pos-${n}`,
        rules: { maxSeats: size as 2 | 6 | 9, smallBlind: 5, bigBlind: 10, turnMs: 60_000 },
        seats: Array.from({ length: n }, (_, i) => ({ playerId: `p${i}`, seatIndex: i, stack: 1000, displayName: `P${i}` })),
        buttonSeat: 0,
        now: 0,
      });
      const seen: number[] = [];
      for (let g = 0; h.stage === 'preflop'; g++) {
        const a = h.actorId()!;
        seen.push(h.seatOf(a)!);
        const type = h.legalOptions(a).some((o) => o.type === 'check') ? 'check' : 'call';
        await h.act(a, { type }, `i${g}`, g + 1);
      }
      // Seats are 0..n-1 clockwise from the button, i.e. positionNames order.
      expect(seen).toEqual(actingOrder(n, 'preflop'));
      expect(h.seatOf(h.actorId()!)).toBe(actingOrder(n, 'postflop')[0]);
    });
  }
});

describe('current hand (in-game helper)', () => {
  it('uses only own cards and the revealed board', () => {
    expect(currentHand(c('Ah Ad'), [])!.rankClass).toBe('pair');
    expect(currentHand(c('Ah Kd'), c('Ac 7s 2d'))!.rankClass).toBe('pair');
    expect(currentHand(null, c('Ac 7s 2d'))).toBeNull();
    const t = (k: string) => KO(k);
    expect(describeHand(currentHand(c('Ah Kd'), c('Ac 7s 2d'))!, 'ko', t as never)).toBe('A 원페어');
    expect(describeHand(currentHand(c('Kc Kd'), c('Kh 7s 7d'))!, 'ko', t as never)).toBe('K 풀하우스 (7 페어)');
    expect(describeHand(currentHand(c('Ah 2c'), c('Kh Qh Jh Th 3s'))!, 'en', ((k: string) => k) as never)).toBe('hand.royal-flush');
    expect(cardName('As', 'ko')).toBe('스페이드 에이스');
    expect(cardName('Tc', 'ko')).toBe('클럽 10');
    expect(cardName('Qh', 'en')).toBe('Queen of Hearts');
  });
});

describe('progress store', () => {
  const memKV = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  it('saves per account and never mixes accounts', () => {
    const kv = memKV();
    P.save(kv, 'u1', P.completeLesson(P.startLesson(P.emptyProgress(), 'cards', 3, 10), 'cards', 20));
    expect(P.isDone(P.load(kv, 'u1'), 'cards')).toBe(true);
    expect(P.isDone(P.load(kv, 'u2'), 'cards')).toBe(false);
    expect([...kv.m.keys()]).toEqual(['jc.academy:u1']);
  });
  it('migrates garbage, unknown versions and partial payloads safely', () => {
    expect(P.migrate(null)).toEqual(P.emptyProgress());
    expect(P.migrate('x')).toEqual(P.emptyProgress());
    expect(P.migrate({ v: 99, lessons: { cards: {} } })).toEqual(P.emptyProgress());
    const m = P.migrate({ v: 1, lessons: { cards: { startedAt: 5, completedAt: 9, step: 2 }, bogus: {} }, last: { lesson: 'nope', step: 1 }, quiz: { correct: -3, wrong: 'a' }, practice: { A: 7, Z: 1 } });
    expect(m.lessons).toEqual({ cards: { startedAt: 5, completedAt: 9, step: 2 } });
    expect(m.last).toBeNull();
    expect(m.quiz).toEqual({ correct: 0, wrong: 0 });
    expect(m.practice).toEqual({ A: 7 });
  });
  it('tracks resume point, answers, scenarios and completion; restart resets', () => {
    let p = P.startLesson(P.emptyProgress(), 'hands', 2, 100);
    expect(P.nextLesson(p)).toBe('hands');
    p = P.recordAnswer(P.recordAnswer(p, true), false);
    expect(p.quiz).toEqual({ correct: 1, wrong: 1 });
    for (const id of P.LESSON_IDS.filter((x) => x !== 'practice')) p = P.completeLesson(p, id, 200);
    expect(P.tutorialComplete(p)).toBe(false);
    for (const s of P.SCENARIO_IDS) p = P.completeScenario(p, s, 300);
    expect(P.isDone(p, 'practice')).toBe(true);
    expect(P.tutorialComplete(p)).toBe(true);
    expect(P.percent(p)).toBe(100);
    expect(P.nextLesson(p)).toBeNull();
    // A restart keeps nothing but the onboarding flag.
    expect({ ...P.emptyProgress(), onboarded: p.onboarded }).toEqual({ ...P.emptyProgress(), onboarded: true });
  });
});

describe('practice scenarios (real engine, scripted opponents)', () => {
  for (const sc of buildScenarios('You')) {
    it(`${sc.id}: ${sc.title.en} — script completes with the described result`, async () => {
      const s = new PracticeSession(sc);
      const stakes = s.view().seats.reduce((a, x) => a + x.stack + x.streetBet, 0);
      for (let guard = 0; guard < 200 && !s.settled; guard++) {
        if (await s.step()) continue;
        if (!s.isHeroTurn()) continue;
        const step = s.currentStep();
        if (!step) {
          expect((await s.heroAct(s.autoHeroAction().type)).ok).toBe(true);
          continue;
        }
        const type = Array.isArray(step.expect) ? step.expect[0]! : step.expect;
        // An off-script action is refused and nothing is sent to the engine.
        const wrong = s.heroLegal().find((o) => o.type !== type && o.type !== 'allin');
        if (wrong) expect(s.checkHero(wrong.type).ok).toBe(false);
        const win = s.heroLegal().find((o) => o.type === type);
        expect(win, `${sc.id} expects ${type}`).toBeTruthy();
        const amount = win && 'min' in win ? Math.max(win.min, step.minTo ?? 0, 30) : undefined;
        expect((await s.heroAct(type, amount)).ok).toBe(true);
      }
      expect(s.settled).toBe(true);
      expect(s.currentStep()).toBeNull();
      const v = s.view();
      expect(v.hand!.result!.winners.map((w) => w.seatIndex).sort()).toEqual([...sc.expectWinners].sort());
      // Chips are conserved and nothing leaves the practice table.
      expect(v.seats.reduce((a, x) => a + x.stack, 0)).toBe(stakes);
      expect(v.you.userId).toBe(HERO_ID);
    });
  }

  it('G: main pot 300 for all three, side pot 400 for two', async () => {
    const sc = buildScenarios('You').find((x) => x.id === 'G')!;
    const s = new PracticeSession(sc);
    for (let g = 0; g < 50 && s.stage !== 'turn'; g++) {
      if (await s.step()) continue;
      const step = s.currentStep()!;
      await s.heroAct(step.expect as 'call');
    }
    const pots = s.view().hand!.pots;
    expect(pots.map((p) => p.amount)).toEqual([300, 400]);
    expect(pots[0]!.eligibleSeats.sort()).toEqual([0, 2, 4]);
    expect(pots[1]!.eligibleSeats.sort()).toEqual([0, 4]);
  });
});
