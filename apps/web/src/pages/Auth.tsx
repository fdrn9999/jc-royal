import { ageOn, isoDate, MIN_SIGNUP_AGE, NICKNAME_RE, normalizeReferralCode, passwordOk, type MeDto, type SignupOptionsDto } from '@jc/types';
import { Button, Field, Input } from '@jc/ui';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AuthLayout } from '../components/AppShell';
import { EmailVerify } from '../components/EmailVerify';
import { PasswordInput, PasswordMatch, PasswordRules } from '../components/PasswordFields';
import { NO_AGREEMENTS, SignupConsent, type Agreements } from '../components/SignupConsent';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { lazyPart } from '../lib/lazyPart';

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

// The referral code field and its text load on their own chunk, so the entry chunk stays within its budget.
// A code from an invitation link is still sent if the field will not load (lazyPart): only the box to change it is missing.
const ReferralField = lazyPart(() => import('../components/ReferralField').then((m) => m.ReferralField));

export function RegisterPage() {
  const { t, err, locale } = useI18n();
  const done = useAfterLogin();
  const [params] = useSearchParams();
  // A shared link (/register?ref=JC…) fills the code; the member may clear or change it.
  const [linkCode] = useState(() => normalizeReferralCode(params.get('ref') ?? '').slice(0, 40));
  const [referralCode, setReferralCode] = useState(linkCode);
  const [options, setOptions] = useState<SignupOptionsDto | null>(null);
  const [email, setEmail] = useState('');
  const [verificationToken, setVerificationToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [nickname, setNickname] = useState('');
  const [nickState, setNickState] = useState<'idle' | 'ok' | 'taken'>('idle');
  const [birthDate, setBirthDate] = useState('');
  const [agreements, setAgreements] = useState<Agreements>(NO_AGREEMENTS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SignupOptionsDto>('/api/auth/signup-options')
      .then(setOptions)
      .catch(() => setOptions({ emailVerification: false, privacyNoticeVersion: '' }));
  }, []);

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

  const onEmail = useCallback((v: { email: string; token: string | null }) => {
    setEmail(v.email);
    setVerificationToken(v.token);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      done(
        await api<MeDto>('/api/auth/register', {
          body: { email, password, nickname, birthDate, locale, agreements: { age14: true, privacy: true },
            pushConsent: { service: agreements.pushService, night: agreements.pushService && agreements.pushNight },
            emailVerificationToken: verificationToken ?? undefined, referralCode: referralCode || undefined },
        }),
      );
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(false);
    }
  }
  const today = isoDate();
  const nickValid = NICKNAME_RE.test(nickname);
  const birthValid = /^\d{4}-\d{2}-\d{2}$/.test(birthDate) && birthDate >= '1900-01-01' && birthDate <= today;
  const underage = birthValid && ageOn(birthDate, today) < MIN_SIGNUP_AGE;
  const needVerify = options?.emailVerification ?? true;
  const verified = !needVerify || verificationToken !== null;
  const canSubmit =
    options !== null && !!email && verified && nickValid && nickState !== 'taken' && birthValid && !underage && passwordOk(password) && confirm === password && agreements.age14 && agreements.privacy;
  return (
    <AuthLayout title={t('auth.register')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t('auth.email')}>{(id) => (options ? <EmailVerify id={id} required={options.emailVerification} onChange={onEmail} /> : <Input id={id} disabled />)}</Field>
        <Field
          label={t('auth.nickname')}
          error={nickState === 'taken' ? t('auth.nicknameTaken') : null}
          hint={nickState === 'ok' ? <span className="text-success">{t('auth.nicknameOk')}</span> : t('auth.nicknameHint')}
        >
          {(id) => <Input id={id} required maxLength={16} value={nickname} onChange={(e) => setNickname(e.target.value.trim())} aria-invalid={nickname !== '' && !nickValid} />}
        </Field>
        <Field label={t('auth.birthDate')} error={underage ? t('auth.underage') : null} hint={t('auth.birthDateHint')}>
          {(id) => (
            <Input id={id} type="date" required min="1900-01-01" max={today} autoComplete="bday" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} aria-invalid={underage} />
          )}
        </Field>
        <Field label={t('auth.password')}>
          {(id) => (
            <div className="flex flex-col gap-2">
              <PasswordInput id={id} autoComplete="new-password" required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={`${id}-rules`} />
              <PasswordRules id={`${id}-rules`} value={password} />
            </div>
          )}
        </Field>
        <Field label={t('auth.passwordConfirm')}>
          {(id) => (
            <div className="flex flex-col gap-2">
              <PasswordInput id={id} autoComplete="new-password" required maxLength={128} value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-describedby={`${id}-match`} />
              <PasswordMatch id={`${id}-match`} password={password} confirm={confirm} />
            </div>
          )}
        </Field>
        <Suspense fallback={null}>
          <ReferralField value={referralCode} onChange={setReferralCode} fromLink={!!linkCode && referralCode === linkCode} />
        </Suspense>
        <SignupConsent value={agreements} onChange={setAgreements} />
        <p className="text-xs text-gold-300/80">{t('auth.welcomeGrant', { amount: '10,000' })}</p>
        {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#f3b0b2]">{error}</p>}
        {email && !verified && <p className="text-center text-xs text-ink-400">{t('auth.verifyNeeded')}</p>}
        <Button type="submit" size="lg" loading={busy} disabled={!canSubmit}>
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
