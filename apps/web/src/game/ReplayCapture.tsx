/**
 * The replay's capture mode: the step full screen over the page (its header and bottom navigation too), the whole table
 * laid out for the screen with no window to scroll, the hand's facts above it and what the step did, or who won what,
 * under it, and no controls. It draws only the step it is given, the TableView the replay shows, so it shows no card the
 * replay does not. Escape or the close button ends it; ← and → step through the hand meanwhile.
 */
import { handLabelKey } from '@jc/types';
import { Button, cx, formatChips, Logo } from '@jc/ui';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MemberName } from '../components/MemberName';
import type { Amounts } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';
import type { ReplayInput, ReplayStep } from './replay';
import { useShortScreen } from './short';
import { TableScene, useBoxSize, useTableLayout, type LayoutOptions } from './TableScene';

/** Capture views open (one, in practice): the page under them is inert while any is. */
let open = 0;

export function ReplayCapture({
  hand,
  step,
  heroSeat,
  chars,
  amounts: a,
  phase,
  line,
  onStep,
  onClose,
  keys = true,
  actions,
}: {
  hand: ReplayInput;
  step: ReplayStep;
  heroSeat: number | null;
  chars: LayoutOptions['chars'];
  amounts: Amounts;
  /** The part of the hand the step is in, named. */
  phase: string;
  /** What the step did, as the replay says it. */
  line: string;
  onStep: (dir: -1 | 1) => void;
  onClose: () => void;
  /** Its keys work (not while a dialog over it has them). */
  keys?: boolean;
  /** More buttons in its bar (saving the step as an image). */
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const short = useShortScreen();
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const layout = useTableLayout(area, step.view.table.maxSeats, heroSeat ?? 0, { me: heroSeat !== null, chars });
  const rootRef = useRef<HTMLDivElement>(null);
  const keyed = useRef({ onStep, onClose, keys });
  keyed.current = { onStep, onClose, keys };

  // The page under it keeps still, the close button takes the focus, and the focus goes back where it was after. The
  // page can be neither tabbed to nor read meanwhile (aria-modal alone keeps neither out): inert, also under a dialog
  // opened over this one, which goes beside it outside the page (HandReplay).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    rootRef.current?.querySelector<HTMLElement>('[data-testid=replay-capture-close]')?.focus();
    const app = document.getElementById('root');
    open++;
    if (app) app.inert = true;
    const onKey = (e: KeyboardEvent) => {
      const k = keyed.current;
      if (!k.keys) return;
      if (e.key === 'Escape') k.onClose();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        k.onStep(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      root.style.overflow = overflow;
      // Before the focus goes back into the page (an inert page takes none).
      if (--open === 0 && app) app.inert = false;
      prev?.focus?.({ preventScroll: true });
    };
  }, []);

  const result = step.kind === 'result' ? step.view.hand?.result : null;
  const shown = new Map((step.view.hand?.result?.showdown ?? []).map((x) => [x.seatIndex, x]));
  const player = (seat: number) => hand.players.find((p) => p.seatIndex === seat);
  const rank = (seat: number) => {
    const x = shown.get(seat);
    return x ? t(`hand.${handLabelKey(x.rankClass, x.bestFive)}` as MsgKey) : null;
  };

  const facts = (
    <>
      <Logo size={26} withWordmark />
      <span className="text-xs font-semibold text-ink-200">{t('replay.hand', { n: hand.handNumber })}</span>
      <span className="text-xs font-semibold text-gold-300" data-testid="capture-phase">{phase}</span>
      {hand.smallBlind !== null && hand.bigBlind !== null && <span className="text-xs text-ink-300">{t('replay.blinds', { sb: formatChips(hand.smallBlind), bb: formatChips(hand.bigBlind) })}</span>}
      <span className={cx('font-mono text-sm text-gold-300 tabular-nums', !short && 'ml-auto')} data-testid="capture-pot">
        {t('table.pot')} {a.fmt(step.view.hand?.potTotal ?? 0)}
      </span>
    </>
  );
  const said = (
    <div className={cx('min-h-0', short ? 'flex-1 overflow-y-auto' : 'shrink-0 px-3 pb-2')} aria-live="polite" data-testid="capture-result">
      {result && result.winners.length > 0 ? (
        <ul className={cx('flex gap-2', short ? 'flex-col' : 'flex-wrap justify-center')}>
          {result.winners.map((w) => {
            const p = player(w.seatIndex);
            const r = rank(w.seatIndex);
            return (
              <li key={w.seatIndex} className={cx('flex max-w-full flex-wrap items-baseline gap-x-2 border border-gold-500/40 bg-gold-500/10 px-3 py-1 text-sm', short ? 'rounded-xl' : 'rounded-full')} data-testid="capture-winner">
                <MemberName name={p?.nickname ?? `#${w.seatIndex + 1}`} role={p?.role} vip={p?.vip} bot={p?.bot} className="font-semibold" />
                {r && <span className="text-xs text-ink-200">{r}</span>}
                <span className="font-mono font-bold text-[#9fd8b6] tabular-nums">+{a.fmt(w.amount)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={cx('break-words text-sm font-semibold text-ivory', short ? 'line-clamp-6' : 'line-clamp-2 text-center')}>
          <span className="text-gold-300">{phase}</span>
          {line && ` · ${line}`}
        </p>
      )}
    </div>
  );
  const close = (
    <Button variant="outline" onClick={onClose} data-testid="replay-capture-close">
      {t('replay.captureClose')}
    </Button>
  );

  // Upright and wide screens: the facts above the table, the step or the result and the buttons under it. Short, wide
  // ones (a phone on its side) keep them in a column at the right edge, as the table screen does, and give the table
  // the full height nine seats with cards need.
  return createPortal(
    <div ref={rootRef} className={cx('fixed inset-0 z-[90] flex', short ? 'flex-row' : 'flex-col')} style={{ background: 'var(--t-bg)' }} role="dialog" aria-modal="true" aria-label={t('replay.capture')} data-testid="replay-capture">
      {!short && (
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-gold-500/15 bg-ink-950/70 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]" data-testid="capture-head">
          {facts}
        </header>
      )}
      {/* The table as large as the screen leaves it, all of it: nothing scrolls. */}
      <div ref={areaRef} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-2" data-testid="capture-table">
        <TableScene s={step.view} layout={layout} mySeat={heroSeat} canSit={false} onSit={() => {}} nextIn={null} cues={[]} consumeCues={() => {}} reducedMotion amounts={a} />
      </div>
      {short ? (
        <aside className="flex w-56 shrink-0 flex-col gap-3 border-l border-gold-500/15 bg-ink-950/70 py-2 pl-3 pr-[max(0.75rem,env(safe-area-inset-right))]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="capture-head">
            {facts}
          </div>
          {said}
          <div className="flex flex-wrap justify-end gap-2">
            {actions}
            {close}
          </div>
        </aside>
      ) : (
        <>
          {said}
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gold-500/15 bg-ink-950/70 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <span className="mr-auto hidden text-xs text-ink-400 sm:inline">{t('replay.captureHint')}</span>
            {actions}
            {close}
          </footer>
        </>
      )}
    </div>,
    document.body,
  );
}
