/**
 * Advanced GTO Academy: the shapes of its content. Every text is a { ko, en } pair (`l(ko, en)` from ../content).
 * The content is our own explanation of standard poker theory: no book or course is copied, nothing is linked, and no
 * number is presented as a solver's output. Where a number depends on a simplified model, the item says which model.
 */
import type { Card } from '@jc/types';
import type { L } from '../content';

export const GTO_MODULES = ['foundations', 'ranges', 'math', 'position', 'texture', 'sizing', 'bluffing', 'mdf', 'streets', 'exploit'] as const;
export type GtoModuleId = (typeof GTO_MODULES)[number];

/** The interactive tool a step shows under its text (rendered by the page; the content only names it). */
export type GtoToolKind =
  /** Rock-paper-scissors style indifference demo: a mixed strategy nobody can exploit. */
  | 'indifference'
  /** The 13x13 range matrix with combo counts, presets and blockers. */
  | 'matrix'
  /** Combos of one hand class with card removal (known cards). */
  | 'combos'
  /** Pot odds: pot before the bet, the bet -> the equity a call needs. */
  | 'potOdds'
  /** EV of a call (equity, pot, bet) or of a pure bluff (fold %, pot, bet). */
  | 'ev'
  /** Outs -> exact equity for one or two cards vs the 2/4 rule. */
  | 'outs'
  /** Position: pick a seat of a 6-max table and see the illustrative opening range for it. */
  | 'position'
  /** Board texture: deal or pick a flop and see it classified (paired, monotone, connected …). */
  | 'texture'
  /** Bet size slider: the caller's pot odds, MDF and the bettor's bluff share at that size. */
  | 'sizing'
  /** SPR: pot and effective stack -> the ratio, pot-size bets to all-in and the geometric size for 1–3 streets. */
  | 'spr'
  /** River bluff ratio: pot, bet and value combos -> the bluffs that keep a bluff-catcher indifferent. */
  | 'bluffRatio'
  /** One hand followed from the flop to the river, a decision and its reasoning on each street. */
  | 'streetWalk'
  /** MDF calculator: P / (P + B). */
  | 'mdf'
  /** Exploit: an opponent's real fold or bluff frequency vs the balanced one -> the best simple response. */
  | 'exploit';

export interface GtoSection {
  /** Optional sub-heading. */
  title?: L;
  paras: L[];
  bullets?: L[];
  /** A worked example: a few lines, numbers shown step by step. */
  example?: { title: L; lines: L[] };
}

export interface GtoStep {
  id: string;
  title: L;
  sections: GtoSection[];
  tool?: GtoToolKind;
}

export interface GtoModule {
  id: GtoModuleId;
  title: L;
  /** One line for the module list. */
  summary: L;
  /** What the learner can do after the module (2–4 lines). */
  goals: L[];
  steps: GtoStep[];
  /** The lesson's review: 3–5 short lines shown at its end and on the review page. */
  review: L[];
}

/** What a test recomputes for a numeric answer (all amounts in big blinds or chips, same unit). */
export type GtoCalc =
  /** Equity a call needs: bet / (pot + 2·bet). `pot` is the pot before the bet. */
  | { kind: 'potOdds'; pot: number; bet: number }
  /** Minimum defence frequency: pot / (pot + bet). */
  | { kind: 'mdf'; pot: number; bet: number }
  /** Break-even fold frequency of a pure bluff (alpha): bet / (pot + bet). */
  | { kind: 'alpha'; pot: number; bet: number }
  /** Share of bluffs in a balanced river betting range: bet / (pot + 2·bet). */
  | { kind: 'bluffShare'; pot: number; bet: number }
  /** EV of calling: equity·(pot + 2·bet) − bet (equity 0–1). */
  | { kind: 'evCall'; pot: number; bet: number; equity: number }
  /** EV of a pure bluff: fold·pot − (1 − fold)·bet (fold 0–1). */
  | { kind: 'evBluff'; pot: number; bet: number; fold: number }
  /** Combos of a hand class ('AA', 'AKs', 'AKo', 'AK') with these cards known (removed from the deck). */
  | { kind: 'combos'; hand: string; dead?: Card[] }
  /** Exact chance to hit with `outs` from `unseen` cards over 1 or 2 cards to come. */
  | { kind: 'outs'; outs: number; cards: 1 | 2; unseen?: number }
  /** Geometric sizing: the share of the pot bet on each of `streets` streets so that the last bet is all-in. */
  | { kind: 'geometric'; pot: number; stack: number; streets: number }
  /** Stack-to-pot ratio: stack / pot. */
  | { kind: 'spr'; pot: number; stack: number }
  /** Bluff combos that balance `value` value combos on the river: value · bet / (pot + bet). */
  | { kind: 'bluffCombos'; pot: number; bet: number; value: number };

export interface GtoOption {
  id: string;
  label: L;
}

export interface GtoQuiz {
  id: string;
  module: GtoModuleId;
  prompt: L;
  options: GtoOption[];
  answer: string;
  /** Why the answer is right (shown after any answer). */
  explain: L;
  /** The model the question assumes, when the answer depends on one (e.g. "river, no more cards; the caller has only bluff-catchers"). */
  assumptions?: L;
  /** For a numeric answer: the tests recompute it and check the right option shows that number. */
  calc?: GtoCalc;
}

export interface GtoHandAnalysis {
  id: string;
  module: GtoModuleId;
  title: L;
  /** The spot: game, positions, stacks and the action so far. */
  spot: L;
  hero: [Card, Card];
  /** 0, 3, 4 or 5 cards. */
  board: Card[];
  street: 'preflop' | 'flop' | 'turn' | 'river';
  /**
   * The pot without the bet hero faces, and that bet: what calling costs (0 when hero acts first). The page shows the
   * pot as it stands, pot + facing. Same unit as the text (big blinds), and the same `pot` a potOdds or mdf calc uses.
   */
  pot: number;
  facing: number;
  question: L;
  options: GtoOption[];
  answer: string;
  /** The reasoning, step by step (3–6 lines). */
  reasoning: L[];
  /** The simplified model this analysis uses. Always present: no hand is "solved" here. */
  assumptions: L;
  takeaway: L;
  calc?: GtoCalc;
}

export interface GlossaryTerm {
  id: string;
  term: L;
  def: L;
  module: GtoModuleId;
}
