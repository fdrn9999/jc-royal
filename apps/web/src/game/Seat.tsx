/**
 * Player seat. Structure follows Elite-Poker's PlayerSeat (name row, chips +
 * last action, hole cards, dealer/blind badges, timer ring, winner state),
 * rebuilt for the server-projected SeatView and the JC ROYAL style.
 */
import type { SeatView } from '@jc/types';
import { cx, PlayingCard } from '@jc/ui';
import { useEffect, useState, type CSSProperties } from 'react';
import { MemberName } from '../components/MemberName';
import type { Amounts } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(h);
  }, [active]);
  return now;
}

/** Timer ring around the avatar driven by the server deadline. */
function TimerRing({ deadline, totalMs }: { deadline: number; totalMs: number }) {
  const now = useNow(true);
  const left = Math.max(0, deadline - now);
  const frac = Math.min(1, left / totalMs);
  const color = frac > 0.5 ? 'var(--color-gold-400)' : frac > 0.25 ? 'var(--color-warning)' : 'var(--color-danger)';
  return (
    <span
      aria-hidden
      data-tour="timer"
      className={cx('absolute -inset-[3px] rounded-full', frac <= 0.25 && 'animate-pulse')}
      style={{ background: `conic-gradient(${color} ${frac * 360}deg, rgba(255,255,255,0.08) 0)` }}
    />
  );
}

function initials(name?: string) {
  return (name ?? '?').slice(0, 2).toUpperCase();
}

export interface SeatProps {
  seat: SeatView;
  isMe: boolean;
  isActor: boolean;
  deadline: number | null;
  turnMs: number;
  isDealer: boolean;
  /** The member who opened this room. */
  isHost: boolean;
  blind: 'SB' | 'BB' | null;
  winAmount: number | null;
  handLabel: string | null;
  bestFive: string[] | null;
  newHandKey: string | null;
  canSit: boolean;
  onSit: () => void;
  /** Opens this player's card (other occupied seats only). */
  onPick?: () => void;
  /** My seat after a hand, with auto-muck on: a button over each card turns it face up for the table. */
  onShow?: (card: 0 | 1) => void;
  compact: boolean;
  amounts: Amounts;
  style: CSSProperties;
}

