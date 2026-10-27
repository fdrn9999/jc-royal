import { passwordOk, type MeDto } from '@jc/types';
import { Button, Field, Input } from '@jc/ui';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AuthLayout } from '../components/AppShell';
import { PasswordInput, PasswordMatch, PasswordRules } from '../components/PasswordFields';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

export function useAfterLogin() {
  const nav = useNavigate();
  const loc = useLocation();
  const { setMe } = useAuth();
  return (me: MeDto) => {
    setMe(me);
    const to = (loc.state as { from?: string } | null)?.from ?? '/';
    nav(to, { replace: true });
  };
}

/** The last "자동 로그인" choice on this device, so the box comes back as the member left it. */
const REMEMBER_KEY = 'jc.remember';

export function LoginPage() {
  const { t, err } = useI18n();
  const done = useAfterLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => {
    try {
      return localStorage.getItem(REMEMBER_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api<MeDto>('/api/auth/login', { body: { email, password, remember } });
      try {
        localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
      } catch {
        /* the choice is only a convenience for next time */
      }
      done(me);
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout title={t('auth.login')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t('auth.email')}>{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label={t('auth.password')}>{(id) => <PasswordInput id={id} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink-100">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-5 shrink-0 accent-[var(--color-gold-500)]" data-testid="login-remember" />
          <span>
            {t('auth.remember')}
            <span className="block text-xs text-ink-400">{t('auth.rememberHint')}</span>
          </span>
        </label>
        {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#f3b0b2]">{error}</p>}
        <Button type="submit" size="lg" loading={busy}>
          {t('auth.login')}
        </Button>
        <div className="flex items-center justify-between text-sm">
          <Link to="/register" className="text-gold-300 hover:underline">
            {t('nav.register')}
          </Link>
          <Link to="/reset" className="text-ink-300 hover:text-ivory">
            {t('auth.forgot')}
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}

export function ResetPage() {
  const { t, err } = useI18n();
  const [params] = useSearchParams();
  const token = params.get('token');
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function request(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ok: true; devToken?: string }>('/api/auth/password-reset/request', { body: { email } });
      setMsg(t('auth.resetSent'));
      setDevToken(r.devToken ?? null);
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(false);
    }
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/password-reset/confirm', { body: { token, newPassword: password } });
      nav('/login', { replace: true, state: { notice: t('auth.resetDone') } });
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout title={t('auth.reset')}>
      {token ? (
        <form className="flex flex-col gap-4" onSubmit={confirm}>
          <Field label={t('auth.newPassword')}>
            {(id) => (
              <div className="flex flex-col gap-2">
                <PasswordInput id={id} required maxLength={128} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={`${id}-rules`} />
                <PasswordRules id={`${id}-rules`} value={password} />
              </div>
            )}
          </Field>
          <Field label={t('auth.passwordConfirm')}>
            {(id) => (
              <div className="flex flex-col gap-2">
                <PasswordInput id={id} required maxLength={128} autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} aria-describedby={`${id}-match`} />
                <PasswordMatch id={`${id}-match`} password={password} confirm={confirmPw} />
              </div>
            )}
          </Field>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button type="submit" size="lg" loading={busy} disabled={!passwordOk(password) || confirmPw !== password}>
            {t('common.save')}
          </Button>
        </form>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={request}>
          <Field label={t('auth.email')}>{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          {msg && <p className="text-sm text-ink-200">{msg}</p>}
          {devToken && (
            <p className="rounded-lg border border-gold-500/30 bg-gold-500/5 px-3 py-2 text-xs text-gold-300">
              {t('auth.resetDevToken')}{' '}
              <Link className="underline" to={`/reset?token=${encodeURIComponent(devToken)}`}>
                /reset?token=…
              </Link>
            </p>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button type="submit" size="lg" loading={busy}>
            {t('auth.resetRequest')}
          </Button>
          <Link to="/login" className="text-center text-sm text-ink-300 hover:text-ivory">
            {t('nav.login')}
          </Link>
        </form>
      )}
    </AuthLayout>
  );
}
