/**
 * Player seat. Structure follows Elite-Poker's PlayerSeat (name row, chips +
 * last action, hole cards, dealer/blind badges, timer ring, winner state),
 * rebuilt for the server-projected SeatView and the JC ROYAL style.
 */
import type { SeatView } from '@jc/types';
import { CrownIcon, cx, holeOrder, HourglassIcon, PlayingCard, PlusIcon } from '@jc/ui';
import { memo, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { BOT_LEVEL_LABEL, botLabel, MemberName } from '../components/MemberName';
import type { Amounts } from '../lib/amount';
import type { Density } from './layout';
import { cardsToShow } from './olderRooms';
import type { RevealSpot } from './reveal';
import { useI18n, type MsgKey } from '../lib/i18n';
import { serverNow } from '../lib/service';
import { ReactionBubble, type SeatReaction } from './Reactions';

/** The server's clock (the deadline is the room's), so a device whose clock is off still shows the time the room allows. */
function useNow(active: boolean) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setNow(serverNow()), 250);
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

/** A show-card button on my cards after a hand; dimmed while its request is on the way. */
const SHOW_BTN =
  'jc-tap grid h-6 shrink-0 place-items-center rounded-full border border-gold-500/60 bg-ink-950/85 text-[10px] font-bold text-gold-200 hover:bg-gold-500/20 focus-visible:outline-2 focus-visible:outline-gold-400 disabled:cursor-wait disabled:opacity-60';

function initials(name?: string) {
  return (name ?? '?').slice(0, 2).toUpperCase();
}

/**
 * The seat's sizes at each density. layout.ts (DIMS) lays the table out by them: change both together. Written out
 * in full so the stylesheet keeps every class.
 */
const SIZE: Record<Density, Record<'me' | 'other' | 'cards' | 'spread' | 'pull' | 'plate' | 'avatar' | 'initials' | 'name' | 'nameText' | 'stack' | 'badges' | 'dealer' | 'blind' | 'host' | 'status' | 'sit' | 'empty', string>> = {
  full: {
    me: '3.4rem',
    other: '2.5rem',
    cards: 'mb-[-0.6rem]',
    spread: '-space-x-3',
    pull: '-0.75rem',
    plate: 'min-w-[8.5rem] gap-2 py-1 pl-1 pr-3',
    avatar: 'size-11',
    initials: 'text-xs',
    name: 'max-w-[7rem]',
    nameText: 'text-[13px]',
    stack: 'text-xs',
    badges: '-left-2 -top-2',
    dealer: 'size-5 text-[10px]',
    blind: 'px-1.5 text-[9px] leading-4',
    host: '-right-1.5 -top-2',
    status: 'mt-1 h-4 max-w-[12.375rem] text-[11px]',
    sit: 'size-16',
    empty: 'size-11',
  },
  compact: {
    me: '2.6rem',
    other: '1.7rem',
    cards: 'mb-[-0.6rem]',
    spread: '-space-x-3',
    pull: '-0.75rem',
    plate: 'min-w-[6.5rem] gap-2 py-1 pl-1 pr-3',
    avatar: 'size-9',
    initials: 'text-xs',
    name: 'max-w-[5.5rem]',
    nameText: 'text-xs',
    stack: 'text-[11px]',
    badges: '-left-2 -top-2',
    dealer: 'size-5 text-[10px]',
    blind: 'px-1.5 text-[9px] leading-4',
    host: '-right-1.5 -top-2',
    status: 'mt-1 h-4 max-w-[10.375rem] text-[10px]',
    sit: 'size-14',
    empty: 'size-9',
  },
  dense: {
    me: '2.2rem',
    other: '1.45rem',
    cards: 'mb-[-0.5rem]',
    spread: '-space-x-2',
    pull: '-0.5rem',
    plate: 'min-w-[5.75rem] gap-1 py-0.5 pl-0.5 pr-2',
    avatar: 'size-6',
    initials: 'text-[9px]',
    name: 'max-w-[3.25rem]',
    nameText: 'text-[10px]',
    stack: 'text-[10px]',
    badges: '-left-1 -top-2',
    dealer: 'size-4 text-[9px]',
    blind: 'px-1 text-[8px] leading-3.5',
    host: '-right-1 -top-2',
    status: 'mt-0.5 h-3.5 max-w-[6.25rem] text-[10px]',
    sit: 'size-12',
    empty: 'size-9',
  },
};

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
  /** A hand dealt in front of us: when each of this seat's cards lands (ms from the deal). */
  deal?: [number, number] | null;
  /** A hand under way when we arrived: the cards already showing then, which stay put. */
  still?: ReadonlySet<string> | null;
  canSit: boolean;
  onSit: () => void;
  /** Opens this player's card (other occupied seats only). */
  onPick?: () => void;
  /**
   * My seat after a hand whose showdown left my cards face down (folded, won uncontested or lost): a button over each
   * card, and one for both, turns them face up for the table until the next deal.
   */
  onShow?: (card: 0 | 1) => void;
  /** Those buttons lie on the cards' lower half, clear of the plate, instead of above them (no room kept there). */
  showOver?: boolean;
  /**
   * Where a winner's cards shown after the hand rest by the board (reveal.ts): shown in front of us they slide there,
   * turning face up on the way; shown before this page saw the hand (a reload), they are just there. Without one (no
   * room clear by the board) they turn where they lie.
   */
  reveal?: RevealSpot | null;
  /** The quick reaction this player sent, while it shows (sent from the status line under the table, Reactions.tsx). */
  reaction?: SeatReaction | null;
  /** Said in the status line in place of the rest (my turn's label on a phone upright, where the stack keeps no line). */
  turnNote?: ReactNode;
  density: Density;
  amounts: Amounts;
  style: CSSProperties;
}

