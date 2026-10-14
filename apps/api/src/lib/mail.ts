/**
 * Transactional mail via Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Sending is enabled only when RESEND_API_KEY, MAIL_FROM and APP_ORIGIN are all set;
 * otherwise password resets fall back to admin-issued links and sign-up skips email verification.
 */
import type { Env } from '../env';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function mailEnabled(env: Env): boolean {
  return !!(env.RESEND_API_KEY && env.MAIL_FROM && env.APP_ORIGIN);
}

export async function sendMail(env: Env, mail: Mail, fetcher: typeof fetch = fetch): Promise<void> {
  const res = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

type Locale = 'ko' | 'en';
const pick = <M extends Record<Locale, unknown>>(m: M, l: Locale): M[Locale] => m[l] ?? m.ko;

const COMMON = {
  ko: {
    chips: 'JC ROYAL의 모든 칩은 현금 가치가 없는 플레이 전용 가상 칩입니다.',
    noreply: '이 메일은 발신 전용입니다.',
  },
  en: {
    chips: 'All chips on JC ROYAL are play-only virtual chips with no cash value.',
    noreply: 'This is an automated message; replies are not monitored.',
  },
} as const;
const TAGLINE = 'PREMIUM HOLD’EM LOUNGE';

const RESET = {
  ko: {
    subject: '[JC ROYAL] 비밀번호 재설정 안내',
    preheader: (m: number) => `요청하신 비밀번호 재설정 링크입니다. ${m}분 안에 사용해 주세요.`,
    title: '비밀번호 재설정',
    greeting: (n: string) => `${n}님, 안녕하세요.`,
    body: 'JC ROYAL 계정의 비밀번호 재설정 요청을 받았습니다. 아래 버튼을 눌러 새 비밀번호를 설정해 주세요.',
    button: '새 비밀번호 설정하기',
    expiry: (m: number) => `이 링크는 <strong>${m}분</strong> 동안 <strong>한 번만</strong> 사용할 수 있습니다.`,
    expiryText: (m: number) => `이 링크는 ${m}분 동안 한 번만 사용할 수 있습니다.`,
    fallback: '버튼이 동작하지 않으면 아래 주소를 브라우저 주소창에 붙여 넣으세요.',
    ignore: '본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다. 비밀번호는 바뀌지 않습니다.',
  },
  en: {
    subject: '[JC ROYAL] Reset your password',
    preheader: (m: number) => `Your password reset link. Use it within ${m} minutes.`,
    title: 'Reset your password',
    greeting: (n: string) => `Hello, ${n}.`,
    body: 'We received a request to reset the password for your JC ROYAL account. Use the button below to choose a new one.',
    button: 'Set a new password',
    expiry: (m: number) => `This link works <strong>once</strong> and expires in <strong>${m} minutes</strong>.`,
    expiryText: (m: number) => `This link works once and expires in ${m} minutes.`,
    fallback: 'If the button does not work, paste this address into your browser.',
    ignore: 'If you did not request this, you can ignore this email. Your password will not change.',
  },
} as const;

const VERIFY = {
  ko: {
    subject: (code: string) => `[JC ROYAL] 이메일 인증번호 ${code}`,
    preheader: (m: number) => `회원가입 인증번호입니다. ${m}분 안에 입력해 주세요.`,
    title: '이메일 인증',
    body: 'JC ROYAL 회원가입을 위한 인증번호입니다. 가입 화면에 아래 6자리 숫자를 입력해 주세요.',
    codeLabel: '인증번호',
    expiry: (m: number) => `인증번호는 <strong>${m}분</strong> 동안 유효합니다.`,
    expiryText: (m: number) => `인증번호는 ${m}분 동안 유효합니다.`,
    ignore: '본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다. 인증번호를 다른 사람에게 알려 주지 마세요.',
  },
  en: {
    subject: (code: string) => `[JC ROYAL] Your verification code ${code}`,
    preheader: (m: number) => `Your sign-up verification code. Enter it within ${m} minutes.`,
    title: 'Verify your email',
    body: 'Here is your code for creating a JC ROYAL account. Enter these 6 digits on the sign-up screen.',
    codeLabel: 'VERIFICATION CODE',
    expiry: (m: number) => `This code expires in <strong>${m} minutes</strong>.`,
    expiryText: (m: number) => `This code expires in ${m} minutes.`,
    ignore: 'If you did not request this, you can ignore this email. Never share this code with anyone.',
  },
} as const;

const FONT = `-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', 'Segoe UI', Roboto, sans-serif`;
const DISPLAY = `'Cinzel', Georgia, 'Times New Roman', serif`;
const MONO = `'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace`;

/** Expiry note in a dark rounded box. `html` may contain <strong>. */
const expiryRow = (html: string) => `
        <tr>
          <td class="pad" style="padding:28px 48px 0;font-family:${FONT};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td bgcolor="#14161a" style="padding:14px 18px;background-color:#14161a;border:1px solid #272b33;border-radius:12px;font-size:13px;line-height:1.6;color:#b9bcc3;text-align:center;">
                <span style="color:#d4af37;">&#9201;</span>&nbsp; ${html}
              </td>
            </tr></table>
          </td>
        </tr>`;

/** Branded dark/gold frame shared by every mail: logo, divider, `rows` (card body), ignore note, footer. */
function frame(o: { locale: Locale; subject: string; preheader: string; origin: string; rows: string; ignore: string }): string {
  const c = pick(COMMON, o.locale);
  const origin = esc(o.origin);
  return `<!doctype html>
<html lang="${o.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(o.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600&display=swap" rel="stylesheet">
<style>
  a { color: #e6c56b; }
  @media (max-width: 620px) {
    .card { border-radius: 0 !important; }
    .pad { padding-left: 24px !important; padding-right: 24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#050506;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#050506;">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#050506" style="background-color:#050506;">
  <tr>
    <td align="center" style="padding:40px 12px;">
      <table role="presentation" class="card" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="#0f1013" style="width:100%;max-width:560px;background-color:#0f1013;border:1px solid #3a2f17;border-radius:18px;overflow:hidden;word-break:keep-all;">
        <tr>
          <td height="4" bgcolor="#d4af37" style="height:4px;line-height:4px;font-size:0;background-color:#d4af37;background-image:linear-gradient(90deg,#8a6b17,#f3dd9b 50%,#8a6b17);">&nbsp;</td>
        </tr>
        <tr>
          <td align="center" class="pad" style="padding:40px 48px 8px;">
            <a href="${origin}" style="text-decoration:none;"><img src="${origin}/email/logo.png" width="88" height="88" alt="JC ROYAL" style="display:block;width:88px;height:88px;border:0;"></a>
            <div style="margin-top:16px;font-family:${DISPLAY};font-size:22px;font-weight:600;letter-spacing:6px;color:#e6c56b;">JC&nbsp;ROYAL</div>
            <div style="margin-top:6px;font-family:${FONT};font-size:10px;letter-spacing:3px;color:#8d929c;">${TAGLINE}</div>
          </td>
        </tr>
        <tr>
          <td align="center" class="pad" style="padding:20px 48px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="64" style="border-top:1px solid #3a2f17;font-size:0;line-height:0;">&nbsp;</td>
              <td style="padding:0 12px;font-family:${DISPLAY};font-size:14px;line-height:14px;color:#b48e22;">&#9824;</td>
              <td width="64" style="border-top:1px solid #3a2f17;font-size:0;line-height:0;">&nbsp;</td>
            </tr></table>
          </td>
        </tr>${o.rows}
        <tr>
          <td class="pad" style="padding:28px 48px 40px;font-family:${FONT};">
            <p style="margin:0;padding-top:20px;border-top:1px solid #272b33;font-size:12px;line-height:1.6;color:#8d929c;">${esc(o.ignore)}</p>
          </td>
        </tr>
      </table>
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
        <tr>
          <td align="center" style="padding:24px 24px 0;font-family:${FONT};font-size:11px;line-height:1.7;color:#5d6370;word-break:keep-all;">
            ${esc(c.chips)}<br>${esc(c.noreply)}<br>
            <a href="${origin}" style="color:#8a6b17;text-decoration:none;letter-spacing:2px;">JC ROYAL</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export function passwordResetMail(opts: { locale: Locale; nickname: string; link: string; origin: string; minutes: number }): Omit<Mail, 'to'> {
  const t = pick(RESET, opts.locale);
  const link = esc(opts.link);
  const rows = `
        <tr>
          <td class="pad" style="padding:28px 48px 0;font-family:${FONT};">
            <h1 style="margin:0;font-size:24px;line-height:1.35;font-weight:700;color:#f4efe3;text-align:center;">${esc(t.title)}</h1>
            <p style="margin:24px 0 0;font-size:15px;line-height:1.7;color:#e4e1d8;">${esc(t.greeting(opts.nickname))}</p>
            <p style="margin:8px 0 0;font-size:15px;line-height:1.7;color:#b9bcc3;">${esc(t.body)}</p>
          </td>
        </tr>
        <tr>
          <td align="center" class="pad" style="padding:32px 48px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td align="center" bgcolor="#d4af37" style="border-radius:999px;background-color:#d4af37;background-image:linear-gradient(180deg,#f3dd9b,#d4af37 55%,#b48e22);">
                <a href="${link}" target="_blank" style="display:inline-block;padding:15px 40px;font-family:${FONT};font-size:16px;font-weight:700;line-height:1;color:#0a0b0d;text-decoration:none;border-radius:999px;">${esc(t.button)}</a>
              </td>
            </tr></table>
          </td>
        </tr>${expiryRow(t.expiry(opts.minutes))}
        <tr>
          <td class="pad" style="padding:24px 48px 0;font-family:${FONT};">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#8d929c;">${esc(t.fallback)}</p>
            <p style="margin:6px 0 0;font-size:12px;line-height:1.6;word-break:break-all;"><a href="${link}" target="_blank" style="color:#e6c56b;text-decoration:underline;">${link}</a></p>
          </td>
        </tr>`;
  const html = frame({ locale: opts.locale, subject: t.subject, preheader: t.preheader(opts.minutes), origin: opts.origin, rows, ignore: t.ignore });
  const text = [
    `JC ROYAL — ${t.title}`,
    '',
    t.greeting(opts.nickname),
    t.body,
    '',
    opts.link,
    '',
    t.expiryText(opts.minutes),
    t.ignore,
    '',
    pick(COMMON, opts.locale).chips,
  ].join('\n');
  return { subject: t.subject, html, text };
}

export function verificationCodeMail(opts: { locale: Locale; code: string; origin: string; minutes: number }): Omit<Mail, 'to'> {
  const t = pick(VERIFY, opts.locale);
  const subject = t.subject(opts.code);
  const rows = `
        <tr>
          <td class="pad" style="padding:28px 48px 0;font-family:${FONT};">
            <h1 style="margin:0;font-size:24px;line-height:1.35;font-weight:700;color:#f4efe3;text-align:center;">${esc(t.title)}</h1>
            <p style="margin:20px 0 0;font-size:15px;line-height:1.7;color:#b9bcc3;text-align:center;">${esc(t.body)}</p>
          </td>
        </tr>
        <tr>
          <td align="center" class="pad" style="padding:28px 48px 0;">
            <div style="font-family:${FONT};font-size:11px;letter-spacing:3px;color:#8d929c;">${esc(t.codeLabel)}</div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;"><tr>
              <td align="center" bgcolor="#14161a" style="padding:18px 22px 18px 32px;background-color:#14161a;border:1px solid #8a6b17;border-radius:14px;font-family:${MONO};font-size:34px;line-height:1;font-weight:700;letter-spacing:10px;color:#f3dd9b;">${esc(opts.code)}</td>
            </tr></table>
          </td>
        </tr>${expiryRow(t.expiry(opts.minutes))}`;
  const html = frame({ locale: opts.locale, subject, preheader: t.preheader(opts.minutes), origin: opts.origin, rows, ignore: t.ignore });
  const text = [
    `JC ROYAL — ${t.title}`,
    '',
    t.body,
    '',
    `${t.codeLabel}: ${opts.code}`,
    '',
    t.expiryText(opts.minutes),
    t.ignore,
    '',
    pick(COMMON, opts.locale).chips,
  ].join('\n');
  return { subject, html, text };
}
