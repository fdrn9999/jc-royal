/**
 * My turn, said so it is hard to miss: a label with the time left above the action bar (TurnBanner), a sound and, when
 * asked for, a short vibration once per decision, and the tab's title while the page is hidden (useTurnCue). The time
 * left is the room's deadline (time bank included), read the same way as the seat's timer ring. Mute, a hidden page and
 * reduced motion are kept: the sound engine plays nothing muted or hidden, and the pulse stops under reduced motion.
 */
import { sound } from '@jc/audio';
import { cx } from '@jc/ui';
import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';

/** From this much time left the clock reads low: the label turns to the warning colour and the timer beeps. */
export const TURN_LOW_MS = 5_000;

const SEEN_KEY = 'jc.turn';
let lastKey: string | null = null;

/**
 * Whether the decision `key` (hand and its state version) is new to this tab, marking it seen: a re-render, a remount
 * of the table or a reload during the same turn cues nothing again.
 */
export function takeTurnCue(key: string): boolean {
  if (key === lastKey) return false;
  lastKey = key;
  try {
    if (sessionStorage.getItem(SEEN_KEY) === key) return false;
    sessionStorage.setItem(SEEN_KEY, key);
  } catch {
    /* storage blocked: this tab's memory only */
  }
  return true;
}

/** For tests: forget the decisions already cued. */
export function resetTurnCue() {
  lastKey = null;
  try {
    sessionStorage.removeItem(SEEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Two short buzzes. */
export const TURN_BUZZ = [40, 60, 40];

/**
 * Cues the decision `key` once: the sound and, with `vibrate`, the buzz. While the page is hidden nothing plays, but
 * the decision still counts as cued, so coming back to the page does not set off a turn already under way. Whether it
 * played.
 */
export function cueTurn(key: string, vibrate: boolean, env: { hidden: boolean; play: () => void; buzz?: (pattern: number[]) => unknown }): boolean {
  if (!takeTurnCue(key) || env.hidden) return false;
  env.play();
  if (vibrate) {
    try {
      env.buzz?.(TURN_BUZZ);
    } catch {
      /* not allowed here */
    }
  }
  return true;
}

type TitleDoc = Pick<Document, 'title' | 'hidden' | 'addEventListener' | 'removeEventListener'>;

/**
 * While `doc` is hidden its title starts with `title`; shown, it is the title it had. The returned function stops that
 * and puts the title back (unless the page changed it meanwhile).
 */
export function holdTurnTitle(doc: TitleDoc, title: string): () => void {
  const base = doc.title;
  const marked = `${title} · ${base}`;
  const sync = () => {
    doc.title = doc.hidden ? marked : base;
  };
  sync();
  doc.addEventListener('visibilitychange', sync);
  return () => {
    doc.removeEventListener('visibilitychange', sync);
    if (doc.title === marked) doc.title = base;
  };
}

/**
 * `key`: the decision now asked of me (`${hand.id}:${hand.seq}`, the same through a time bank's extra time), or null
 * when it is not my turn. See cueTurn and holdTurnTitle.
 */
export function useTurnCue(key: string | null, o: { vibrate: boolean; title: string }) {
  const { vibrate, title } = o;
  useEffect(() => {
    if (!key) return;
    cueTurn(key, vibrate, { hidden: document.hidden, play: () => sound.play('turn'), buzz: (p) => navigator.vibrate?.(p) });
  }, [key, vibrate]);

  useEffect(() => (key ? holdTurnTitle(document, title) : undefined), [key, title]);
}

/** Whole seconds left to `deadline` (epoch ms), counting down; null without one. */
export function useSecondsLeft(deadline: number | null): number | null {
  const read = () => (deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null);
  const [left, setLeft] = useState(read);
  useEffect(() => {
    setLeft(read());
    if (!deadline) return;
    const h = setInterval(() => setLeft(read()), 250);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline]);
  return left;
}

/**
 * "Your turn" with the time left, at the action bar (above it on a phone; in a short screen's column, `compact` in the
 * time bank's pill, so the column is no taller for it). Takes no taps and lays nothing over the table: it is a line of the
 * stack under it. Low on time it turns to the warning colour with a ⚠ and says so to a screen reader once (the seconds
 * themselves are not read out).
 */
export function TurnBanner({ deadline, compact = false, className }: { deadline: number | null; compact?: boolean; className?: string }) {
  const { t } = useI18n();
  const left = useSecondsLeft(deadline);
  const low = left !== null && left * 1000 <= TURN_LOW_MS;
  return (
    <div
      role="status"
      className={cx(
        'pointer-events-none flex items-center text-xs font-bold whitespace-nowrap',
        compact ? 'gap-1.5' : 'justify-center gap-2 rounded-full border px-3 py-1 tracking-wider',
        low ? 'text-danger-soft' : 'text-gold-300',
        !compact && (low ? 'border-danger/70 bg-danger/15' : 'jc-pulse-gold border-gold-400/70 bg-gold-500/15'),
        className,
      )}
      data-testid="turn-banner"
      data-low={low ? '' : undefined}
    >
      <span className="uppercase">{t(compact ? 'table.turnTitle' : 'table.yourTurn')}</span>
      {left !== null && (
        <span className="font-mono tabular-nums" aria-hidden data-testid="turn-left">
          {low && '⚠ '}
          {t('table.turnLeft', { n: left })}
        </span>
      )}
      {low && <span className="sr-only">{t('table.turnLow')}</span>}
    </div>
  );
}
