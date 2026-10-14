import { PASSWORD_RULES } from '@jc/types';
import { cx, Input } from '@jc/ui';
import { useState, type InputHTMLAttributes } from 'react';
import { useI18n } from '../lib/i18n';

/** Password input with an eye button that shows or hides the value. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={shown ? 'text' : 'password'} className="pr-11" />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? t('auth.hidePassword') : t('auth.showPassword')}
        aria-controls={props.id}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-ink-400 transition hover:text-ivory focus-visible:text-gold-300 focus-visible:outline-none"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
          {shown && <path d="M4 4l16 16" />}
        </svg>
      </button>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  const { t } = useI18n();
  return (
    <li className={cx('flex items-center gap-1.5 transition-colors', ok ? 'text-success' : 'text-ink-400')}>
      <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {ok ? <path d="M3.5 8.5l3 3 6-7" /> : <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />}
      </svg>
      {label}
      <span className="sr-only">{ok ? t('auth.ruleMet') : t('auth.ruleUnmet')}</span>
    </li>
  );
}

/** Live checklist of the password policy: green when met, grey when not. */
export function PasswordRules({ value, id }: { value: string; id?: string }) {
  const { t } = useI18n();
  return (
    <ul id={id} className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
      {PASSWORD_RULES.map((r) => (
        <Check key={r.id} ok={r.test(value)} label={t(`auth.rule.${r.id}`)} />
      ))}
    </ul>
  );
}

/** Single checklist line for the confirmation field. */
export function PasswordMatch({ password, confirm, id }: { password: string; confirm: string; id?: string }) {
  const { t } = useI18n();
  return (
    <ul id={id} className="text-xs">
      <Check ok={confirm !== '' && confirm === password} label={t('auth.passwordMatch')} />
    </ul>
  );
}
