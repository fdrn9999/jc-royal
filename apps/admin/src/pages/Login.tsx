import { Button, Field, Input, Logo } from '@jc/ui';
import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { errText, rawApi, useAdmin } from '../lib';

export function LoginPage() {
  const { t } = useT();
  const { refresh } = useAdmin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await rawApi('/api/admin/auth/login', { body: { email, password } });
      await refresh();
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4" style={{ background: 'var(--t-bg)' }}>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Logo size={72} />
          <div className="font-display text-lg font-bold tracking-[0.3em] jc-gold-text">JC ROYAL</div>
          <div className="text-xs font-semibold text-ink-300">{t('title')}</div>
        </div>
        <form className="jc-panel flex flex-col gap-4 p-6" onSubmit={submit}>
          <Field label={t('email')}>{(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label={t('password')}>{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          {error != null && <p role="alert" className="text-sm text-danger">{errText(error, t)}</p>}
          <Button type="submit" size="lg" loading={busy}>
            {t('login')}
          </Button>
        </form>
      </div>
    </div>
  );
}
