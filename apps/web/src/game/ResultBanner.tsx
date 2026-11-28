/**
 * A settled hand's result in words, from the server's result only (showdown.ts): the winner's banner over the table's
 * middle once the pot is paid, and for me a line on why the hand ended as it did. Neither takes a tap; both stay until
 * the next deal (the room's time between hands, pace.ts) and are gone with the hand.
 */
import { handLabelKey } from '@jc/types';
import { cx } from '@jc/ui';
import { memo, useEffect, useRef } from 'react';
import type { Amounts } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';
import { winTier, type Outcome, type WinBanner } from './showdown';

/** How long the banner's amount counts up. */
const COUNT_MS = 700;

/** `to` counting up from nothing, written straight to the element (no redraw of anything else). */
function CountUp({ to, fmt, still }: { to: number; fmt: (n: number) => string; still: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || still || typeof requestAnimationFrame !== 'function') return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / COUNT_MS);
      el.textContent = `+${fmt(Math.round(to * (1 - (1 - k) ** 3)))}`;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one count per amount
  }, [to, still]);
  return (
    <span ref={ref} className="tabular-nums" data-amount={to}>
      +{fmt(to)}
    </span>
  );
}

const handName = (t: (k: MsgKey) => string, h: { rankClass: string; bestFive: readonly string[] } | null) => (h ? t(`hand.${handLabelKey(h.rankClass, h.bestFive)}` as MsgKey) : null);

/**
 * The winner's banner: WINNER (or SPLIT POT), who, with what hand (only one the showdown turned over), how much. A four
 * of a kind, a straight flush and a royal flush each get their own look (`data-tier`), with `effects` on.
 */
export const WinnerBanner = memo(function WinnerBanner({
  banner,
  names,
  amounts,
  effects,
  still,
  maxWidth,
}: {
  banner: WinBanner;
  /** Nicknames by seat index. */
  names: ReadonlyMap<number, string>;
  amounts: Amounts;
  effects: boolean;
  /** No count-up (reduced motion). */
  still: boolean;
  maxWidth: number;
}) {
  const { t } = useI18n();
  const first = banner.winners[0]!;
  const many = banner.winners.length > 1;
  const tier = effects ? winTier(banner.hand) : null;
  const hand = handName(t, banner.hand);
  return (
    <div className="jc-win-banner" style={{ maxWidth }} role="status" data-testid="winner-banner" data-tight={maxWidth < 340 ? '1' : undefined} data-tier={tier ?? undefined} data-split={banner.split ? '1' : undefined}>
      <span className="jc-win-banner-title">{banner.split ? 'SPLIT POT' : many ? 'WINNERS' : 'WINNER'}</span>
      {many ? (
        <span className="min-w-0 truncate">
          {banner.winners
            .slice(0, 3)
            .map((w) => `${names.get(w.seatIndex) ?? ''} +${amounts.fmt(w.amount, true)}`)
            .join(' · ')}
          {banner.winners.length > 3 ? ' …' : ''}
        </span>
      ) : (
        <>
          <span className="min-w-0 truncate font-semibold" data-testid="winner-name">
            {names.get(first.seatIndex) ?? ''}
          </span>
          {hand && (
            <span className="jc-win-banner-hand shrink-0" data-testid="winner-hand">
              {hand}
            </span>
          )}
          <span className="shrink-0 font-bold text-gold-300">
            <CountUp to={first.amount} fmt={(n) => amounts.fmt(n, true)} still={still} />
          </span>
        </>
      )}
    </div>
  );
});

/** Why the hand ended as it did for me (showdown.ts `outcomeFor`), in two short lines. */
export function OutcomeNote({ outcome, names, amounts, className }: { outcome: Outcome; names: ReadonlyMap<number, string>; amounts: Amounts; className?: string }) {
  const { t } = useI18n();
  const who = (seat: number) => names.get(seat) ?? '';
  let title: string;
  let lines: { label: string; text: string; id: string }[] = [];
  let note: string | null = null;
  if (outcome.kind === 'lost') {
    title = t('result.lostShowdown');
    lines = [
      { id: 'mine', label: t('result.yourHand'), text: handName(t, outcome.mine) ?? t('result.notShown') },
      { id: 'winning', label: t('result.winningHand'), text: [handName(t, outcome.hand), who(outcome.winner)].filter(Boolean).join(' · ') },
    ];
    note = outcome.sameRank ? t('result.kicker') : null;
  } else if (outcome.kind === 'folded') {
    title = t('result.folded');
    lines = [{ id: 'winning', label: t('result.winningHand'), text: [handName(t, outcome.hand) ?? t('result.notShown'), who(outcome.winner)].filter(Boolean).join(' · ') }];
  } else {
    title = t(outcome.kind === 'split' ? 'result.split' : 'result.side');
    note = t(outcome.kind === 'split' ? 'result.splitNote' : 'result.sideNote', { names: outcome.others.map(who).filter(Boolean).join(', '), amount: amounts.fmt(outcome.amount, true) });
  }
  return (
    <div
      className={cx('pointer-events-none max-w-md rounded-lg border border-white/15 bg-ink-950/95 px-3 py-1 text-xs text-ink-100 shadow-lg sm:py-1.5', className)}
      role="status"
      data-testid="outcome-note"
      data-kind={outcome.kind}
    >
      <div className={cx('text-[10px] font-bold tracking-[0.14em]', outcome.kind === 'lost' ? 'text-[#f3b0b2]' : outcome.kind === 'folded' ? 'text-ink-300' : 'text-gold-300')}>{title}</div>
      {lines.map((l) => (
        <div key={l.id} className="flex gap-2" data-testid={`outcome-${l.id}`}>
          <span className="shrink-0 text-[10px] font-semibold tracking-[0.08em] text-ink-300">{l.label}</span>
          <span className="min-w-0 truncate font-medium">{l.text}</span>
        </div>
      ))}
      {note && (
        <div className="text-ink-200" data-testid="outcome-reason">
          {note}
        </div>
      )}
    </div>
  );
}
