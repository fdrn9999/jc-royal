import { Button, Input } from '@jc/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { copyText, shareLink, type ShareData, type ShareResult } from '../lib/share';

/** What a share or copy did, said for a few seconds next to the button (and to screen readers). */
function useOutcome() {
  const [outcome, setOutcome] = useState<ShareResult | null>(null);
  useEffect(() => {
    if (!outcome) return;
    const h = setTimeout(() => setOutcome(null), 2_500);
    return () => clearTimeout(h);
  }, [outcome]);
  return [outcome, setOutcome] as const;
}

function Outcome({ outcome, testId }: { outcome: ShareResult | null; testId?: string }) {
  const { t } = useI18n();
  const text = outcome === 'copied' ? t('share.copied') : outcome === 'shared' ? t('share.shared') : outcome === 'failed' ? t('share.failed') : '';
  return (
    <span role="status" aria-live="polite" className={`text-xs ${outcome === 'failed' ? 'text-[#f3b0b2]' : 'text-gold-300'}`} data-testid={testId}>
      {text}
    </span>
  );
}

/** One button: the system share sheet where there is one, otherwise a copy of the link. */
export function ShareButton({ data, label, children, testId, size = 'sm', variant = 'subtle', className }: { data: ShareData; label: string; children?: ReactNode; testId?: string; size?: 'sm' | 'md' | 'icon'; variant?: 'subtle' | 'outline' | 'ghost'; className?: string }) {
  const [outcome, setOutcome] = useOutcome();
  return (
    <span className="relative inline-flex items-center">
      <Button size={size} variant={variant} className={className} onClick={async () => setOutcome(await shareLink(data))} aria-label={label} data-testid={testId}>
        {children ?? label}
      </Button>
      {outcome && outcome !== 'cancelled' && (
        <span className="absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded-md border border-gold-500/30 bg-ink-950/95 px-2 py-1 shadow-lg">
          <Outcome outcome={outcome} testId={testId ? `${testId}-status` : undefined} />
        </span>
      )}
    </span>
  );
}

/** A link shown in full, with Share and Copy: the table invite in the table settings, the referral link on My page. */
export function LinkShare({ data, label, hint, testId }: { data: ShareData; label: string; hint?: string; testId: string }) {
  const { t } = useI18n();
  const [outcome, setOutcome] = useOutcome();
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="text-xs font-semibold text-ink-300">{label}</div>
      <div className="flex gap-2">
        <Input readOnly value={data.url} className="min-w-0 flex-1 font-mono text-xs" aria-label={label} data-testid={`${testId}-url`} onFocus={(e) => e.target.select()} />
        <Button variant="outline" size="sm" onClick={async () => setOutcome((await copyText(data.url)) ? 'copied' : 'failed')} data-testid={`${testId}-copy`}>
          {t('share.copy')}
        </Button>
        <Button variant="outline" size="sm" onClick={async () => setOutcome(await shareLink(data))} data-testid={`${testId}-share`}>
          {t('share.share')}
        </Button>
      </div>
      <div className="flex min-h-4 flex-wrap items-center gap-x-2">
        {hint && <span className="text-xs text-ink-400">{hint}</span>}
        <Outcome outcome={outcome === 'cancelled' ? null : outcome} testId={`${testId}-status`} />
      </div>
    </div>
  );
}
