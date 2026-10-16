/**
 * The signup form's referral code (api lib/referral.ts): filled from the link's `?ref=`, checked as it is typed, and
 * told whose code it is and what it gives now. The server decides at signup; this only shows its answer. Loaded on its
 * own chunk with its text, so the entry chunk stays within its budget (tests/bundle-check.mjs).
 */
import { normalizeReferralCode, REFERRAL_CODE_RE, type ReferralCodeCheckDto } from '@jc/types';
import { createTranslator, Field, formatChips, Input } from '@jc/ui';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';

const ko = {
  label: '추천 코드 (선택)',
  hint: '친구에게 받은 추천 코드가 있으면 입력하세요. 없으면 비워 두면 됩니다.',
  fromLink: '추천 링크로 들어와 코드가 입력되었습니다. 원하지 않으면 지우세요.',
  checking: '추천 코드를 확인하는 중…',
  invalid: '사용할 수 없는 추천 코드입니다. 코드를 확인하거나 비워 두세요.',
  unchecked: '코드를 지금 확인하지 못했습니다. 가입할 때 다시 확인합니다.',
  inviter: "'{name}' 님의 추천 코드입니다.",
  reward: '가입하면 추천 보상 {amount}칩을 받습니다.',
  rewardHands: '가입 후 핸드 {n}판을 마치면 추천 보상 {amount}칩을 받습니다.',
  paused: '추천 보상 지급이 잠시 중지되어 있어, 재개되면 지급됩니다.',
  none: '지금은 추천 보상이 없습니다.',
  note: '추천 보상은 가입 축하 칩과 별도이며, 현금 가치가 없는 가상 칩입니다.',
} as const;

const en: Record<keyof typeof ko, string> = {
  label: 'Referral code (optional)',
  hint: 'If a friend gave you a referral code, enter it. Otherwise leave this empty.',
  fromLink: 'The code came with the referral link you opened. Clear it if you do not want it.',
  checking: 'Checking the referral code…',
  invalid: 'This referral code cannot be used. Check it, or leave the field empty.',
  unchecked: 'The code could not be checked right now. It is checked again when you sign up.',
  inviter: "This is {name}'s referral code.",
  reward: 'You receive a {amount}-chip referral reward when you sign up.',
  rewardHands: 'You receive a {amount}-chip referral reward after you finish {n} hands.',
  paused: 'Referral rewards are paused for now and are paid once they resume.',
  none: 'There is no referral reward right now.',
  note: 'Referral rewards are separate from the welcome chips and are virtual chips with no cash value.',
};

const translate = createTranslator({ ko, en });

type Check = { kind: 'idle' | 'checking' | 'invalid' | 'unchecked' } | { kind: 'ok'; dto: ReferralCodeCheckDto };

export function ReferralField({ value, onChange, fromLink }: { value: string; onChange: (code: string) => void; fromLink: boolean }) {
  const { locale } = useI18n();
  const tr = translate(locale);
  const [check, setCheck] = useState<Check>({ kind: 'idle' });

  useEffect(() => {
    if (!value) return setCheck({ kind: 'idle' });
    if (!REFERRAL_CODE_RE.test(value)) return setCheck({ kind: 'invalid' });
    setCheck({ kind: 'checking' });
    let live = true;
    const h = setTimeout(async () => {
      try {
        const dto = await api<ReferralCodeCheckDto>(`/api/auth/referral/${encodeURIComponent(value)}`);
        if (live) setCheck(dto.valid ? { kind: 'ok', dto } : { kind: 'invalid' });
      } catch (e) {
        // A refusal of the code is an answer; anything else (offline, too many checks) is decided at signup.
        if (live) setCheck(e instanceof ApiError && e.status === 404 ? { kind: 'invalid' } : { kind: 'unchecked' });
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [value]);

  let hint: string = fromLink && check.kind !== 'ok' ? tr('fromLink') : tr('hint');
  if (check.kind === 'checking') hint = tr('checking');
  if (check.kind === 'unchecked') hint = tr('unchecked');
  if (check.kind === 'ok') {
    const r = check.dto.reward;
    const name = tr('inviter', { name: check.dto.inviter ?? '' });
    const what = !r || r.amount <= 0 ? tr('none') : r.minHands > 0 ? tr('rewardHands', { amount: formatChips(r.amount), n: r.minHands }) : tr('reward', { amount: formatChips(r.amount) });
    hint = [name, what, r?.paused && r.amount > 0 ? tr('paused') : '', r && r.amount > 0 ? tr('note') : ''].filter(Boolean).join(' ');
  }
  return (
    <div data-testid="referral-field" data-state={check.kind}>
      <Field label={tr('label')} error={check.kind === 'invalid' ? tr('invalid') : null} hint={hint}>
        {(id) => (
          <Input
            id={id}
            maxLength={40}
            value={value}
            placeholder="JC7K4P2"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono uppercase"
            onChange={(e) => onChange(normalizeReferralCode(e.target.value).slice(0, 40))}
            aria-invalid={check.kind === 'invalid'}
            data-testid="referral-code"
          />
        )}
      </Field>
    </div>
  );
}
