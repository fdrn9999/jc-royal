/**
 * Console building blocks the pages share: the dialog in the console's language, what a list shows besides its rows
 * (first load, nothing found, a failed load with a retry), the result of an action, and a page-by-page pager.
 */
import { Badge, Button, Modal as BaseModal } from '@jc/ui';
import type { ComponentProps, ReactNode } from 'react';
import { useT } from './i18n';

/** A day picked in this device's time zone, as the epoch ms of its midnight (`next`: the midnight after it). */
export function dayStart(v: string | null, next = false): number | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  if (next) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** A post or comment's state in the same colour wherever it is shown: visible, hidden (can be shown again), deleted. */
export function contentTone(status: string): ComponentProps<typeof Badge>['tone'] {
  return status === 'visible' ? 'green' : status === 'hidden' ? 'gold' : 'red';
}

/** The shared dialog with its ✕ button named in the console's language. */
export function Modal(props: Omit<ComponentProps<typeof BaseModal>, 'closeLabel'>) {
  const { t } = useT();
  return <BaseModal {...props} closeLabel={t('closeDialog')} />;
}

/** A failed load, with a retry. The rows already shown (if any) stay under it. */
export function LoadError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#f3b0b2]" data-testid="load-error">
      <span className="min-w-0 flex-1 break-words">{t('loadFailed', { msg: error })}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry} data-testid="retry">{t('retry')}</Button>}
    </div>
  );
}

/**
 * What a list shows when it has no rows to show: still loading the first time, or nothing matched. Rows from an
 * earlier search stay visible (dimmed by the page) while the next one loads.
 */
export function ListState({ loading, empty, children }: { loading: boolean; empty: boolean; children?: ReactNode }) {
  const { t } = useT();
  if (loading && empty) return <p className="py-8 text-center text-sm text-ink-400" aria-live="polite" data-testid="list-loading">{t('loading')}</p>;
  if (empty) return <p className="py-8 text-center text-sm text-ink-400" data-testid="list-empty">{children ?? t('stEmpty')}</p>;
  return null;
}

/** A detail page before its data: loading, or the failed load with a retry (never "loading" for ever). */
export function PageState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const { t } = useT();
  return error ? <LoadError error={error} onRetry={onRetry} /> : <p className="py-8 text-center text-sm text-ink-400" aria-live="polite" data-testid="page-loading">{t('loading')}</p>;
}

/** The result of an action: a success is announced politely, a failure as an alert and in red. */
export type Note = { ok: boolean; text: string } | null;
export function Feedback({ note, testid = 'feedback' }: { note: Note; testid?: string }) {
  if (!note) return null;
  return note.ok ? (
    <p className="break-words rounded-lg border border-gold-500/30 bg-gold-500/5 px-3 py-2 text-sm text-gold-300" role="status" data-testid={testid}>{note.text}</p>
  ) : (
    <p className="break-words rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#f3b0b2]" role="alert" data-testid={testid}>{note.text}</p>
  );
}

/** Previous / next for a list read page by page; `range` says which rows are shown. */
export function Pager({ label, range, prev, next, busy, testid }: { label: string; range: ReactNode; prev: (() => void) | null; next: (() => void) | null; busy: boolean; testid: string }) {
  const { t } = useT();
  return (
    <nav className="mt-3 flex flex-wrap items-center justify-end gap-2" aria-label={label} data-testid={testid}>
      <span className="mr-auto text-xs text-ink-400" aria-live="polite">{range}</span>
      <Button size="sm" variant="outline" disabled={!prev || busy} onClick={prev ?? undefined} data-testid="page-prev">{t('prevPage')}</Button>
      <Button size="sm" variant="outline" disabled={!next || busy} onClick={next ?? undefined} data-testid="page-next">{t('nextPage')}</Button>
    </nav>
  );
}
