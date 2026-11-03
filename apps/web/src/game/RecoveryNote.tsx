/**
 * The connection's recovery step (recovery.ts) in the table's header, over the table's name: a place every screen has
 * that holds neither the game nor a control (the name steps aside meanwhile), so the note neither moves the table nor
 * covers any of it, and leaves no trace when it goes (table-stable.spec). Over the table it pushed the table down as a
 * line of its own, or covered the top seat or the turn's band on a phone, which have no room to spare.
 *
 * The header's name place is its container: wide enough, the whole sentence (two lines at most); else a word or two and
 * what follows from it, the sentence kept for screen readers, and on the narrowest phone (320px) without the icon, which
 * would leave the words no room. While it retries, a tap on it retries at once.
 */
import { CheckIcon, cx, RefreshCwIcon, TriangleAlertIcon, WifiOffIcon } from '@jc/ui';
import { useI18n } from '../lib/i18n';
import type { Recovery } from './recovery';
import { recoveryBrief, recoveryText } from './recoveryText';

const ICONS = { offline: WifiOffIcon, reconnecting: WifiOffIcon, failed: TriangleAlertIcon, syncing: RefreshCwIcon, restoring: RefreshCwIcon, restored: CheckIcon };

export function RecoveryNote({ recovery, onRetry }: { recovery: Recovery; onRetry?: () => void }) {
  const { t, locale } = useI18n();
  const [head, then] = recoveryBrief(locale)(recovery);
  const Icon = ICONS[recovery];
  const pill = cx(
    'pointer-events-auto flex h-full max-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-gold-500/35 bg-ink-900 px-2 text-left text-gold-300 shadow-lg @max-[6rem]:px-1.5 @md:gap-2 @md:px-3',
    // A short screen's header is 44px with its border, the note a pixel less: a finger has 44px of it at least, the rest
    // of the header's height around it.
    onRetry && "jc-tap relative hover:bg-ink-800 before:absolute before:inset-x-0 before:inset-y-[min(0px,calc((100%_-_44px)/2))] before:content-['']",
  );
  const body = (
    <>
      <Icon className="size-4 shrink-0 @max-[6rem]:hidden" />
      <span className="flex min-w-0 flex-col leading-tight @md:hidden" aria-hidden>
        <span className="truncate text-[11px] font-semibold">{head}</span>
        {then && <span className="truncate text-[10px] text-gold-300/80">{then}</span>}
      </span>
      <span className="sr-only @md:not-sr-only @md:min-w-0">
        <span className="line-clamp-2 text-xs leading-4">{recoveryText(locale)(recovery)}</span>
      </span>
      {onRetry && <span className="hidden shrink-0 rounded-full border border-gold-500/40 px-3 py-1 text-xs font-semibold @md:inline">{t('table.reconnectNow')}</span>}
    </>
  );
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center" role="status" data-testid="table-banner" data-recovery={recovery}>
      {onRetry ? (
        <button type="button" className={pill} onClick={onRetry} data-testid="reconnect-now">
          {body}
          <span className="sr-only @md:hidden">{t('table.reconnectNow')}</span>
        </button>
      ) : (
        <div className={pill}>{body}</div>
      )}
    </div>
  );
}
