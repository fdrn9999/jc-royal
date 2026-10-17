/**
 * Quick reactions: an emoji a seated player sends that shows for a moment over their avatar for everyone at the table.
 * Nothing about them touches the game; the room only checks the sender is seated and keeps to its rate. The social
 * policy (admin console) sets that rate, or turns them off: then the room sends `reactions: null` and none are offered.
 */
import { DEFAULT_REACTION_RULES, REACTION_EMOJI, REACTIONS, reactionWait, type ReactionId, type ReactionRules } from '@jc/types';
import { useEffect, useMemo, useRef, useState } from 'react';
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

/** The eight reactions, above my seat. Closes after a pick; the seat closes it on a tap elsewhere, Escape or my turn. */
export function ReactionTray({ sender, onClose }: { sender: ReactionSender; onClose: () => void }) {
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
      role="group"
      aria-label={t('react.title')}
      className="absolute bottom-full left-1/2 mb-2 w-max -translate-x-1/2 rounded-2xl border border-gold-500/30 bg-ink-950/95 p-1.5 shadow-2xl backdrop-blur"
      data-testid="react-tray"
    >
      <div className="grid grid-cols-4 gap-1">
        {REACTIONS.map((r, i) => (
          <button
            key={r}
            ref={i === 0 ? first : undefined}
            type="button"
            disabled={wait > 0}
            onClick={() => {
              sender.send(r);
              onClose();
            }}
            className="jc-tap grid size-11 place-items-center rounded-xl text-2xl leading-none hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-gold-400 disabled:opacity-35"
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
