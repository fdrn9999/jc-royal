/**
 * The felt, board, pot, seats and cue effects of a table view. Shared by the
 * multiplayer table and the offline Academy practice table so both look and
 * animate the same; it only renders the TableView it is given.
 */
import { handLabelKey, type Card, type SeatView, type TableView } from '@jc/types';
import { ChipStack, cx, Logo, PlayingCard } from '@jc/ui';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { amounts as chipAmounts, type Amounts, type AmountUnit } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';
import { Flights, useCueStaging } from './CueLayer';
import { planForText, planHeight, planTable, scalePlan, type Density, type PlanInput, type Point, type SeatGeometry, type TablePlan } from './layout';
import type { SeatReaction } from './Reactions';
import { revealSpots } from './reveal';
import { Seat } from './Seat';
import { collected as collectedOf } from './staging';
import type { CueEvent } from './useTableSocket';
import { wonFrom } from './won';

export function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setSize((s) => (s.w === e.contentRect.width && s.h === e.contentRect.height ? s : { w: e.contentRect.width, h: e.contentRect.height })));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** A margin of a style in px; one not given in px (a `max(…, env(…))`) counts as none, the same when measured as when set. */
const px = (v: unknown) => (typeof v === 'number' ? v : Number.parseFloat(String(v ?? '')) || 0);

/**
 * The size of a table area kept clear of the stack by useStackRoom's `style`, for that style: the area is measured
 * without the room's margins it had then, and the style's are taken off here, in the render that sets them. A raise panel
 * opening or closing lays the table out once, not once for the new margins and again a frame later for the size the
 * area was measured to have with them (the table moved twice, each a whole render of it; TEST_REPORT). The measurement
 * after it finds the same size and draws nothing.
 */
