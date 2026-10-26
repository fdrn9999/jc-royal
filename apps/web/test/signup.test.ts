import { describe, expect, it } from 'vitest';
import { en } from '../src/lib/i18n-en';
import { DRAFT_TTL_MS, formatBirthTyping, normalizeBirthDate, parseDraft, signupValidation, type SignupBlock, type SignupInput } from '../src/lib/signup';

const TODAY = '2026-10-26';
const ok: SignupInput = {
  policy: { emailVerification: true },
  email: 'me@naver.com',
  verificationToken: 'proof',
  nickname: '홍길동',
  nickCheck: 'ok',
  birthDate: '1990-01-01',
  password: 'Password1!',
  confirm: 'Password1!',
  age14: true,
  privacy: true,
  today: TODAY,
};
const blocks = (patch: Partial<SignupInput>) => signupValidation({ ...ok, ...patch }).blocks;

describe('sign-up rules', () => {
  it('is ready once everything holds', () => {
    const v = signupValidation(ok);
    expect(v.ready).toBe(true);
    expect(v.blocks).toEqual([]);
    expect(v).toMatchObject({ emailValid: true, emailVerified: true, nicknameValid: true, nicknameAvailable: true, birthDateValid: true, ageValid: true, passwordValid: true, passwordMatched: true, requiredConsentsAccepted: true });
  });

  it('asks for the email code while verification is on, and not when the server turned it off', () => {
    expect(blocks({ verificationToken: null })).toEqual(['emailVerify']);
    expect(blocks({ verificationToken: null, policy: { emailVerification: false } })).toEqual([]);
  });

  it('never takes a policy it could not read as "no verification"', () => {
    expect(blocks({ verificationToken: null, policy: 'failed' })).toEqual(['policyFailed', 'emailVerify']);
    expect(blocks({ verificationToken: null, policy: 'loading' })).toEqual(['policy', 'emailVerify']);
    // Even with a proof in hand, sign-up waits for the policy.
    expect(signupValidation({ ...ok, policy: 'failed' }).ready).toBe(false);
  });

  it('only lets a nickname through on a yes from the server', () => {
    expect(blocks({ nickCheck: 'checking' })).toEqual(['nicknameChecking']);
    expect(blocks({ nickCheck: 'idle' })).toEqual(['nicknameChecking']);
    expect(blocks({ nickCheck: 'taken' })).toEqual(['nicknameTaken']);
    expect(blocks({ nickCheck: 'error' })).toEqual(['nicknameError']);
    // A badly formed nickname is named as such, whatever an earlier answer said.
    expect(blocks({ nickname: 'a', nickCheck: 'ok' })).toEqual(['nickname']);
  });

  it('checks the birth date is a real day, not in the future, and old enough', () => {
    expect(blocks({ birthDate: '' })).toEqual(['birthDate']);
    expect(blocks({ birthDate: '1990-02-30' })).toEqual(['birthDate']);
    expect(blocks({ birthDate: '19900101' })).toEqual(['birthDate']); // not normalized: the page normalizes first
    expect(blocks({ birthDate: '2027-01-01' })).toEqual(['birthDate']);
    expect(blocks({ birthDate: '1899-12-31' })).toEqual(['birthDate']);
    expect(blocks({ birthDate: '2012-10-27' })).toEqual(['underage']); // turns 14 tomorrow
    expect(blocks({ birthDate: '2012-10-26' })).toEqual([]); // 14 today
  });

  it('checks the password rules and the confirmation', () => {
    expect(blocks({ password: 'short', confirm: 'short' })).toEqual(['password']);
    expect(blocks({ confirm: 'Password1?' })).toEqual(['passwordMatch']);
    expect(blocks({ confirm: '' })).toEqual(['passwordMatch']);
  });

  it('needs both required consents', () => {
    expect(blocks({ privacy: false })).toEqual(['consent']);
    expect(blocks({ age14: false })).toEqual(['consent']);
  });

  it('lists what is missing in the order the form asks for it', () => {
    const empty: SignupInput = { ...ok, email: '', verificationToken: null, nickname: '', nickCheck: 'idle', birthDate: '', password: '', confirm: '', age14: false, privacy: false };
    expect(signupValidation(empty).blocks).toEqual(['email', 'nickname', 'birthDate', 'password', 'passwordMatch', 'consent']);
  });

  it('has a message for every reason', () => {
    const all: SignupBlock[] = ['policy', 'policyFailed', 'email', 'emailVerify', 'nickname', 'nicknameChecking', 'nicknameTaken', 'nicknameError', 'birthDate', 'underage', 'password', 'passwordMatch', 'consent'];
    for (const b of all) expect(en[`auth.why.${b}`]).toBeTruthy();
  });
});

