/**
 * A short, wide screen: a phone held sideways (844×390, 800×360) or a short window. The table screen then keeps its
 * controls in a column at the right edge and gives the felt the full height, which nine seats with cards need (a bar
 * below the table leaves them 286px of the 354px or more they take). Wider than a phone held upright, so the column
 * never takes a phone's width; no taller than a landscape phone, so a tablet or a laptop keeps the bar below.
 */
import { useSyncExternalStore } from 'react';
import type { LayoutOptions } from './TableScene';

export const SHORT_QUERY = '(min-width: 640px) and (max-height: 500px)';

function subscribe(onChange: () => void) {
  const m = window.matchMedia?.(SHORT_QUERY);
  m?.addEventListener?.('change', onChange);
  return () => m?.removeEventListener?.('change', onChange);
}

const read = () => window.matchMedia?.(SHORT_QUERY).matches === true;

export function useShortScreen() {
  return useSyncExternalStore(subscribe, read, () => false);
}

/**
 * The real table's layout options. Upright, room is kept above my cards for the show-card buttons and a status line
 * under the board; short, the buttons lie on my cards' lower half (the ranks stay visible) and the status line goes to
 * the column, which leaves the seats the height, and the table may narrow by up to 15% where that keeps every bet by
 * its own seat (nine seats at 800×360 fit 572px of the 580 the column leaves, not 580).
 */
export function realTableOptions(short: boolean): Pick<LayoutOptions, 'meTop' | 'footer' | 'narrow'> {
  return short ? { meTop: 4, footer: false, narrow: 0.85 } : { meTop: 28, footer: true };
}
