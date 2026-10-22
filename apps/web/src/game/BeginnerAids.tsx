/**
 * Beginner-mode helpers at the multiplayer table. They only read the viewer's
 * own TableView: own hole cards and the revealed board (the server never sends
 * hidden cards, so nothing else is available). No odds, no opponent reads.
 */
import type { MsgKey } from '../lib/i18n';
import type { TableView } from '@jc/types';
import { cx } from '@jc/ui';
import { useState } from 'react';
import { describeCurrent } from '../academy/content';
import { useI18n } from '../lib/i18n';

/**
 * My current hand (the "show my current hand" setting): the starting hand's name before the flop, the made hand after,
 * from my own cards and the board shown (describeCurrent). `compact`, without the beginner aids: one line. `inline`: the
 * same line at the status line's size under the board (a phone upright, where the stack has no line to spare for it).
 */
export function CurrentHandPill({ s, compact = false, inline = false, className }: { s: TableView; compact?: boolean; inline?: boolean; className?: string }) {
  const { t, locale } = useI18n();
  const mine = s.seats.find((x) => x.seatIndex === s.you.seatIndex);
  const hand = s.hand;
  if (!hand || !mine?.holeCards || mine.state === 'folded') return null;
  const name = describeCurrent(mine.holeCards, hand.board, locale, t);
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
      <div className={cx('pointer-events-auto max-w-full truncate rounded-full border border-gold-500/30 bg-ink-950/85 px-3 py-1 text-xs backdrop-blur', className)} title={t('table.currentHandNote')} data-testid="current-hand">
        <span className="text-ink-300">{t('table.currentHand')}</span> <span className="font-bold text-gold-300">{name}</span>{' '}
        <span className="text-[10px] text-ink-400">· {t('table.currentHandTiny')}</span>
      </div>
    );
  }
  return (
    <div className="pointer-events-auto flex max-w-full flex-col items-center rounded-2xl border border-gold-500/30 bg-ink-950/85 px-3 py-1 text-xs backdrop-blur" title={t('table.currentHandNote')} data-testid="current-hand">
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
 * "You can: …" line plus a toggleable help panel; sits above the action bar, never over its buttons. The panel scrolls
 * past a few lines, so it fits the band the table's dock keeps for a beginner's notes (Table.tsx).
 */
export function ActionHelp({ s, className }: { s: TableView; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const types = s.you.legal.map((o) => o.type);
  if (types.length === 0) return null;
  return (
    <div className={cx('pointer-events-auto flex w-full flex-col items-stretch gap-1.5 sm:w-[26rem]', className)}>
      {open && (
        <ul className="jc-panel flex max-h-24 flex-col gap-1 overflow-y-auto p-3 text-xs" data-testid="action-help">
          {types.map((k) => (
            <li key={k}>
              <b className="text-gold-300">{t(`action.${k}` as MsgKey)}</b> <span className="text-ink-100">{t(`help.${k}` as MsgKey)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2 rounded-full bg-gold-500/15 py-1 pl-3 pr-1 text-xs">
        {/* "Your turn" itself is the turn label's (TurnCue.tsx), shown beside it. */}
        <span className="min-w-0 truncate font-bold text-gold-300">
          {t('table.canDo')}: {types.map((k) => t(`action.${k}` as MsgKey)).join(' · ')}
        </span>
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={t('table.actionHelp')} className={cx('jc-tap grid size-9 shrink-0 place-items-center rounded-full border text-sm font-bold', open ? 'border-gold-400 bg-gold-500/25 text-gold-300' : 'border-white/15 text-ivory')} data-testid="action-help-toggle">
          ?
        </button>
      </div>
    </div>
  );
}
