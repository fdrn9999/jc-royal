import { Button, cx, PlayingCard, RabbitIcon, Spinner, XIcon } from '@jc/ui';
import { useEffect } from 'react';
import { useI18n } from '../lib/i18n';
import { RABBIT_SHOW_MS, type RabbitHunt } from './rabbitHunt';

/**
 * The rabbit hunt of the hand before, once the table has moved on from it (useTableSocket `rabbitHunt.late`): a small
 * panel of its own beside the game. That hand's board and the cards that would have come are drawn here and nowhere
 * else, so they are never taken for the board of the hand played now. It says where the request stands (still asked,
 * failed on the way, too late), and closes by itself or with its button; the game never waits for it.
 * Two lines at most, one of them the cards: it has to fit in what the dock leaves free over its buttons (Table.tsx).
 * In the dock's narrow column (`narrow`: a phone on its side) the cards go to a line of their own, under the name and
 * the button that closes it, instead of out of it.
 */
export function RabbitPanel({ hunt, onRetry, onClose, narrow = false, className }: { hunt: RabbitHunt; onRetry: () => void; onClose: () => void; narrow?: boolean; className?: string }) {
  const { t } = useI18n();
  const { phase, at } = hunt;
  useEffect(() => {
    if (phase === 'requesting') return;
    const h = setTimeout(onClose, Math.max(0, at + RABBIT_SHOW_MS[phase] - Date.now()));
    return () => clearTimeout(h);
  }, [phase, at, onClose]);
  const mini = '1.25rem';
  const said = phase === 'success' ? t('table.rabbitNote') : phase === 'error' ? t('table.rabbitFailed') : phase === 'expired' ? t('table.rabbitExpired') : null;
  return (
    <div
      className={cx('pointer-events-auto flex max-w-full flex-col rounded-xl border border-dashed border-gold-400/60 bg-ink-950/95 py-1 pl-2.5 pr-1 text-xs text-ink-200 shadow-lg', className)}
      role="status"
      aria-label={t('table.rabbit')}
      data-testid="rabbit-panel"
      data-phase={phase}
      data-hand={hunt.handNumber}
    >
      <div className="flex min-h-8 flex-wrap items-center gap-x-1.5">
        <RabbitIcon className="size-4 shrink-0 text-gold-300" />
        <span className="shrink-0 font-semibold tabular-nums text-gold-300" data-testid="rabbit-panel-hand">
          {t('table.rabbitPrev', { n: hunt.handNumber })}
        </span>
        {phase === 'requesting' && (
          <span className="flex items-center gap-1.5 text-ink-200">
            <Spinner className="size-3.5" />
            {t('table.rabbitAsking')}
          </span>
        )}
        {phase === 'success' && hunt.cards && (
          <div className={cx('flex items-center gap-[3px] pl-0.5', narrow && 'order-last basis-full pb-1')} data-testid="rabbit-panel-cards">
            {hunt.board.map((c) => (
              <PlayingCard key={c} card={c} size={mini} dim />
            ))}
            {hunt.cards.map((c) => (
              <div key={c} className="rounded-[calc(var(--card-size)*0.12)] outline-1 outline-dashed outline-gold-400/80" style={{ ['--card-size' as string]: mini }} data-testid="rabbit-panel-card" data-card={c}>
                <PlayingCard card={c} size={mini} />
              </div>
            ))}
          </div>
        )}
        {phase === 'error' && (
          <Button size="sm" variant="outline" className="min-h-8 px-2.5" onClick={onRetry} data-testid="rabbit-panel-retry">
            {t('table.rabbitRetry')}
          </Button>
        )}
        <button type="button" className="jc-tap ml-auto grid size-8 shrink-0 place-items-center rounded-lg text-ink-300 hover:text-ivory" onClick={onClose} aria-label={t('common.close')} data-testid="rabbit-panel-close">
          <XIcon className="size-4" />
        </button>
      </div>
      {said && <div className={cx('pr-1.5 text-[11px] leading-tight', phase === 'error' ? 'text-[#f3b0b2]' : 'text-ink-300')}>{said}</div>}
    </div>
  );
}
