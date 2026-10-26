import { isoDate, NICKNAME_RE, normalizeReferralCode, passwordOk, type MeDto, type SignupOptionsDto } from '@jc/types';
import { Button, cx, Field, Input } from '@jc/ui';
import { Suspense, useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AuthLayout } from '../components/AppShell';
import { EmailVerify } from '../components/EmailVerify';
import { PasswordInput, PasswordMatch, PasswordRules } from '../components/PasswordFields';
import { NO_AGREEMENTS, SignupConsent, type Agreements } from '../components/SignupConsent';
import { SignupInAppHelp } from '../components/SignupInAppHelp';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFieldSync } from '../lib/fieldSync';
import { useI18n } from '../lib/i18n';
import { platformOf } from '../lib/install';
import { lazyPart } from '../lib/lazyPart';
import {
  clearDraft,
  dateInputSupported,
  formatBirthTyping,
  loadDraft,
  normalizeBirthDate,
  saveDraft,
  signupValidation,
  type NickCheck,
  type SignupBlock,
  type SignupPolicy,
} from '../lib/signup';

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

type SignupFields = { nickname: string; birthDate: string; password: string; confirm: string };
const sameFields = (a: SignupFields, b: SignupFields) => a.nickname === b.nickname && a.birthDate === b.birthDate && a.password === b.password && a.confirm === b.confirm;

/** Where pressing sign-up with something missing moves the focus. */
const FOCUS: Partial<Record<SignupBlock, string>> = {
  policyFailed: '[data-signup-focus="policy"]',
  email: '[name="email-local"]',
  emailVerify: '[data-signup-focus="emailVerify"]',
  nickname: '[name="nickname"]',
  nicknameTaken: '[name="nickname"]',
  nicknameError: '[name="nickname"]',
  birthDate: '[name="birthDate"]',
  underage: '[name="birthDate"]',
  password: '[name="password"]',
  passwordMatch: '[name="confirm"]',
  consent: '[name="agree-all"]',
};

/**
 * Sign-up. The text fields are uncontrolled and read from the page (useFieldSync), not only from React's change events:
 * in in-app browsers (KakaoTalk, Instagram, other WebViews) a value can arrive without the event a controlled input
 * needs — autofill that sets the value, a date picker that only blurs — and the button then never came on, the field
 * even emptied by the next render. The button only looks unavailable (aria-disabled) until every rule holds: pressing it
 * reads the fields once more and either signs up or shows what is still missing. The line above it names the first
 * missing thing (lib/signup), and the server checks every rule again.
 */
