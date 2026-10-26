import type { EmailVerificationSentDto } from '@jc/types';
import { Button, Input } from '@jc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useFieldSync } from '../lib/fieldSync';
import { useI18n } from '../lib/i18n';
import { isEmail, loadDraft, saveDraft } from '../lib/signup';
import { EmailInput, emailOf, NO_EMAIL, type EmailParts } from './EmailInput';

type Phase =
  | { kind: 'idle' }
  | { kind: 'sent'; email: string; expiresAt: number; resendAt: number; devCode?: string }
  | { kind: 'verified'; email: string; token: string; expiresAt: number };

/** How long a proof lasts when the answer does not say (the API's PROOF_MINUTES). */
const PROOF_MINUTES = 30;

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Email field with the sign-up code step: send a 6-digit code, enter it, and get a
 * one-time proof for /register. With `required` off it is a plain email field.
 *
 * The step survives a reload of the page (in-app browsers often reload it on the way back from the mail app): the
 * address, the code sent and a finished verification are kept for this tab (lib/signup draft) until they expire.
 * Bumping `resetKey` drops a verification the server no longer accepts.
 */
export function EmailVerify({
  id,
  required,
  onChange,
  resetKey = 0,
}: {
  id: string;
  required: boolean;
  onChange: (v: { email: string; token: string | null }) => void;
  resetKey?: number;
}) {
  const { t, locale, err } = useI18n();
  const [draft] = useState(loadDraft);
  const [email, setEmail] = useState(() => emailOf(draft.email ?? NO_EMAIL));
  const [phase, setPhase] = useState<Phase>(() => draft.verify ?? { kind: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'send' | 'confirm' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // One request at a time, and an answer to a request older than the current step is dropped.
  const inflight = useRef(false);
  const seq = useRef(0);

  // The code box is read from the page as well: a code filled in from Mail may come without the events React needs.
  const readCode = useCallback(() => {
    const el = codeRef.current;
    if (!el) return;
    const digits = el.value.replace(/\D/g, '').slice(0, 6);
    if (el.value !== digits) el.value = digits;
    setCode(digits);
  }, []);
  useFieldSync(root, readCode);

  const restart = useCallback(() => {
    seq.current++;
    setPhase({ kind: 'idle' });
    setCode('');
  }, []);

  useEffect(() => {
    if (phase.kind !== 'sent') return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [phase.kind]);

  // A finished verification lasts as long as the server's proof; after that the code step starts over.
  useEffect(() => {
    if (phase.kind !== 'verified') return;
    const h = setTimeout(() => {
      restart();
      setError(t('auth.verifyExpired'));
    }, Math.max(0, phase.expiresAt - Date.now()));
    return () => clearTimeout(h);
  }, [phase, restart, t]);

  useEffect(() => {
    if (!resetKey) return;
    restart();
    setError(t('auth.verifyExpired'));
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Editing the address drops a code sent to the previous one.
  useEffect(() => {
    if (phase.kind === 'sent' && email !== phase.email) {
      restart();
      setError(null);
    }
  }, [email, phase, restart]);

  useEffect(() => {
    saveDraft({ verify: phase.kind === 'idle' ? undefined : phase });
  }, [phase]);

  useEffect(() => {
    onChange({ email, token: phase.kind === 'verified' && phase.email === email ? phase.token : null });
  }, [email, phase, onChange]);

  const onEmail = useCallback((v: string, parts: EmailParts) => {
    setEmail(v);
    saveDraft({ email: parts });
  }, []);

  async function send() {
    if (inflight.current || !isEmail(email)) return;
    inflight.current = true;
    const mine = ++seq.current;
    const target = email;
    const fromIdle = phase.kind === 'idle';
    setBusy('send');
    setError(null);
    try {
      const r = await api<EmailVerificationSentDto>('/api/auth/email-verification/request', { body: { email: target, locale } });
      if (mine !== seq.current) return;
      const at = Date.now();
      setPhase({ kind: 'sent', email: target, expiresAt: at + r.expiresInMinutes * 60_000, resendAt: at + r.resendAfterSeconds * 1000, devCode: r.devCode });
      setNow(at);
      setCode('');
      if (codeRef.current) codeRef.current.value = '';
    } catch (x) {
      if (mine !== seq.current) return;
      const wait = x instanceof ApiError && x.code === 'resend_too_soon' ? (x.details as { retryAfterSeconds?: number; codeExpiresInSeconds?: number } | undefined) : undefined;
      if (fromIdle && wait?.codeExpiresInSeconds) {
        // A code went to this address moments ago (before the page reloaded, or from another tab): enter that one.
        const at = Date.now();
        setPhase({ kind: 'sent', email: target, expiresAt: at + wait.codeExpiresInSeconds * 1000, resendAt: at + (wait.retryAfterSeconds ?? 60) * 1000 });
        setNow(at);
        setCode('');
      } else setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      inflight.current = false;
      setBusy(null);
    }
  }

  async function confirm() {
    const typed = (codeRef.current?.value ?? code).replace(/\D/g, '').slice(0, 6);
    if (phase.kind !== 'sent' || typed.length !== 6 || inflight.current) return;
    inflight.current = true;
    const mine = ++seq.current;
    const target = phase.email;
    setBusy('confirm');
    setError(null);
    try {
      const r = await api<{ verificationToken: string; expiresInMinutes?: number }>('/api/auth/email-verification/confirm', { body: { email: target, code: typed } });
      if (mine !== seq.current) return;
      setPhase({ kind: 'verified', email: target, token: r.verificationToken, expiresAt: Date.now() + (r.expiresInMinutes ?? PROOF_MINUTES) * 60_000 });
    } catch (x) {
      if (mine !== seq.current) return;
      const left = x instanceof ApiError && x.code === 'invalid_code' ? (x.details as { attemptsLeft?: number } | undefined)?.attemptsLeft : undefined;
      setError(left !== undefined ? t('auth.verifyAttemptsLeft', { n: left }) : err(x instanceof ApiError ? x.code : null));
    } finally {
      inflight.current = false;
      setBusy(null);
    }
  }

  const expired = phase.kind === 'sent' && now >= phase.expiresAt;
  const resendIn = phase.kind === 'sent' ? Math.ceil((phase.resendAt - now) / 1000) : 0;

  return (
    <div ref={root} className="flex flex-col gap-2">
      <EmailInput id={id} onChange={onEmail} disabled={phase.kind === 'verified'} initial={draft.email} />
      {required && phase.kind === 'idle' && (
        <Button type="button" variant="outline" onClick={send} loading={busy === 'send'} disabled={!isEmail(email)} data-signup-focus="emailVerify">
          {t('auth.verifySend')}
        </Button>
      )}
      {required && phase.kind === 'sent' && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-white/10 bg-ink-900/60 p-3">
          <p className="text-xs leading-relaxed text-ink-200">{t('auth.verifySent', { email: phase.email })}</p>
          <div className="flex gap-2">
            <Input
              ref={codeRef}
              name="email-code"
              defaultValue=""
              onKeyDown={(e) => {
                // Enter confirms the code instead of submitting the sign-up form.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void confirm();
                }
              }}
              aria-label={t('auth.verifyCode')}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              data-signup-focus="emailVerify"
              className="min-w-0 flex-1 text-center font-mono text-lg tracking-[0.35em] placeholder:tracking-[0.35em]"
            />
            <Button type="button" onClick={confirm} loading={busy === 'confirm'} disabled={code.length !== 6 || expired} className="h-11 shrink-0">
              {t('auth.verifyConfirm')}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className={expired ? 'text-danger' : 'font-mono tabular-nums text-ink-300'}>
              {expired ? t('err.code_expired') : t('auth.verifyExpiresIn', { time: mmss(phase.expiresAt - now) })}
            </span>
            <button
              type="button"
              onClick={send}
              disabled={resendIn > 0 || busy !== null}
              className="rounded px-1 font-semibold text-gold-300 hover:underline disabled:cursor-not-allowed disabled:text-ink-400 disabled:no-underline"
            >
              {resendIn > 0 ? t('auth.verifyResendIn', { s: resendIn }) : t('auth.verifyResend')}
            </button>
          </div>
          {phase.devCode && (
            <p data-testid="dev-code" className="rounded-md border border-gold-500/30 bg-gold-500/5 px-2.5 py-1.5 text-xs text-gold-300">
              {t('auth.verifyDevCode', { code: phase.devCode })}
            </p>
          )}
        </div>
      )}
      {required && phase.kind === 'verified' && (
        <div role="status" className="flex items-center justify-between gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-success">
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
            {t('auth.verifyDone')}
          </span>
          <button
            type="button"
            onClick={() => {
              restart();
              setError(null);
            }}
            className="rounded px-1 text-xs font-semibold text-ink-300 hover:text-ivory hover:underline"
          >
            {t('auth.verifyChange')}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
