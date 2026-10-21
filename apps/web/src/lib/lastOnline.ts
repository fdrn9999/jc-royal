/**
 * "Last online 5 min ago" for a friend shown offline (docs/PRESENCE.md). The time is the server's, to the minute, and
 * only ever one it recorded: with none, nothing is shown rather than a guess.
 */
import { useEffect, useState } from 'react';

export type LastOnlineAgo =
  | { key: 'now' | 'yesterday' | 'long' }
  | { key: 'min' | 'hour' | 'days'; n: number };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Further back than this many calendar days: "over a month ago". */
const DAYS_MAX = 30;

/** Calendar days between two times on this device's clock (a daylight-saving day still counts as one). */
function calendarDays(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  return Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / DAY);
}

/**
 * How long ago `at` was: under a minute "just now", then minutes, then hours up to a day, then "yesterday" or calendar
 * days, then "over a month". A time ahead of this device's clock (a clock running late) reads as just now.
 */
export function lastOnlineAgo(at: number, now: number): LastOnlineAgo {
  const ago = Math.max(0, now - at);
  if (ago < MIN) return { key: 'now' };
  if (ago < HOUR) return { key: 'min', n: Math.floor(ago / MIN) };
  if (ago < DAY) return { key: 'hour', n: Math.floor(ago / HOUR) };
  const days = calendarDays(at, now);
  if (days <= 1) return { key: 'yesterday' };
  return days > DAYS_MAX ? { key: 'long' } : { key: 'days', n: days };
}

const tickers = new Set<(now: number) => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

/** The time now, moving once a minute while the calling screen is on: one timer for every caller, none without one. */
export function useMinuteNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticker) {
      ticker = setInterval(() => {
        const at = Date.now();
        for (const f of tickers) f(at);
      }, MIN);
    }
    tickers.add(setNow);
    return () => {
      tickers.delete(setNow);
      if (!tickers.size && ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    };
  }, []);
  return now;
}
