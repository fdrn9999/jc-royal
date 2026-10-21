/**
 * Quick reactions: an emoji a seated player sends that shows for a moment over their avatar for everyone at the table.
 * Nothing about them touches the game; the room only checks the sender is seated and keeps to its rate. The social
 * policy (admin console) sets that rate, or turns them off: then the room sends `reactions: null` and none are offered.
 */
import { DEFAULT_REACTION_RULES, REACTION_EMOJI, REACTIONS, reactionWait, type ReactionId, type ReactionRules } from '@jc/types';
import { cx } from '@jc/ui';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useI18n, type MsgKey } from '../lib/i18n';

/** How long a reaction stays over a seat (its animation, .jc-react, runs 2.4 s). */
export const REACTION_SHOW_MS = 2_600;

/** A reaction showing at a seat, for the player who sent it. */
export interface SeatReaction {
  id: number;
  seatIndex: number;
  userId: string;
  reaction: ReactionId;
}

/** Sending from my seat, keeping to the room's limits so that a tap it would refuse is not offered. */
export interface ReactionSender {
  send: (reaction: ReactionId) => void;
  /** Milliseconds until the room takes another one (0: now). */
  wait: () => number;
}

/** `rules`: the limits the room sent (TableView.reactions); a room too old to send them keeps the defaults. */
export function useReactionSender(send: (msg: { t: 'react'; reaction: ReactionId }) => void, rules: ReactionRules | undefined): ReactionSender {
  const times = useRef<number[]>([]);
  const limits = useRef(DEFAULT_REACTION_RULES);
  limits.current = rules ?? DEFAULT_REACTION_RULES;
  return useMemo(
    () => ({
      wait: () => reactionWait(times.current, Date.now(), limits.current),
      send: (reaction) => {
        const now = Date.now();
        if (reactionWait(times.current, now, limits.current) > 0) return;
        times.current = [...times.current.filter((at) => now - at < limits.current.burstWindowMs), now];
        send({ t: 'react', reaction });
      },
    }),
    [send],
  );
}

/** The reaction over an avatar: inside the avatar's circle, so it hides nothing the avatar did not. */
export function ReactionBubble({ r, compact }: { r: SeatReaction; compact: boolean }) {
  return (
    <span
      aria-hidden
      className="jc-react pointer-events-none absolute inset-0 grid place-items-center rounded-full bg-ink-950/70 leading-none"
      style={{ fontSize: compact ? '1.35rem' : '1.65rem' }}
      data-testid={`reaction-${r.seatIndex}`}
      data-reaction={r.reaction}
    >
      {REACTION_EMOJI[r.reaction]}
    </span>
  );
}

/** The reaction button and its tray, open or not; `off` (my turn: the action bar takes the line) closes it. */
export interface ReactionTrayState {
  open: boolean;
  toggle: () => void;
  close: () => void;
  opener: RefObject<HTMLButtonElement | null>;
  tray: RefObject<HTMLDivElement | null>;
}

/**
 * The button lies in the status line under the table and the tray is a line of its own above it (Table.tsx), not over my
 * seat: the table makes room for it while it is open (useStackRoom's data-momentary) and comes back when it closes, so
 * it covers neither my cards nor a seat nor the wallet beside the button. Closes after a pick, on a tap elsewhere, on
 * Escape (the button gets its focus back) and on my turn.
 */
export function useReactionTray(off: boolean): ReactionTrayState {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const tray = useRef<HTMLDivElement>(null);
  const shown = open && !off;
  useEffect(() => {
    if (off) setOpen(false);
  }, [off]);
  useEffect(() => {
    if (!shown) return;
    // The button toggles it itself: a tap on it is not one elsewhere.
    const outside = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!tray.current?.contains(at) && !opener.current?.contains(at)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      opener.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [shown]);
  return useMemo(() => ({ open: shown, toggle: () => setOpen((o) => !o), close: () => setOpen(false), opener, tray }), [shown]);
}

/** Opens the tray: a finger's size (44px), in the status line. */
export function ReactionButton({ tray }: { tray: ReactionTrayState }) {
  const { t } = useI18n();
  return (
    <button
      ref={tray.opener}
      type="button"
      onClick={tray.toggle}
      className={cx(
        'jc-tap grid size-11 shrink-0 place-items-center rounded-full border text-xl leading-none hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-gold-400',
        tray.open ? 'border-gold-400/70 bg-gold-500/15' : 'border-white/10',
      )}
      aria-label={t('react.open')}
      title={t('react.open')}
      aria-expanded={tray.open}
      aria-controls={tray.open ? 'react-tray' : undefined}
      data-testid="react-open"
    >
      <span aria-hidden>😊</span>
    </button>
  );
}

/**
 * The eight reactions, a line of the stack above the status line's button: four to a row on a phone and in a short
 * screen's column (`column`, where each takes a quarter of its width), all eight in one row wider.
 */
export function ReactionTray({ state, sender, column }: { state: ReactionTrayState; sender: ReactionSender; column: boolean }) {
  const { t } = useI18n();
  const wait = sender.wait();
  const [, tick] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const h = setTimeout(() => tick((n) => n + 1), Math.min(wait, 250));
    return () => clearTimeout(h);
  });
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);

  return (
    <div
      ref={state.tray}
      id="react-tray"
      role="group"
      aria-label={t('react.title')}
      className={cx('pointer-events-auto rounded-2xl border border-gold-500/30 bg-ink-950/95 shadow-2xl backdrop-blur sm:self-end', column ? 'p-1' : 'p-1.5')}
      data-testid="react-tray"
      data-momentary
    >
      <div className={cx('grid', column ? 'grid-cols-4 gap-0.5' : 'grid-cols-4 gap-1 sm:grid-cols-8')}>
        {REACTIONS.map((r, i) => (
          <button
            key={r}
            ref={i === 0 ? first : undefined}
            type="button"
            disabled={wait > 0}
            onClick={() => {
              sender.send(r);
              state.close();
            }}
            className={cx(
              'jc-tap grid place-items-center rounded-xl text-2xl leading-none hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-gold-400 disabled:opacity-35',
              column ? 'h-11 w-full' : 'size-11',
            )}
            aria-label={t(`react.${r}` as MsgKey)}
            title={t(`react.${r}` as MsgKey)}
            data-testid={`react-${r}`}
          >
            {REACTION_EMOJI[r]}
          </button>
        ))}
      </div>
      {wait > 0 && (
        <p className="px-1 pt-1 text-center text-[11px] text-ink-300" role="status" data-testid="react-wait">
          {t('react.wait', { s: Math.ceil(wait / 1000) })}
        </p>
      )}
    </div>
  );
}
