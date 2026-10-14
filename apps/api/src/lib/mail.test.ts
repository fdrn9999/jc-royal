import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { mailEnabled, passwordResetMail, sendMail, verificationCodeMail } from './mail';

const env = (over: Partial<Env> = {}) =>
  ({ RESEND_API_KEY: 're_test', MAIL_FROM: 'JC ROYAL <no-reply@jcroyal.test>', APP_ORIGIN: 'https://play.jcroyal.test', ...over }) as Env;

describe('mailEnabled', () => {
  it('needs the key, the sender and the public origin', () => {
    expect(mailEnabled(env())).toBe(true);
    expect(mailEnabled(env({ RESEND_API_KEY: undefined }))).toBe(false);
    expect(mailEnabled(env({ MAIL_FROM: undefined }))).toBe(false);
    expect(mailEnabled(env({ APP_ORIGIN: undefined }))).toBe(false);
  });
});

describe('passwordResetMail', () => {
  const base = { link: 'https://play.jcroyal.test/reset?token=abc_DEF-123', origin: 'https://play.jcroyal.test', minutes: 30 };

  it('renders the link, logo and expiry in Korean', () => {
    const m = passwordResetMail({ ...base, locale: 'ko', nickname: '로열' });
    expect(m.subject).toBe('[JC ROYAL] 비밀번호 재설정 안내');
    expect(m.html).toContain('href="https://play.jcroyal.test/reset?token=abc_DEF-123"');
    expect(m.html).toContain('src="https://play.jcroyal.test/email/logo.png"');
    expect(m.html).toContain('<strong>30분</strong>');
    expect(m.html).toContain('로열님, 안녕하세요.');
    expect(m.text).toContain(base.link);
  });

  it('renders English for English-locale members', () => {
    const m = passwordResetMail({ ...base, locale: 'en', nickname: 'Royal' });
    expect(m.subject).toBe('[JC ROYAL] Reset your password');
    expect(m.html).toContain('lang="en"');
    expect(m.text).toContain('expires in 30 minutes');
  });

  it('escapes member-controlled text', () => {
    const m = passwordResetMail({ ...base, locale: 'ko', nickname: '<img src=x onerror=alert(1)>"' });
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;');
  });
});

describe('verificationCodeMail', () => {
  it('shows the code and expiry in the requested language', () => {
    const ko = verificationCodeMail({ locale: 'ko', code: '048213', origin: 'https://play.jcroyal.test', minutes: 10 });
    expect(ko.subject).toBe('[JC ROYAL] 이메일 인증번호 048213');
    expect(ko.html).toContain('>048213</td>');
    expect(ko.html).toContain('<strong>10분</strong>');
    expect(ko.text).toContain('인증번호: 048213');
    const en = verificationCodeMail({ locale: 'en', code: '048213', origin: 'https://play.jcroyal.test', minutes: 10 });
    expect(en.html).toContain('lang="en"');
    expect(en.text).toContain('This code expires in 10 minutes.');
  });
});

describe('sendMail', () => {
  it('posts to Resend with the key and sender', async () => {
    const fetcher = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    await sendMail(env(), { to: 'a@b.test', subject: 's', html: '<p>h</p>', text: 't' }, fetcher as unknown as typeof fetch);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toEqual({ from: 'JC ROYAL <no-reply@jcroyal.test>', to: ['a@b.test'], subject: 's', html: '<p>h</p>', text: 't' });
  });

  it('throws when Resend rejects the message', async () => {
    const fetcher = vi.fn(async () => new Response('{"message":"domain not verified"}', { status: 403 }));
    await expect(sendMail(env(), { to: 'a@b.test', subject: 's', html: 'h', text: 't' }, fetcher as unknown as typeof fetch)).rejects.toThrow(/resend 403/);
  });
});
