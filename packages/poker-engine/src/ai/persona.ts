/**
 * How a bot plays: its level (how well it reads ranges and adapts) and its style (how wide and how aggressively it
 * plays). Styles only shift ranges, sizes and mixing frequencies within sane bounds: none of them turns a bot into a
 * calling station or a random all-in machine.
 */
import type { BotLevel, BotStyle } from '@jc/types';

// The styles and an account's automatic one live with the shared types, so the API and the console can name them.
export { BOT_STYLES, styleFor, type BotStyle } from '@jc/types';

export interface Persona {
  /** Opening range width. */
  open: number;
  /** Calling threshold: above 1 calls a little more. */
  call: number;
  /** Value and bluff 3-bet frequency. */
  threeBet: number;
  /** Bluffing frequency (3-bet bluffs, c-bets without a hand, river bluffs). */
  bluff: number;
  /**
   * Betting and raising for value instead of checking and calling. Above 1 it also bets thinner; below 1 it checks more
   * of its medium-strong hands to call.
   */
  aggression: number;
  /** Bet and raise size. */
  sizing: number;
  /** Limping instead of raising or folding, including this share of its opening hands. */
  limp: number;
  /** Continuation bet frequency. */
  cbet: number;
}

const PERSONAS: Record<BotStyle, Persona> = {
  balanced: { open: 1, call: 1, threeBet: 1, bluff: 1, aggression: 1, sizing: 1, limp: 0, cbet: 1 },
  tag: { open: 0.92, call: 0.92, threeBet: 1.15, bluff: 0.9, aggression: 1.15, sizing: 1.05, limp: 0, cbet: 1.05 },
  lag: { open: 1.3, call: 1.02, threeBet: 1.45, bluff: 1.4, aggression: 1.4, sizing: 1.05, limp: 0, cbet: 1.25 },
  'tight-passive': { open: 0.8, call: 0.98, threeBet: 0.6, bluff: 0.45, aggression: 0.7, sizing: 0.95, limp: 0.12, cbet: 0.75 },
  'loose-passive': { open: 1.12, call: 1.12, threeBet: 0.6, bluff: 0.5, aggression: 0.72, sizing: 0.92, limp: 0.3, cbet: 0.7 },
};

export const personaOf = (style: BotStyle | undefined): Persona => PERSONAS[style ?? 'balanced'] ?? PERSONAS.balanced;

export interface LevelParams {
  /** Monte Carlo deals per decision. */
  iterations: number;
  /** Uses opponent statistics at all, and how many imagined opportunities pull small samples to the average. */
  adapt: boolean;
  priorWeight: number;
  /** Opening and shoving ranges this much wider than its style's (the easy level plays a few hands too many). */
  loose: number;
  /** How much it 3-bets as a bluff and bluffs after the flop (0 none … 1 full). */
  bluff: number;
  /** Extra equity it asks for before calling (negative calls a little light). */
  margin: number;
  /** Width of the soft edge between calling and folding (bigger mixes more around the threshold). */
  mix: number;
  /** Equity a hand needs before it 3-bets for value heads-up. */
  value3: number;
  /** Bets thinner for value. */
  refined: boolean;
  /** Share of its very strong turn and river value bets heads-up that overbet the pot (0 never). */
  overbet: number;
  /**
   * Reads what opponents' bets, calls and checks after the flop say about their hands. The easy level does not: it
   * judges its hand against what they could have had before the flop, so it calls big bets too often.
   */
  reads: boolean;
  /**
   * How often it bets and raises its strong hands instead of checking and calling them. Below 1 the easy level misses
   * some value; how aggressive a bot is beyond that comes from its style.
   */
  value: number;
  /** Sizes bets by street and board; without it, half the pot every time. */
  sizes: boolean;
  /** Share of its opening hands it limps instead (the easy level's open limps). */
  limp: number;
}

export const LEVEL_PARAMS: Record<BotLevel, LevelParams> = {
  easy: { iterations: 240, adapt: false, priorWeight: 0, loose: 1.1, bluff: 0.55, margin: -0.01, mix: 0.04, value3: 0.66, refined: false, overbet: 0, reads: false, value: 0.9, sizes: false, limp: 0.2 },
  normal: { iterations: 500, adapt: true, priorWeight: 60, loose: 1, bluff: 0.6, margin: 0.01, mix: 0.02, value3: 0.6, refined: false, overbet: 0, reads: true, value: 1, sizes: true, limp: 0 },
  hard: { iterations: 800, adapt: true, priorWeight: 30, loose: 1, bluff: 0.9, margin: 0, mix: 0.015, value3: 0.585, refined: false, overbet: 0, reads: true, value: 1, sizes: true, limp: 0 },
  expert: { iterations: 1100, adapt: true, priorWeight: 14, loose: 1, bluff: 1, margin: 0, mix: 0.012, value3: 0.575, refined: true, overbet: 0.12, reads: true, value: 1, sizes: true, limp: 0 },
};

export const levelParams = (level: BotLevel): LevelParams => LEVEL_PARAMS[level] ?? LEVEL_PARAMS.normal;
