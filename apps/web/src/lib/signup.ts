import { ageOn, isCalendarDate, MIN_SIGNUP_AGE, NICKNAME_RE, passwordOk } from '@jc/types';

/**
 * The sign-up form's rules in one place: what is still missing, in the order the form asks for it, so the button and
 * the line under it never disagree. The server checks every rule again; this only decides what the page shows.
 */

/** Where the duplicate check of the typed nickname stands. Only 'ok' lets sign-up go: no answer is never a yes. */
export type NickCheck = 'idle' | 'checking' | 'ok' | 'taken' | 'error';

/** /signup-options: still loading, could not be read (retry; never guessed as "no verification"), or the policy. */
export type SignupPolicy = 'loading' | 'failed' | { emailVerification: boolean };

/** One reason sign-up cannot go yet; `auth.why.<reason>` names it. */
export type SignupBlock =
  | 'policy'
  | 'policyFailed'
  | 'email'
  | 'emailVerify'
  | 'nickname'
  | 'nicknameChecking'
  | 'nicknameTaken'
  | 'nicknameError'
  | 'birthDate'
  | 'underage'
  | 'password'
  | 'passwordMatch'
  | 'consent';

export interface SignupInput {
  policy: SignupPolicy;
  email: string;
  verificationToken: string | null;
  nickname: string;
  nickCheck: NickCheck;
  /** YYYY-MM-DD when it could be read (normalizeBirthDate), otherwise what was typed. */
  birthDate: string;
  password: string;
  confirm: string;
  age14: boolean;
  privacy: boolean;
  /** YYYY-MM-DD (isoDate()). */
  today: string;
}

