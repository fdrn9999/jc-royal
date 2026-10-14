import { Input } from '@jc/ui';
import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';

export const EMAIL_DOMAINS = ['naver.com', 'gmail.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'icloud.com', 'outlook.com'] as const;
const CUSTOM = '__custom__';

/**
 * Email entry split into a local part and a domain picker (common domains +
 * "direct input"). Reports the combined address, or '' while incomplete.
 */
export function EmailInput({ id, onChange, disabled }: { id: string; onChange: (email: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [local, setLocal] = useState('');
  const [domain, setDomain] = useState<string>(EMAIL_DOMAINS[0]);
  const [custom, setCustom] = useState('');

  useEffect(() => {
    const d = domain === CUSTOM ? custom.trim() : domain;
    onChange(local.trim() && d ? `${local.trim()}@${d}` : '');
  }, [local, domain, custom, onChange]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          value={local}
          // Pasting a full address splits it into both fields.
          onChange={(e) => {
            const v = e.target.value.trim();
            const at = v.indexOf('@');
            if (at >= 0) {
              const d = v.slice(at + 1).toLowerCase();
              setLocal(v.slice(0, at));
              if ((EMAIL_DOMAINS as readonly string[]).includes(d)) setDomain(d);
              else {
                setDomain(CUSTOM);
                setCustom(d);
              }
            } else setLocal(v);
          }}
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
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          disabled={disabled}
          aria-label={t('auth.emailDomain')}
          className="h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-850 px-2 text-ivory focus:border-gold-500/70 focus:outline-none disabled:opacity-60"
        >
          {EMAIL_DOMAINS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
          <option value={CUSTOM}>{t('auth.emailCustom')}</option>
        </select>
      </div>
      {domain === CUSTOM && (
        <Input value={custom} onChange={(e) => setCustom(e.target.value.trim().toLowerCase())} placeholder="example.com" aria-label={t('auth.emailCustomDomain')} required autoComplete="off" disabled={disabled} />
      )}
    </div>
  );
}
