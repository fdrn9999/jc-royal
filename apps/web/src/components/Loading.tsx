import { Button, cx, Spinner } from '@jc/ui';
import { ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';

/** A refusal that trying again will not change (gone, not allowed): not found, rather than "try again". */
export const isGone = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;

/** A section that is loading: the spinner, named for screen readers. */
export function Loading({ className = 'py-12' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <div className={cx('flex justify-center text-gold-400', className)}>
      <Spinner label={t('common.loading')} />
    </div>
  );
}

/** A section that could not load: says so, with a way to try again, instead of a spinner that never ends. */
export function LoadFailed({ onRetry, className = 'py-10', testId = 'load-failed' }: { onRetry: () => void; className?: string; testId?: string }) {
  const { t } = useI18n();
  return (
    <div className={cx('flex flex-col items-center gap-3 text-center', className)} role="alert" data-testid={testId}>
      <p className="text-sm text-ink-200">{t('common.loadFailed')}</p>
      <Button size="sm" variant="outline" onClick={onRetry} data-testid={`${testId}-retry`}>
        {t('common.retry')}
      </Button>
    </div>
  );
}