export function useAreaSize<T extends HTMLElement>(style: CSSProperties) {
  const ref = useRef<T>(null);
  const [base, setBase] = useState({ w: 1200, h: 700 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      const w = e.contentRect.width + px(el.style.marginRight);
      const h = e.contentRect.height + px(el.style.marginBottom);
      // Under half a pixel is the rounding of a layout, not a new size.
      setBase((b) => (Math.abs(b.w - w) < 0.5 && Math.abs(b.h - h) < 0.5 ? b : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, { w: Math.max(0, base.w - px(style.marginRight)), h: Math.max(0, base.h - px(style.marginBottom)) }] as const;
}

/**
 * Keeps the stack at the bottom of a table screen (beginner notes, coaching, questions, the action bar or the
 * pre-actions, the status bar) off the table: `colRef` goes on the column holding both, `stackRef` on the stack, and
 * `style` on the table area. On a phone the stack spans the screen, so the area ends where the stack starts. Wider, the
 * stack sits in the bottom-right corner and the area keeps clear of its height, or of its width beside it (a phone on
 * its side), whichever leaves the table more room. Measured, since the stack depends on the state, the language and the
 * width, and only growing within a `mode` (and width), so the table does not move turn by turn. Passing toasts and
 * notices (data-transient) are left out. A panel opened for a moment (data-momentary: the raise being sized) gets its
 * room only while it is open: the table makes way for it and comes back when it closes, instead of staying small.
 *
 * `side` (a short screen, short.ts): the stack is a column of a fixed width at the right edge, and the area keeps clear
 * of that width whatever it holds, so the table keeps one size through the turns and with the raise panel open.
 *
 * `open`: such a panel is open (the table may drop what only matters off the turn, such as room for the show-card buttons).
 * `narrow`: the column is a phone's width, where the stack spans it and every line of it costs the table its height.
 *
 * The Academy's practice tables use it. The real table keeps a band of one height for its dock instead (Table.tsx
 * dockBand), so that nothing the dock holds moves the table.
 */
export function useStackRoom(mode: string, side = false) {
  const [colRef, col] = useBoxSize<HTMLDivElement>();
  const stackRef = useRef<HTMLDivElement>(null);
  const key = `${mode}|${side}|${Math.round(col.w)}`;
  const [room, setRoom] = useState<{ key: string; w: number; h: number; open: { w: number; h: number } | null }>({ key, w: 0, h: 0, open: null });
  useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const read = () => {
      const kids = Array.from(el.children as HTMLCollectionOf<HTMLElement>).filter((k) => k.dataset.transient === undefined && k.offsetHeight > 0);
      const h = kids.length ? Math.ceil(el.getBoundingClientRect().bottom - Math.min(...kids.map((k) => k.getBoundingClientRect().top))) : 0;
      const w = side ? el.offsetWidth : Math.max(0, ...kids.map((k) => k.offsetWidth));
      const momentary = el.querySelector('[data-momentary]') !== null;
      setRoom((r) => {
        const kept = r.key === key ? r : { w: 0, h: 0 };
        const next = momentary ? { key, w: kept.w, h: kept.h, open: { w, h } } : { key, w: Math.max(w, kept.w), h: Math.max(h, kept.h), open: null };
        return next.key === r.key && next.w === r.w && next.h === r.h && next.open?.w === r.open?.w && next.open?.h === r.open?.h ? r : next;
      });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]);
  const { w, h } = room.key === key ? { w: Math.max(room.w, room.open?.w ?? 0), h: Math.max(room.h, room.open?.h ?? 0) } : { w: 0, h: 0 };
  let style: CSSProperties = { marginBottom: h };
  if (side && col.w >= 640) {
    // Beside the column, with the home indicator's room below (none on most phones).
    style = { marginBottom: 'max(4px, env(safe-area-inset-bottom))', marginRight: w + 4 };
  } else if (col.w >= 640) {
    // The box a fixed table fills (useTableLayout), in the area left by sm:mx-6, sm:mt-6 and the margin kept here.
    const fit = (x: number, y: number) => Math.max(0, Math.min(x, 2.1 * y)) * Math.max(0, Math.min(y, 1.9 * x));
    const below = Math.max(h, 24);
    const beside = 24 + w + 8;
    style = fit(col.w - 24 - beside, col.h - 48) > fit(col.w - 48, col.h - 24 - below) ? { marginBottom: 24, marginRight: beside } : { marginBottom: below };
  }
  return { colRef, stackRef, style, open: room.key === key && room.open !== null, narrow: col.w < 640 };
}

/**
 * The table's status line: waiting for players or the next hand's countdown between hands, the side pots while a hand
 * has them. Under the board, or in a short screen's column (short.ts).
 */
export function useTableStatus(s: TableView | null, nextIn: number | null, amounts: Amounts) {
  const { t } = useI18n();
  if (!s) return { status: null, sidePots: null };
  const hand = s.hand;
  const status = !hand ? (nextIn !== null ? t('table.nextHand', { s: nextIn }) : t('table.waiting')) : hand.stage === 'settled' && nextIn !== null ? t('table.nextHand', { s: nextIn }) : null;
  const sidePots =
    hand && hand.pots.length > 1 && hand.stage !== 'settled' ? hand.pots.map((p, i) => `${i === 0 ? t('table.pot') : t('table.sidePot', { n: i })} ${amounts.fmt(p.amount, true)}`).join(' · ') : null;
  return { status, sidePots };
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
  /** The least share of the width the table may narrow to where that keeps every bet by its own seat (planTable's minW). */
  narrow?: number;
}

/** Longest amounts a table usually shows in a unit: a full-size stack ("1,234,567", "1,234.5 BB"), a bet and the pot. */
export function amountChars(unit: AmountUnit): PlanInput['chars'] {
  return unit === 'bb' ? { stack: 11, bet: 9, pot: 9 } : { stack: 9, bet: 6, pot: 6 };
}

const ALL: Density[] = ['full', 'compact', 'dense'];
const SMALL: Density[] = ['compact', 'dense'];

/**
 * The last plans laid out, the latest last. A raise panel opening and closing upright gives the table two areas in
 * turn, and on a small phone with nine seats each plan costs some 13–21ms on a desktop CPU, more on a phone's
 * (TEST_REPORT): a repeat costs nothing.
 */
const plans = new Map<string, TablePlan>();
function planned(key: string, make: () => TablePlan) {
  let plan = plans.get(key);
  if (plan) plans.delete(key);
  else plan = make();
  plans.set(key, plan);
  if (plans.size > 16) plans.delete(plans.keys().next().value!);
  return plan;
}

/**
 * The root font over the 16px DIMS are given at: a browser's or phone's text size, which the seats' rem sizes follow
 * (scalePlan). Read as the table is laid out: the header and the stack round the table are sized in rem too, so a text
 * size changed with the page open changes the area and the table is laid out again.
 */
function textScale() {
  const px = typeof document === 'undefined' ? 16 : Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return px > 0 ? px / 16 : 1;
}

/**
 * The table laid out in the available area (layout.ts): every seat, bet and the board in a place of its own, the
 * seats smaller when the area is. A fixed area is kept from stretching into a band, at most 2.1 times as wide as tall
 * and 1.9 times as tall as wide. With the text larger, it is laid out as if the area were that much smaller and drawn
 * that much larger (scalePlan), or for text less large where the seats find no room at that size (planForText).
 */
export function useTableLayout(area: { w: number; h: number }, maxSeats: number | undefined, anchor: number, opts: LayoutOptions = {}): TableLayout {
  const { me = false, meTop = 0, footer = false, grow = 0, narrow = 1 } = opts;
  const { stack, bet, pot } = opts.chars ?? amountChars('chips');
  const n = maxSeats ?? 0;
  return useMemo(() => {
    const input: PlanInput = { n, anchor, me, meTop, footer, chars: { stack, bet, pot } };
    const lay = (u: number) => {
      // Narrow or short areas (phones, landscape phones, an open keyboard) start from the smaller seats. A free height
      // (the replay) takes the largest seats that fit its budget, so only the width counts there.
      const densities = area.w / u < 640 || (grow <= 0 && area.h / u < 520) ? SMALL : ALL;
      const w = Math.max(1, area.w) / u;
      const h = Math.max(1, area.h) / u;
      const bw = Math.min(w, 2.1 * h);
      const key = [w, h, u, grow, narrow, n, anchor, me, meTop, footer, stack, bet, pot, densities.length].join();
      return planned(key, () =>
        scalePlan(grow > 0 ? planHeight(w, h, grow / u, input, densities) : planTable(bw, Math.min(h, 1.9 * w), input, densities, Math.round(narrow * bw)), u),
      );
    };
    const plan = planForText(textScale(), lay);
    const pct = (q: Point): Point => ({ x: (q.x / plan.w) * 100, y: (q.y / plan.h) * 100 });
    const geometry = plan.seats.map((seat, i) => {
      const b = pct(plan.bets[i] ?? seat);
      const f = plan.folds[i];
      const bet = plan.bets[i];
      return { seat: pct(seat), bet: b, button: b, ...(f && bet && (f.x !== bet.x || f.y !== bet.y) && { fold: pct(f) }) };
    });
    return { portrait: plan.w / plan.h < 0.95, compact: plan.density !== 'full', density: plan.density, box: { w: plan.w, h: plan.h }, geometry, pot: pct(plan.pot), footer, plan };
  }, [area.w, area.h, n, anchor, me, meTop, footer, stack, bet, pot, grow, narrow]);
}

const CHIPS = chipAmounts('chips', 0);

/**
 * A board card keeps the delay it was first drawn with. Its staging plan ends while it is still turning (60ms after the
 * last card is drawn), and a delay changed then puts a running turn back: the river vanished 50ms into its turn and
 * turned again, the flop's second and third cards with it (TEST_REPORT).
 */
function BoardCard({ delay, ...card }: Omit<ComponentProps<typeof PlayingCard>, 'style'> & { delay: number }) {
  const [at] = useState(delay);
  return <PlayingCard {...card} style={{ animationDelay: `${at}ms` }} />;
}

/**
 * Drawn again only when its props change (the real table keeps them the same between its draws): a press, a chat line
 * or a toast draws the table page, and the board, the plates and the header's table under it were most of that draw
 * (TEST_REPORT). A staged street redraws itself at each of its steps (CueLayer).
 */
export const TableScene = memo(function TableScene({
  s,
  layout,
  mySeat,
  canSit,
  onSit,
  onSeatClick,
  onShow,
  showOnCards = false,
  reactions,
  nextIn,
  cues,
  consumeCues,
  reducedMotion,
  amounts = CHIPS,
  onResultShown,
  turnNote,
  handNote,
}: {
  s: TableView;
  layout: TableLayout;
  mySeat: number | null;
  canSit: boolean;
  onSit: (seatIndex: number) => void;
  /** Tapping another player's plate (the real table only). */
  onSeatClick?: (seat: SeatView) => void;
  /** Shows my first card, my second or both after the hand (the real table only; offered while `you.canShow`). */
  onShow?: (card: 0 | 1) => void;
  /** The show-card buttons lie on my cards instead of above them (a short screen keeps no room there: short.ts). */
  showOnCards?: boolean;
  /** Quick reactions showing now (the real table only), each at its sender's seat while that player still sits there. */
  reactions?: SeatReaction[];
  nextIn: number | null;
  cues: CueEvent[];
  consumeCues: (upToId: number) => void;
  reducedMotion: boolean;
  /** How amounts read (the player's unit at a real table or a replay; the Academy keeps chips, as its lessons do). */
  amounts?: Amounts;
  /** Told whether the hand's result shows yet: it waits for the hands to turn, so a page can hold its own word on it. */
  onResultShown?: (shown: boolean) => void;
  /** Said in my seat's status line while it is my turn (the real table on a phone upright: the turn label). */
  turnNote?: ReactNode;
  /** Said in the status line under the board while it has nothing else to say but the side pots (the real table on a
   * phone upright: my current hand). */
  handNote?: ReactNode;
}) {
  const { t } = useI18n();
  const { portrait, density, box, geometry, plan } = layout;
  const d = plan.dims;
  const hand = s.hand;
  // The server state, as the cues that brought it play out (CueLayer): bets land, then go to the pot, cards turn in
  // order, the hands show before the result, the result before the payouts.
  const { staged, flights, start, arrival } = useCueStaging(s, cues, consumeCues, mySeat, reducedMotion);
  const result = !staged || staged.result;
  const reveal = !staged || staged.reveal;
  // Before the frame is painted, so a page holding its word never shows it a frame early.
  useLayoutEffect(() => onResultShown?.(result), [result, onResultShown]);
  // What each winner won: chips nobody called, handed back, are no win.
  const won = useMemo(() => (result ? wonFrom(hand?.result) : []), [hand?.result, result]);
  const winners = useMemo(() => new Map(won.map((w) => [w.seatIndex, w.amount])), [won]);
  const showdown = useMemo(() => new Map(result ? (hand?.result?.showdown ?? []).map((x) => [x.seatIndex, x]) : []), [hand?.result, result]);
  const topWinner = won[0]?.seatIndex;
  const winningFive = topWinner !== undefined ? (showdown.get(topWinner)?.bestFive ?? []) : [];
  // Where winners' cards shown after the hand come to rest by the board (reveal.ts), worked out once per plan and set
  // of such winners.
  const showing = s.seats.filter((x) => (winners.get(x.seatIndex) ?? 0) > 0 && x.shown?.some(Boolean)).map((x) => x.seatIndex);
  const showingKey = showing.join();
  const spots = useMemo(
    () => (showing.length ? revealSpots(plan, showing.map((seat) => ({ seat, mine: seat === mySeat }))) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `showing` is read through its key
    [plan, showingKey, mySeat],
  );
  // Chips already gathered in the middle; after settlement they have been paid out.
  const collected = staged?.pot ?? collectedOf(s);
  const boardShown = staged?.board ?? hand?.board.length ?? 0;
  // The board cards drawn last time (this hand's): the ones drawn now for the first time are the ones that turn.
  const drawn = useRef({ hand: '', n: 0 });
  const before = drawn.current.hand === hand?.id ? drawn.current.n : 0;
  useLayoutEffect(() => {
    drawn.current = { hand: hand?.id ?? '', n: boardShown };
  });
  const boardSize = `${plan.board}px`;
  const { status, sidePots } = useTableStatus(s, nextIn, amounts);
  // Each seat's place and handlers stay the same objects from one draw to the next, so a seat is drawn again only when
  // what it shows changes (a staged chip or card moving drew every seat; TEST_REPORT). The handlers call the latest props.
  const latest = useRef({ s, onSit, onSeatClick, onShow });
  latest.current = { s, onSit, onSeatClick, onShow };
  const places = useMemo(() => geometry.map((g) => ({ left: `${g.seat.x}%`, top: `${g.seat.y}%` })), [geometry]);
  // Another player's bet once they fold, their cards gone, lies where it still reads as theirs (layout's `folds`), and
  // its chips fly to the pot from there.
  const foldedKey = s.seats
    .filter((x) => x.state === 'folded' && x.seatIndex !== mySeat && geometry[x.seatIndex]?.fold)
    .map((x) => x.seatIndex)
    .join();
  const placed = useMemo(() => {
    if (!foldedKey) return geometry;
    const folded = new Set(foldedKey.split(',').map(Number));
    return geometry.map((g, i) => (folded.has(i) && g.fold ? { ...g, bet: g.fold } : g));
  }, [geometry, foldedKey]);
  const handlers = useRef(new Map<number, { sit: () => void; pick: () => void }>());
  const handlersOf = (i: number) => {
    let h = handlers.current.get(i);
    if (!h) {
      h = {
        sit: () => latest.current.onSit(i),
        pick: () => {
          const seat = latest.current.s.seats.find((x) => x.seatIndex === i);
          if (seat) latest.current.onSeatClick?.(seat);
        },
      };
      handlers.current.set(i, h);
    }
    return h;
  };
  const show = useCallback((card: 0 | 1) => latest.current.onShow?.(card), []);

  return (
    <div className="relative" style={{ width: box.w, height: box.h }} data-testid="table" data-portrait={portrait ? '1' : '0'} data-density={density}>
      {/* rail + felt, around the seats' middles */}
      <div className="absolute rounded-[50%] p-[1.2%] shadow-[0_30px_80px_rgba(0,0,0,0.7)]" style={{ left: plan.felt.x, top: plan.felt.y, width: plan.felt.w, height: plan.felt.h, background: 'var(--t-rail)' }}>
        <div className="relative size-full rounded-[50%] p-[0.6%]" style={{ background: 'var(--t-rail-inner)' }}>
          <div className="relative size-full overflow-hidden rounded-[50%] shadow-[inset_0_6px_30px_rgba(0,0,0,0.7)]" style={{ background: 'var(--t-felt)' }} data-testid="felt">
            <div className="absolute inset-[9%] rounded-[50%] border" style={{ borderColor: 'var(--t-felt-line)' }} />
            <div className="absolute inset-x-0 flex justify-center" style={{ top: portrait ? '16%' : '12%', opacity: 'var(--t-watermark-opacity)' }}>
              <Logo size={Math.min(plan.felt.w, plan.felt.h) * 0.18} />
            </div>
          </div>
        </div>
      </div>

      {/* pot, board and the status line, in the room the layout kept for them. The room takes no taps, only what it
          draws: on a small table it reaches over the seats beside it, whose level and style open a bot's card. */}
      <div className="pointer-events-none absolute z-20 flex flex-col items-center gap-2" style={{ left: plan.block.x, top: plan.block.y, width: plan.block.w, height: plan.block.h }}>
        <div className="flex shrink-0 items-center justify-center [&>*]:pointer-events-auto" style={{ height: plan.potRowH }} data-testid="pot">
          {collected > 0 && <ChipStack amount={collected} size={`${plan.potChip}px`} text={amounts.fmt(collected, true)} />}
        </div>
        <div className="pointer-events-auto flex shrink-0 rounded-xl bg-black/35 shadow-[inset_0_1px_8px_rgba(0,0,0,0.45)]" style={{ gap: d.boardGap, padding: d.boardPad }} data-testid="board">
          {Array.from({ length: 5 }, (_, i) => {
            const c = i < boardShown ? (hand?.board[i] as Card | undefined) : undefined;
            // A staged card turns when it is drawn; cards drawn at once (a street that arrived unstaged) one after another.
            return c ? (
              <BoardCard
                key={`${hand!.id}-${c}`}
                card={c}
                size={boardSize}
                animate={arrival?.still?.has(c) ? false : 'flip'}
                highlight={winningFive.includes(c)}
                delay={staged?.board != null ? 0 : Math.max(0, i - before) * 120}
              />
            ) : (
              <div key={i} className="jc-card border border-dashed border-white/10 bg-black/10" style={{ ['--card-size' as string]: boardSize, boxShadow: 'none' }} />
            );
          })}
        </div>
        {/* Fixed-height status slot: text changes never move the board. Side pots take two short lines at most, one beside
            a hand note. */}
        {layout.footer && (
          // As wide as what it says (up to the block's width), so nothing round it counts as drawn.
          <div className="pointer-events-auto flex h-6 max-w-full shrink-0 flex-col items-center justify-center text-center text-ink-200/80" data-testid="table-status" aria-live="polite">
            {status ? (
              <span className="text-xs tracking-[0.06em]">{status}</span>
            ) : (
              <>
                {/* Read where it is, not announced street by street. */}
                {handNote && (
                  <div className="flex max-w-full" aria-live="off">
                    {handNote}
                  </div>
                )}
                {sidePots && (
                  <span className={cx('rounded-md bg-black/45 px-2 text-[10px] leading-3 text-ink-200', handNote ? 'line-clamp-1' : 'line-clamp-2')} title={sidePots} data-testid="side-pots">
                    {sidePots}
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* seats, bets, dealer button */}
      {s.seats.map((seat) => {
        const g = placed[seat.seatIndex]!;
        const sd = showdown.get(seat.seatIndex);
        const label = sd ? t(`hand.${handLabelKey(sd.rankClass, sd.bestFive)}` as MsgKey) : null;
        const bet = staged?.bets[seat.seatIndex] ?? (hand?.stage !== 'settled' ? seat.streetBet : 0);
        const held = staged?.stacks[seat.seatIndex];
        // The turn's clock goes only to the seat whose turn it is, the only one that reads it.
        const isActor = !!hand && hand.actorSeat === seat.seatIndex && hand.stage !== 'settled';
        // Other players' showdown cards stay face down until the hands show; a winner's stack until its chips arrive.
        const hide = !reveal && seat.seatIndex !== mySeat && !!seat.holeCards?.length;
        const shownSeat = held !== undefined || hide ? { ...seat, ...(held !== undefined && { stack: held }), ...(hide && { holeCards: null }) } : seat;
        return (
          <div key={seat.seatIndex}>
            <Seat
              seat={shownSeat}
              isMe={seat.seatIndex === mySeat}
              isActor={isActor}
              turnNote={seat.seatIndex === mySeat && isActor ? turnNote : undefined}
              deadline={isActor ? (hand.deadline ?? null) : null}
              turnMs={isActor ? s.table.turnSeconds * 1000 + (hand.extraMs ?? 0) : 0}
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
              onSit={handlersOf(seat.seatIndex).sit}
              onPick={onSeatClick && seat.userId && seat.seatIndex !== mySeat ? handlersOf(seat.seatIndex).pick : undefined}
              onShow={onShow && seat.seatIndex === mySeat && s.you.canShow ? show : undefined}
              showOver={showOnCards}
              reveal={spots?.get(seat.seatIndex) ?? null}
              reaction={seat.userId ? reactions?.find((r) => r.seatIndex === seat.seatIndex && r.userId === seat.userId) : null}
              density={density}
              amounts={amounts}
              style={places[seat.seatIndex]!}
            />
            {bet > 0 && (
              <div className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2" style={{ left: `${g.bet.x}%`, top: `${g.bet.y}%` }} data-testid={`bet-${seat.seatIndex}`}>
                <ChipStack amount={bet} size={`${d.chip}px`} text={amounts.fmt(bet, true)} />
              </div>
            )}
          </div>
        );
      })}

      <Flights flights={flights} start={start} geometry={placed} pot={layout.pot} box={box} amounts={amounts} />
    </div>
  );
});