export function Seat(p: SeatProps) {
  const { t } = useI18n();
  const s = p.seat;
  const cardSize = p.compact ? (p.isMe ? '2.6rem' : '1.7rem') : p.isMe ? '3.4rem' : '2.5rem';

  if (s.state === 'empty') {
    return (
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={p.style}>
        {p.canSit ? (
          <button
            onClick={p.onSit}
            data-testid={`sit-${s.seatIndex}`}
            className="flex size-14 flex-col items-center justify-center rounded-full border border-dashed border-gold-500/50 bg-black/40 text-[10px] font-semibold text-gold-300 transition hover:bg-gold-500/15 sm:size-16"
          >
            <span className="text-base leading-none">＋</span>
            {t('table.sit')}
          </button>
        ) : (
          <div className="size-9 rounded-full border border-dashed border-white/[0.07] sm:size-11" title={t('table.emptySeat')} />
        )}
      </div>
    );
  }

  const folded = s.state === 'folded';
  const allIn = s.state === 'allin';
  const winner = p.winAmount !== null && p.winAmount > 0;
  // Cards shown after the hand: face up where chosen, the other one face down (its owner sees both in holeCards).
  const shown = s.shown?.length ? s.shown : null;
  const isShown = (i: number) => !!shown?.[i];
  const showCards = s.hasCards || (s.holeCards && s.holeCards.length > 0) || !!shown;
  const cards = s.holeCards && s.holeCards.length ? s.holeCards : (shown ?? (showCards ? [null, null] : []));
  const actionLabel = s.lastAction ? `${t(`action.${s.lastAction.type}` as MsgKey)}${s.lastAction.amount > 0 ? ` ${p.amounts.fmt(s.lastAction.amount, true)}` : ''}` : null;
  const actionTone =
    s.lastAction?.type === 'fold'
      ? 'text-[#f0a0a2]'
      : s.lastAction?.type === 'raise' || s.lastAction?.type === 'bet'
        ? 'text-gold-300'
        : s.lastAction?.type === 'allin'
          ? 'text-[#f5a860]'
          : 'text-[#9fd8b6]';

  return (
    <div className="absolute z-10 -translate-x-1/2 -translate-y-1/2" style={p.style} data-testid={`seat-${s.seatIndex}`} data-state={s.state}>
      <div className={cx('relative flex flex-col items-center', folded && !shown && 'opacity-55')}>
        {/* hole cards */}
        {cards.length > 0 && (
          <div className={cx('relative mb-[-0.6rem] flex', p.isMe ? 'gap-1' : '-space-x-3')} key={p.newHandKey ?? 'cards'}>
            {cards.map((c, i) => (
              <PlayingCard
                key={`${c ?? 'x'}-${i}`}
                card={c ?? null}
                size={cardSize}
                animate={c ? 'flip' : 'deal'}
                highlight={!!c && !!p.bestFive?.includes(c)}
                dim={folded && !isShown(i)}
                style={{ animationDelay: `${i * 90}ms`, transform: !p.isMe ? `rotate(${i === 0 ? -6 : 6}deg)` : undefined }}
              />
            ))}
            {p.onShow && (
              <div className="absolute bottom-full left-0 mb-1 flex gap-1" data-testid="show-cards">
                {cards.map((_, i) =>
                  isShown(i) ? (
                    <span
                      key={i}
                      className="grid h-6 place-items-center rounded-full border border-[#9fd8b6]/40 bg-ink-950/85 text-[10px] font-bold text-[#9fd8b6]"
                      style={{ width: cardSize }}
                      data-testid={`shown-card-${i}`}
                    >
                      {t('table.shownCard')}
                    </span>
                  ) : (
                    <button
                      key={i}
                      type="button"
                      onClick={() => p.onShow!(i === 0 ? 0 : 1)}
                      className="jc-tap grid h-6 place-items-center rounded-full border border-gold-500/60 bg-ink-950/85 text-[10px] font-bold text-gold-200 hover:bg-gold-500/20 focus-visible:outline-2 focus-visible:outline-gold-400"
                      style={{ width: cardSize }}
                      aria-label={t('table.showCardAria', { n: i + 1 })}
                      data-testid={`show-card-${i}`}
                    >
                      {t('table.showCard')}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        )}
        {/* plate */}
        <div
          className={cx(
            'relative flex min-w-[6.5rem] items-center gap-2 rounded-full border py-1 pl-1 pr-3 shadow-xl backdrop-blur-sm sm:min-w-[8.5rem]',
            p.isActor ? 'border-gold-400/80' : 'border-[var(--t-seat-border)]',
            winner && 'jc-winner',
          )}
          style={{ background: 'var(--t-seat)' }}
        >
          <span className="relative grid size-9 shrink-0 place-items-center rounded-full sm:size-11">
            {p.isActor && p.deadline && <TimerRing deadline={p.deadline} totalMs={p.turnMs} />}
            <span
              className={cx(
                'relative grid size-full place-items-center overflow-hidden rounded-full border bg-gradient-to-br from-ink-600 to-ink-800 text-xs font-bold text-gold-300',
                s.role === 'super_admin' ? 'border-[#e2bd6a]/80' : s.role === 'admin' ? 'border-[#5aa9ff]/80' : 'border-white/10',
              )}
            >
              {s.avatarUrl ? <img src={s.avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : initials(s.nickname)}
            </span>
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            {/* The width cap sits on a wrapper: MemberName's own max-w-full comes later in the stylesheet and would win. */}
            <span className="flex min-w-0 max-w-[5.5rem] sm:max-w-[7rem]">
              <MemberName name={s.nickname ?? ''} role={s.role} className={cx('text-xs font-semibold sm:text-[13px]', p.isMe ? 'text-gold-300' : 'text-ivory')} />
            </span>
            <span className="font-mono text-[11px] font-semibold text-[#9fd8b6] tabular-nums sm:text-xs" data-testid={`stack-${s.seatIndex}`}>
              {p.amounts.fmt(s.stack, p.compact)}
            </span>
          </span>
          {(p.isDealer || p.blind) && (
            <span className="absolute -left-2 -top-2 z-10 flex items-center gap-0.5">
              {p.isDealer && (
                <span className="grid size-5 place-items-center rounded-full border border-black/30 bg-gradient-to-b from-ivory to-[#cfc6b0] font-display text-[10px] font-black text-ink-950 shadow-md" data-testid="dealer-button">
                  D
                </span>
              )}
              {p.blind && (
                <span data-tour={`blind-${p.blind}`} className={cx('rounded-full border px-1.5 text-[9px] font-bold leading-4', p.blind === 'SB' ? 'border-info/50 bg-[#16263b] text-[#a9c8ee]' : 'border-danger/50 bg-[#3a1618] text-[#f0a0a2]')}>{p.blind}</span>
              )}
            </span>
          )}
          {p.isHost && (
            <span className="absolute -right-1.5 -top-2 z-10 rounded-full border border-gold-500/50 bg-ink-950 px-1 text-[10px] leading-4" title={t('room.host')} aria-label={t('room.host')} data-testid="host-mark">
              👑
            </span>
          )}
          {p.onPick && (
            <button type="button" className="absolute inset-0 rounded-full focus-visible:outline-2 focus-visible:outline-gold-400" onClick={p.onPick} aria-label={s.nickname} data-testid={`seat-pick-${s.seatIndex}`} />
          )}
        </div>
        {/* status line */}
        <div className="mt-1 flex h-4 items-center gap-1 text-[10px] font-bold tracking-wide sm:text-[11px]">
          {winner ? (
            <span className="text-[var(--t-winner)]">
              {t('table.winner')} +{p.amounts.fmt(p.winAmount!, true)}
              {p.handLabel ? ` · ${p.handLabel}` : ''}
            </span>
          ) : allIn ? (
            <span className="rounded-full bg-[#e08227]/20 px-1.5 text-[#f5a860]">{t('table.allin')}</span>
          ) : s.state === 'sittingOut' ? (
            <span className="text-ink-400">{t('table.sittingOut')}</span>
          ) : !s.connected ? (
            <span className="text-ink-400">{t('table.offline')}</span>
          ) : p.handLabel ? (
            <span className="text-gold-300">{p.handLabel}</span>
          ) : actionLabel ? (
            <span className={actionTone}>{actionLabel}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
