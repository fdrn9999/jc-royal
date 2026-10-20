/** Turning a bot's wish (bet about this much, call, give up) into one of the legal options the engine offered. */
import type { LegalOption } from '@jc/types';
import type { ActionRequest } from '../hand';

/** What these helpers read from a bot's view. */
export interface LegalSpot {
  legal: LegalOption[];
  pot: number;
  toCall: number;
  streetBet: number;
}

type Win = Extract<LegalOption, { min: number; max: number }>;

export const find = <T extends LegalOption['type']>(legal: readonly LegalOption[], t: T) => legal.find((o) => o.type === t) as Extract<LegalOption, { type: T }> | undefined;

/** Bet or raise to about `to` (street total), kept inside the legal range; all in when that is all that is left. */
export function aggress(v: LegalSpot, to: number): ActionRequest | null {
  const win = (find(v.legal, 'raise') ?? find(v.legal, 'bet')) as Win | undefined;
  const allin = find(v.legal, 'allin');
  const target = Math.round(to);
  if (win) {
    if (allin && target >= win.max) return { type: 'allin' };
    return { type: win.type, amount: Math.min(win.max, Math.max(win.min, target)) };
  }
  // No raise left (the stack covers less than a minimum raise): all in only if that is more than a call.
  if (allin && allin.amount > v.streetBet + v.toCall) return { type: 'allin' };
  return null;
}

/** All in, when the engine offers it. */
export const shove = (v: LegalSpot): ActionRequest | null => (find(v.legal, 'allin') ? { type: 'allin' } : aggress(v, Number.MAX_SAFE_INTEGER));

/** A bet of `fraction` of the pot (after calling, for a raise), as a street total. */
export const potSized = (v: LegalSpot, fraction: number) => v.streetBet + v.toCall + (v.pot + v.toCall) * fraction;

export const passive = (v: LegalSpot): ActionRequest => (find(v.legal, 'check') ? { type: 'check' } : { type: 'fold' });
export const callOr = (v: LegalSpot): ActionRequest => (find(v.legal, 'check') ? { type: 'check' } : find(v.legal, 'call') ? { type: 'call' } : find(v.legal, 'allin') ? { type: 'allin' } : { type: 'fold' });

/** Turns any wish into a legal request: the request itself if the engine offers it, otherwise check, else fold. */
export function legalize(v: Pick<LegalSpot, 'legal'>, req: ActionRequest): ActionRequest {
  const o = v.legal.find((x) => x.type === req.type);
  if (o) {
    if (o.type !== 'bet' && o.type !== 'raise') return { type: o.type };
    const amount = req.amount ?? o.min;
    if (Number.isSafeInteger(amount) && amount >= o.min && amount <= o.max) return { type: o.type, amount };
    return { type: o.type, amount: Math.min(o.max, Math.max(o.min, Math.round(amount))) };
  }
  if (find(v.legal, 'check')) return { type: 'check' };
  // A call shown as all in (the stack covers no more) is the same as calling.
  if (req.type === 'call' && find(v.legal, 'allin')) return { type: 'allin' };
  return { type: 'fold' };
}
