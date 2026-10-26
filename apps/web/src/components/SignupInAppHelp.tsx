import { Button, cx } from '@jc/ui';
import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { copyText, siteUrl } from '../lib/share';

/**
 * Shown on the sign-up page only when an in-app browser (KakaoTalk, Instagram, …) is having trouble: a way out to the
 * default browser, never forced. The address carries nothing typed on the page (at most the invitation code it was
 * opened with). The browser name only picks which way out to offer; sign-up itself runs the same everywhere.
 */
export function SignupInAppHelp({ path }: { path: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<boolean | null>(null);
  const ua = navigator.userAgent;
  const url = siteUrl(path);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-gold-500/30 bg-gold-500/5 p-3 text-sm" data-testid="signup-inapp">
      <p className="text-ink-100">{t('auth.inApp.note')}</p>
      <div className="flex flex-wrap items-center gap-2">
        {/KAKAOTALK/i.test(ua) && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              window.location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
            }}
            data-testid="signup-inapp-open"
          >
            {t('auth.inApp.openExternal')}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={async () => setCopied(await copyText(url))} data-testid="signup-inapp-copy">
          {t('auth.inApp.copy')}
        </Button>
        <span role="status" aria-live="polite" className={cx('text-xs', copied === false ? 'text-[#f3b0b2]' : 'text-gold-300')}>
          {copied === true ? t('auth.inApp.copied') : copied === false ? t('auth.inApp.copyFailed') : ''}
        </span>
      </div>
      {/Instagram/i.test(ua) && <p className="text-xs text-ink-300">{t('auth.inApp.instagram')}</p>}
    </div>
  );
}
