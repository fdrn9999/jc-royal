/**
 * The felt, board, pot, seats and cue effects of a table view. Shared by the
 * multiplayer table and the offline Academy practice table so both look and
 * animate the same; it only renders the TableView it is given.
 */
import { handLabelKey, type Card, type SeatView, type TableView } from '@jc/types';
import { ChipStack, Logo, PlayingCard } from '@jc/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { amounts as chipAmounts, type Amounts, type AmountUnit } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';
import { Flights, useCueStaging } from './CueLayer';
import { DIMS, planHeight, planTable, type Density, type PlanInput, type Point, type SeatGeometry, type TablePlan } from './layout';
import type { ReactionSender, SeatReaction } from './Reactions';
import { Seat } from './Seat';
import { collected as collectedOf } from './staging';
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

/**
 * Keeps the stack at the bottom of a table screen (beginner notes, coaching, questions, the action bar or the
 * pre-actions, the status bar) off the table: `colRef` goes on the column holding both, `stackRef` on the stack, and
 * `style` on the table area. On a phone the stack spans the screen, so the area ends where the stack starts. Wider, the
 * stack sits in the bottom-right corner and the area keeps clear of its height, or of its width beside it (a phone on
 * its side), whichever leaves the table more room. Measured, since the stack depends on the state, the language and the
 * width, and only growing within a `mode` (and width), so the table does not move turn by turn. Passing toasts and
 * notices (data-transient) are left out.
 */
