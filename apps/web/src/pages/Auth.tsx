import { NICKNAME_RE, type MeDto } from '@jc/types';
import { Button, Field, Input } from '@jc/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AuthLayout } from '../components/AppShell';
import { EmailInput } from '../components/EmailInput';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

function useAfterLogin() {
  const nav = useNavigate();
  const loc = useLocation();
  const { setMe } = useAuth();
  return (me: MeDto) => {
    setMe(me);
    const to = (loc.state as { from?: string } | null)?.from ?? '/';
    nav(to, { replace: true });
  };
}

export function LoginPage() {
  const { t, err } = useI18n();
  const done = useAfterLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      done(await api<MeDto>('/api/auth/login', { body: { email, password } }));
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
        <Field label={t('auth.password')}>{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
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

export function RegisterPage() {
  const { t, err } = useI18n();
  const done = useAfterLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [nickState, setNickState] = useState<'idle' | 'ok' | 'taken'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!NICKNAME_RE.test(nickname)) return setNickState('idle');
    const h = setTimeout(async () => {
      try {
        const r = await api<{ available: boolean }>(`/api/auth/nickname-available?nickname=${encodeURIComponent(nickname)}`);
        setNickState(r.available ? 'ok' : 'taken');
      } catch {
        setNickState('idle');
      }
    }, 350);
    return () => clearTimeout(h);
  }, [nickname]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      done(await api<MeDto>('/api/auth/register', { body: { email, password, nickname } }));
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(false);
    }
  }
  const nickValid = NICKNAME_RE.test(nickname);
  return (
    <AuthLayout title={t('auth.register')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t('auth.email')}>{(id) => <EmailInput id={id} onChange={setEmail} />}</Field>
        <Field
          label={t('auth.nickname')}
          error={nickState === 'taken' ? t('auth.nicknameTaken') : null}
          hint={nickState === 'ok' ? <span className="text-success">{t('auth.nicknameOk')}</span> : t('auth.nicknameHint')}
        >
          {(id) => <Input id={id} required maxLength={16} value={nickname} onChange={(e) => setNickname(e.target.value.trim())} aria-invalid={nickname !== '' && !nickValid} />}
        </Field>
        <Field label={t('auth.password')} hint={t('auth.passwordHint')}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <p className="text-xs text-gold-300/80">{t('auth.welcomeGrant', { amount: '10,000' })}</p>
        {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#f3b0b2]">{error}</p>}
        <Button type="submit" size="lg" loading={busy} disabled={!email || !nickValid || nickState === 'taken' || password.length < 8}>
          {t('auth.register')}
        </Button>
        <p className="text-center text-sm text-ink-300">
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="text-gold-300 hover:underline">
            {t('nav.login')}
          </Link>
        </p>
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
          <Field label={t('auth.newPassword')} hint={t('auth.passwordHint')}>
            {(id) => <Input id={id} type="password" minLength={8} required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button type="submit" size="lg" loading={busy}>
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
