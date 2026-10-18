import type { HandResultView } from '@jc/types';

/**
 * Who won what, from a hand's result: each payout without the chips nobody called, handed back to the player who put
 * them in (`returned`). A player paid only their own chips back is no winner. In the result's order.
 */
export function wonFrom(r: HandResultView | null | undefined): HandResultView['winners'] {
  let left = r?.returned?.amount ?? 0;
  const out: HandResultView['winners'] = [];
  for (const w of r?.winners ?? []) {
    const own = w.seatIndex === r?.returned?.seatIndex ? Math.min(left, w.amount) : 0;
    left -= own;
    if (w.amount - own > 0) out.push({ ...w, amount: w.amount - own });
  }
  return out;
}