describe('typed birth dates', () => {
  it('reads the ways people type a date', () => {
    expect(normalizeBirthDate('19900101')).toBe('1990-01-01');
    expect(normalizeBirthDate('1990-01-01')).toBe('1990-01-01');
    expect(normalizeBirthDate(' 1990.1.1 ')).toBe('1990-01-01');
    expect(normalizeBirthDate('1990. 1. 1.')).toBe('1990-01-01');
    expect(normalizeBirthDate('1990/12/31')).toBe('1990-12-31');
    expect(normalizeBirthDate('1990년 3월 7일')).toBe('1990-03-07');
  });

  it('leaves anything else for the check to refuse', () => {
    expect(normalizeBirthDate('')).toBe('');
    expect(normalizeBirthDate('1990-0')).toBe('1990-0');
    expect(normalizeBirthDate('900101')).toBe('900101');
    expect(normalizeBirthDate('abc')).toBe('abc');
  });

  it('puts hyphens in as digits are typed', () => {
    expect(formatBirthTyping('1990')).toBe('1990');
    expect(formatBirthTyping('19900')).toBe('1990-0');
    expect(formatBirthTyping('199001')).toBe('1990-01');
    expect(formatBirthTyping('1990-011')).toBe('1990-01-1');
    expect(formatBirthTyping('19900101')).toBe('1990-01-01');
    expect(formatBirthTyping('1990-01-019')).toBe('1990-01-01');
    // A separator of the member's own is left alone.
    expect(formatBirthTyping('1990.1.1')).toBe('1990.1.1');
    expect(formatBirthTyping('199-0')).toBe('199-0');
  });
});

describe('sign-up draft', () => {
  const NOW = Date.UTC(2026, 9, 26, 3);
  const verified = { kind: 'verified', email: 'me@naver.com', token: 'proof', expiresAt: NOW + 60_000 };
  const sent = { kind: 'sent', email: 'me@naver.com', expiresAt: NOW + 60_000, resendAt: NOW + 30_000, devCode: '123456' };

  it('brings back the code step and the fields', () => {
    const raw = JSON.stringify({ savedAt: NOW - 1000, email: { local: 'me', domain: 'naver.com', custom: '' }, verify: sent, nickname: '홍길동', birthDate: '1990-01-01' });
    expect(parseDraft(raw, NOW)).toEqual({ savedAt: NOW - 1000, email: { local: 'me', domain: 'naver.com', custom: '' }, verify: sent, nickname: '홍길동', birthDate: '1990-01-01' });
    expect(parseDraft(JSON.stringify({ savedAt: NOW, verify: verified }), NOW).verify).toEqual(verified);
  });

  it('drops a verification that has expired', () => {
    const raw = JSON.stringify({ savedAt: NOW - 1000, verify: { ...verified, expiresAt: NOW - 1 }, nickname: 'kept' });
    expect(parseDraft(raw, NOW)).toEqual({ savedAt: NOW - 1000, nickname: 'kept' });
  });

  it('drops an old draft, one from the future, and anything malformed', () => {
    expect(parseDraft(JSON.stringify({ savedAt: NOW - DRAFT_TTL_MS - 1, nickname: 'x' }), NOW)).toEqual({ savedAt: NOW });
    expect(parseDraft(JSON.stringify({ savedAt: NOW + 3_600_000, nickname: 'x' }), NOW)).toEqual({ savedAt: NOW });
    expect(parseDraft('{not json', NOW)).toEqual({ savedAt: NOW });
    expect(parseDraft(null, NOW)).toEqual({ savedAt: NOW });
    expect(parseDraft(JSON.stringify({ savedAt: NOW, verify: { kind: 'verified', email: 'me@naver.com', expiresAt: NOW + 1 } }), NOW)).toEqual({ savedAt: NOW });
    expect(parseDraft(JSON.stringify({ savedAt: NOW, email: { local: 1 } }), NOW)).toEqual({ savedAt: NOW });
  });

  it('never keeps a password', () => {
    const raw = JSON.stringify({ savedAt: NOW, password: 'Password1!', confirm: 'Password1!' });
    expect(parseDraft(raw, NOW)).toEqual({ savedAt: NOW });
  });
});
