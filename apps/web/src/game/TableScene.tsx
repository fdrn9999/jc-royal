/**
 * The felt, board, pot, seats and cue effects of a table view. Shared by the
 * multiplayer table and the offline Academy practice table so both look and
 * animate the same; it only renders the TableView it is given.
 */
import { handLabelKey, type Card, type SeatView, type TableView } from '@jc/types';
import { ChipStack, Logo, PlayingCard } from '@jc/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { amounts as chipAmounts, type Amounts } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';
import { CueLayer } from './CueLayer';
import { POT_POINT, seatLayout, type SeatGeometry } from './layout';
import type { ReactionSender, SeatReaction } from './Reactions';
import { Seat } from './Seat';
import type { CueEvent } from './useTableSocket';

export function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export interface TableLayout {
  portrait: boolean;
  compact: boolean;
  box: { w: number; h: number };
  geometry: SeatGeometry[];
}

/** Table box and seat geometry for the available area (portrait vs landscape, compact on small screens). */
export function useTableLayout(area: { w: number; h: number }, maxSeats: number | undefined, anchor: number): TableLayout {
  const portrait = area.w / Math.max(1, area.h) < 0.95;
  // Short viewports (landscape phones, open keyboard) get the dense layout too.
  const compact = area.w < 640 || area.h < 520;
  const plateHalfPx = compact ? 60 : 76;
  // Table box: keep the felt proportions inside the available area.
  const box = useMemo(() => {
    const ratio = portrait ? 0.68 : 1.75;
    let w = area.w;
    let h = w / ratio;
    if (h > area.h) {
      h = area.h;
      w = h * ratio;
    }
    return { w, h };
  }, [area, portrait]);
  const geometry = useMemo(
    () => (maxSeats ? seatLayout(maxSeats, anchor, portrait, Math.min(45, (plateHalfPx / Math.max(1, box.w)) * 100)) : []),
    [maxSeats, anchor, portrait, plateHalfPx, box.w],
  );
  return { portrait, compact, box, geometry };
}

const CHIPS = chipAmounts('chips', 0);

