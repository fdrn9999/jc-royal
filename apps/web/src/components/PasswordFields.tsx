import { PASSWORD_RULES } from '@jc/types';
import { cx, PasswordInput as Field } from '@jc/ui';
import type { ComponentProps } from 'react';
import { useI18n } from '../lib/i18n';

/** Password input with an eye button that shows or hides the value (@jc/ui's, named in the page's language). */
export function PasswordInput(props: Omit<ComponentProps<typeof Field>, 'showLabel' | 'hideLabel'>) {
  const { t } = useI18n();
  return <Field {...props} showLabel={t('auth.showPassword')} hideLabel={t('auth.hidePassword')} />;
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
    <ul id={id} className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
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
