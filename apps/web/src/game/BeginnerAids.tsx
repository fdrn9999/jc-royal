/**
 * Beginner-mode helpers at the multiplayer table. They only read the viewer's
 * own TableView: own hole cards and the revealed board (the server never sends
 * hidden cards, so nothing else is available). No odds, no opponent reads.
 */
import type { MsgKey } from '../lib/i18n';
import type { Side } from '../lib/floating';
import type { TableView } from '@jc/types';
import { cx } from '@jc/ui';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { describeCurrent } from '../academy/content';
import { Floating, type KeepClear } from '../components/Floating';
import { useI18n } from '../lib/i18n';

/** My current hand's name, from my own cards and the board shown (describeCurrent); null folded or without cards. */
function useHandName(s: TableView) {
  const { t, locale } = useI18n();
  const mine = s.seats.find((x) => x.seatIndex === s.you.seatIndex);
  if (!s.hand || !mine?.holeCards || mine.state === 'folded') return null;
  return describeCurrent(mine.holeCards, s.hand.board, locale, t) || null;
}

/**
 * My current hand (the "show my current hand" setting): the starting hand's name before the flop, the made hand after.
 * `compact`: one line (the short screen's column without the beginner aids); `wrap` lets it take a second line rather
 * than cut it (the beginner's band, where the two-line pill has no room). `inline`: the same line at the status line's
 * size under the board (a phone upright, where the stack has no line to spare for it).
 */
export function CurrentHandPill({ s, compact = false, inline = false, wrap = false, className }: { s: TableView; compact?: boolean; inline?: boolean; wrap?: boolean; className?: string }) {
  const { t } = useI18n();
  const name = useHandName(s);
  if (!name) return null;
  if (inline) {
    return (
      <div className={cx('max-w-full truncate rounded-full bg-black/45 px-2 text-[10px] leading-3', className)} title={t('table.currentHandNote')} data-testid="current-hand">
        <span className="text-ink-300">{t('table.currentHand')}</span> <span className="font-bold text-gold-300">{name}</span>{' '}
        <span className="text-ink-400">· {t('table.currentHandTiny')}</span>
      </div>
    );
  }
  if (compact) {
    return (
      <div className={cx('pointer-events-auto max-w-full border border-gold-500/30 bg-ink-950/85 px-3 py-1 text-xs backdrop-blur', wrap ? 'rounded-2xl text-center' : 'truncate rounded-full', className)} title={t('table.currentHandNote')} data-testid="current-hand">
        <span className="text-ink-300">{t('table.currentHand')}</span> <span className="font-bold text-gold-300">{name}</span>{' '}
        <span className="text-[10px] text-ink-400">· {t('table.currentHandTiny')}</span>
      </div>
    );
  }
  return (
    <div className="pointer-events-auto flex max-w-full flex-col items-center rounded-2xl border border-gold-500/30 bg-ink-950/85 px-3 py-1 text-center text-xs backdrop-blur" title={t('table.currentHandNote')} data-testid="current-hand">
      <span>
        <span className="text-ink-300">{t('table.currentHand')}</span> <span className="font-bold text-gold-300">{name}</span>
      </span>
      {/* A made hand is not a win: say so on screen, not only in a tooltip. */}
      <span className="text-[10px] text-ink-400">{t('table.currentHandShort')}</span>
    </div>
  );
}

export function StageNote({ s, className }: { s: TableView; className?: string }) {
  const { t } = useI18n();
  if (!s.hand) return null;
  return (
    <div className={cx('pointer-events-none rounded-full bg-black/50 px-3 py-1 text-center text-[11px] text-ink-100', className)} data-testid="stage-note">
      {t(`stageInfo.${s.hand.stage}` as MsgKey)}
    </div>
  );
}

/**
 * How far a beginner's notes step down to fit the room they are given (`box`, the dock's part for them, of the size the
 * band leaves it): 0 shows them all, each step one less (Table.tsx), up to `most`; past that they scroll in it. Measured
 * again from 0 whenever what they say (`key`) or the room changes, each step before the screen is drawn.
 */