export function TableScene({
  s,
  layout,
  mySeat,
  canSit,
  onSit,
  onSeatClick,
  onShow,
  reactions,
  react,
  nextIn,
  cues,
  consumeCues,
  reducedMotion,
  amounts = CHIPS,
}: {
  s: TableView;
  layout: TableLayout;
  mySeat: number | null;
  canSit: boolean;
  onSit: (seatIndex: number) => void;
  /** Tapping another player's plate (the real table only). */
  onSeatClick?: (seat: SeatView) => void;
  /** Shows one of my cards after the hand (the real table only; offered while `you.canShow`). */
  onShow?: (card: 0 | 1) => void;
  /** Quick reactions showing now (the real table only), each at its sender's seat while that player still sits there. */
  reactions?: SeatReaction[];
  /** Sending reactions from my seat (the real table only, while seated). */
  react?: ReactionSender;
  nextIn: number | null;
  cues: CueEvent[];
  consumeCues: (upToId: number) => void;
  reducedMotion: boolean;
  /** How amounts read (the player's unit at a real table or a replay; the Academy keeps chips, as its lessons do). */
  amounts?: Amounts;
}) {
  const { t } = useI18n();
  const { portrait, compact, box, geometry } = layout;
  const hand = s.hand;
  const winners = useMemo(() => new Map((hand?.result?.winners ?? []).map((w) => [w.seatIndex, w.amount])), [hand?.result]);
  const showdown = useMemo(() => new Map((hand?.result?.showdown ?? []).map((x) => [x.seatIndex, x])), [hand?.result]);
  const topWinner = hand?.result?.winners?.[0]?.seatIndex;
  const winningFive = topWinner !== undefined ? (showdown.get(topWinner)?.bestFive ?? []) : [];
  // Chips already gathered in the middle; after settlement they have been paid out.
  const collected = hand && hand.stage !== 'settled' ? hand.potTotal - s.seats.reduce((a, x) => a + x.streetBet, 0) : 0;
  const boardSize = compact ? '2.1rem' : 'clamp(2.4rem,4.2vw,3.6rem)';

  return (
    <div className="relative" style={{ width: box.w, height: box.h }} data-testid="table" data-portrait={portrait ? '1' : '0'}>
      {/* rail + felt */}
      <div className="absolute rounded-[50%] p-[1.2%] shadow-[0_30px_80px_rgba(0,0,0,0.7)]" style={{ inset: portrait ? '9% 11%' : '11% 9%', background: 'var(--t-rail)' }}>
        <div className="relative size-full rounded-[50%] p-[0.6%]" style={{ background: 'var(--t-rail-inner)' }}>
          <div className="relative size-full overflow-hidden rounded-[50%] shadow-[inset_0_6px_30px_rgba(0,0,0,0.7)]" style={{ background: 'var(--t-felt)' }}>
            <div className="absolute inset-[9%] rounded-[50%] border" style={{ borderColor: 'var(--t-felt-line)' }} />
            <div className="absolute inset-x-0 flex justify-center" style={{ top: portrait ? '16%' : '12%', opacity: 'var(--t-watermark-opacity)' }}>
              <Logo size={Math.min(box.w, box.h) * 0.18} />
            </div>
          </div>
        </div>
      </div>

      {/* pot + board */}
      <div className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2" style={{ top: `${POT_POINT.y + 7}%` }}>
        <div className="flex min-h-7 items-center gap-2" data-testid="pot">
          {collected > 0 && <ChipStack amount={collected} text={amounts.fmt(collected, true)} />}
          {hand && hand.pots.length > 1 && hand.stage !== 'settled' && (
            <span className="rounded-full bg-black/45 px-2 py-0.5 text-[10px] text-ink-200">{hand.pots.map((p, i) => `${i === 0 ? t('table.pot') : t('table.sidePot', { n: i })} ${amounts.fmt(p.amount, true)}`).join(' · ')}</span>
          )}
        </div>
        <div className="flex gap-1 rounded-xl bg-black/35 p-1.5 shadow-[inset_0_1px_8px_rgba(0,0,0,0.45)] sm:gap-1.5 sm:p-2" data-testid="board">
          {Array.from({ length: 5 }, (_, i) => {
            const c = hand?.board[i] as Card | undefined;
            return c ? (
              <PlayingCard key={`${hand!.id}-${c}`} card={c} size={boardSize} animate="flip" highlight={winningFive.includes(c)} style={{ animationDelay: `${(i % 3) * 120}ms` }} />
            ) : (
              <div key={i} className="jc-card border border-dashed border-white/10 bg-black/10" style={{ ['--card-size' as string]: boardSize, boxShadow: 'none' }} />
            );
          })}
        </div>
        {/* Fixed-height status slot: text changes never move the board. */}
        <div className="flex h-5 items-center text-xs tracking-[0.06em] text-ink-200/80" data-testid="table-status" aria-live="polite">
          {!hand ? (nextIn !== null ? t('table.nextHand', { s: nextIn }) : t('table.waiting')) : hand.stage === 'settled' && nextIn !== null ? t('table.nextHand', { s: nextIn }) : null}
        </div>
      </div>

      {/* seats, bets, dealer button */}
      {s.seats.map((seat) => {
        const g = geometry[seat.seatIndex]!;
        const sd = showdown.get(seat.seatIndex);
        const label = sd ? t(`hand.${handLabelKey(sd.rankClass, sd.bestFive)}` as MsgKey) : null;
        return (
          <div key={seat.seatIndex}>
            <Seat
              seat={seat}
              isMe={seat.seatIndex === mySeat}
              isActor={!!hand && hand.actorSeat === seat.seatIndex && hand.stage !== 'settled'}
              deadline={hand?.deadline ?? null}
              turnMs={s.table.turnSeconds * 1000}
              isDealer={hand?.buttonSeat === seat.seatIndex}
              isHost={!!s.table.hostId && seat.userId === s.table.hostId}
              blind={hand && hand.stage === 'preflop' ? (hand.sbSeat === seat.seatIndex ? 'SB' : hand.bbSeat === seat.seatIndex ? 'BB' : null) : null}
              winAmount={winners.get(seat.seatIndex) ?? null}
              handLabel={label}
              bestFive={sd?.bestFive ?? null}
              newHandKey={hand?.id ?? null}
              canSit={canSit}
              onSit={() => onSit(seat.seatIndex)}
              onPick={onSeatClick && seat.userId && seat.seatIndex !== mySeat ? () => onSeatClick(seat) : undefined}
              onShow={onShow && seat.seatIndex === mySeat && s.you.canShow ? onShow : undefined}
              reaction={seat.userId ? reactions?.find((r) => r.seatIndex === seat.seatIndex && r.userId === seat.userId) : null}
              react={seat.seatIndex === mySeat ? react : undefined}
              compact={compact}
              amounts={amounts}
              style={{ left: `${g.seat.x}%`, top: `${g.seat.y}%` }}
            />
            {seat.streetBet > 0 && hand?.stage !== 'settled' && (
              <div className="absolute z-20 -translate-x-1/2 -translate-y-1/2" style={{ left: `${g.bet.x}%`, top: `${g.bet.y}%` }} data-testid={`bet-${seat.seatIndex}`}>
                <ChipStack amount={seat.streetBet} size={compact ? '1rem' : '1.25rem'} text={amounts.fmt(seat.streetBet, true)} />
              </div>
            )}
          </div>
        );
      })}

      <CueLayer cues={cues} consume={consumeCues} geometry={geometry} mySeat={mySeat} reducedMotion={reducedMotion} />
    </div>
  );
}
