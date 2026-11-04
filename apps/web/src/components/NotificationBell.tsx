import { BellIcon } from '@jc/ui';
import { Suspense, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { lazyPart } from '../lib/lazyPart';

// What the panel lists and its text load on the first opening (components/Inbox.tsx), so the entry chunk carries only
// the button (tests/bundle-check.mjs).
const BellPanel = lazyPart(
  () => import('./Inbox').then((m) => m.BellPanel),
  () => <PanelNote k="common.loadFailed" />,
);

function PanelNote({ k }: { k: 'common.loading' | 'common.loadFailed' }) {
  const { t } = useI18n();
  return <p className="px-3 py-6 text-center text-sm text-ink-400">{t(k)}</p>;
}

/**
 * The header's round icon buttons (mail, bell, settings): a 40 px target for a finger, laid out as the 36 px button they
 * were (32 px below 375 px, where a ten-digit wallet leaves no more room) with their edges in the 8 px gaps beside them,
 * so two never share a spot.
 */
export const iconButton = 'grid size-10 shrink-0 place-items-center rounded-full text-ink-200 hover:text-ivory -mx-0.5 max-[374px]:-mx-1';

/**
 * The header's bell: unread items counted on it (`count`, the counters' `notifications`, drawn by the header's own
 * `badge`), and a panel (not a dialog) of the newest under it; outside it or Escape closes it. The panel hangs from the
 * header's row (AppShell's positioned container), not from the button, so it opens below the header however tall the
 * row is beside the button.
 */
export function NotificationBell({ count, badge }: { count: number; badge: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div ref={box}>
      <button
        ref={btn}
        type="button"
        className={`${iconButton} relative`}
        aria-expanded={open}
        aria-controls={panel}
        aria-label={count ? t('inbox.bellUnread', { n: count }) : t('inbox.title')}
        onClick={() => setOpen((o) => !o)}
        data-testid="bell"
      >
        <BellIcon className="size-5" />
        {badge}
      </button>
      {open && (
        <div
          id={panel}
          className="fixed inset-x-2 top-[4.25rem] z-50 flex max-h-[min(32rem,calc(100dvh-5.5rem))] flex-col overflow-hidden rounded-xl border border-white/10 bg-ink-900 shadow-panel sm:absolute sm:inset-x-auto sm:right-4 sm:top-full sm:mt-1 sm:w-96"
          data-testid="bell-panel"
        >
          <Suspense fallback={<PanelNote k="common.loading" />}>
            <BellPanel count={count} close={close} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