export function useStackRoom(mode: string) {
  const [colRef, col] = useBoxSize<HTMLDivElement>();
  const stackRef = useRef<HTMLDivElement>(null);
  const key = `${mode}|${Math.round(col.w)}`;
  const [room, setRoom] = useState({ key, w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const read = () => {
      const kids = Array.from(el.children as HTMLCollectionOf<HTMLElement>).filter((k) => k.dataset.transient === undefined && k.offsetHeight > 0);
      const h = kids.length ? Math.ceil(el.getBoundingClientRect().bottom - Math.min(...kids.map((k) => k.getBoundingClientRect().top))) : 0;
      const w = Math.max(0, ...kids.map((k) => k.offsetWidth));
      setRoom((r) => (r.key !== key ? { key, w, h } : w > r.w || h > r.h ? { key, w: Math.max(w, r.w), h: Math.max(h, r.h) } : r));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]);
  const { w, h } = room.key === key ? room : { w: 0, h: 0 };
  let style: CSSProperties = { marginBottom: h };
  if (col.w >= 640) {
    // The box a fixed table fills (useTableLayout), in the area left by sm:mx-6, sm:mt-6 and the margin kept here.
    const fit = (x: number, y: number) => Math.max(0, Math.min(x, 2.1 * y)) * Math.max(0, Math.min(y, 1.9 * x));
    const below = Math.max(h, 24);
    const beside = 24 + w + 8;
    style = fit(col.w - 24 - beside, col.h - 48) > fit(col.w - 48, col.h - 24 - below) ? { marginBottom: 24, marginRight: beside } : { marginBottom: below };
  }
  return { colRef, stackRef, style };
}

export interface TableLayout {
  portrait: boolean;
  /** Smaller seats and shortened amounts: any density but the full one. */
  compact: boolean;
  density: Density;
  box: { w: number; h: number };
  /** Per seat index, in % of the box: the seat's centre and its bet's (the cue layer's chips fly between them). */
  geometry: SeatGeometry[];
  /** The pot's centre, in % of the box. */
  pot: Point;
  /** The status line under the board is drawn. */
  footer: boolean;
  /** The same in px, with the board, the pot row and the felt. */
  plan: TablePlan;
}

export interface LayoutOptions {
  /** The bottom seat is the viewer's own: it gets the bigger cards. */
  me?: boolean;
  /** Room kept above the viewer's cards (the real table's show-card buttons). */
  meTop?: number;
  /** A status line under the board: waiting, the next hand, the side pots. The replay lists its pots above the table instead. */
  footer?: boolean;
  /** Longest amounts expected, in characters (amountChars by default). */
  chars?: PlanInput['chars'];
  /** The height is free (the replay): `area.h` is the most it may take, and it grows no taller than this. */
  grow?: number;
}

/** Longest amounts a table usually shows in a unit: a full-size stack ("1,234,567", "1,234.5 BB"), a bet and the pot. */
export function amountChars(unit: AmountUnit): PlanInput['chars'] {
  return unit === 'bb' ? { stack: 11, bet: 9, pot: 9 } : { stack: 9, bet: 6, pot: 6 };
}

const ALL: Density[] = ['full', 'compact', 'dense'];
const SMALL: Density[] = ['compact', 'dense'];

/**
 * The table laid out in the available area (layout.ts): every seat, bet and the board in a place of its own, the
 * seats smaller when the area is. A fixed area is kept from stretching into a band, at most 2.1 times as wide as tall
 * and 1.9 times as tall as wide.
 */
export function useTableLayout(area: { w: number; h: number }, maxSeats: number | undefined, anchor: number, opts: LayoutOptions = {}): TableLayout {
  const { me = false, meTop = 0, footer = false, grow = 0 } = opts;
  const { stack, bet, pot } = opts.chars ?? amountChars('chips');
  const n = maxSeats ?? 0;
  return useMemo(() => {
    // Narrow or short areas (phones, landscape phones, an open keyboard) start from the smaller seats. A free height
    // (the replay) takes the largest seats that fit its budget, so only the width counts there.
    const densities = area.w < 640 || (grow <= 0 && area.h < 520) ? SMALL : ALL;
    const input: PlanInput = { n, anchor, me, meTop, footer, chars: { stack, bet, pot } };
    const w = Math.max(1, area.w);
    const h = Math.max(1, area.h);
    const plan = grow > 0 ? planHeight(w, h, grow, input, densities) : planTable(Math.min(w, 2.1 * h), Math.min(h, 1.9 * w), input, densities);
    const pct = (q: Point): Point => ({ x: (q.x / plan.w) * 100, y: (q.y / plan.h) * 100 });
    const geometry = plan.seats.map((seat, i) => {
      const b = pct(plan.bets[i] ?? seat);
      return { seat: pct(seat), bet: b, button: b };
    });
    return { portrait: plan.w / plan.h < 0.95, compact: plan.density !== 'full', density: plan.density, box: { w: plan.w, h: plan.h }, geometry, pot: pct(plan.pot), footer, plan };
  }, [area.w, area.h, n, anchor, me, meTop, footer, stack, bet, pot, grow]);
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
  onResultShown,
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
  /** Told whether the hand's result shows yet: it waits for the hands to turn, so a page can hold its own word on it. */
  onResultShown?: (shown: boolean) => void;
}) {
  const { t } = useI18n();
  const { portrait, density, box, geometry, plan } = layout;
  const d = DIMS[density];
  const hand = s.hand;
  // The server state, as the cues that brought it play out (CueLayer): bets land, then go to the pot, cards turn in
  // order, the hands show before the result, the result before the payouts.
  const { staged, flights, start, arrival } = useCueStaging(s, cues, consumeCues, mySeat, reducedMotion);
  const result = !staged || staged.result;
  const reveal = !staged || staged.reveal;
  // Before the frame is painted, so a page holding its word never shows it a frame early.
  useLayoutEffect(() => onResultShown?.(result), [result, onResultShown]);
  const winners = useMemo(() => new Map(result ? (hand?.result?.winners ?? []).map((w) => [w.seatIndex, w.amount]) : []), [hand?.result, result]);
  const showdown = useMemo(() => new Map(result ? (hand?.result?.showdown ?? []).map((x) => [x.seatIndex, x]) : []), [hand?.result, result]);
  const topWinner = result ? hand?.result?.winners?.[0]?.seatIndex : undefined;
  const winningFive = topWinner !== undefined ? (showdown.get(topWinner)?.bestFive ?? []) : [];
  // Chips already gathered in the middle; after settlement they have been paid out.
  const collected = staged?.pot ?? collectedOf(s);
  const boardShown = staged?.board ?? hand?.board.length ?? 0;
  const boardSize = `${plan.board}px`;
  const status = !hand ? (nextIn !== null ? t('table.nextHand', { s: nextIn }) : t('table.waiting')) : hand.stage === 'settled' && nextIn !== null ? t('table.nextHand', { s: nextIn }) : null;
  const sidePots =
    hand && hand.pots.length > 1 && hand.stage !== 'settled' ? hand.pots.map((p, i) => `${i === 0 ? t('table.pot') : t('table.sidePot', { n: i })} ${amounts.fmt(p.amount, true)}`).join(' · ') : null;

  return (
    <div className="relative" style={{ width: box.w, height: box.h }} data-testid="table" data-portrait={portrait ? '1' : '0'} data-density={density}>
      {/* rail + felt, around the seats' middles */}
      <div className="absolute rounded-[50%] p-[1.2%] shadow-[0_30px_80px_rgba(0,0,0,0.7)]" style={{ left: plan.felt.x, top: plan.felt.y, width: plan.felt.w, height: plan.felt.h, background: 'var(--t-rail)' }}>
        <div className="relative size-full rounded-[50%] p-[0.6%]" style={{ background: 'var(--t-rail-inner)' }}>
          <div className="relative size-full overflow-hidden rounded-[50%] shadow-[inset_0_6px_30px_rgba(0,0,0,0.7)]" style={{ background: 'var(--t-felt)' }}>
            <div className="absolute inset-[9%] rounded-[50%] border" style={{ borderColor: 'var(--t-felt-line)' }} />
            <div className="absolute inset-x-0 flex justify-center" style={{ top: portrait ? '16%' : '12%', opacity: 'var(--t-watermark-opacity)' }}>
              <Logo size={Math.min(plan.felt.w, plan.felt.h) * 0.18} />
            </div>
          </div>
        </div>
      </div>

      {/* pot, board and the status line, in the room the layout kept for them */}
      <div className="absolute z-20 flex flex-col items-center gap-2" style={{ left: plan.block.x, top: plan.block.y, width: plan.block.w, height: plan.block.h }}>
        <div className="flex shrink-0 items-center justify-center" style={{ height: plan.potRowH }} data-testid="pot">
          {collected > 0 && <ChipStack amount={collected} size={`${plan.potChip}px`} text={amounts.fmt(collected, true)} />}
        </div>
        <div className="flex shrink-0 rounded-xl bg-black/35 shadow-[inset_0_1px_8px_rgba(0,0,0,0.45)]" style={{ gap: d.boardGap, padding: d.boardPad }} data-testid="board">
          {Array.from({ length: 5 }, (_, i) => {
            const c = i < boardShown ? (hand?.board[i] as Card | undefined) : undefined;
            // A staged card turns when it is drawn; the cards of a street that arrived at once turn one after another.
            return c ? (
              <PlayingCard
                key={`${hand!.id}-${c}`}
                card={c}
                size={boardSize}
                animate={arrival?.still?.has(c) ? false : 'flip'}
                highlight={winningFive.includes(c)}
                style={{ animationDelay: `${staged?.board != null ? 0 : (i % 3) * 120}ms` }}
              />
            ) : (
              <div key={i} className="jc-card border border-dashed border-white/10 bg-black/10" style={{ ['--card-size' as string]: boardSize, boxShadow: 'none' }} />
            );
          })}
        </div>
        {/* Fixed-height status slot: text changes never move the board. Side pots take two short lines at most. */}
        {layout.footer && (
          <div className="flex h-6 w-full shrink-0 items-center justify-center text-center text-ink-200/80" data-testid="table-status" aria-live="polite">
            {status ? (
              <span className="text-xs tracking-[0.06em]">{status}</span>
            ) : sidePots ? (
              <span className="line-clamp-2 rounded-md bg-black/45 px-2 text-[10px] leading-3 text-ink-200" title={sidePots} data-testid="side-pots">
                {sidePots}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {/* seats, bets, dealer button */}
      {s.seats.map((seat) => {
        const g = geometry[seat.seatIndex]!;
        const sd = showdown.get(seat.seatIndex);
        const label = sd ? t(`hand.${handLabelKey(sd.rankClass, sd.bestFive)}` as MsgKey) : null;
        const bet = staged?.bets[seat.seatIndex] ?? (hand?.stage !== 'settled' ? seat.streetBet : 0);
        const held = staged?.stacks[seat.seatIndex];
        // Other players' showdown cards stay face down until the hands show; a winner's stack until its chips arrive.
        const hide = !reveal && seat.seatIndex !== mySeat && !!seat.holeCards?.length;
        const shownSeat = held !== undefined || hide ? { ...seat, ...(held !== undefined && { stack: held }), ...(hide && { holeCards: null }) } : seat;
        return (
          <div key={seat.seatIndex}>
            <Seat
              seat={shownSeat}
              isMe={seat.seatIndex === mySeat}
              isActor={!!hand && hand.actorSeat === seat.seatIndex && hand.stage !== 'settled'}
              deadline={hand?.deadline ?? null}
              turnMs={s.table.turnSeconds * 1000 + (hand?.extraMs ?? 0)}
              isDealer={hand?.buttonSeat === seat.seatIndex}
              isHost={!!s.table.hostId && seat.userId === s.table.hostId}
              blind={hand && hand.stage === 'preflop' ? (hand.sbSeat === seat.seatIndex ? 'SB' : hand.bbSeat === seat.seatIndex ? 'BB' : null) : null}
              winAmount={winners.get(seat.seatIndex) ?? null}
              handLabel={label}
              bestFive={sd?.bestFive ?? null}
              newHandKey={hand?.id ?? null}
              deal={arrival?.deal?.[seat.seatIndex] ?? null}
              still={arrival?.still ?? null}
              canSit={canSit}
              onSit={() => onSit(seat.seatIndex)}
              onPick={onSeatClick && seat.userId && seat.seatIndex !== mySeat ? () => onSeatClick(seat) : undefined}
              onShow={onShow && seat.seatIndex === mySeat && s.you.canShow ? onShow : undefined}
              reaction={seat.userId ? reactions?.find((r) => r.seatIndex === seat.seatIndex && r.userId === seat.userId) : null}
              react={seat.seatIndex === mySeat ? react : undefined}
              density={density}
              amounts={amounts}
              style={{ left: `${g.seat.x}%`, top: `${g.seat.y}%` }}
            />
            {bet > 0 && (
              <div className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2" style={{ left: `${g.bet.x}%`, top: `${g.bet.y}%` }} data-testid={`bet-${seat.seatIndex}`}>
                <ChipStack amount={bet} size={`${d.chip}px`} text={amounts.fmt(bet, true)} />
              </div>
            )}
          </div>
        );
      })}

      <Flights flights={flights} start={start} geometry={geometry} pot={layout.pot} amounts={amounts} />
    </div>
  );
}
