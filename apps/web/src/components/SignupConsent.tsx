import { cx } from '@jc/ui';
import { useId, useState } from 'react';
import { PRIVACY_NOTICE } from '../legal/privacyNotice';
import { useI18n } from '../lib/i18n';

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
  const notice = PRIVACY_NOTICE[locale];
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
            <p className="font-semibold text-ivory">{notice.title}</p>
            <p className="mt-2">{notice.intro}</p>
            {notice.sections.map((s) => (
              <section key={s.heading} className="mt-3">
                <h4 className="font-semibold text-ink-100">{s.heading}</h4>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {s.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </section>
            ))}
            <p className="mt-3 text-ink-400">{notice.effective}</p>
          </div>
        )}
      </div>
    </fieldset>
  );
}