export function useNotesFit(box: HTMLElement | null, most: number, key: string) {
  const [room, setRoom] = useState('');
  const [fit, setFit] = useState({ key: '', step: 0 });
  const at = `${key}|${room}|${most}`;
  const step = fit.key === at ? fit.step : 0;
  useLayoutEffect(() => {
    if (box && step < most && box.scrollHeight > box.clientHeight + 1) setFit({ key: at, step: step + 1 });
  });
  useEffect(() => {
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setRoom(`${box.clientWidth}x${box.clientHeight}`));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  return Math.min(step, most);
}

/** What the guide must not cover while open: the turn's controls never, my seat and cards and the turn's label hardly, the board and the pot little. */
const keepClear = (s: TableView): KeepClear[] => [
  { selector: '[data-testid=action-bar], [data-testid=time-bank], [data-testid=pre-actions]', weight: 100 },
  { selector: `[data-testid="seat-${s.you.seatIndex ?? -1}"], [data-testid=turn-banner]`, weight: 40 },
  { selector: '[data-testid=board], [data-testid=pot]', weight: 3 },
  { selector: '[data-testid=table] [data-testid^="seat-"][data-state]', weight: 1 },
];

/**
 * "You can: …" above the action bar, with a "?" that opens the guide of the moment: the street, my hand and what it does
 * not promise, and what each action open to me does. The guide is a panel of its own over the page (Floating), so the
 * band's fixed height never cuts or hides it, and it never covers the action bar or the time bank. `merged`: where the
 * band has room for one line only, that line is my hand (or the street, without one) and the "?"; the guide still says
 * all of it, on my turn and off it.
 */
export function ActionHelp({
  s,
  merged = false,
  showHand = true,
  area,
  sides = ['top', 'bottom'],
  className,
}: {
  s: TableView;
  merged?: boolean;
  showHand?: boolean;
  area?: RefObject<HTMLElement | null>;
  sides?: Side[];
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const handName = useHandName(s);
  const name = showHand ? handName : null;
  const types = s.you.legal.map((o) => o.type);
  const myTurn = types.length > 0;
  if (!s.hand || (!myTurn && !merged)) return null;
  const canDo = `${t('table.canDo')}: ${types.map((k) => t(`action.${k}` as MsgKey)).join(' · ')}`;
  const title = myTurn ? t('table.actionHelp') : t('table.guide');
  return (
    <div className={cx('pointer-events-auto flex w-full flex-col items-stretch sm:w-[26rem]', className)}>
      <div className="flex items-center justify-between gap-2 rounded-2xl bg-gold-500/15 py-0.5 pl-3 pr-0.5 text-xs" data-testid={merged ? 'beginner-line' : undefined}>
        {/* "Your turn" itself is the turn label's (TurnCue.tsx), shown beside it. */}
        {merged && name ? (
          <span className="min-w-0 py-1" data-testid="current-hand">
            <span className="text-ink-300">{t('table.currentHand')}</span> <span className="font-bold text-gold-300">{name}</span>{' '}
            <span className="text-[10px] text-ink-400">· {t('table.currentHandTiny')}</span>
          </span>
        ) : (
          <span className="min-w-0 py-1 font-bold text-gold-300">{merged && !myTurn ? t(`stageInfo.${s.hand.stage}` as MsgKey) : canDo}</span>
        )}
        <button
          ref={toggle}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={title}
          className={cx('jc-tap grid size-9 shrink-0 place-items-center rounded-full border text-sm font-bold', open ? 'border-gold-400 bg-gold-500/25 text-gold-300' : 'border-white/15 text-ivory')}
          data-testid="action-help-toggle"
        >
          ?
        </button>
      </div>
      {open && (
        <Floating anchor={toggle} area={area} title={title} sides={sides} keepClear={keepClear(s)} onClose={() => setOpen(false)} testId="action-help">
          <div className="flex flex-col gap-2.5 leading-relaxed">
            <p className="text-ink-100">{t(`stageInfo.${s.hand.stage}` as MsgKey)}</p>
            {name && (
              <p>
                <span className="text-ink-300">{t('table.currentHand')}</span> <b className="text-gold-300">{name}</b>
                <span className="block text-[11px] text-ink-400">{t('table.currentHandNote')}</span>
              </p>
            )}
            {myTurn && (
              <ul className="flex flex-col gap-1.5 border-t border-white/10 pt-2.5">
                {types.map((k) => (
                  <li key={k}>
                    <b className="text-gold-300">{t(`action.${k}` as MsgKey)}</b> <span className="text-ink-100">{t(`help.${k}` as MsgKey)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Floating>
      )}
    </div>
  );
}