export interface SignupValidation {
  emailValid: boolean;
  emailVerified: boolean;
  nicknameValid: boolean;
  nicknameAvailable: boolean;
  birthDateValid: boolean;
  ageValid: boolean;
  passwordValid: boolean;
  passwordMatched: boolean;
  requiredConsentsAccepted: boolean;
  ready: boolean;
  /** Every unmet requirement, in form order; the first is the one to show. */
  blocks: SignupBlock[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isEmail = (s: string) => EMAIL_RE.test(s);

export function signupValidation(i: SignupInput): SignupValidation {
  const emailValid = isEmail(i.email);
  const needVerify = typeof i.policy === 'object' ? i.policy.emailVerification : true;
  const emailVerified = emailValid && (!needVerify || i.verificationToken !== null);
  const nicknameValid = NICKNAME_RE.test(i.nickname);
  const nicknameAvailable = nicknameValid && i.nickCheck === 'ok';
  const birthDateValid = isCalendarDate(i.birthDate) && i.birthDate >= '1900-01-01' && i.birthDate <= i.today;
  const ageValid = birthDateValid && ageOn(i.birthDate, i.today) >= MIN_SIGNUP_AGE;
  const passwordValid = passwordOk(i.password);
  const passwordMatched = i.confirm !== '' && i.confirm === i.password;
  const requiredConsentsAccepted = i.age14 && i.privacy;
  const blocks: SignupBlock[] = [];
  if (i.policy === 'loading') blocks.push('policy');
  else if (i.policy === 'failed') blocks.push('policyFailed');
  if (!emailValid) blocks.push('email');
  else if (!emailVerified) blocks.push('emailVerify');
  if (!nicknameValid) blocks.push('nickname');
  else if (i.nickCheck === 'taken') blocks.push('nicknameTaken');
  else if (i.nickCheck === 'error') blocks.push('nicknameError');
  else if (i.nickCheck !== 'ok') blocks.push('nicknameChecking');
  if (!birthDateValid) blocks.push('birthDate');
  else if (!ageValid) blocks.push('underage');
  if (!passwordValid) blocks.push('password');
  if (!passwordMatched) blocks.push('passwordMatch');
  if (!requiredConsentsAccepted) blocks.push('consent');
  return {
    emailValid,
    emailVerified,
    nicknameValid,
    nicknameAvailable,
    birthDateValid,
    ageValid,
    passwordValid,
    passwordMatched,
    requiredConsentsAccepted,
    ready: blocks.length === 0,
    blocks,
  };
}

/**
 * A birth date as YYYY-MM-DD from how people type it where no date picker is offered (19900101, 1990.1.1, 1990/01/01,
 * "1990. 1. 1.", 1990년 1월 1일); anything else comes back trimmed and unchanged, so the check fails on it.
 */
export function normalizeBirthDate(raw: string): string {
  const s = raw.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  const parts = compact ? compact.slice(1) : /^(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D*$/.exec(s)?.slice(1);
  if (!parts) return s;
  const [y, m, d] = parts as [string, string, string];
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Hyphens put in as digits are typed (1990 → 1990-0 → 1990-01-01); a separator the member typed elsewhere is left alone. */
export function formatBirthTyping(raw: string): string {
  if (!/^[\d-]*$/.test(raw) || [...raw].some((c, i) => c === '-' && i !== 4 && i !== 7)) return raw;
  const d = raw.replace(/-/g, '').slice(0, 8);
  return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8)].filter(Boolean).join('-');
}

/** Whether this browser offers its own date picker (otherwise the field is a typed YYYY-MM-DD box). */
export function dateInputSupported(): boolean {
  try {
    const i = document.createElement('input');
    i.setAttribute('type', 'date');
    i.value = 'not-a-date';
    return i.type === 'date' && i.value === '';
  } catch {
    return false;
  }
}

/**
 * What sign-up keeps for this tab while it is in progress, so an in-app browser that reloads the page on the way back
 * from the mail app does not lose the code step or a finished verification. Never the passwords, never the consents.
 * The proof token stays in this tab's sessionStorage only (no URL, no log) and expires with the server's proof.
 */
export interface SignupDraft {
  savedAt: number;
  email?: { local: string; domain: string; custom: string };
  verify?: { kind: 'sent'; email: string; expiresAt: number; resendAt: number; devCode?: string } | { kind: 'verified'; email: string; token: string; expiresAt: number };
  nickname?: string;
  birthDate?: string;
}

const DRAFT_KEY = 'jc.signupDraft';
/** A draft untouched for this long is dropped (well past the 30-minute proof). */
export const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads a stored draft, keeping only well-formed parts that have not expired. */
export function parseDraft(raw: string | null, now: number): SignupDraft {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw ?? 'null') as Record<string, unknown>;
  } catch {
    return { savedAt: now };
  }
  if (!o || typeof o !== 'object' || !num(o.savedAt) || now - o.savedAt > DRAFT_TTL_MS || o.savedAt > now + 60_000) return { savedAt: now };
  const out: SignupDraft = { savedAt: o.savedAt };
  const e = o.email as Record<string, unknown> | undefined;
  if (e && str(e.local, 254) && str(e.domain, 254) && str(e.custom, 254)) out.email = { local: e.local, domain: e.domain, custom: e.custom };
  const v = o.verify as Record<string, unknown> | undefined;
  if (v && str(v.email, 254) && num(v.expiresAt) && v.expiresAt > now) {
    if (v.kind === 'sent' && num(v.resendAt)) out.verify = { kind: 'sent', email: v.email, expiresAt: v.expiresAt, resendAt: v.resendAt, ...(str(v.devCode, 12) ? { devCode: v.devCode } : {}) };
    if (v.kind === 'verified' && str(v.token, 200)) out.verify = { kind: 'verified', email: v.email, token: v.token, expiresAt: v.expiresAt };
  }
  if (str(o.nickname, 64)) out.nickname = o.nickname;
  if (str(o.birthDate, 32)) out.birthDate = o.birthDate;
  return out;
}

export function loadDraft(now = Date.now()): SignupDraft {
  try {
    return parseDraft(sessionStorage.getItem(DRAFT_KEY), now);
  } catch {
    return { savedAt: now };
  }
}

/** Merges `patch` into the stored draft (an `undefined` part is removed). Storage may be off; sign-up works without it. */
export function saveDraft(patch: Partial<Omit<SignupDraft, 'savedAt'>>, now = Date.now()) {
  try {
    const next: Record<string, unknown> = { ...loadDraft(now), ...patch, savedAt: now };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(next));
  } catch {
    /* private mode or storage off: nothing is kept across reloads */
  }
}

export function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* nothing stored */
  }
}
