/**
 * The seated player's time bank on their own turn: what is left, and a button that adds one use to this turn
 * (packages/types/src/timebank.ts). The room keeps the bank and the deadline; this only asks. The request carries the
 * hand's seq and the time already added that this screen shows, so a second tap sent before the first one's result
 * arrived adds nothing, and the button waits for the answer anyway.
 */
import { TIME_BANK_MIN_USE_MS, type TableView } from '@jc/types';
import { cx, HourglassIcon } from '@jc/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';

/** Draw the eye to the button this long before the turn runs out. */
const URGENT_MS = 8_000;

/**
 * `column`: in a short screen's column (short.ts) the pill takes its width and wraps instead of widening it. `turn`: a
 * line shown above the bank's own (the column's turn label, so the column is no taller for it), the pill edged in gold.
 * `fallback`: shown instead when this turn has no bank. `chip`: a cell of the raise panel's presets line (ActionBar's
 * `bank`), as high as a preset: the button, what is left over what it adds.
 */
export function TimeBankButton({
  s,
  onUse,
  column = false,
  turn,
  fallback = null,
  chip = false,
}: {
  s: TableView;
  onUse: (handId: string, seq: number, seen: number) => Promise<void>;
  column?: boolean;
  turn?: ReactNode;
  fallback?: ReactNode;
  chip?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [urgent, setUrgent] = useState(false);
  const hand = s.hand;
  const deadline = hand?.deadline ?? null;
  useEffect(() => {
    setUrgent(false);
    if (!deadline) return;
    const h = setTimeout(() => setUrgent(true), Math.max(0, deadline - URGENT_MS - Date.now()));
    return () => clearTimeout(h);
  }, [deadline]);

  const bank = s.you.timeBank;
  const rules = s.timeBank;
  // A closing table or a maintenance under way plays the hand out at its normal pace (the room refuses it too).
  if (!hand || !bank || !rules || s.status === 'closing' || s.maintenance?.active) return <>{fallback}</>;
  const left = Math.floor(bank.ms / 1000);
  const add = Math.floor(Math.min(rules.unitMs, bank.ms) / 1000);
  const usable = bank.ms >= TIME_BANK_MIN_USE_MS;
  const added = Math.round((hand.extraMs ?? 0) / 1000);

  async function use() {
    if (!hand || !usable || busy) return;
    setBusy(true);
    try {
      await onUse(hand.id, hand.seq, hand.extraMs ?? 0);
    } finally {
      setBusy(false);
    }
  }

  const tone = cx(usable ? 'bg-gold-500 text-ink-950 hover:bg-gold-400 disabled:opacity-60' : 'bg-white/5 text-ink-400', usable && urgent && !busy && 'jc-pulse-gold');
  const aria = usable ? t('timeBank.useAria', { n: add, left }) : t('timeBank.emptyAria');

  if (chip)
    return (
      <div className="flex min-w-0" data-testid="time-bank">
        <button
          type="button"
          className={cx('jc-tap flex h-10 min-w-0 flex-1 flex-col items-center justify-center rounded-lg font-bold leading-tight tabular-nums transition-colors', tone)}
          disabled={!usable || busy}
          onClick={() => void use()}
          aria-label={aria}
          data-testid="time-bank-use"
        >
          <span className="flex items-center gap-0.5 text-[10px] font-semibold">
            <HourglassIcon className="size-3" />
            <span data-testid="time-bank-left">{t('timeBank.seconds', { n: left })}</span>
          </span>
          <span className="text-xs">{usable ? t('timeBank.use', { n: add }) : t('timeBank.empty')}</span>
        </button>
      </div>
    );

  return (
    <div
      className={cx(
        'pointer-events-auto flex items-center border bg-ink-950/85 pl-3 pr-1 text-xs backdrop-blur',
        turn ? 'border-gold-400/60' : 'border-white/10',
        column ? 'flex-wrap gap-x-2 gap-y-1 rounded-2xl' : 'gap-2 rounded-full py-0.5 sm:self-end',
      )}
      data-testid="time-bank"
    >
      <span className="flex min-w-0 flex-col">
        {turn}
        <span className="text-ink-300">
          {t('timeBank.label')} <b className="font-mono text-ivory tabular-nums" data-testid="time-bank-left">{t('timeBank.seconds', { n: left })}</b>
        </span>
      </span>
      {added > 0 && (
        <span className="rounded-full bg-gold-500/15 px-2 py-0.5 font-mono text-[11px] text-gold-300 tabular-nums" data-testid="time-bank-added">
          {t('timeBank.added', { n: added })}
        </span>
      )}
      <button
        type="button"
        className={cx('jc-tap min-h-10 rounded-full px-3.5 font-bold tabular-nums transition-colors', column && 'ml-auto', tone)}
        disabled={!usable || busy}
        onClick={() => void use()}
        aria-label={aria}
        data-testid="time-bank-use"
      >
        {usable ? t('timeBank.use', { n: add }) : t('timeBank.empty')}
      </button>
    </div>
  );
}
