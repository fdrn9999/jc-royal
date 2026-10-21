/**
 * How table amounts read: in chips, or in big blinds of the table (or replayed hand) on screen when the player chose
 * that in settings. Only the reading changes. Amounts held, compared and sent are always the server's integer chips,
 * and a typed big-blind amount becomes whole chips before anything uses it. The wallet, the ledger and the admin
 * console stay in chips: they never ask for big blinds.
 */
import { formatBB, formatChips } from '@jc/ui';
import { useMemo } from 'react';
import { usePrefs, type AmountUnit } from './prefs';

export { AMOUNT_UNITS, type AmountUnit } from './prefs';

export interface Amounts {
  /** The unit in effect: big blinds only where it was chosen and a big blind is known. */
  unit: AmountUnit;
  bigBlind: number;
  /** For reading. `compact` shortens large amounts (12.5K) where space is tight. */
  fmt: (chips: number, compact?: boolean) => string;
  /** Wallet money changing hands (buy-in, top-up, rebuy): in big blinds the exact chips follow, "2.5 BB (50)". */
  exact: (chips: number) => string;
  /** The text an amount field shows for `chips`. */
  toInput: (chips: number) => string;
  /** What may be typed: digits, and in big blinds one decimal point (a comma counts as one). */
  clean: (typed: string) => string;
  /** Whole chips for a typed amount (rounded to the nearest chip in big blinds); 0 for nothing usable. */
  fromInput: (typed: string) => number;
}

export function amounts(unit: AmountUnit, bigBlind: number): Amounts {
  if (unit !== 'bb' || !(bigBlind > 0)) {
    const clean = (typed: string) => typed.replace(/\D/g, '');
    return {
      unit: 'chips',
      bigBlind,
      fmt: (n, compact) => formatChips(n, compact),
      exact: (n) => formatChips(n),
      toInput: (n) => String(n),
      clean,
      fromInput: (typed) => Number(clean(typed)) || 0,
    };
  }
  const clean = (typed: string) => {
    const s = typed.replace(/,/g, '.').replace(/[^\d.]/g, '');
    const dot = s.indexOf('.');
    return dot < 0 ? s : `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, '')}`;
  };
  return {
    unit: 'bb',
    bigBlind,
    fmt: (n, compact) => formatBB(n, bigBlind, compact),
    exact: (n) => `${formatBB(n, bigBlind)} (${formatChips(n)})`,
    toInput: (n) => String(Math.round((n / bigBlind) * 100) / 100),
    clean,
    fromInput: (typed) => {
      const v = Number(clean(typed));
      return Number.isFinite(v) && v > 0 ? Math.round(v * bigBlind) : 0;
    },
  };
}

/**
 * Amounts at a table (or a replayed hand) with this big blind, as the player chose to read them. The same object until
 * either changes, so the seats it is handed to are not drawn again for it.
 */
export function useAmounts(bigBlind: number): Amounts {
  const unit = usePrefs().amountUnit;
  return useMemo(() => amounts(unit, bigBlind), [unit, bigBlind]);
}