export function RegisterPage() {
  const { t, err, locale } = useI18n();
  const done = useAfterLogin();
  const [params] = useSearchParams();
  // A shared link (/register?ref=JC…) fills the code; the member may clear or change it.
  const [linkCode] = useState(() => normalizeReferralCode(params.get('ref') ?? '').slice(0, 40));
  const [referralCode, setReferralCode] = useState(linkCode);
  // What this tab had typed before a reload (in-app browsers may reload the page on the way back from the mail app).
  const [draft] = useState(loadDraft);
  const [dateInput] = useState(dateInputSupported);
  const [inApp] = useState(() => platformOf(navigator.userAgent, navigator.maxTouchPoints ?? 0).startsWith('in-app'));
  const [policy, setPolicy] = useState<SignupPolicy>('loading');
  const [email, setEmail] = useState('');
  const [verificationToken, setVerificationToken] = useState<string | null>(null);
  const [verifyReset, setVerifyReset] = useState(0);
  const [fields, setFields] = useState<SignupFields>(() => ({ nickname: (draft.nickname ?? '').trim(), birthDate: normalizeBirthDate(draft.birthDate ?? ''), password: '', confirm: '' }));
  const [nick, setNick] = useState<{ value: string; check: NickCheck }>({ value: '', check: 'idle' });
  const [nickRetry, setNickRetry] = useState(0);
  const [agreements, setAgreements] = useState<Agreements>(NO_AGREEMENTS);
  const [touched, setTouched] = useState<Record<string, true>>({});
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const whyId = useId();

  // A policy that could not be read is never taken as "no verification": the email step waits, with a way to retry.
  const loadPolicy = useCallback(() => {
    setPolicy((p) => (p === 'failed' ? 'loading' : p));
    api<SignupOptionsDto>('/api/auth/signup-options').then(
      (o) => setPolicy({ emailVerification: o.emailVerification }),
      () => setPolicy((p) => (typeof p === 'object' ? p : 'failed')),
    );
  }, []);
  useEffect(loadPolicy, [loadPolicy]);
  useEffect(() => {
    if (policy !== 'failed') return;
    const again = () => document.visibilityState === 'visible' && loadPolicy();
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [policy, loadPolicy]);

  const read = useCallback((): SignupFields | null => {
    const f = form.current;
    if (!f) return null;
    const val = (name: string) => {
      const el = f.elements.namedItem(name);
      return el instanceof HTMLInputElement ? el.value : '';
    };
    const next = { nickname: val('nickname').trim(), birthDate: normalizeBirthDate(val('birthDate')), password: val('password'), confirm: val('confirm') };
    setFields((p) => (sameFields(p, next) ? p : next));
    return next;
  }, []);
  useFieldSync(form, read);

  useEffect(() => {
    saveDraft({ nickname: fields.nickname || undefined, birthDate: fields.birthDate || undefined });
  }, [fields.nickname, fields.birthDate]);

  // Each answer is tied to the nickname it was asked about, so a late answer for an earlier spelling never shows.
  useEffect(() => {
    const name = fields.nickname;
    if (!NICKNAME_RE.test(name)) return;
    const ctl = new AbortController();
    const h = setTimeout(() => {
      api<{ available: boolean }>(`/api/auth/nickname-available?nickname=${encodeURIComponent(name)}`, { signal: ctl.signal }).then(
        (r) => !ctl.signal.aborted && setNick({ value: name, check: r.available ? 'ok' : 'taken' }),
        () => !ctl.signal.aborted && setNick({ value: name, check: 'error' }),
      );
    }, 350);
    return () => {
      clearTimeout(h);
      ctl.abort();
    };
  }, [fields.nickname, nickRetry]);
  const checkOf = (name: string): NickCheck => (!NICKNAME_RE.test(name) ? 'idle' : nick.value === name ? nick.check : 'checking');

  const onEmail = useCallback((v: { email: string; token: string | null }) => {
    setEmail(v.email);
    setVerificationToken(v.token);
  }, []);

  const today = isoDate();
  const validate = (f: SignupFields) =>
    signupValidation({
      policy,
      email,
      verificationToken,
      nickname: f.nickname,
      nickCheck: checkOf(f.nickname),
      birthDate: f.birthDate,
      password: f.password,
      confirm: f.confirm,
      age14: agreements.age14,
      privacy: agreements.privacy,
      today,
    });
  const v = validate(fields);
  const block = v.blocks[0] ?? null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sending.current) return;
    const f = read() ?? fields;
    const now = validate(f);
    if (!now.ready) {
      setAttempted(true);
      const sel = now.blocks[0] && FOCUS[now.blocks[0]];
      if (sel) form.current?.querySelector<HTMLElement>(sel)?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const me = await api<MeDto>('/api/auth/register', {
        body: { email, password: f.password, nickname: f.nickname, birthDate: f.birthDate, locale, agreements: { age14: true, privacy: true },
          pushConsent: { service: agreements.pushService, night: agreements.pushService && agreements.pushNight },
          emailVerificationToken: verificationToken ?? undefined, referralCode: referralCode || undefined },
      });
      clearDraft();
      done(me);
    } catch (x) {
      const code = x instanceof ApiError ? x.code : null;
      if (code === 'nickname_taken') setNick({ value: f.nickname, check: 'taken' });
      // The proof expired or was already used: the code step starts over instead of failing the same way again.
      if (code === 'email_not_verified') setVerifyReset((n) => n + 1);
      setError(err(code));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const nickCheck = checkOf(fields.nickname);
  const nickBad = fields.nickname !== '' && !v.nicknameValid;
  const birthBad = !v.birthDateValid && (attempted || (!!touched.birthDate && fields.birthDate !== ''));
  const underage = v.birthDateValid && !v.ageValid;
  // Typed dates (no picker offered): hyphens go in as the digits are typed at the end of the box.
  const formatBirth = (e: FormEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (!(e.nativeEvent as InputEvent).inputType?.startsWith('insert') || el.selectionStart !== el.value.length) return;
    const f = formatBirthTyping(el.value);
    if (f !== el.value) el.value = f;
  };
  return (
    <AuthLayout title={t('auth.register')}>
      <form
        ref={form}
        className="flex flex-col gap-4"
        onSubmit={submit}
        noValidate
        onBlur={(e) => {
          const n = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement ? e.target.name : '';
          if (n && !touched[n]) setTouched((s) => ({ ...s, [n]: true }));
        }}
      >
        <Field label={t('auth.email')}>
          {(id) =>
            typeof policy === 'object' ? (
              <EmailVerify id={id} required={policy.emailVerification} onChange={onEmail} resetKey={verifyReset} />
            ) : policy === 'loading' ? (
              <Input id={id} disabled />
            ) : (
              <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#f3b0b2]">
                <span>{t('auth.optionsFailed')}</span>
                <Button type="button" size="sm" variant="outline" onClick={loadPolicy} data-signup-focus="policy" data-testid="signup-policy-retry">
                  {t('common.retry')}
                </Button>
              </div>
            )
          }
        </Field>
        <Field
          label={t('auth.nickname')}
          error={nickCheck === 'taken' ? t('auth.nicknameTaken') : nickBad && (attempted || touched.nickname) ? t('auth.nicknameInvalid') : null}
          hint={
            nickCheck === 'ok' ? (
              <span className="text-success">{t('auth.nicknameOk')}</span>
            ) : nickCheck === 'checking' ? (
              t('auth.nicknameChecking')
            ) : nickCheck === 'error' ? (
              <span className="text-danger">
                {t('auth.nicknameCheckFailed')}{' '}
                <button
                  type="button"
                  className="font-semibold text-gold-300 underline underline-offset-2"
                  onClick={() => {
                    setNick({ value: fields.nickname, check: 'checking' });
                    setNickRetry((n) => n + 1);
                  }}
                  data-testid="signup-nick-retry"
                >
                  {t('common.retry')}
                </button>
              </span>
            ) : (
              t('auth.nicknameHint')
            )
          }
        >
          {(id) => <Input id={id} name="nickname" required maxLength={16} autoComplete="nickname" defaultValue={draft.nickname ?? ''} aria-invalid={nickBad || nickCheck === 'taken'} />}
        </Field>
        <Field
          label={t('auth.birthDate')}
          error={underage ? t('auth.underage') : birthBad ? t('auth.birthDateInvalid') : null}
          hint={
            dateInput ? (
              t('auth.birthDateHint')
            ) : (
              <>
                {t('auth.birthDateFormat')}
                <br />
                {t('auth.birthDateHint')}
              </>
            )
          }
        >
          {(id) =>
            dateInput ? (
              <Input id={id} name="birthDate" type="date" required min="1900-01-01" max={today} autoComplete="bday" defaultValue={draft.birthDate ?? ''} aria-invalid={birthBad || underage} />
            ) : (
              <Input
                id={id}
                name="birthDate"
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                maxLength={10}
                required
                autoComplete="bday"
                defaultValue={draft.birthDate ?? ''}
                onInput={formatBirth}
                aria-invalid={birthBad || underage}
              />
            )
          }
        </Field>
        <Field label={t('auth.password')}>
          {(id) => (
            <div className="flex flex-col gap-2">
              <PasswordInput id={id} name="password" autoComplete="new-password" required maxLength={128} aria-describedby={`${id}-rules`} />
              <PasswordRules id={`${id}-rules`} value={fields.password} />
            </div>
          )}
        </Field>
        <Field label={t('auth.passwordConfirm')}>
          {(id) => (
            <div className="flex flex-col gap-2">
              <PasswordInput id={id} name="confirm" autoComplete="new-password" required maxLength={128} aria-describedby={`${id}-match`} />
              <PasswordMatch id={`${id}-match`} password={fields.password} confirm={fields.confirm} />
            </div>
          )}
        </Field>
        <Suspense fallback={null}>
          <ReferralField value={referralCode} onChange={setReferralCode} fromLink={!!linkCode && referralCode === linkCode} />
        </Suspense>
        <SignupConsent value={agreements} onChange={setAgreements} />
        <p className="text-xs text-gold-300/80">{t('auth.welcomeGrant', { amount: '10,000' })}</p>
        {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#f3b0b2]">{error}</p>}
        {/* One line is kept for the reason, so the button does not move as it changes. */}
        <p id={whyId} aria-live="polite" data-testid="signup-why" className={cx('min-h-4 text-center text-xs leading-4', attempted ? 'text-[#f3b0b2]' : 'text-ink-400')}>
          {block ? t(`auth.why.${block}`) : ''}
        </p>
        <Button
          type="submit"
          size="lg"
          loading={busy}
          aria-disabled={!v.ready || undefined}
          aria-describedby={block ? whyId : undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:active:translate-y-0"
          data-testid="signup-submit"
        >
          {t('auth.register')}
        </Button>
        {inApp && ((attempted && !v.ready) || error !== null || policy === 'failed') && <SignupInAppHelp path={`/register${linkCode ? `?ref=${encodeURIComponent(linkCode)}` : ''}`} />}
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
