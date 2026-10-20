/**
 * The table bots as they played before Bot AI 2.0 (Easy, Normal, Hard), kept unchanged for the before/after simulation
 * only. Nothing in the game uses it.
 */
import type { BotLevel } from '@jc/types';
import { aggress, callOr, legalize, passive, potSized } from '../src/ai/act';
import { estimateEquity, readHand, startingScore, type BotView } from '../src/bot';
import type { ActionRequest } from '../src/hand';

function easy(v: BotView, rand: () => number): ActionRequest {
  const bb = v.bigBlind;
  if (v.stage === 'preflop') {
    const s = startingScore(v.hole);
    if (s >= 12 && rand() < 0.5) return aggress(v, Math.max(bb * 3, (v.streetBet + v.toCall) * 2.5)) ?? callOr(v);
    if (v.toCall === 0) return { type: 'check' };
    if (s >= 3 || rand() < 0.3) return v.toCall <= bb * (s >= 9 ? 15 : 6) ? callOr(v) : passive(v);
    return passive(v);
  }
  const r = readHand(v.hole, v.board);
  if (r.made === 3 && rand() < 0.5) return aggress(v, potSized(v, 0.5)) ?? callOr(v);
  if (v.toCall === 0) return { type: 'check' };
  if (r.made >= 1 || r.outs > 0) return v.toCall <= v.pot ? callOr(v) : rand() < 0.3 ? callOr(v) : passive(v);
  return v.toCall <= v.pot / 3 && rand() < 0.4 ? callOr(v) : passive(v);
}

function normal(v: BotView, rand: () => number): ActionRequest {
  const bb = v.bigBlind;
  const facing = v.toCall;
  if (v.stage === 'preflop') {
    const s = startingScore(v.hole);
    const raised = v.streetBet + facing > bb;
    const late = v.position >= 0.6;
    if (s >= 12) {
      if (facing >= v.stack * 0.3) return callOr(v);
      return aggress(v, raised ? (v.streetBet + facing) * 3 : bb * 3 + bb * Math.max(0, v.opponents - 2) * 0.5) ?? callOr(v);
    }
    if (s >= 9) {
      if (!raised) return aggress(v, bb * 3) ?? callOr(v);
      return facing <= bb * 4 || facing <= v.stack * 0.08 ? callOr(v) : passive(v);
    }
    if (s >= 7) {
      if (!raised) return late && rand() < 0.6 ? (aggress(v, bb * 2.5) ?? callOr(v)) : callOr(v);
      return facing <= bb * 2.5 ? callOr(v) : passive(v);
    }
    if (s >= 5 && !raised) return late || facing === 0 ? callOr(v) : facing <= bb / 2 ? callOr(v) : passive(v);
    return passive(v);
  }
  const r = readHand(v.hole, v.board);
  const odds = facing / (v.pot + facing);
  const streetsLeft = v.stage === 'flop' ? 2 : v.stage === 'turn' ? 1 : 0;
  const drawChance = Math.min(0.6, (r.outs * (streetsLeft === 2 ? 4 : 2)) / 100);
  if (r.made === 3) {
    if (facing === 0) return aggress(v, potSized(v, 0.66)) ?? { type: 'check' };
    return rand() < 0.55 ? (aggress(v, potSized(v, 0.8)) ?? callOr(v)) : callOr(v);
  }
  if (r.made === 2) {
    if (facing === 0) return rand() < 0.75 ? (aggress(v, potSized(v, 0.5)) ?? { type: 'check' }) : { type: 'check' };
    if (facing <= v.pot * 0.75 || facing <= v.stack * 0.15) return callOr(v);
    return v.aggressors >= 2 ? passive(v) : facing <= v.pot ? callOr(v) : passive(v);
  }
  if (r.made === 1) {
    if (facing === 0) return v.position >= 0.6 && v.opponents <= 2 && rand() < 0.3 ? (aggress(v, potSized(v, 0.4)) ?? { type: 'check' }) : { type: 'check' };
    return facing <= v.pot * 0.4 ? callOr(v) : passive(v);
  }
  if (r.outs > 0) {
    if (facing === 0) return rand() < 0.3 ? (aggress(v, potSized(v, 0.55)) ?? { type: 'check' }) : { type: 'check' };
    return drawChance >= odds ? callOr(v) : passive(v);
  }
  if (facing === 0) return v.position >= 0.6 && v.opponents === 1 && rand() < 0.15 ? (aggress(v, potSized(v, 0.5)) ?? { type: 'check' }) : { type: 'check' };
  return passive(v);
}

/** Hands scored per decision, shared by the opponents (each simulated deal scores the bot's hand and theirs). */
const HARD_EVALS = 3000;

function hard(v: BotView, rand: () => number): ActionRequest {
  const bb = v.bigBlind;
  const facing = v.toCall;
  const opp = Math.max(1, v.opponents);
  const iterations = Math.max(60, Math.floor(HARD_EVALS / (Math.min(opp, 5) + 1)));
  let equity = estimateEquity(v.hole, v.board, opp, iterations, rand);
  // Random hands are weaker than the hands people bet with: each bet faced on this street asks for more.
  if (facing > 0 && v.aggressors > 0) equity -= 0.06 * Math.min(2, v.aggressors);
  const odds = facing / (v.pot + facing);
  const fair = 1 / (opp + 1);
  const strong = equity >= Math.min(0.8, fair + 0.3);
  const good = equity >= Math.min(0.65, fair + 0.15);
  if (v.stage === 'preflop') {
    const raised = v.streetBet + facing > bb;
    if (strong) return aggress(v, raised ? (v.streetBet + facing) * 3 : bb * 3) ?? callOr(v);
    if (good) {
      if (!raised) return aggress(v, bb * (v.position >= 0.6 ? 2.5 : 3)) ?? callOr(v);
      return equity >= odds + 0.05 && facing <= v.stack * 0.25 ? callOr(v) : passive(v);
    }
    if (facing === 0) return { type: 'check' };
    return equity >= odds + 0.08 && facing <= bb * 3 ? callOr(v) : passive(v);
  }
  const r = readHand(v.hole, v.board);
  if (strong) {
    // Short stack against the pot: get it all in.
    if (v.stack <= v.pot * 0.7) return aggress(v, v.stack + v.streetBet) ?? callOr(v);
    return aggress(v, potSized(v, facing === 0 ? 0.7 : 0.9)) ?? callOr(v);
  }
  if (good) {
    if (facing === 0) return aggress(v, potSized(v, 0.5)) ?? { type: 'check' };
    return equity >= odds ? callOr(v) : passive(v);
  }
  if (facing === 0) {
    // Semi-bluff a draw; on the river, bluff now and then from late position against one player.
    if (r.outs >= 8 && rand() < 0.4) return aggress(v, potSized(v, 0.6)) ?? { type: 'check' };
    if (v.stage === 'river' && v.opponents === 1 && v.position >= 0.6 && rand() < 0.15) return aggress(v, potSized(v, 0.6)) ?? { type: 'check' };
    return { type: 'check' };
  }
  return equity >= odds + 0.02 ? callOr(v) : passive(v);
}

/** The pre-2.0 decision for a level (Expert did not exist: it plays as Hard). */
export function decideLegacy(level: BotLevel, v: BotView, rand: () => number): ActionRequest {
  const want = level === 'easy' ? easy(v, rand) : level === 'hard' || level === 'expert' ? hard(v, rand) : normal(v, rand);
  return legalize(v, want);
}
