import { THEMES, type ThemeId } from '@jc/ui';
import { useSyncExternalStore } from 'react';

/** How table amounts read (see amount.ts). Kept here so loading the preferences needs nothing else. */
export const AMOUNT_UNITS = ['chips', 'bb'] as const;
export type AmountUnit = (typeof AMOUNT_UNITS)[number];

/** Per-device UI preferences (cosmetic, except autoMuck, which the table is asked to apply to the player's seat). */
export interface Prefs {
  theme: ThemeId;
  fourColor: boolean;
  /** Require a second tap for fold-when-check-is-free, large calls and all-in. */
  confirmRisky: boolean;
  /** Beginner aids at the table: current hand, action help, street notes. Independent of confirmRisky. */
  beginner: boolean;
  /** Keep a losing showdown hand face down where the rules allow it; sent to the room for the seat (`muck`). */
  autoMuck: boolean;
  /** Table and replay amounts in chips or in big blinds (reading only; the wallet stays in chips). */
  amountUnit: AmountUnit;
}

const KEY = 'jc.prefs';
const DEFAULTS: Prefs = { theme: 'royal', fourColor: false, confirmRisky: true, beginner: false, autoMuck: false, amountUnit: 'chips' };
let current: Prefs = load();
const listeners = new Set<() => void>();

function load(): Prefs {
  try {
    const p = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
    if (!THEMES.includes(p.theme)) p.theme = 'royal';
    if (!AMOUNT_UNITS.includes(p.amountUnit)) p.amountUnit = 'chips';
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = current.theme;
  for (const l of listeners) l();
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function applyInitialTheme() {
  document.documentElement.dataset.theme = current.theme;
}
