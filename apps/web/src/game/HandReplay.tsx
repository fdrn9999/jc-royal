/**
 * Step-by-step replay of a finished hand on the live table's TableScene: a timeline of the streets, the showdown and
 * the payout, a slider over every step, previous/next action, play/pause and speed, and a line saying what each step
 * did; then the winners and every pot's payout. Only the stored record is shown (see replay.ts); nothing is fetched
 * or derived from hidden cards, and moving along the timeline only picks one of the steps built from it. Amounts read
 * in the player's unit, in big blinds of this hand's table when chosen (hands recorded without blinds stay in chips).
 */
import { handLabelKey } from '@jc/types';
import { ArrowDownIcon, Button, cardLabel, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, cx, LightbulbIcon, Modal, PauseIcon, PlayIcon, RotateCcwIcon, SkipBackIcon, SkipForwardIcon } from '@jc/ui';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LoadFailed, Loading } from '../components/Loading';
import { MemberName } from '../components/MemberName';
import { amounts, useAmounts, type Amounts } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';
import { lazyPart } from '../lib/lazyPart';
import { usePrefs } from '../lib/prefs';
import { buildReplay, REPLAY_PHASES, replayParts, replayPhase, wonLessReturned, type ReplayInput, type ReplayLinePart, type ReplayPhase } from './replay';
import { ReplayCapture } from './ReplayCapture';
import { SHARE_DEFAULTS, shareFileName, shareSnap, type ShareOptions, type SnapAt } from './shareSnap';
import { TableScene, useBoxSize, useTableLayout } from './TableScene';

/** The share image's dialog and drawing, loaded only when asked for; if they will not load, its window says so. */
const ShareDialog = lazyPart(() => import('./ShareDialog').then((m) => m.default), ShareUnavailable);
function ShareUnavailable({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal open onClose={onClose} title={t('shareImg.title')} closeLabel={t('replay.captureClose')}>
      <LoadFailed onRetry={() => location.reload()} />
    </Modal>
  );
}
/** The decision review (StrategyPanel), loaded only when opened; if it will not load, its place says so. */
const StrategyPanel = lazyPart(() => import('./StrategyPanel').then((m) => m.default), StrategyUnavailable);
function StrategyUnavailable() {
  return <LoadFailed onRetry={() => location.reload()} className="py-6" testId="replay-strategy-failed" />;
}

const STEP_MS = 1400;
const SPEEDS = [0.5, 1, 2] as const;
/**
 * Gap between the areas (gap-3), the table's inset in its frame (p-1.5), the side column's least and most width, a
 * little air, and the controls' padding and border (px).
 */
const GAP = 12;
const INSET = 6;
const SIDE_W = 224;
const SIDE_MAX = 288;
const AIR = 8;
const PAD = 26;
/** Half the slider's thumb (1.75rem): the thumb's centre runs from this far inside one end to as far inside the other. */
const THUMB_HALF = 14;
/** The least height of a table window worth having: about two rows of the smallest seats (px). */
const WINDOW_MIN = 160;
/** How far the window's edge fades out where more of the table lies past it (px). */
const EDGE = 28;
const fade = (up: boolean, down: boolean) => {
  const g = `linear-gradient(to bottom, ${up ? 'transparent' : '#000'}, #000 ${EDGE}px, #000 calc(100% - ${EDGE}px), ${down ? 'transparent' : '#000'})`;
  return { maskImage: g, WebkitMaskImage: g };
};
/** Actions the line reads in words; anything else shows as stored. */
const DOES = new Set(['post-sb', 'post-bb', 'fold', 'check', 'call', 'bet', 'raise', 'allin', 'timeout-fold', 'timeout-check']);

/**
 * How the replay is laid out: `normal` with every control (timeline, slider, play and speed), `focus` with the
 * controls folded down to the step and previous/play/next, the table taking the room they leave.
 */
type ReplayMode = 'normal' | 'focus';

