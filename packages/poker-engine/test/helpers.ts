import type { Card } from '@jc/types';
import { HandEngine, type HandRules, type HandSeat } from '../src';

export const RULES: HandRules = { maxSeats: 6, smallBlind: 5, bigBlind: 10, turnMs: 20_000 };

export { stackedDeck } from '../src';

export function seats(stacks: number[], startIndex = 0): HandSeat[] {
  return stacks.map((stack, i) => ({ playerId: `p${i}`, seatIndex: startIndex + i, stack, displayName: `P${i}` }));
}

let intentSeq = 0;
export const nextIntent = () => `intent-${++intentSeq}-${Math.random().toString(36).slice(2, 8)}`;

export function start(stackList: number[], opts: { button?: number; deck?: Card[]; rules?: Partial<HandRules> } = {}) {
  return HandEngine.start({
    handId: `hand-${Math.random().toString(36).slice(2)}`,
    rules: { ...RULES, ...opts.rules },
    seats: seats(stackList),
    buttonSeat: opts.button ?? 0,
    now: 1_000,
    deck: opts.deck,
  });
}

/** Everybody checks or calls until the hand settles. */
export async function checkDown(h: HandEngine) {
  for (let guard = 0; guard < 100 && !h.isSettled; guard++) {
    const actor = h.actorId();
    if (!actor) throw new Error(`no actor but stage ${h.stage}`);
    const legal = h.legalOptions(actor);
    const type = legal.some((o) => o.type === 'check') ? 'check' : 'call';
    const r = await h.act(actor, { type }, nextIntent(), 2_000 + guard);
    if (!r.ok) throw new Error(`${actor} ${type} rejected: ${r.reason}`);
  }
}

export async function must(h: HandEngine, actor: string, type: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin', amount?: number) {
  expect(h.actorId()).toBe(actor);
  const r = await h.act(actor, { type, amount }, nextIntent(), 3_000);
  if (!r.ok) throw new Error(`${actor} ${type} ${amount ?? ''} rejected: ${r.code} ${r.reason}`);
  return r;
}

import { expect } from 'vitest';
