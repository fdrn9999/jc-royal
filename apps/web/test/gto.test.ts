import type { Card } from '@jc/types';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { calcSteps } from '../src/academy/gto/explain';
import { GLOSSARY } from '../src/academy/gto/glossary';
import { HANDS } from '../src/academy/gto/hands';
import * as M from '../src/academy/gto/math';
import { MODULE_BY_ID, MODULES } from '../src/academy/gto/modules';
import * as P from '../src/academy/gto/progress';
import { QUIZZES } from '../src/academy/gto/quizzes';
import { GtoTool } from '../src/academy/gto/tools';
import { GTO_MODULES, type GtoCalc, type GtoToolKind } from '../src/academy/gto/types';
import { STREET_WALK } from '../src/academy/gto/walk';
import { I18nProvider } from '../src/lib/i18n';

// The provider reads ?lang= from the address on its first render.
(globalThis as { window?: unknown }).window ??= { location: { search: '' } };
const CATALOG: P.GtoCatalog = { quizzes: QUIZZES, hands: HANDS };
const ALL_TOOLS: GtoToolKind[] = ['indifference', 'matrix', 'combos', 'potOdds', 'ev', 'outs', 'position', 'texture', 'sizing', 'spr', 'bluffRatio', 'streetWalk', 'mdf', 'exploit'];
const CARD = /^[AKQJT2-9][shdc]$/;
const ITEM_ID = /^[a-z0-9-]{1,32}$/;
/** The server's academy event id (apps/api/src/routes/academy.ts). */
const EVENT_ID = /^[A-Za-z0-9:_-]{1,48}$/;
const BOARD_LEN = { preflop: 0, flop: 3, turn: 4, river: 5 } as const;

