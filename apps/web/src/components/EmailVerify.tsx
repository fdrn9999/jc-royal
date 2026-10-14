import type { EmailVerificationSentDto } from '@jc/types';
import { Button, Input } from '@jc/ui';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { EmailInput } from './EmailInput';

type Phase =
  | { kind: 'idle' }
  | { kind: 'sent'; email: string; expiresAt: number; resendAt: number; devCode?: string }
  | { kind: 'verified'; email: string; token: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Email field with the sign-up code step: send a 6-digit code, enter it, and get a
 * one-time proof for /register. With `required` off it is a plain email field.
 */
export function EmailVerify({ id, required, onChange }: { id: string; required: boolean; onChange: (v: { email: string; token: string | null }) => void }) {
  const { t, locale, err } = useI18n();
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'send' | 'confirm' | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (phase.kind !== 'sent') return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [phase.kind]);

  // Editing the address drops a code sent to the previous one.
  useEffect(() => {
    if (phase.kind === 'sent' && email !== phase.email) {
      setPhase({ kind: 'idle' });
      setCode('');
      setError(null);
    }
  }, [email, phase]);

  useEffect(() => {
    onChange({ email, token: phase.kind === 'verified' && phase.email === email ? phase.token : null });
  }, [email, phase, onChange]);

  async function send() {
    setBusy('send');
    setError(null);
    try {
      const r = await api<EmailVerificationSentDto>('/api/auth/email-verification/request', { body: { email, locale } });
      const at = Date.now();
      setPhase({ kind: 'sent', email, expiresAt: at + r.expiresInMinutes * 60_000, resendAt: at + r.resendAfterSeconds * 1000, devCode: r.devCode });
      setNow(at);
      setCode('');
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (phase.kind !== 'sent' || code.length !== 6) return;
    setBusy('confirm');
    setError(null);
    try {
      const r = await api<{ verificationToken: string }>('/api/auth/email-verification/confirm', { body: { email: phase.email, code } });
      setPhase({ kind: 'verified', email: phase.email, token: r.verificationToken });
    } catch (x) {
      const left = x instanceof ApiError && x.code === 'invalid_code' ? (x.details as { attemptsLeft?: number } | undefined)?.attemptsLeft : undefined;
      setError(left !== undefined ? t('auth.verifyAttemptsLeft', { n: left }) : err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(null);
    }
  }

  const expired = phase.kind === 'sent' && now >= phase.expiresAt;
  const resendIn = phase.kind === 'sent' ? Math.ceil((phase.resendAt - now) / 1000) : 0;

  return (
    <div className="flex flex-col gap-2">
      <EmailInput id={id} onChange={setEmail} disabled={phase.kind === 'verified'} />
      {required && phase.kind === 'idle' && (
        <Button type="button" variant="outline" onClick={send} loading={busy === 'send'} disabled={!EMAIL_RE.test(email)}>
          {t('auth.verifySend')}
        </Button>
      )}
      {required && phase.kind === 'sent' && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-white/10 bg-ink-900/60 p-3">
          <p className="text-xs leading-relaxed text-ink-200">{t('auth.verifySent', { email: phase.email })}</p>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
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
              setPhase({ kind: 'idle' });
              setCode('');
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
