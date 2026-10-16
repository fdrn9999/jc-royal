/**
 * Step-by-step replay of a finished hand on the live table's TableScene: previous/next action, play/pause and speed,
 * the pot growing street by street, then the winners and every pot's payout. Only the stored record is shown (see
 * replay.ts); nothing is fetched or derived from hidden cards. Amounts read in the player's unit, in big blinds of this
 * hand's table when chosen (hands recorded without blinds stay in chips).
 */
import { Button, cx } from '@jc/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MemberName } from '../components/MemberName';
import { useAmounts, type Amounts } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';
import { buildReplay, type ReplayInput, type ReplayStep } from './replay';
import { TableScene, useBoxSize, useTableLayout } from './TableScene';

const STEP_MS = 1400;
const SPEEDS = [0.5, 1, 2] as const;
/** Gap between the areas (gap-3), the table's inset in its frame (p-1.5), the side column (12rem) and a little air (px). */
const GAP = 12;
const INSET = 6;
const SIDE_W = 192;
const AIR = 8;

/**
 * The part of the screen the page's own bars leave free: below the app's sticky header and above its fixed bottom
 * navigation (phones). Read from the page, since the replay shows inside other pages.
 */
function useViewBand() {
  const read = () => {
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const fixed = (el: Element) => ['sticky', 'fixed'].includes(getComputedStyle(el).position) && (el as HTMLElement).offsetHeight > 0;
    const header = Array.from(document.querySelectorAll('header')).find(fixed) as HTMLElement | undefined;
    const nav = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed' && (n as HTMLElement).offsetHeight > 0) as HTMLElement | undefined;
    return { top: header?.offsetHeight ?? 0, bottom: vh - (nav?.offsetHeight ?? 0), w: window.innerWidth, h: vh };
  };
  const [band, setBand] = useState(read);
  useLayoutEffect(() => {
    const update = () =>
      setBand((b) => {
        const n = read();
        return n.top === b.top && n.bottom === b.bottom && n.w === b.w && n.h === b.h ? b : n;
      });
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  return band;
}

/** An element's height as drawn, kept current. */
function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setH(el.offsetHeight);
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
}

export function HandReplay({ hand, heroSeat }: { hand: ReplayInput; heroSeat: number | null }) {
  const { t } = useI18n();
  const a = useAmounts(hand.bigBlind ?? 0);
  const steps = useMemo(() => buildReplay(hand, heroSeat), [hand, heroSeat]);
  const last = steps.length - 1;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  const step = steps[Math.min(i, last)]!;
  const pots = step.view.hand?.pots ?? [];
  // A line for the pots under the step's pot when the hand ever splits into side pots, kept for every step so the
  // table does not move from one step to the next.
  const sideLine = useMemo(() => steps.some((s) => (s.view.hand?.pots.length ?? 0) > 1), [steps]);
  // The longest amounts this hand shows, so its bets and pot get room enough.
  const chars = useMemo(() => {
    const c = { stack: 1, bet: 1, pot: 1 };
    for (const s of steps) {
      for (const x of s.view.seats) {
        c.stack = Math.max(c.stack, a.fmt(x.stack).length);
        c.bet = Math.max(c.bet, a.fmt(x.streetBet, true).length);
      }
      c.pot = Math.max(c.pot, a.fmt(s.view.hand?.potTotal ?? 0, true).length);
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `a` is rebuilt every render; its unit and big blind are what count
  }, [steps, a.unit, a.bigBlind]);

  // Three areas that never cover one another: the step (top), the table, the controls (bottom). The table takes the
  // height the screen leaves once the other two are counted, so all three show together under the header (scrolled
  // there), and no more than keeps the controls on screen as the replay opens, unless its seats need more. Short
  // landscape screens put the step and the controls beside the table instead.
  const [rootRef, root] = useBoxSize<HTMLDivElement>();
  const [statusRef, statusNow] = useHeight<HTMLDivElement>();
  const [controlsRef, controlsH] = useHeight<HTMLDivElement>();
  const band = useViewBand();
  const bandH = band.bottom - band.top;
  const side = band.w > band.h && bandH < 520 && root.w >= 560;
  // A step text running to more lines only ever shrinks the table once, not back and forth step by step.
  const [statusH, setStatusH] = useState(0);
  useEffect(() => setStatusH(0), [root.w, bandH]);
  useEffect(() => setStatusH((x) => Math.max(x, statusNow)), [statusNow, root.w, bandH]);
  const [openTop, setOpenTop] = useState<number | null>(null);
  useLayoutEffect(() => setOpenTop(rootRef.current?.getBoundingClientRect().top ?? null), [rootRef]);
  const around = side ? 2 * INSET + AIR : Math.max(statusH, statusNow) + controlsH + 2 * GAP + 2 * INSET + AIR;
  const tableW = (side ? root.w - SIDE_W - GAP : root.w) - 2 * INSET;
  const budget = bandH - around;
  const room = band.bottom - Math.max(band.top, openTop ?? band.top) - around;
  const cap = Math.max(1, Math.min(tableW < 640 ? 1.4 * tableW : 0.6 * tableW, room));
  const layout = useTableLayout({ w: tableW, h: budget }, step.view.table.maxSeats, heroSeat ?? 0, { me: heroSeat !== null, chars, grow: cap });

  useEffect(() => {
    if (!playing) return;
    if (i >= last) return setPlaying(false);
    const id = setTimeout(() => setI((x) => Math.min(x + 1, last)), STEP_MS / speed);
    return () => clearTimeout(id);
  }, [playing, i, last, speed]);

  const go = (to: number) => {
    setPlaying(false);
    setI(Math.max(0, Math.min(last, to)));
  };
  const toggle = () => {
    if (playing) return setPlaying(false);
    if (i >= last) setI(0);
    setPlaying(true);
  };
  const name = (seat: number) => hand.players.find((p) => p.seatIndex === seat)?.nickname ?? `#${seat + 1}`;
  const actionText = (type: string) => (['post-sb', 'post-bb', 'timeout-fold', 'timeout-check'].includes(type) ? t(`replay.${type}` as MsgKey) : t(`action.${type}` as MsgKey));
  const describe = (s: ReplayStep) => {
    const acts = s.actions.map((x) => `${name(x.seatIndex)} ${actionText(x.type)}${x.amount > 0 ? ` ${a.fmt(x.amount)}` : ''}`).join(' · ');
    if (s.kind === 'deal') return acts ? `${t('replay.step.deal')} · ${acts}` : t('replay.step.deal');
    if (s.kind === 'street') return t('replay.step.street', { street: t(`stage.${s.stage}` as MsgKey) });
    if (s.kind === 'showdown') return t('replay.step.showdown');
    if (s.kind === 'result') return t('replay.step.result');
    return acts;
  };

  // Beside the table the step buttons share one row of four, the play button above them.
  const nav = side ? 'min-w-0 px-0' : undefined;
  const potLine = (p: { amount: number }, k: number) => `${k === 0 ? t('replay.mainPot') : t('table.sidePot', { n: k })} ${a.fmt(p.amount)}`;

  return (
    <div ref={rootRef} className="flex flex-col gap-3" data-testid="hand-replay">
      <div className={cx('grid gap-3', side && 'grid-cols-[minmax(0,1fr)_12rem] grid-rows-[auto_1fr] items-start')}>
        <div ref={statusRef} className={cx('flex min-w-0 flex-col gap-1 rounded-xl border border-white/10 bg-black/25 px-3 py-2', side && 'col-start-2 row-start-1')} data-testid="replay-status">
          <div className="flex items-baseline justify-between gap-2 text-xs text-ink-300">
            <span>
              <span className="font-mono tabular-nums" data-testid="replay-index">{i + 1}/{steps.length}</span> · {t(`stage.${step.stage}` as MsgKey)}
            </span>
            <span className="font-mono text-gold-300 tabular-nums" data-testid="replay-pot">
              {t('table.pot')} {a.fmt(step.view.hand!.potTotal)}
            </span>
          </div>
          {sideLine && (
            <p className="min-h-4 text-[11px] leading-4 text-ink-300" data-testid="replay-side-pots">
              {pots.length > 1 ? pots.map(potLine).join(' · ') : ''}
            </p>
          )}
          <p className="min-h-10 break-words text-sm font-semibold text-ivory" aria-live="polite" data-testid="replay-step">
            {describe(step)}
          </p>
        </div>
        {/* The table at the size its plan asked for: every seat, bet and the board inside it, nothing drawn over it. */}
        <div
          className={cx('jc-game-surface relative flex justify-center overflow-hidden rounded-2xl p-1.5', side && 'col-start-1 row-span-2 row-start-1')}
          style={{ background: 'var(--t-bg)' }}
          data-testid="replay-table"
        >
          <TableScene s={step.view} layout={layout} mySeat={heroSeat} canSit={false} onSit={() => {}} nextIn={null} cues={[]} consumeCues={() => {}} reducedMotion={reducedMotion} amounts={a} />
        </div>
        <div ref={controlsRef} className={cx('flex min-w-0 flex-col gap-2 rounded-xl border border-gold-500/30 bg-ink-850 p-3', side && 'col-start-2 row-start-2')} data-testid="replay-controls">
          <div className={cx('flex flex-wrap items-center gap-2', side ? 'flex-col items-stretch' : 'justify-between')}>
            <div className={cx('items-center gap-1', side ? 'grid grid-cols-4' : 'flex')} role="group" aria-label={t('replay.player')}>
              <Button variant="ghost" size="md" onClick={() => go(0)} disabled={i === 0} className={nav} aria-label={t('replay.first')} title={t('replay.first')} data-testid="replay-first">⏮</Button>
              <Button variant="outline" size="md" onClick={() => go(i - 1)} disabled={i === 0} className={nav} aria-label={t('replay.prev')} title={t('replay.prev')} data-testid="replay-prev">◀</Button>
              <Button
                variant="gold"
                size="md"
                className={cx('min-w-24', side && 'order-first col-span-4')}
                onClick={toggle}
                aria-pressed={playing}
                data-testid="replay-play"
              >
                {playing ? `❚❚ ${t('replay.pause')}` : `▶ ${t('replay.play')}`}
              </Button>
              <Button variant="outline" size="md" onClick={() => go(i + 1)} disabled={i >= last} className={nav} aria-label={t('replay.next')} title={t('replay.next')} data-testid="replay-next">▶</Button>
              <Button variant="ghost" size="md" onClick={() => go(last)} disabled={i >= last} className={nav} aria-label={t('replay.last')} title={t('replay.last')} data-testid="replay-last">⏭</Button>
            </div>
            <div className={cx('items-center gap-1', side ? 'grid grid-cols-3' : 'flex')} role="group" aria-label={t('replay.speed')}>
              <span className={side ? 'sr-only' : 'mr-1 text-xs text-ink-400'}>{t('replay.speed')}</span>
              {SPEEDS.map((x) => (
                <Button key={x} variant={speed === x ? 'subtle' : 'ghost'} size="sm" onClick={() => setSpeed(x)} aria-pressed={speed === x} data-testid={`replay-speed-${x}`}>
                  {x}×
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {step.kind === 'result' && <Settlement hand={hand} name={name} amounts={a} />}
    </div>
  );
}

/** Each pot of the hand and who won it, or each player's total for hands recorded before pots were stored. */
function Settlement({ hand, name, amounts: a }: { hand: ReplayInput; name: (seat: number) => string; amounts: Amounts }) {
  const { t } = useI18n();
  let side = 0;
  return (
    <section className="rounded-xl border border-white/10 bg-black/25 p-3" data-testid="replay-pots">
      <h4 className="mb-2 text-sm font-bold text-gold-300">{t('replay.settlement')}</h4>
      {hand.pots ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {hand.pots.map((pot, k) => {
            const label = pot.uncalled ? t('replay.returned') : k === 0 ? t('replay.mainPot') : t('table.sidePot', { n: (side += 1) });
            return (
              <li key={k} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5" data-testid="replay-pot-row">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-ink-100">{label}</span>
                  <span className="font-mono text-gold-300 tabular-nums">{a.fmt(pot.amount)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                  {!pot.uncalled && <span className="text-ink-400">{t('replay.contenders', { names: pot.eligibleSeats.map(name).join(', ') })}</span>}
                  <span className="text-[#9fd8b6]">
                    {pot.winners.map((w) => `${name(w.seatIndex)} ${pot.uncalled ? '' : '+'}${a.fmt(w.amount)}`).join(' · ')}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          <ul className="flex flex-col gap-1 text-sm">
            {hand.players
              .filter((p) => p.won > 0)
              .map((p) => (
                <li key={p.seatIndex} className="flex justify-between gap-2">
                  <MemberName name={p.nickname} role={p.role} bot={p.bot} />
                  <span className="font-mono text-[#9fd8b6] tabular-nums">+{a.fmt(p.won)}</span>
                </li>
              ))}
          </ul>
          <p className="mt-2 text-xs text-ink-400">{t('replay.legacy')}</p>
        </>
      )}
    </section>
  );
}
