import { AUTO_REBUY_MAX_TIMES, type AutoBuyPolicy, type AutoBuyRequest, type TableView } from '@jc/types';

/** Total limits offered: this many rebuys of the amount, or top-ups of the target. */
export const AUTO_TIMES = [1, 2, 3, AUTO_REBUY_MAX_TIMES];

/** The automatic chip policy a player is choosing (one mode at a time), before it goes to the room. */
export interface AutoBuyDraft {
  mode: 'off' | 'rebuy' | 'topup';
  /** Chips per rebuy. */
  amount: number;
  /** The stack a top-up restores, and the stack below which it does (at most the target). */
  target: number;
  trigger: number;
  /** A top-up the wallet cannot cover in full takes what it holds (when that reaches the table's minimum). */
  partial: boolean;
  /** The total limit, in rebuys of `amount` or top-ups of `target` (one of AUTO_TIMES). */
  times: number;
  consent: boolean;
}

/**
 * A change to the draft. Any change to the terms withdraws the consent given for the old ones; a trigger that was the
 * target follows it, and none is ever above it.
 */
export function editDraft(d: AutoBuyDraft, patch: Partial<AutoBuyDraft>): AutoBuyDraft {
  const next = { ...d, ...patch, consent: patch.consent ?? false };
  if (patch.target !== undefined && patch.trigger === undefined && d.trigger === d.target) next.trigger = next.target;
  next.trigger = Math.max(1, Math.min(next.trigger, next.target));
  return next;
}

/** A draft from the policy the room holds (to change it), or a new one of `mode` around `base` chips. */
export function draftFrom(policy: AutoBuyPolicy | null, mode: AutoBuyDraft['mode'], base: number): AutoBuyDraft {
  if (!policy) return { mode, amount: base, target: base, trigger: base, partial: false, times: 1, consent: false };
  const per = policy.mode === 'rebuy' ? policy.amount : policy.target;
  const times = AUTO_TIMES.includes(policy.cap / per) ? policy.cap / per : 1;
  return policy.mode === 'rebuy'
    ? { mode: 'rebuy', amount: policy.amount, target: base, trigger: base, partial: false, times, consent: false }
    : { mode: 'topup', amount: base, target: policy.target, trigger: policy.trigger, partial: policy.partial, times, consent: false };
}

/** What goes to the room; null while a policy still lacks the player's consent. */
export function draftRequest(d: AutoBuyDraft): AutoBuyRequest | null {
  if (d.mode === 'off') return { mode: 'off' };
  if (!d.consent) return null;
  if (d.mode === 'rebuy') return { mode: 'rebuy', amount: d.amount, cap: d.amount * d.times, consent: true };
  return { mode: 'topup', target: d.target, trigger: d.trigger, partial: d.partial, cap: d.target * d.times, consent: true };
}

/** The seat's policy: from `autoBuy`, or from `autoRebuy` alone in a room older than automatic top-ups. */
export function seatPolicy(you: TableView['you']): AutoBuyPolicy | null {
  if (you.autoBuy !== undefined) return you.autoBuy;
  return you.autoRebuy ? { mode: 'rebuy', ...you.autoRebuy } : null;
}

/**
 * What the policy would take after the next hand if it ended with `stack`, as the room decides it (room.ts autoRebuy /
 * autoTopUp): `amount` 0 when nothing is due; `stop` when the policy would turn itself off instead (the wallet short,
 * or past its limit or the table's range). An estimate only: the hand decides the stack, and the room the rest.
 */
export function autoBuyEstimate(
  p: AutoBuyPolicy,
  stack: number,
  t: { minBuyIn: number; maxBuyIn: number },
  wallet: number,
): { amount: number; stop?: 'short' | 'cap' } {
  if (p.mode === 'rebuy') {
    if (stack > 0) return { amount: 0 };
    const amount = Math.min(p.amount, t.maxBuyIn);
    if (amount < t.minBuyIn || p.spent + amount > p.cap) return { amount: 0, stop: 'cap' };
    return wallet < amount ? { amount: 0, stop: 'short' } : { amount };
  }
  if (stack >= p.trigger) return { amount: 0 };
  const target = Math.min(p.target, t.maxBuyIn);
  if (target < t.minBuyIn) return { amount: 0, stop: 'cap' };
  let amount = target - stack;
  if (amount <= 0) return { amount: 0 };
  if (p.partial) {
    amount = Math.min(amount, wallet);
    if (amount <= 0 || stack + amount < t.minBuyIn) return { amount: 0, stop: 'short' };
  }
  if (p.spent + amount > p.cap) return { amount: 0, stop: 'cap' };
  return wallet < amount ? { amount: 0, stop: 'short' } : { amount };
}