// Drawn like the UI's line icons (icons.tsx): 18px, a 1.8 stroke, round ends.
const icon = 'size-[18px]';
/** Four corners: the capture mode. */
const CaptureIcon = () => (
  <svg aria-hidden viewBox="0 0 24 24" className={icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
  </svg>
);
/** A picture: the share image. */
const ImageIcon = () => (
  <svg aria-hidden viewBox="0 0 24 24" className={icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m20.5 16-4.5-4.5-8.5 8" />
  </svg>
);

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

/** `review`: the viewer's own hand, whose decisions can be reviewed under the controls (StrategyPanel). */
export function HandReplay({ hand, heroSeat, review = false }: { hand: ReplayInput; heroSeat: number | null; review?: boolean }) {
  const { t } = useI18n();
  const a = useAmounts(hand.bigBlind ?? 0);
  const steps = useMemo(() => buildReplay(hand, heroSeat), [hand, heroSeat]);
  const last = steps.length - 1;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [mode, setMode] = useState<ReplayMode>('normal');
  const [capturing, setCapturing] = useState(false);
  const [studying, setStudying] = useState(false);
  const { fourColor } = usePrefs();
  // The share image's options, kept while the replay is open (its amounts at first as the player reads them); the step
  // it was asked for, taken then and kept (the dialog open on it); a quick save's progress.
  const [shareOpt, setShareOpt] = useState<ShareOptions>(() => ({ ...SHARE_DEFAULTS, unit: a.unit }));
  const [sharing, setSharing] = useState<{ snapAt: SnapAt; failed: boolean } | null>(null);
  const [quick, setQuick] = useState<{ kind: 'making' } | { kind: 'saved'; name: string } | null>(null);
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  const step = steps[Math.min(i, last)]!;
  const parts = useMemo(() => replayParts(steps), [steps]);
  const phase = replayPhase(step);
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
  // there), and no more than keeps the controls on screen as the replay opens, with smaller seats where that is what
  // it takes; taller only when even the smallest seats need more. Short
  // landscape screens put the step and the controls beside the table instead, in whatever width the table leaves.
  const [rootRef, root] = useBoxSize<HTMLDivElement>();
  const [statusRef, statusNow] = useHeight<HTMLDivElement>();
  const [controlsRef, controlsNow] = useHeight<HTMLDivElement>();
  const band = useViewBand();
  const bandH = band.bottom - band.top;
  const side = band.w > band.h && bandH < 520 && root.w >= 560;
  // Text running to more lines only ever shrinks the table once, not back and forth step by step. Heights read as the
  // width (or the screen's height) changes were laid out for the old one (the first render assumes a wide box) and are
  // left out; so are those of the other mode, whose controls are another height (folded, the table grows).
  const [chromeH, setChromeH] = useState(0);
  const settled = useRef(false);
  useEffect(() => {
    setChromeH(0);
    settled.current = false;
  }, [root.w, bandH, mode]);
  useEffect(() => {
    if (settled.current) setChromeH((x) => Math.max(x, statusNow + controlsNow));
    settled.current = true;
  }, [statusNow, controlsNow, root.w, bandH, mode]);
  const [openTop, setOpenTop] = useState<number | null>(null);
  useLayoutEffect(() => setOpenTop(rootRef.current?.getBoundingClientRect().top ?? null), [rootRef]);
  const around = side ? 2 * INSET + AIR : Math.max(chromeH, statusNow + controlsNow) + 2 * GAP + 2 * INSET + AIR;
  const tableW = (side ? root.w - SIDE_W - GAP : root.w) - 2 * INSET;
  const budget = bandH - around;
  const room = band.bottom - Math.max(band.top, openTop ?? band.top) - around;
  const cap = Math.max(1, Math.min(tableW < 640 ? 1.4 * tableW : 0.6 * tableW, room));
  const layout = useTableLayout({ w: tableW, h: budget }, step.view.table.maxSeats, heroSeat ?? 0, { me: heroSeat !== null, chars, grow: cap });
  const sideW = Math.round(Math.max(SIDE_W, Math.min(SIDE_MAX, root.w - GAP - 2 * INSET - layout.box.w)));
  // Narrow controls keep play and speed on one row: the play button shows its icon only, the speed no label.
  const roomy = (side ? sideW : root.w) - PAD >= 372;
  // Upright phones where even the smallest seats leave the controls under the screen's edge as the replay opens: the
  // table is drawn whole in a window as tall as keeps the controls on screen, and the window scrolls to what each step
  // is about. A window shorter than WINDOW_MIN is no use; it then takes what the band leaves once the replay is scrolled
  // up under the header, and the page scrolls once to get there.
  const fit = room >= WINDOW_MIN ? room : Math.max(room, budget);
  const windowH = !side && tableW < 640 && layout.box.h > fit + 1 ? Math.floor(Math.max(WINDOW_MIN / 2, fit)) : null;
  const frameRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ up: false, down: false });
  const edges = () => {
    const f = frameRef.current;
    const up = !!f && windowH !== null && f.scrollTop > 1;
    const down = !!f && windowH !== null && f.scrollTop + f.clientHeight < f.scrollHeight - 1;
    setMore((m) => (m.up === up && m.down === down ? m : { up, down }));
  };
  // Who acted, showed or won, or the board; the viewer's own seat on the deal (the blinds' otherwise): scrolled into the
  // window when outside it, its top first when it is taller than the window. A finger's own scrolling stays until the next step.
  useLayoutEffect(() => {
    const f = frameRef.current;
    if (windowH !== null && f) {
      const seats = step.kind === 'deal' && heroSeat !== null ? [heroSeat] : step.line.flatMap((x) => ('seat' in x ? [x.seat] : []));
      const sel = seats.flatMap((s) => [`[data-testid="seat-${s}"]`, `[data-testid="bet-${s}"]`]);
      if (step.line.some((x) => x.kind === 'board')) sel.push('[data-testid=board]');
      const boxes = sel.flatMap((q) => Array.from(f.querySelectorAll(q), (e) => e.getBoundingClientRect())).filter((r) => r.height > 0);
      if (boxes.length > 0) {
        const at = f.getBoundingClientRect().top + f.clientTop - f.scrollTop;
        const top = Math.min(...boxes.map((r) => r.top)) - at - AIR;
        const bottom = Math.max(...boxes.map((r) => r.bottom)) - at + AIR;
        const to = top < f.scrollTop ? top : bottom > f.scrollTop + f.clientHeight ? Math.min(top, bottom - f.clientHeight) : f.scrollTop;
        if (Math.abs(to - f.scrollTop) > 1) f.scrollTo({ top: to, behavior: reducedMotion ? 'auto' : 'smooth' });
      }
    }
    edges();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `edges` only reads the frame
  }, [step, windowH, heroSeat, reducedMotion]);

  useEffect(() => {
    if (!playing) return;
    if (i >= last) return setPlaying(false);
    const id = setTimeout(() => setI((x) => Math.min(x + 1, last)), STEP_MS / speed);
    return () => clearTimeout(id);
  }, [playing, i, last, speed]);

  // "Saved" is about the step it was saved at.
  useEffect(() => setQuick((q) => (q?.kind === 'saved' ? null : q)), [i]);

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
  const phaseName = (p: ReplayPhase) => (p === 'result' ? t('replay.result') : t(`stage.${p}` as MsgKey));
  // What a part of a step's line did, in words, with the names `nameOf` gives (the share image can leave them out) and
  // the amounts as `fmt` reads them (the share image's own unit).
  const sayIn = (fmt: Amounts['fmt']) => (x: ReplayLinePart, nameOf: (seat: number) => string) => {
    if (x.kind === 'deal') return t('replay.step.deal');
    if (x.kind === 'board') return t('replay.line.board', { cards: x.cards.map(cardLabel).join(' ') });
    if (x.kind === 'shows') return t('replay.line.shows', { name: nameOf(x.seat), hand: t(`hand.${handLabelKey(x.rankClass, x.bestFive)}` as MsgKey) });
    if (x.kind === 'mucks') return t('replay.line.mucks', { name: nameOf(x.seat) });
    if (x.kind === 'wins') return t('replay.line.wins', { name: nameOf(x.seat), amount: fmt(x.amount) });
    return DOES.has(x.type) ? t(`replay.do.${x.type}` as MsgKey, { name: nameOf(x.seat), amount: fmt(x.amount) }) : `${nameOf(x.seat)} ${x.type}`;
  };
  const said = (x: ReplayLinePart) => sayIn(a.fmt)(x, name);
  // "Flop · Q♣ 9♠ 5♦ dealt", "Turn · A bets 8 BB": the part of the hand, then what the step did.
  const did = steps.map((s) => {
    const words = s.line.map(said);
    if (s.kind === 'result' && words.length === 0) words.push(t('replay.step.result'));
    return words;
  });
  const lines = steps.map((s, k) => [phaseName(replayPhase(s)), ...did[k]!].join(' · '));
  const longest = lines.reduce((x, y) => (y.length > x.length ? y : x), '');

  // The share image of the step on screen, taken now (stepping on while it is made changes nothing in it), or of the
  // whole hand where that is chosen; its amounts in chips, or in this hand's own big blinds (chips where it has none).
  const snapNow = (): SnapAt => {
    const at = Math.min(i, last);
    return ({ span, unit }) => {
      const fmt = amounts(unit, hand.bigBlind ?? 0).fmt;
      return shareSnap({ hand, steps, index: span === 'hand' ? last : at, heroSeat, say: sayIn(fmt), fmt, t });
    };
  };
  const openShare = () => {
    setPlaying(false);
    setSharing({ snapAt: snapNow(), failed: false });
  };
  // The options last chosen (the defaults at first), straight to a file; a failure opens the dialog to say so.
  const quickSave = async () => {
    if (quick?.kind === 'making') return;
    setPlaying(false);
    const snapAt = snapNow();
    setQuick({ kind: 'making' });
    try {
      const snap = snapAt(shareOpt);
      const { downloadShare, makeShare } = await import('./shareDraw');
      const { blob, format } = await makeShare(snap, shareOpt, fourColor);
      const file = shareFileName(snap, format);
      downloadShare(blob, file);
      setQuick({ kind: 'saved', name: file });
    } catch {
      setQuick(null);
      setSharing({ snapAt, failed: true });
    }
  };
  // Over the capture mode it goes beside it, outside the page that is inert meanwhile (ReplayCapture), so Tab stays
  // out of the page under them.
  const shareDialog = sharing && (
    <Suspense fallback={null}>
      <ShareDialog snapAt={sharing.snapAt} bigBlind={hand.bigBlind} failed={sharing.failed} fourColor={fourColor} opt={shareOpt} onOpt={setShareOpt} onClose={() => setSharing(null)} />
    </Suspense>
  );

  const potLine = (p: { amount: number }, k: number) => `${k === 0 ? t('replay.mainPot') : t('table.sidePot', { n: k })} ${a.fmt(p.amount)}`;
  // Every side-pot line the hand shows, laid over one another unseen, so the line is as tall as its tallest throughout.
  const sideLines = [...new Set(steps.map((s) => s.view.hand?.pots ?? []).filter((x) => x.length > 1).map((x) => x.map(potLine).join(' · ')))];
  // The status line's step count and pot as wide as their widest (in a fixed-width face), so it breaks the same way throughout.
  const indexCh = String(steps.length).length * 2 + 1;
  const potCh = Math.max(...steps.map((s) => a.fmt(s.view.hand?.potTotal ?? 0).length));

  // The payout shows on the last step. The room it took stays once it has shown, so stepping back from it never shortens
  // the page and pulls what lies under a finger (the slider) down the screen.
  const settleRef = useRef<HTMLDivElement>(null);
  const [keep, setKeep] = useState(0);
  useLayoutEffect(() => {
    const el = settleRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setKeep((x) => Math.max(x, el.offsetHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Measured afresh at another width (a phone turned), where it may take fewer lines.
  useLayoutEffect(() => setKeep(settleRef.current?.offsetHeight ?? 0), [band.w]);
  const potsRef = useRef<HTMLElement>(null);
  // Brought between the header and the bottom bar (its top first when it is taller).
  const onScreen = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const top = r.top - (band.top + GAP);
    const by = top < 0 ? top : Math.max(0, Math.min(top, r.bottom - (band.bottom - GAP)));
    if (Math.abs(by) > 1) window.scrollBy({ top: by, behavior: reducedMotion ? 'auto' : 'smooth' });
  };
  // ...and focused for the keyboard.
  const toSettlement = () => {
    const el = potsRef.current;
    if (!el) return;
    onScreen(el);
    el.focus({ preventScroll: true });
  };
  const studyRef = useRef<HTMLDivElement>(null);
  // Where a step sits along the slider: its thumb's centre at that value.
  const at = (k: number) => `calc(${THUMB_HALF}px + (100% - ${2 * THUMB_HALF}px) * ${last > 0 ? k / last : 0})`;
  const stepper = (dir: -1 | 1) => (
    <Button
      variant="outline"
      size="icon"
      className="h-10! min-w-10! shrink-0"
      onClick={() => go(i + dir)}
      disabled={dir < 0 ? i === 0 : i >= last}
      aria-label={t(dir < 0 ? 'replay.prev' : 'replay.next')}
      title={t(dir < 0 ? 'replay.prev' : 'replay.next')}
      data-testid={dir < 0 ? 'replay-prev' : 'replay-next'}
    >
      {/* One step; the bar-ended pair below goes to the first and last. */}
      {dir < 0 ? <ChevronLeftIcon className="size-5" /> : <ChevronRightIcon className="size-5" />}
    </Button>
  );
  // Its width changes with the controls' (the first render guesses wide); animated, the row would wrap for a moment and
  // the table be sized for it.
  const playButton = (
    <Button variant="gold" size="md" className={cx('transition-colors!', roomy ? 'min-w-28' : 'min-w-12 px-3!')} onClick={toggle} aria-pressed={playing} data-testid="replay-play">
      {playing ? <PauseIcon className="size-5" /> : i >= last ? <RotateCcwIcon className="size-5" /> : <PlayIcon className="size-5" />}
      <span className={roomy ? undefined : 'sr-only'}>{playing ? t('replay.pause') : i >= last ? t('replay.again') : t('replay.play')}</span>
    </Button>
  );

  return (
    <div ref={rootRef} className="flex flex-col gap-3" data-testid="hand-replay">
      <div className={cx('grid gap-3', side && 'grid-rows-[auto_1fr] items-start')} style={side ? { gridTemplateColumns: `minmax(0,1fr) ${sideW}px` } : undefined}>
        <div ref={statusRef} className={cx('flex min-w-0 flex-col gap-1 rounded-xl border border-white/10 bg-black/25 px-3 py-2', side && 'col-start-2 row-start-1')} data-testid="replay-status">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-ink-300">
            <span className="flex items-baseline gap-2">
              <span>
                <span className="inline-block font-mono tabular-nums" style={{ minWidth: `${indexCh}ch` }} data-testid="replay-index">
                  {i + 1}/{steps.length}
                </span>{' '}
                · {/* Every part's name laid over the others unseen: as wide as the widest. */}
                <span className="inline-grid font-semibold text-ivory">
                  {REPLAY_PHASES.map((p) => (
                    <span key={p} className={cx('[grid-area:1/1]', p !== phase && 'invisible')} aria-hidden={p !== phase || undefined}>
                      {phaseName(p)}
                    </span>
                  ))}
                </span>
              </span>
              {/* Laid out at every step and shown on the payout's, so the line keeps its size. Its hit area reaches past the
                  text's height without making the line taller. */}
              <button
                type="button"
                className={cx(
                  '-my-1 rounded py-1 font-semibold text-gold-300 underline decoration-dotted underline-offset-2 hover:text-gold-200 focus-visible:outline-2 focus-visible:outline-gold-400',
                  step.kind !== 'result' && 'invisible',
                )}
                onClick={toSettlement}
                disabled={step.kind !== 'result'}
                data-testid="replay-to-settlement"
              >
                {t('replay.toSettlement')} <ArrowDownIcon className="inline size-3.5 align-[-2px]" />
              </button>
            </span>
            <span className="font-mono text-gold-300 tabular-nums" data-testid="replay-pot">
              {t('table.pot')}{' '}
              <span className="inline-block text-right" style={{ minWidth: `${potCh}ch` }}>
                {a.fmt(step.view.hand!.potTotal)}
              </span>
            </span>
          </div>
          {sideLine && (
            <div className="grid text-[11px] leading-4 text-ink-300">
              <p className="min-h-4 [grid-area:1/1]" data-testid="replay-side-pots">
                {pots.length > 1 ? pots.map(potLine).join(' · ') : ''}
              </p>
              {sideLines.map((x) => (
                <p key={x} className="invisible [grid-area:1/1]" aria-hidden="true">
                  {x}
                </p>
              ))}
            </div>
          )}
        </div>
        {/* The table at the size its plan asked for: every seat, bet and the board inside it, nothing drawn over it; in a
            window it scrolls up and down under a finger, the rest of the table past the faded edge. */}
        <div
          ref={frameRef}
          className={cx('jc-game-surface relative flex justify-center rounded-2xl p-1.5', windowH === null ? 'overflow-hidden' : 'overflow-x-hidden overflow-y-auto', side && 'col-start-1 row-span-2 row-start-1')}
          style={{
            background: 'var(--t-bg)',
            ...(windowH !== null && {
              height: windowH + 2 * INSET,
              touchAction: 'pan-y',
              // At either end a swipe goes on to the page, as anywhere else on it.
              overscrollBehavior: 'auto',
              ...((more.up || more.down) && fade(more.up, more.down)),
            }),
          }}
          onScroll={windowH === null ? undefined : edges}
          tabIndex={windowH === null ? undefined : 0}
          role={windowH === null ? undefined : 'region'}
          aria-label={windowH === null ? undefined : t('replay.tableWindow')}
          data-window={windowH === null ? undefined : '1'}
          data-testid="replay-table"
        >
          <TableScene s={step.view} layout={layout} mySeat={heroSeat} canSit={false} onSit={() => {}} nextIn={null} cues={[]} consumeCues={() => {}} reducedMotion={reducedMotion} amounts={a} />
        </div>
        <div ref={controlsRef} className={cx('flex min-w-0 flex-col gap-2 rounded-xl border border-gold-500/30 bg-ink-850 p-3', side && 'col-start-2 row-start-2')} data-testid="replay-controls" data-mode={mode}>
          {/* The step's line and the view's buttons on one row; where the row leaves the line too little room (a side
              column, a phone narrower than 360 px), the buttons take a row of their own above it. A 360 px phone keeps the
              one row (the line 156 px wide): a second row there costs the table the room that keeps the controls above
              the bottom navigation as the replay opens. */}
          <div className="flex flex-wrap-reverse items-start gap-2">
            {/* What this step did, the part of the hand first, in as many lines as the hand's longest takes (three at most,
                two folded: a long payout is in full in the settlement below, and read out whole), so the table keeps its
                size throughout. */}
            <div className="grid min-w-36 flex-1">
              <p className={cx('min-h-10 break-words text-sm font-semibold text-ivory [grid-area:1/1]', mode === 'focus' ? 'line-clamp-2' : 'line-clamp-3')} aria-live="polite" data-testid="replay-step">
                <span className="text-gold-300">{phaseName(phase)}</span>
                {did[i]!.length > 0 && ` · ${did[i]!.join(' · ')}`}
              </p>
              <p className={cx('invisible min-h-10 break-words text-sm font-semibold [grid-area:1/1]', mode === 'focus' ? 'line-clamp-2' : 'line-clamp-3')} aria-hidden="true">
                {longest}
              </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1" role="group" aria-label={t('replay.view')} data-testid="replay-tools">
              <Button variant="ghost" size="icon" className="h-10! min-w-10!" onClick={openShare} aria-haspopup="dialog" aria-label={t('shareImg.open')} title={t('shareImg.open')} data-testid="replay-share-open">
                <ImageIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-10! min-w-10!"
                onClick={() => {
                  setPlaying(false);
                  setCapturing(true);
                }}
                aria-haspopup="dialog"
                aria-label={t('replay.capture')}
                title={t('replay.capture')}
                data-testid="replay-capture-open"
              >
                <CaptureIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-10! min-w-10!"
                onClick={() => setMode(mode === 'normal' ? 'focus' : 'normal')}
                aria-expanded={mode === 'normal'}
                aria-label={t(mode === 'normal' ? 'replay.collapse' : 'replay.expand')}
                title={t(mode === 'normal' ? 'replay.collapse' : 'replay.expand')}
                data-testid="replay-fold"
              >
                {/* A chevron: down to fold the controls, up to bring them back. */}
                {mode === 'focus' ? <ChevronUpIcon /> : <ChevronDownIcon />}
              </Button>
            </div>
          </div>
          {mode === 'focus' ? (
            <div className="flex items-center gap-2" role="group" aria-label={t('replay.player')} data-testid="replay-compact">
              {stepper(-1)}
              {playButton}
              {stepper(1)}
            </div>
          ) : (
            <>
              {/* Each part as wide as its name needs and the row's room shared out; a narrow column takes two rows. */}
              <div className="flex flex-wrap gap-1" role="group" aria-label={t('replay.timeline')} data-testid="replay-timeline">
                {REPLAY_PHASES.map((p) => {
                  const part = parts.find((x) => x.phase === p);
                  const now = p === phase;
                  return (
                    <button
                      key={p}
                      type="button"
                      className={cx(
                        'h-9 flex-auto rounded-md px-1 text-[11px] whitespace-nowrap font-semibold transition-colors',
                        now ? 'bg-gold-500/25 text-gold-300 ring-1 ring-gold-400/60' : part ? 'bg-white/[0.05] text-ink-200 hover:bg-white/10' : 'cursor-not-allowed text-ink-400 opacity-60',
                      )}
                      onClick={() => part && go(part.first)}
                      disabled={!part}
                      aria-current={now ? 'step' : undefined}
                      title={part ? undefined : t('replay.unreached')}
                      data-testid={`replay-phase-${p}`}
                    >
                      {phaseName(p)}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                {stepper(-1)}
                <div className="relative min-w-0 flex-1">
                  {parts
                    .filter((x) => x.phase !== 'preflop')
                    .map((x) => (
                      <span
                        key={x.phase}
                        className="pointer-events-none absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold-300/70"
                        style={{ left: at(x.first) }}
                        aria-hidden="true"
                        data-testid={`replay-tick-${x.phase}`}
                      />
                    ))}
                  <input
                    type="range"
                    className="jc-range relative block w-full"
                    min={0}
                    max={last}
                    step={1}
                    value={i}
                    onChange={(e) => go(Number(e.target.value))}
                    aria-label={t('replay.position')}
                    aria-valuetext={`${i + 1}/${steps.length} · ${lines[i]}`}
                    data-testid="replay-slider"
                  />
                </div>
                {stepper(1)}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1" role="group" aria-label={t('replay.player')}>
                  <Button variant="ghost" size="icon" className="h-10! min-w-10!" onClick={() => go(0)} disabled={i === 0} aria-label={t('replay.first')} title={t('replay.first')} data-testid="replay-first">
                    <SkipBackIcon className="size-5" />
                  </Button>
                  {playButton}
                  <Button variant="ghost" size="icon" className="h-10! min-w-10!" onClick={() => go(last)} disabled={i >= last} aria-label={t('replay.last')} title={t('replay.last')} data-testid="replay-last">
                    <SkipForwardIcon className="size-5" />
                  </Button>
                </div>
                <div className="flex items-center gap-1" role="group" aria-label={t('replay.speed')}>
                  <span className={roomy ? 'mr-1 text-xs text-ink-400' : 'sr-only'}>{t('replay.speed')}</span>
                  {SPEEDS.map((x) => (
                    <Button key={x} variant={speed === x ? 'subtle' : 'ghost'} size="icon" className="h-10! min-w-9!" onClick={() => setSpeed(x)} aria-pressed={speed === x} data-testid={`replay-speed-${x}`}>
                      {x}×
                    </Button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {capturing && (
        <ReplayCapture
          hand={hand}
          step={step}
          heroSeat={heroSeat}
          chars={chars}
          amounts={a}
          phase={phaseName(phase)}
          line={did[i]!.join(' · ')}
          onStep={(dir) => go(i + dir)}
          onClose={() => setCapturing(false)}
          keys={sharing === null}
          actions={
            <>
              <span className="sr-only" role="status" data-testid="replay-share-quick-status">
                {quick?.kind === 'saved' ? t('shareImg.saved', { name: quick.name }) : ''}
              </span>
              <Button variant="outline" onClick={openShare} aria-haspopup="dialog" data-testid="replay-share-open-capture">
                <ImageIcon />
                {t('shareImg.open')}
              </Button>
              <Button onClick={quickSave} loading={quick?.kind === 'making'} data-testid="replay-share-quick" data-state={quick?.kind ?? 'idle'}>
                {quick?.kind === 'saved' && <CheckIcon />}
                {t(shareOpt.span === 'hand' ? 'shareImg.quickHand' : 'shareImg.quick')}
              </Button>
            </>
          }
        />
      )}
      {shareDialog && (capturing ? createPortal(shareDialog, document.body) : shareDialog)}
      {/* Under the controls, not among them: opening it changes neither the table's size nor where the controls are. */}
      {review && heroSeat !== null && (
        <div ref={studyRef} className="flex flex-col gap-2">
          {/* Its name wraps on a narrow phone rather than being cut short (the longer English one at 320px). */}
          <Button variant="outline" className="h-auto! min-h-10 w-full justify-between! py-2! text-left whitespace-normal!" onClick={() => setStudying(!studying)} aria-expanded={studying} aria-controls="replay-strategy" data-testid="replay-strategy-toggle">
            <span className="flex min-w-0 items-center gap-2">
              <LightbulbIcon className="size-4 shrink-0" />
              <span className="min-w-0">{t('replay.study')}</span>
            </span>
            {studying ? <ChevronUpIcon className="size-4 shrink-0" /> : <ChevronDownIcon className="size-4 shrink-0" />}
          </Button>
          {studying && (
            <Suspense fallback={<Loading className="py-6" />}>
              <StrategyPanel hand={hand} steps={steps} heroSeat={heroSeat} index={i} onGo={go} amounts={a} onShown={() => studyRef.current && onScreen(studyRef.current)} />
            </Suspense>
          )}
        </div>
      )}
      <div className={cx(keep === 0 && step.kind !== 'result' && 'hidden')} style={keep > 0 ? { minHeight: keep } : undefined}>
        <div ref={settleRef}>{step.kind === 'result' && <Settlement hand={hand} name={name} amounts={a} sectionRef={potsRef} />}</div>
      </div>
    </div>
  );
}

/**
 * Each pot of the hand and who won it, or each player's total for hands recorded before pots were stored; chips nobody
 * called show as handed back, not won. Pots and the chips handed back are as the server sent them.
 */
function Settlement({ hand, name, amounts: a, sectionRef }: { hand: ReplayInput; name: (seat: number) => string; amounts: Amounts; sectionRef: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const pots = hand.pots;
  const back = pots ? null : hand.returned;
  let side = 0;
  return (
    <section ref={sectionRef} tabIndex={-1} className="rounded-xl border border-white/10 bg-black/25 p-3 focus-visible:outline-2 focus-visible:outline-gold-400" data-testid="replay-pots">
      <h4 className="mb-2 text-sm font-bold text-gold-300">{t('replay.settlement')}</h4>
      {pots ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {pots.map((pot, k) => {
            const label = pot.uncalled ? t('replay.returned') : k === 0 ? t('replay.mainPot') : t('table.sidePot', { n: (side += 1) });
            return (
              <li key={k} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5" data-testid="replay-pot-row">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-ink-100">{label}</span>
                  <span className="font-mono text-gold-300 tabular-nums">{a.fmt(pot.amount)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                  {!pot.uncalled && <span className="text-ink-400">{t('replay.contenders', { names: pot.eligibleSeats.map(name).join(', ') })}</span>}
                  <span className={pot.uncalled ? 'text-ink-300' : 'text-[#9fd8b6]'}>
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
              .map((p) => ({ p, won: wonLessReturned(hand, p) }))
              .filter((x) => x.won > 0)
              .map(({ p, won }) => (
                <li key={p.seatIndex} className="flex justify-between gap-2">
                  <MemberName name={p.nickname} role={p.role} vip={p.vip} bot={p.bot} />
                  <span className="font-mono text-[#9fd8b6] tabular-nums">+{a.fmt(won)}</span>
                </li>
              ))}
            {back && (
              <li className="flex justify-between gap-2 text-ink-300" data-testid="replay-returned">
                <span>
                  {t('replay.returned')} · {name(back.seatIndex)}
                </span>
                <span className="font-mono tabular-nums">{a.fmt(back.amount)}</span>
              </li>
            )}
          </ul>
          <p className="mt-2 text-xs text-ink-400">{t('replay.legacy')}</p>
        </>
      )}
    </section>
  );
}