type Pair = { ko: string; en: string };
const isPair = (x: unknown): x is Pair => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join() === 'en,ko';
/** Every { ko, en } text under a value, with where it sits. */
function texts(x: unknown, path = '', out: [string, Pair][] = []): [string, Pair][] {
  if (isPair(x)) out.push([path, x]);
  else if (Array.isArray(x)) x.forEach((v, i) => texts(v, `${path}[${i}]`, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) texts(v, `${path}.${k}`, out);
  return out;
}
const CONTENT = { MODULES, QUIZZES, HANDS, GLOSSARY, STREET_WALK };
/** The number as it stands alone in a text: "25%" but not inside "125%" or "2.25%". */
const shows = (text: string, v: string) => new RegExp(`(^|[^0-9.])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);
const allCalcs = (): [string, GtoCalc][] => [...QUIZZES.filter((q) => q.calc).map((q) => [`quiz ${q.id}`, q.calc!] as [string, GtoCalc]), ...HANDS.filter((x) => x.calc).map((x) => [`hand ${x.id}`, x.calc!] as [string, GtoCalc])];

describe('GTO academy content (§28–§31)', () => {
  it('has the ten modules in course order, each with goals, steps and a review', () => {
    expect(MODULES.map((m) => m.id)).toEqual([...GTO_MODULES]);
    for (const m of MODULES) {
      expect(MODULE_BY_ID[m.id]).toBe(m);
      expect(m.goals.length, m.id).toBeGreaterThanOrEqual(2);
      expect(m.steps.length, m.id).toBeGreaterThanOrEqual(2);
      expect(m.review.length, m.id).toBeGreaterThanOrEqual(3);
      expect(new Set(m.steps.map((s) => s.id)).size, m.id).toBe(m.steps.length);
      for (const s of m.steps) expect(s.sections.length, `${m.id}/${s.id}`).toBeGreaterThan(0);
    }
  });

  it('has at least 30 quizzes and 12 hand analyses, with valid unique ids that fit the progress store and the server events', () => {
    expect(QUIZZES.length).toBeGreaterThanOrEqual(30);
    expect(HANDS.length).toBeGreaterThanOrEqual(12);
    const ids = [...QUIZZES.map((q) => q.id), ...HANDS.map((x) => x.id)];
    expect(new Set(QUIZZES.map((q) => q.id)).size).toBe(QUIZZES.length);
    expect(new Set(HANDS.map((x) => x.id)).size).toBe(HANDS.length);
    for (const id of ids) expect(id, id).toMatch(ITEM_ID);
    for (const q of QUIZZES) expect(`gto:${q.id}`).toMatch(EVENT_ID);
    for (const x of HANDS) expect(`gto:hand:${x.id}`).toMatch(EVENT_ID);
    for (const m of GTO_MODULES) expect(`gto:${m}`).toMatch(EVENT_ID);
    expect(QUIZZES.length + HANDS.length).toBeLessThanOrEqual(200); // the store's cap per record kind
    for (const m of GTO_MODULES) expect(QUIZZES.some((q) => q.module === m), `a quiz for ${m}`).toBe(true);
  });

  it('every text has Korean and English, and the English has no Korean left in it', () => {
    const all = texts(CONTENT);
    expect(all.length).toBeGreaterThan(500);
    for (const [where, t] of all) {
      expect(t.ko.trim(), `${where}.ko`).not.toBe('');
      expect(t.en.trim(), `${where}.en`).not.toBe('');
      expect(t.en, `${where}.en`).not.toMatch(/[가-힣]/);
    }
  });

  it('uses the course terms (§31): equity is 에퀴티, never 승률 outside the glossary note', () => {
    const want: [string, string][] = [
      ['equity', '에퀴티'],
      ['range', '레인지'],
      ['pot odds', '팟 오즈'],
      ['expected value', '기대값'],
      ['blocker', '블로커'],
      ['fold equity', '폴드 에퀴티'],
      ['range advantage', '레인지 우위'],
      ['equity realisation', '에퀴티 실현'],
    ];
    for (const [en, ko] of want) {
      const g = GLOSSARY.find((x) => x.term.en.toLowerCase().replace(/\s*\(.*\)$/, '') === en);
      expect(g, en).toBeDefined();
      expect(g!.term.ko.startsWith(ko), `${en} → ${g!.term.ko}`).toBe(true);
    }
    const stray = texts({ MODULES, QUIZZES, HANDS, STREET_WALK }).filter(([, t]) => t.ko.includes('승률'));
    expect(stray.map(([w]) => w)).toEqual([]);
    expect(new Set(GLOSSARY.map((g) => g.id)).size).toBe(GLOSSARY.length);
  });

  it('every quiz answer is one of its options, and a numeric answer shows the recomputed number in the right option only', () => {
    for (const q of QUIZZES) {
      const ids = q.options.map((o) => o.id);
      expect(new Set(ids).size, q.id).toBe(ids.length);
      expect(ids, q.id).toContain(q.answer);
      if (!q.calc) continue;
      const v = M.formatCalc(q.calc);
      const hits = q.options.filter((o) => shows(o.label.ko, v) && shows(o.label.en, v)).map((o) => o.id);
      expect(hits, `${q.id}: ${v}`).toEqual([q.answer]);
    }
    expect(QUIZZES.filter((q) => q.calc).length).toBeGreaterThanOrEqual(15);
  });

  it('hand analyses: valid cards, none twice, the board fits the street, and a calc matches the pot and the reasoning', () => {
    for (const x of HANDS) {
      const cards = [...x.hero, ...x.board];
      for (const c of cards) expect(c, x.id).toMatch(CARD);
      expect(new Set(cards).size, x.id).toBe(cards.length);
      expect(x.board.length, x.id).toBe(BOARD_LEN[x.street]);
      expect(x.options.map((o) => o.id), x.id).toContain(x.answer);
      expect(x.reasoning.length, x.id).toBeGreaterThanOrEqual(3);
      expect(x.pot, x.id).toBeGreaterThan(0);
      expect(x.facing, x.id).toBeGreaterThanOrEqual(0);
      if (!x.calc) continue;
      const c = x.calc;
      if (c.kind === 'potOdds' || c.kind === 'mdf') {
        // Facing a bet: the calc's pot is the one before it, and its bet is what hero faces (or, acting first, hero's bet).
        expect(c.pot, x.id).toBe(x.pot);
        if (x.facing > 0) expect(c.bet, x.id).toBe(x.facing);
      }
      if (c.kind === 'alpha') expect([c.pot, x.facing], x.id).toEqual([x.pot, 0]);
      const v = M.formatCalc(c);
      expect(x.reasoning.some((r) => shows(r.ko, v) && shows(r.en, v)), `${x.id} shows ${v}`).toBe(true);
    }
  });

  it('step-by-step working ends in the same number the answer shows', () => {
    const calcs = allCalcs();
    expect(calcs.length).toBeGreaterThan(20);
    for (const [where, c] of calcs) {
      const lines = calcSteps(c);
      const v = M.formatCalc(c);
      expect(lines.length, where).toBeGreaterThan(0);
      expect(lines.some((x) => x.ko.includes(v) && x.en.includes(v)), `${where}: ${v}`).toBe(true);
    }
  });
});

describe('GTO academy maths', () => {
  it('pot odds, MDF, alpha and EV', () => {
    expect(M.potOdds(100, 50)).toBeCloseTo(0.25);
    expect(M.potOdds(100, 0)).toBe(0);
    expect(M.mdf(100, 50)).toBeCloseTo(2 / 3);
    expect(M.alpha(100, 50)).toBeCloseTo(1 / 3);
    expect(M.mdf(100, 50) + M.alpha(100, 50)).toBeCloseTo(1);
    expect(M.evCall(100, 50, 0.25)).toBeCloseTo(0); // break-even exactly at the pot odds
    expect(M.evBluff(100, 50, 1 / 3)).toBeCloseTo(0); // break-even exactly at alpha
    expect(M.formatCalc({ kind: 'evCall', pot: 100, bet: 50, equity: 0.4 })).toBe('+30');
    expect(M.formatCalc({ kind: 'evBluff', pot: 100, bet: 100, fold: 0.3 })).toBe('−40');
  });

  it('SPR, pot-size bets to all-in and geometric sizing', () => {
    expect(M.spr(10, 100)).toBe(10);
    expect(M.spr(0, 100)).toBe(0);
    expect(M.potBetsToAllIn(10, 40)).toBeCloseTo(2); // 10 → 30 → 90: 40 each in
    const f = M.geometric(10, 100, 3);
    expect((1 + 2 * f) ** 3).toBeCloseTo(1 + (2 * 100) / 10);
    expect(M.geometric(10, 100, 1)).toBeCloseTo(10); // one street left: the whole stack, 10 pots
    expect(M.geometric(10, 100, 0)).toBe(0);
  });

  it('a sized bet the stack caps says so: what was asked for, the all-in, and the share of the pot really bet', () => {
    expect(M.sizedBet(100, 50, 200)).toEqual({ asked: 50, bet: 50, capped: false, allIn: false, of: 0.5 });
    expect(M.sizedBet(100, 50, 50)).toEqual({ asked: 50, bet: 50, capped: false, allIn: true, of: 0.5 }); // exactly the stack
    const c = M.sizedBet(100, 200, 50);
    expect(c).toEqual({ asked: 200, bet: 50, capped: true, allIn: true, of: 0.5 });
    expect(M.share(c.of)).toBe('50%');
    expect(M.sizedBet(12.3, 33, 100).asked).toBe(4.1);
    expect(M.sizedBet(100, 50, Number.NaN)).toEqual({ asked: 0, bet: 0, capped: false, allIn: false, of: 0 });
  });

  it('balanced bluffs leave the bluff-catcher indifferent', () => {
    const b = M.balancedBluffs(100, 100, 20);
    expect(b).toBeCloseTo(10);
    expect(b / (20 + b)).toBeCloseTo(M.bluffShare(100, 100));
    expect(M.valuePerBluff(100, 100)).toBe(2);
    expect(M.balancedBluffs(100, 0, 20)).toBe(0);
  });

  it('outs: exact against the rule of 2 and 4', () => {
    expect(M.outsExact(9, 2)).toBeCloseTo(1 - (38 / 47) * (37 / 46));
    expect(M.outsExact(9, 1)).toBeCloseTo(9 / 46);
    expect(M.outsRule(9, 2)).toBeCloseTo(0.36);
    expect(M.outsRule(30, 2)).toBe(1);
    expect(M.outsExact(50, 1)).toBe(1);
  });

  it('combos and card removal', () => {
    expect(M.comboCount('AA')).toBe(6);
    expect(M.comboCount('AKs')).toBe(4);
    expect(M.comboCount('AKo')).toBe(12);
    expect(M.comboCount('AK')).toBe(16);
    expect(M.comboCount('AA', ['As'] as Card[])).toBe(3);
    expect(M.comboCount('AKs', ['As', 'Kh'] as Card[])).toBe(2);
    expect(M.rangeCombos(M.ALL_CLASSES)).toBe(M.TOTAL_COMBOS);
    expect(M.ALL_CLASSES.length).toBe(169);
    for (const seat of M.OPEN_SEATS) expect(() => M.parseRange(M.OPEN_RANGES[seat])).not.toThrow();
    // Later seats open wider (the teaching picture the position tool shows).
    const shares = (['UTG', 'HJ', 'CO', 'BTN'] as const).map((s) => M.rangeShare(M.parseRange(M.OPEN_RANGES[s])));
    expect([...shares].sort((a, b) => a - b)).toEqual(shares);
    expect(M.parseRange('77+').size).toBe(8);
    expect(M.parseRange('A5s-A2s')).toEqual(new Set(['A5s', 'A4s', 'A3s', 'A2s']));
  });

  it('board texture', () => {
    expect(M.texture(['Kd', '7c', '2h'] as Card[]).label).toBe('dry');
    expect(M.texture(['9h', '8h', '7d'] as Card[]).label).toBe('wet');
    expect(M.texture(['Qh', '8h', '4h'] as Card[]).suits).toBe('monotone');
    expect(M.texture(['Ks', 'Kd', '4c'] as Card[]).pairing).toBe('paired');
    expect(M.texture(['As', '2d', '4c'] as Card[]).connect).toBe('connected'); // the wheel
  });

  it('the street walk: the pots chain, the cards fit, and the numbers in the text are the computed ones', () => {
    const w = STREET_WALK;
    const [flop, turn, river] = w.streets as [(typeof w.streets)[0], (typeof w.streets)[0], (typeof w.streets)[0]];
    expect(w.streets.map((s) => s.board.length)).toEqual([3, 4, 5]);
    expect(turn.board.slice(0, 3)).toEqual(flop.board);
    expect(river.board.slice(0, 4)).toEqual(turn.board);
    const cards = [...w.hero, ...river.board];
    expect(new Set(cards).size).toBe(cards.length);
    expect(turn.pot).toBe(flop.pot + 2 * flop.bet);
    expect(river.pot).toBe(turn.pot + 2 * turn.bet);
    const says = (s: (typeof w.streets)[0], v: string) => s.reasoning.some((r) => r.ko.includes(v) && r.en.includes(v));
    expect(M.share(M.potOdds(flop.pot, flop.bet))).toBe('21.1%');
    expect(says(flop, '21.1%')).toBe(true);
    expect(M.pct(M.outsExact(12, 2, 47))).toBe('45%');
    expect(M.pct(M.outsRule(12, 2))).toBe('48%');
    expect(says(flop, '45%') && says(flop, '48%')).toBe(true);
    expect(M.share(M.potOdds(turn.pot, turn.bet))).toBe('28.9%');
    expect(M.share(M.outsExact(12, 1, 46))).toBe('26.1%');
    expect(says(turn, '28.9%') && says(turn, '26.1%')).toBe(true);
    const implied = turn.bet / M.outsExact(12, 1, 46) - (turn.pot + 2 * turn.bet);
    expect(M.num(implied)).toBe('2.4');
    expect(says(turn, '2.4')).toBe(true);
    expect(M.share(M.potOdds(river.pot, river.bet))).toBe('28.6%');
    expect(says(river, '28.6%')).toBe(true);
    expect(M.texture(river.board).pairing).toBe('unpaired');
  });
});

describe('GTO academy tools (§29)', () => {
  it('every tool kind is used by a lesson step and renders with its accuracy note', () => {
    const used = new Set(MODULES.flatMap((m) => m.steps.map((s) => s.tool).filter(Boolean)));
    expect([...used].sort()).toEqual([...ALL_TOOLS].sort());
    for (const kind of ALL_TOOLS) {
      const html = renderToStaticMarkup(h(I18nProvider, null, h(GtoTool, { kind })));
      expect(html, kind).toContain(`data-testid="tool-${kind}"`);
      expect(html, kind).toMatch(/data-accuracy="(exact|estimate|example)"/);
      // No external links (§27); an inline icon's SVG namespace is not one.
      expect(html.replaceAll('xmlns="http://www.w3.org/2000/svg"', ''), kind).not.toMatch(/https?:\/\//);
    }
  });

  it('the matrix and grids name every cell for screen readers and mark "in range" with a shape as well as a colour', () => {
    const html = renderToStaticMarkup(h(I18nProvider, null, h(GtoTool, { kind: 'position' })));
    const cells = html.match(/data-cell="/g) ?? [];
    expect(cells.length).toBe(169);
    const inRange = (html.match(/data-in="1"/g) ?? []).length;
    expect(inRange).toBeGreaterThan(0);
    expect((html.match(/aria-label="[^"]+, (레인지 안|in range)"/g) ?? []).length).toBe(inRange);
    expect((html.match(/●/g) ?? []).length).toBeGreaterThanOrEqual(inRange);
  });
});

describe('GTO academy progress (§32): its own store, migrated, merged and reset', () => {
  const t0 = 1_000;
  it('migrates anything into a valid current copy', () => {
    expect(P.migrateGto(null)).toEqual(P.emptyGtoProgress());
    expect(P.migrateGto('x')).toEqual(P.emptyGtoProgress());
    expect(P.migrateGto({ v: 99, modules: { math: { startedAt: 1 } } })).toEqual(P.emptyGtoProgress()); // a newer version: fresh, not a crash
    const m = P.migrateGto({
      v: 1,
      updatedAt: 5,
      modules: { math: { startedAt: 2, completedAt: 3, step: 4 }, nope: { startedAt: 1 } },
      last: { module: 'math', step: 2 },
      quiz: { ok: { correct: 2, wrong: 1, last: true, at: 9 }, 'BAD ID': { correct: 1 }, empty: { correct: 0, wrong: 0 } },
      hands: { 'river-catch-call': { correct: 0, wrong: 1, last: false, at: 7 } },
    });
    expect(m.modules).toEqual({ math: { startedAt: 2, completedAt: 3, step: 4 } });
    expect(m.last).toEqual({ module: 'math', step: 2 });
    expect(Object.keys(m.quiz)).toEqual(['ok']);
    expect(m.hands['river-catch-call']).toEqual({ correct: 0, wrong: 1, last: false, at: 7 });
    expect(P.migrateGto(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it('records steps, completion and answers', () => {
    let p = P.visitStep(P.emptyGtoProgress(), 'math', 2, t0);
    p = P.visitStep(p, 'math', 1, t0 + 1);
    expect(p.modules.math).toEqual({ startedAt: t0, completedAt: null, step: 2 });
    expect(p.last).toEqual({ module: 'math', step: 1 }); // where they are now, for "continue"
    expect(P.nextModule(p)).toEqual({ module: 'math', step: 1 });
    // Opening the same step again, or finishing a finished module, changes nothing: the same object, so no write or PUT.
    expect(P.visitStep(p, 'math', 1, t0 + 9)).toBe(p);
    expect(P.visitStep(p, 'math', 2, t0 + 9)).not.toBe(p);
    p = P.completeModule(p, 'math', t0 + 2);
    expect(P.moduleDone(p, 'math')).toBe(true);
    expect(P.completeModule(p, 'math', t0 + 9)).toBe(p);
    expect(P.nextModule(p)).toEqual({ module: 'foundations', step: 0 });
    p = P.answerQuiz(p, QUIZZES[0]!.id, false, t0 + 3);
    p = P.answerQuiz(p, QUIZZES[0]!.id, true, t0 + 4);
    expect(p.quiz[QUIZZES[0]!.id]).toEqual({ correct: 1, wrong: 1, last: true, at: t0 + 4 });
  });

  it('percent: half modules, 30% quizzes right once, 20% hands; weak modules come from the latest wrong answers', () => {
    let p = P.emptyGtoProgress();
    expect(P.gtoPercent(p, CATALOG)).toBe(0);
    for (const m of GTO_MODULES) p = P.completeModule(p, m, t0);
    expect(P.gtoPercent(p, CATALOG)).toBe(50);
    for (const q of QUIZZES) p = P.answerQuiz(p, q.id, true, t0);
    expect(P.gtoPercent(p, CATALOG)).toBe(80);
    for (const x of HANDS) p = P.answerHand(p, x.id, false, t0);
    expect(P.gtoPercent(p, CATALOG)).toBe(100);
    expect(P.nextModule(p)).toBeNull();
    const weak = P.weakModules(p, CATALOG);
    const total = weak.reduce((n, w) => n + w.count, 0);
    expect(total).toBe(HANDS.length);
    expect(weak.map((w) => w.count)).toEqual([...weak.map((w) => w.count)].sort((a, b) => b - a));
    const s = P.gtoSummary(p, CATALOG);
    expect(s).toMatchObject({ modules: 10, quizzes: QUIZZES.length, hands: HANDS.length, answered: QUIZZES.length, correct: QUIZZES.length });
    // A record the catalog no longer has is not counted.
    expect(P.gtoPercent(P.answerQuiz(P.emptyGtoProgress(), 'gone', true, t0), CATALOG)).toBe(0);
  });

  it('merge keeps both devices’ achievements in either order; a reset wins over what came before it', () => {
    const a = { ...P.answerQuiz(P.completeModule(P.emptyGtoProgress(), 'math', 50), 'q1', true, 60), updatedAt: 100 };
    const b = { ...P.answerQuiz(P.visitStep(P.emptyGtoProgress(), 'ranges', 3, 70), 'q1', false, 80), updatedAt: 200 };
    const m = P.mergeGto(a, b);
    expect(P.moduleDone(m, 'math')).toBe(true);
    expect(m.modules.ranges?.step).toBe(3);
    expect(m.quiz.q1).toEqual({ correct: 1, wrong: 1, last: false, at: 80 });
    expect(m.updatedAt).toBe(200);
    expect(P.mergeGto(b, a)).toEqual(m);
    const reset = { ...P.emptyGtoProgress(), resetAt: 300, updatedAt: 300 };
    expect(P.mergeGto(m, reset)).toEqual(reset);
    expect(P.mergeGto(reset, m)).toEqual(reset);
    const after = { ...P.visitStep(P.emptyGtoProgress(), 'mdf', 1, 400), updatedAt: 400 };
    expect(P.mergeGto(reset, after).modules).toEqual(after.modules);
  });

  it('a device that missed the reset and kept studying brings only what it did after the reset', () => {
    // Before the reset (made elsewhere at 300): math done, ranges begun, q1 twice and q2 once.
    let stale = P.completeModule(P.emptyGtoProgress(), 'math', 50);
    stale = P.visitStep(stale, 'ranges', 2, 90);
    stale = P.answerQuiz(P.answerQuiz(stale, 'q1', true, 60), 'q1', false, 70);
    stale = P.answerQuiz(stale, 'q2', true, 80);
    // After it, still offline: q1 once more, ranges finished, mdf begun.
    stale = P.answerQuiz(stale, 'q1', true, 400);
    stale = P.completeModule(stale, 'ranges', 410);
    stale = { ...P.visitStep(stale, 'mdf', 1, 420), updatedAt: 420 };
    const reset = { ...P.emptyGtoProgress(), resetAt: 300, updatedAt: 300 };
    const m = P.mergeGto(reset, stale);
    expect(P.mergeGto(stale, reset)).toEqual(m);
    expect(m.modules).toEqual({ ranges: { startedAt: 410, completedAt: 410, step: 2 }, mdf: { startedAt: 420, completedAt: null, step: 1 } });
    expect(P.moduleDone(m, 'math')).toBe(false);
    expect(m.quiz).toEqual({ q1: { correct: 1, wrong: 0, last: true, at: 400 } });
    expect(m).toMatchObject({ resetAt: 300, updatedAt: 420, last: { module: 'mdf', step: 1 } });
    // Merged again (the next sync), nothing changes; a copy that saw the reset is kept as it is.
    expect(P.mergeGto(m, stale)).toEqual(m);
    expect(P.mergeGto(m, reset)).toEqual(m);
  });

  it('stores under its own key, apart from the beginner course', () => {
    const kv = new Map<string, string>();
    const store: P.KV = { getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => void kv.set(k, v) };
    const p = P.completeModule(P.emptyGtoProgress(), 'exploit', t0);
    P.saveGto(store, 'u1', p);
    expect([...kv.keys()]).toEqual(['jc.academy.gto:u1']);
    expect(P.loadGto(store, 'u1')).toEqual(p);
    expect(P.loadGto(store, 'u2')).toEqual(P.emptyGtoProgress());
    kv.set('jc.academy.gto:u3', '{not json');
    expect(P.loadGto(store, 'u3')).toEqual(P.emptyGtoProgress());
  });
});
