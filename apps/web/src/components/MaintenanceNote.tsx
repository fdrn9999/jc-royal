import type { MaintenanceDto } from '@jc/types';
import { cx } from '@jc/ui';
import { Link } from 'react-router';
import { useI18n } from '../lib/i18n';
import { when } from '../lib/service';

/** Why the buttons beside it are off: maintenance under way pauses `what` until it ends. */
export function MaintenanceNote({ m, what, className }: { m: MaintenanceDto; what: 'games' | 'posting'; className?: string }) {
  const { t, locale } = useI18n();
  return (
    <p className={cx('rounded-lg border border-gold-500/25 bg-gold-500/10 px-3 py-2 text-sm text-gold-300', className)} role="status" data-testid={`maint-note-${what}`}>
      {t(what === 'games' ? 'maint.games' : 'maint.posting', { end: when(m.endsAt, locale) })}{' '}
      <Link to="/maintenance" className="whitespace-nowrap text-xs font-semibold underline underline-offset-2">
        {t('svc.more')}
      </Link>
    </p>
  );
}