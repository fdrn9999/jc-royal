/**
 * Pot odds at the viewer's own decisions facing a bet in a finished hand (My Page → hand detail), rebuilt from the
 * stored actions alone: what a call cost then and what was already in the pot, the bet included. A plain calculation
 * for review, not advice: it ignores what the others could still do and every later bet.
 */

export interface PotOddsInput {
  actions: { seatIndex: number; stage: string; type: string; amount: number }[];
  players: { seatIndex: number; isYou: boolean; stackStart: number }[];
}

export interface PotOdds {
  /** Chips the call cost, and what was in the pot before it. */
  toCall: number;
  pot: number;
  /** Share of the final pot the call is: the equity it needed to break even, in whole percent. */
  need: number;
}

/**
 * By action index: the viewer's calls, all-ins that only called, and folds, each facing a bet. Left out wherever the
 * record leaves it uncertain: a call whose amount isn't what the bet asked for, or a bet bigger than the viewer's
 * stack then (a short call plays for part of the pot only).
 */
export function potOddsFor(h: PotOddsInput): Map<number, PotOdds> {
  const out = new Map<number, PotOdds>();
  const me = h.players.find((p) => p.isYou);
  if (!me) return out;
  const put = new Map<number, number>();
  const street = new Map<number, number>();
  let stage = '';
  h.actions.forEach((a, i) => {
    if (a.stage !== stage) {
      stage = a.stage;
      street.clear();
    }
    if (a.seatIndex === me.seatIndex && (a.type === 'call' || a.type === 'allin' || a.type === 'fold')) {
      const toCall = Math.max(0, ...street.values()) - (street.get(me.seatIndex) ?? 0);
      const left = me.stackStart - (put.get(me.seatIndex) ?? 0);
      const pot = [...put.values()].reduce((s, n) => s + n, 0);
      // An all-in counts only when it put in exactly the call and that was every chip left.
      const certain = toCall > 0 && toCall <= left && (a.type === 'fold' || (a.amount === toCall && (a.type === 'call' || toCall === left)));
      if (certain) out.set(i, { toCall, pot, need: Math.round((toCall / (pot + toCall)) * 100) });
    }
    put.set(a.seatIndex, (put.get(a.seatIndex) ?? 0) + a.amount);
    street.set(a.seatIndex, (street.get(a.seatIndex) ?? 0) + a.amount);
  });
  return out;
}

/** "3.5 : 1" — the pot against the call, one decimal. */
export const oddsRatio = (o: PotOdds) => `${(Math.round((o.pot / o.toCall) * 10) / 10).toLocaleString('en-US')} : 1`;
