import { Input } from '@jc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFieldSync } from '../lib/fieldSync';
import { useI18n } from '../lib/i18n';

export const EMAIL_DOMAINS = ['naver.com', 'gmail.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'icloud.com', 'outlook.com'] as const;
const CUSTOM = '__custom__';

export interface EmailParts {
  local: string;
  domain: string;
  custom: string;
}
export const NO_EMAIL: EmailParts = { local: '', domain: '', custom: '' };

/** The address the parts make, or '' while incomplete. */
export function emailOf(p: EmailParts): string {
  const d = p.domain === CUSTOM ? p.custom.trim() : p.domain;
  return p.local.trim() && d ? `${p.local.trim()}@${d}` : '';
}

/**
 * Email entry split into a local part and a domain picker (common domains +
 * "direct input"). Reports the combined address, or '' while incomplete.
 * The fields are read from the page (useFieldSync), so an address an in-app browser or password manager filled in
 * without an input event still counts.
 */
export function EmailInput({
  id,
  onChange,
  disabled,
  initial = NO_EMAIL,
}: {
  id: string;
  onChange: (email: string, parts: EmailParts) => void;
  disabled?: boolean;
  initial?: EmailParts;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  // No preselected domain: a default made people sign up with the wrong address.
  const [parts, setParts] = useState<EmailParts>(initial);

  const read = useCallback(() => {
    const el = root.current;
    const localEl = el?.querySelector<HTMLInputElement>('input[name="email-local"]');
    const select = el?.querySelector<HTMLSelectElement>('select[name="email-domain"]');
    if (!localEl || !select) return;
    const customEl = el?.querySelector<HTMLInputElement>('input[name="email-custom"]');
    let local = localEl.value.trim();
    let domain = select.value;
    let custom: string | null = customEl ? customEl.value.trim().toLowerCase() : null;
    // Pasting (or a filled-in) full address splits it into both fields.
    const at = local.indexOf('@');
    if (at >= 0) {
      const d = local.slice(at + 1).toLowerCase();
      local = local.slice(0, at);
      localEl.value = local;
      if ((EMAIL_DOMAINS as readonly string[]).includes(d)) domain = d;
      else {
        domain = CUSTOM;
        custom = d;
        if (customEl) customEl.value = d;
      }
      select.value = domain;
    }
    setParts((p) => {
      const next = { local, domain, custom: custom ?? p.custom };
      return p.local === next.local && p.domain === next.domain && p.custom === next.custom ? p : next;
    });
  }, []);
  useFieldSync(root, read);

  useEffect(() => {
    onChange(emailOf(parts), parts);
  }, [parts, onChange]);

  return (
    <div ref={root} className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          name="email-local"
          defaultValue={initial.local}
          autoComplete="username"
          inputMode="email"
          required
          disabled={disabled}
          aria-label={t('auth.emailLocal')}
          className="min-w-0 flex-1"
        />
        <span className="text-ink-300" aria-hidden>
          @
        </span>
        <select
          name="email-domain"
          defaultValue={initial.domain}
          disabled={disabled}
          aria-label={t('auth.emailDomain')}
          required
          className={`h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-850 px-2 focus:border-gold-500/70 focus:outline-none disabled:opacity-60 ${parts.domain ? 'text-ivory' : 'text-ink-400'}`}
        >
          <option value="" disabled>
            {t('auth.emailSelect')}
          </option>
          {EMAIL_DOMAINS.map((d) => (
            <option key={d} value={d} className="text-ivory">
              {d}
            </option>
          ))}
          <option value={CUSTOM} className="text-ivory">
            {t('auth.emailCustom')}
          </option>
        </select>
      </div>
      {parts.domain === CUSTOM && (
        <Input
          name="email-custom"
          defaultValue={parts.custom}
          placeholder="example.com"
          aria-label={t('auth.emailCustomDomain')}
          required
          autoComplete="off"
          disabled={disabled}
        />
      )}
    </div>
  );
}
