import { cx } from '@jc/ui';
import { useEffect, useId, useState } from 'react';
import type { PrivacyNotice } from '../legal/privacyNotice';
import { useI18n } from '../lib/i18n';

// The notice text is long and only read when opened, so it stays out of the first bundle.
let notices: Promise<Record<'ko' | 'en', PrivacyNotice>> | null = null;
const loadNotices = () => (notices ??= import('../legal/privacyNotice').then((m) => m.PRIVACY_NOTICE).catch((e: unknown) => ((notices = null), Promise.reject(e))));

export interface Agreements {
  age14: boolean;
  privacy: boolean;
}

const box = 'size-[18px] shrink-0 cursor-pointer accent-gold-500';

function Required() {
  const { t } = useI18n();
  return <span className="mr-1 font-semibold text-gold-300">[{t('consent.required')}]</span>;
}

/** Sign-up agreements: "agree to all", 14+ confirmation and the privacy notice (expandable). */
export function SignupConsent({ value, onChange }: { value: Agreements; onChange: (v: Agreements) => void }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const noticeId = useId();
  const all = value.age14 && value.privacy;
  const [notice, setNotice] = useState<Record<'ko' | 'en', PrivacyNotice> | 'error' | null>(null);
  useEffect(() => {
    if (!open || (notice && notice !== 'error')) return;
    let gone = false;
    loadNotices().then(
      (n) => !gone && setNotice(n),
      () => !gone && setNotice('error'),
    );
    return () => {
      gone = true;
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = notice && notice !== 'error' ? notice[locale] : null;
  return (
    <fieldset className="break-keep rounded-xl border border-white/10 bg-ink-900/60">
      <legend className="sr-only">{t('consent.title')}</legend>
      <label className="flex cursor-pointer items-start gap-3 border-b border-white/10 px-4 py-3.5">
        <input type="checkbox" className={cx(box, 'mt-0.5')} checked={all} onChange={(e) => onChange({ age14: e.target.checked, privacy: e.target.checked })} />
        <span>
          <span className="block text-sm font-semibold text-ivory">{t('consent.all')}</span>
          <span className="mt-0.5 block text-xs text-ink-400">{t('consent.allHint')}</span>
        </span>
      </label>
      <div className="flex flex-col gap-1 px-4 py-3">
        <label className="flex cursor-pointer items-center gap-3 py-1.5 text-sm text-ink-200">
          <input type="checkbox" className={box} checked={value.age14} onChange={(e) => onChange({ ...value, age14: e.target.checked })} />
          <span>
            <Required />
            {t('consent.age14')}
          </span>
        </label>
        <div className="flex items-center gap-3 py-1.5">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm text-ink-200">
            <input type="checkbox" className={box} checked={value.privacy} onChange={(e) => onChange({ ...value, privacy: e.target.checked })} />
            <span>
              <Required />
              {t('consent.privacy')}
            </span>
          </label>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={noticeId}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-ink-300 underline-offset-2 hover:text-gold-300 hover:underline focus-visible:text-gold-300 focus-visible:outline-none"
          >
            {open ? t('consent.hide') : t('consent.view')}
          </button>
        </div>
        {open && (
          <div id={noticeId} tabIndex={0} className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-ink-950/70 px-3.5 py-3 text-xs leading-relaxed text-ink-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500/30">
            {text ? (
              <>
                <p className="font-semibold text-ivory">{text.title}</p>
                <p className="mt-2">{text.intro}</p>
                {text.sections.map((s) => (
                  <section key={s.heading} className="mt-3">
                    <h4 className="font-semibold text-ink-100">{s.heading}</h4>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {s.items.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  </section>
                ))}
                <p className="mt-3 text-ink-400">{text.effective}</p>
              </>
            ) : (
              // Loading, or it failed (offline): the full policy page below still has it.
              <p role="status">{t(notice === 'error' ? 'common.error' : 'common.loading')}</p>
            )}
            <a href="/privacy" target="_blank" rel="noopener" className="mt-1 inline-block font-semibold text-gold-300 underline-offset-2 hover:underline" data-testid="consent-policy-link">
              {t('consent.fullPolicy')}
            </a>
          </div>
        )}
        <p className="pt-1 text-xs text-ink-400">
          <a href="/terms" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-gold-300" data-testid="consent-terms-link">
            {t('consent.termsLink')}
          </a>
          {' · '}
          <a href="/privacy" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-gold-300">
            {t('legal.privacy')}
          </a>
        </p>
      </div>
    </fieldset>
  );
}