/**
 * Drawn again only when its props change (TableScene keeps them the same objects from draw to draw): the table draws
 * at every step of a staged street, and nine seats drawn each time were most of its work (TEST_REPORT).
 */
export const Seat = memo(SeatPlace);

function SeatPlace(p: SeatProps) {
  const { t } = useI18n();
  const s = p.seat;
  const z = SIZE[p.density];
  const compact = p.density !== 'full';
  const cardSize = p.isMe ? z.me : z.other;
  // Cards asked to be shown, until the room's answer shows them (a second tap sends nothing): cleared when what is
  // shown changes, at the next hand, or after a while when the answer never came (the request was refused).
  const [showing, setShowing] = useState<readonly number[]>([]);
  const shownKey = (s.shown ?? []).map((c) => (c ? 1 : 0)).join('');
  useEffect(() => setShowing([]), [shownKey, p.newHandKey]);
  // What was shown when this hand first drew here: only cards shown since are seen being shown (they move).
  const [seen, setSeen] = useState({ hand: p.newHandKey, shown: shownKey });
  if (seen.hand !== p.newHandKey) setSeen({ hand: p.newHandKey, shown: shownKey });
  const fresh = (i: number) => seen.hand === p.newHandKey && seen.shown[i] !== '1';
  useEffect(() => {
    if (!showing.length) return;
    const id = setTimeout(() => setShowing([]), 5_000);
    return () => clearTimeout(id);
  }, [showing]);
  // The order the cards are drawn in (higher rank on the left, holeOrder), settled once a hand, when a card first shows:
  // as dealt when one showed before the other, so a card seen face up never moves. Indices into the cards as dealt, which
  // the rest goes by (showing one, which rests by the board).
  const [order, setOrder] = useState<{ hand: string | null; at: readonly number[] }>({ hand: null, at: [] });

  if (s.state === 'empty') {
    return (
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={p.style}>
        {s.held ? (
          // Its player folded and stood up: the hand they were dealt into is still played, so nobody sits here until it
          // ends (the room refuses it too).
          <div
            role="img"
            className={cx('grid place-items-center rounded-full border border-dashed border-white/20 bg-black/30 text-xs text-ink-400', z.empty)}
            title={t('table.heldSeat')}
            aria-label={t('table.heldSeat')}
            data-testid={`held-${s.seatIndex}`}
          >
            <HourglassIcon className="size-4" />
          </div>
        ) : p.canSit ? (
          <button
            onClick={p.onSit}
            data-testid={`sit-${s.seatIndex}`}
            className={cx('flex flex-col items-center justify-center rounded-full border border-dashed border-gold-500/50 bg-black/40 text-[10px] font-semibold text-gold-300 transition hover:bg-gold-500/15', z.sit)}
          >
            <PlusIcon className="size-4" />
            {t('table.sit')}
          </button>
        ) : (
          <div className={cx('rounded-full border border-dashed border-white/[0.07]', z.empty)} title={t('table.emptySeat')} />
        )}
      </div>
    );
  }

  const folded = s.state === 'folded';
  const allIn = s.state === 'allin';
  const winner = p.winAmount !== null && p.winAmount > 0;
  const won = winner ? `+${p.amounts.fmt(p.winAmount!, true)}${p.handLabel ? ` · ${p.handLabel}` : ''}` : '';
  // Cards shown after the hand: face up where chosen, the other one face down (its owner sees both in holeCards).
  const shown = s.shown?.length ? s.shown : null;
  const isShown = (i: number) => !!shown?.[i];
  // A winner's shown cards rest by the board (reveal); their places at the seat stay, empty.
  const rest = winner && shown && p.reveal ? p.reveal : null;
  const rests = (i: number) => !!rest && isShown(i);
  const show = (choice: 0 | 1 | 'both') => {
    const todo = cardsToShow(choice, showing, isShown);
    setShowing([...showing, ...todo]);
    for (const i of todo) p.onShow?.(i);
  };
  const showCards = s.hasCards || (s.holeCards && s.holeCards.length > 0) || !!shown;
  const cards = s.holeCards && s.holeCards.length ? s.holeCards : (shown ?? (showCards ? [null, null] : []));
  const dealt = cards.map((_, i) => i);
  const settled = order.hand === p.newHandKey && order.at.length === cards.length ? order.at : null;
  const seenUp = cards.some(Boolean);
  if (!settled && seenUp) setOrder({ hand: p.newHandKey, at: holeOrder(cards) ?? dealt });
  const drawn = (settled ?? (seenUp ? (holeOrder(cards) ?? dealt) : dealt)).map((i) => ({ i, c: cards[i] ?? null }));
  // A bot's level and the style it plays (the style's whole name in the title).
  const botLevel = s.bot && s.bot !== true ? t(BOT_LEVEL_LABEL[s.bot]) : '';
  const botTitle = s.botStyle ? `${botLevel} · ${t(`bot.style.${s.botStyle}` as MsgKey)}` : undefined;
  // The plate's button covers the robot mark, so it carries the mark's title (and the style): what a pointer resting on
  // a bot's seat reads. A tap opens the bot's card.
  const pickTitle = s.bot ? [botLabel(t, s.bot), s.botStyle && t(`bot.style.${s.botStyle}` as MsgKey)].filter(Boolean).join(' · ') : undefined;
  const botLine = (
    <>
      {botLevel}
      {s.botStyle && <span data-testid={`bot-style-${s.seatIndex}`}> · {t(`bot.styleShort.${s.botStyle}` as MsgKey)}</span>}
    </>
  );
  const actionLabel = s.lastAction ? `${t(`action.${s.lastAction.type}` as MsgKey)}${s.lastAction.amount > 0 ? ` ${p.amounts.fmt(s.lastAction.amount, true)}` : ''}` : null;
  // The colour vision modes swap these (styles.css); the label always says the action too.
  const actionTone =
    s.lastAction?.type === 'fold'
      ? 'text-[color:var(--act-fold-text)]'
      : s.lastAction?.type === 'raise' || s.lastAction?.type === 'bet'
        ? 'text-gold-300'
        : s.lastAction?.type === 'allin'
          ? 'text-[color:var(--act-allin-text)]'
          : 'text-[color:var(--act-call-text)]';

  return (
    <div
      // My own seat is above the board and the bets: where a cramped table (a raise panel open on a small phone) cannot
      // keep them apart, my cards stay in sight.
      className={cx('absolute -translate-x-1/2 -translate-y-1/2', p.isMe ? 'z-[25]' : 'z-10')}
      style={p.style}
      data-testid={`seat-${s.seatIndex}`}
      data-state={s.state}
    >
      {/* A folded hand fades back in when its owner shows a card (quieter than a winner's: it stays where it is). */}
      <div className={cx('relative flex flex-col items-center transition-opacity duration-300', folded && !shown && 'opacity-55')}>
        {/* hole cards. A seat without any keeps their room, empty: layout.ts lays every seat out with its cards, and the
            seat is centred on its place, so its plate and status line would rise half a card as its cards fold away (a
            folded seat's bet then read as its neighbour's on a small phone) and drop as they are dealt. */}
        {cards.length > 0 ? (
          <div className={cx('relative flex', z.cards, p.isMe ? 'gap-1' : z.spread)} key={p.newHandKey ?? 'cards'}>
            {drawn.map(({ i, c }, at) =>
              rests(i) ? (
                <span key={`rest-${i}`} aria-hidden className="block shrink-0" style={{ width: cardSize, height: `calc(${cardSize} * 1.4)` }} />
              ) : (
                <PlayingCard
                  key={`${c ?? 'x'}-${at}`}
                  card={c ?? null}
                  size={cardSize}
                  // Mine are dealt face down like the rest and turn face up as they land.
                  animate={p.still && (!c || p.still.has(c)) ? false : !c ? 'deal' : p.deal && p.isMe ? 'deal-flip' : 'flip'}
                  highlight={!!c && !!p.bestFive?.includes(c)}
                  dim={folded && !isShown(i)}
                  // Dealt round the table in order, the left card first; cards turned later (a showdown) one after the
                  // other. The fan is a variable, so the card's lift and its animations keep it.
                  style={{ animationDelay: `${p.deal && (p.isMe || !c) ? p.deal[at] : at * 90}ms`, ['--card-rot' as string]: !p.isMe ? `${at === 0 ? -6 : 6}deg` : undefined }}
                />
              ),
            )}
            {p.onShow && (
              <div className={cx('absolute left-0 flex gap-1', p.showOver ? 'bottom-2 z-10' : 'bottom-full mb-1')} data-testid="show-cards">
                {drawn.map(({ i }, at) =>
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
                      onClick={() => show(i === 0 ? 0 : 1)}
                      disabled={showing.includes(i)}
                      aria-busy={showing.includes(i) || undefined}
                      className={SHOW_BTN}
                      style={{ width: cardSize }}
                      // Counted as drawn, from the left (the room goes by the cards as dealt: i).
                      aria-label={t('table.showCardAria', { n: at + 1 })}
                      data-testid={`show-card-${i}`}
                    >
                      {t('table.showCard')}
                    </button>
                  ),
                )}
                {cards.length === 2 && !isShown(0) && !isShown(1) && (
                  <button
                    type="button"
                    onClick={() => show('both')}
                    disabled={showing.length === 2}
                    aria-busy={showing.length === 2 || undefined}
                    className={cx(SHOW_BTN, 'px-2')}
                    aria-label={t('table.showBothAria')}
                    data-testid="show-card-both"
                  >
                    {t('table.showBoth')}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div aria-hidden className={cx('flex', z.cards, p.isMe ? 'gap-1' : z.spread)} data-testid={`no-cards-${s.seatIndex}`}>
            {[0, 1].map((i) => (
              <span key={i} className="block shrink-0" style={{ width: cardSize, height: `calc(${cardSize} * 1.4)` }} />
            ))}
          </div>
        )}
        {/* A winner's shown cards, resting by the board, each in its own place of two (a card shown later takes the other
            without moving the first). One shown in front of us slides there from its place at the seat (--sx: its middle
            off the cards' middle there, --gx: here), turning face up on the way if others saw only its back. */}
        {rest && (
          <div
            className="jc-reveal pointer-events-none absolute left-1/2 z-10 flex gap-1"
            style={{ top: `calc(${cardSize} * 0.7)`, ['--rx' as string]: `${rest.x}px`, ['--ry' as string]: `${rest.y}px`, ['--rs' as string]: rest.s }}
            data-testid={`reveal-${s.seatIndex}`}
          >
            {drawn.map(({ i, c }, at) => {
              const side = at === 0 ? -1 : 1;
              return rests(i) && c ? (
                <span
                  key={`${c}-${i}`}
                  className={cx('block', fresh(i) && 'jc-reveal-in')}
                  style={{
                    ['--sx' as string]: `calc((${cardSize} + ${p.isMe ? '0.25rem' : z.pull}) / 2 * ${side})`,
                    ['--gx' as string]: `calc((${cardSize} + 0.25rem) / 2 * ${side})`,
                    ['--rr' as string]: `${(p.isMe ? 0 : 6 * side) + (rest.x > 0 ? -6 : 6)}deg`,
                  }}
                >
                  <PlayingCard card={c} size={cardSize} animate={fresh(i) && !p.isMe && !p.still?.has(c) ? 'flip' : false} highlight={!!p.bestFive?.includes(c)} />
                </span>
              ) : (
                <span key={`gap-${i}`} aria-hidden className="block shrink-0" style={{ width: cardSize }} />
              );
            })}
          </div>
        )}
        {/* plate */}
        <div
          className={cx(
            'relative flex items-center rounded-full border shadow-xl backdrop-blur-sm',
            z.plate,
            p.isActor ? 'border-gold-400/80' : 'border-[var(--t-seat-border)]',
            // My turn: a gold ring that breathes (still under reduced motion), outside the plate so the seat keeps its size.
            p.isActor && p.isMe && !winner && 'jc-turn',
            winner && 'jc-winner',
          )}
          style={{ background: 'var(--t-seat)' }}
        >
          <span className={cx('relative grid shrink-0 place-items-center rounded-full', z.avatar)}>
            {p.isActor && p.deadline && <TimerRing deadline={p.deadline} totalMs={p.turnMs} />}
            <span
              className={cx(
                'relative grid size-full place-items-center overflow-hidden rounded-full border bg-gradient-to-br from-ink-600 to-ink-800 font-bold text-gold-300',
                z.initials,
                s.role === 'super_admin' ? 'border-[#e2bd6a]/80' : s.role === 'admin' ? 'border-[#5aa9ff]/80' : s.bot ? 'border-[#6fd8c6]/60' : 'border-white/10',
              )}
            >
              {s.avatarUrl ? <img src={s.avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : initials(s.nickname)}
            </span>
            {p.reaction && <ReactionBubble key={p.reaction.id} r={p.reaction} compact={compact} />}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            {/* The width cap sits on a wrapper: MemberName's own max-w-full comes later in the stylesheet and would win. */}
            <span className={cx('flex min-w-0', z.name)}>
              <MemberName name={s.nickname ?? ''} role={s.role} vip={s.bot ? undefined : s.vip} bot={s.bot} className={cx('font-semibold', z.nameText, p.isMe ? 'text-gold-300' : 'text-ivory')} />
            </span>
            <span className={cx('font-mono font-semibold text-[#9fd8b6] tabular-nums', z.stack)} data-testid={`stack-${s.seatIndex}`}>
              {p.amounts.fmt(s.stack, compact)}
            </span>
          </span>
          {(p.isDealer || p.blind) && (
            <span className={cx('absolute z-10 flex items-center gap-0.5', z.badges)}>
              {p.isDealer && (
                <span className={cx('grid place-items-center rounded-full border border-black/30 bg-gradient-to-b from-ivory to-[#cfc6b0] font-display font-black text-ink-950 shadow-md', z.dealer)} data-testid="dealer-button">
                  D
                </span>
              )}
              {p.blind && (
                <span data-tour={`blind-${p.blind}`} className={cx('rounded-full border font-bold', z.blind, p.blind === 'SB' ? 'border-info/50 bg-[#16263b] text-[#a9c8ee]' : 'border-danger/50 bg-[#3a1618] text-[#f0a0a2]')}>{p.blind}</span>
              )}
            </span>
          )}
          {p.isHost && (
            <span className={cx('absolute z-10 grid h-4 place-items-center rounded-full border border-gold-500/50 bg-ink-950 px-1 text-gold-300', z.host)} title={t('room.host')} aria-label={t('room.host')} data-testid="host-mark">
              <CrownIcon className="size-2.5" />
            </span>
          )}
          {p.onPick && (
            <button type="button" className="absolute inset-0 rounded-full focus-visible:outline-2 focus-visible:outline-gold-400" onClick={p.onPick} aria-label={s.nickname} title={pickTitle} data-testid={`seat-pick-${s.seatIndex}`} />
          )}
        </div>
        {/* status line: no wider than the seat (layout.ts); what does not fit is cut short, whole in its title */}
        <div className={cx('flex items-center gap-1 overflow-hidden whitespace-nowrap font-bold tracking-wide [&>span]:min-w-0 [&>span]:truncate', z.status)} data-testid={`seat-status-${s.seatIndex}`}>
          {p.turnNote ? (
            p.turnNote
          ) : winner ? (
            <span className="text-[var(--t-winner)]" title={`${t('table.winner')} ${won}`}>
              {/* The smallest seats keep the word for screen readers only: the plate already glows. */}
              <span className={cx(p.density === 'dense' && 'sr-only')}>{t('table.winner')} </span>
              {won}
            </span>
          ) : allIn ? (
            <span className="rounded-full bg-[#e08227]/20 px-1.5 text-[color:var(--act-allin-text)]">{t('table.allin')}</span>
          ) : s.state === 'sittingOut' ? (
            <span className="text-ink-400">{t('table.sittingOut')}</span>
          ) : !s.connected ? (
            <span className="text-ink-400">{t('table.offline')}</span>
          ) : p.handLabel ? (
            <span className="text-gold-300">{p.handLabel}</span>
          ) : actionLabel ? (
            <span className={actionTone}>{actionLabel}</span>
          ) : s.bot && s.bot !== true && !s.botLeaving ? (
            p.onPick ? (
              // A tap on the bot's level and style opens its card (BotCard), as one on its avatar does.
              <button
                type="button"
                className="min-w-0 truncate text-[#8fd9cb]/80 underline decoration-[#8fd9cb]/40 decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-gold-400"
                title={botTitle}
                onClick={p.onPick}
                data-testid={`bot-level-${s.seatIndex}`}
              >
                {botLine}
              </button>
            ) : (
              <span className="text-[#8fd9cb]/80" title={botTitle} data-testid={`bot-level-${s.seatIndex}`}>
                {botLine}
              </span>
            )
          ) : null}
          {/* A bot giving up its seat plays the hand out first: its action stays readable beside the notice. */}
          {s.botLeaving && (
            <span className="text-ink-300" title={t('bot.leavingTitle')} data-testid={`bot-leaving-${s.seatIndex}`}>
              {t('bot.leaving')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
