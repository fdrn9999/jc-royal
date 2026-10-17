/**
 * The referral card on the Me page (api lib/referral.ts): the member's code and link to share, the current terms,
 * what the members they invited brought them, their own reward if they signed up with a code, and the rules. The
 * server decides and pays each side at most once; opening the card pays what can be paid, and this only shows the
 * answer. Loaded with the Me page, so its text lives here rather than in the entry chunk.
 */
import type { ReferralFailure, ReferralMeDto, ReferralRewardDto } from '@jc/types';
import { Badge, Button, createTranslator, formatChips, formatDate, Panel } from '@jc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { copyText } from '../lib/share';
import { LinkShare } from './Share';

const ko = {
  title: '친구 추천',
  code: '내 추천 코드',
  copyCode: '코드 복사',
  codeCopied: '코드를 복사했습니다.',
  codeFailed: '복사하지 못했습니다. 코드를 직접 적어 주세요.',
  link: '추천 링크',
  linkHint: '친구가 이 링크로 가입하면 추천 코드가 자동으로 입력됩니다.',
  shareTitle: 'JC ROYAL 초대',
  shareText: 'JC ROYAL에서 함께 텍사스 홀덤을 즐겨요. 추천 코드 {code}',
  terms: '친구가 내 코드로 가입하면 친구는 {invitee}칩, 나는 {referrer}칩을 받습니다.',
  termsHands: '친구가 내 코드로 가입하고 핸드 {n}판을 마치면 친구는 {invitee}칩, 나는 {referrer}칩을 받습니다.',
  caps: '내가 받는 추천 보상은 하루 {daily}명, 모두 합쳐 {total}명까지입니다.',
  paused: '추천 보상 지급이 운영상 잠시 중지되었습니다. 대기 중인 보상은 재개되면 지급됩니다.',
  off: '지금은 추천 보상을 운영하지 않습니다. 이 기간에 내 코드로 가입한 친구에게는 보상이 없습니다.',
  invited: '추천한 친구',
  received: '보상 받음',
  waiting: '대기 중',
  earned: '받은 보상',
  waitingChips: '대기 {amount}칩',
  invitedBy: "'{name}' 님의 추천으로 가입했습니다.",
  invitedByGone: '추천 코드로 가입했습니다.',
  ownPaid: '추천 보상 {amount}칩을 받았습니다 ({at}).',
  ownHands: '핸드 {n}판을 더 마치면 추천 보상 {amount}칩을 받습니다.',
  ownWait: '추천 보상 {amount}칩을 기다리는 중입니다: {why}',
  ownNone: '추천 보상은 지급되지 않았습니다: {why}',
  recent: '최근 추천 가입',
  none: '아직 내 코드로 가입한 친구가 없습니다.',
  withdrawn: '탈퇴한 회원',
  joined: '{at} 가입',
  sidePaid: '+{amount}',
  sidePending: '대기',
  sideCapped: '한도 초과',
  sideSkipped: '보상 없음',
  sideUnpaid: '지급 안 됨',
  guide: '안내',
  g1: '추천 코드는 가입할 때 한 번만 입력할 수 있고, 한 회원은 한 사람의 추천으로만 가입합니다.',
  g2: '탈퇴 후 같은 이메일로 다시 가입하거나, 추천한 회원과 같은 이메일로 가입하면 보상이 없습니다.',
  g3: '짧은 시간에 한 사람의 코드로 가입이 몰리면 운영자가 확인한 뒤 지급합니다. 같은 인터넷 연결이라는 이유만으로 거절하지 않습니다.',
  g4: '추천 보상은 가입 축하 칩과 별도이며, 현금 가치가 없는 플레이 전용 가상 칩입니다.',
  loadFail: '추천 정보를 불러오지 못했습니다.',
  retry: '다시 시도',
  loading: '불러오는 중…',
  'why.off': '가입 당시 추천 보상이 꺼져 있었습니다',
  'why.paused': '지급이 잠시 중지되었습니다',
  'why.hands': '친구의 핸드 진행을 기다립니다',
  'why.email': '이메일 인증이 필요했습니다',
  'why.repeat_email': '이전에 가입했던 이메일입니다',
  'why.burst': '운영자가 확인하고 있습니다',
  'why.rejected': '운영자 확인 결과 지급하지 않습니다',
  'why.daily_cap': '하루 한도를 넘었습니다',
  'why.total_cap': '전체 한도를 넘었습니다',
  'why.invitee_deleted': '가입한 회원이 탈퇴했습니다',
  'why.invitee_suspended': '가입한 회원의 이용이 제한되어 있습니다',
  'why.referrer_deleted': '추천한 회원이 탈퇴했습니다',
  'why.referrer_suspended': '이용이 제한된 동안은 지급되지 않습니다',
} as const;

const en: Record<keyof typeof ko, string> = {
  title: 'Invite friends',
  code: 'My referral code',
  copyCode: 'Copy code',
  codeCopied: 'Code copied.',
  codeFailed: 'Could not copy. Please write the code down.',
  link: 'Referral link',
  linkHint: 'Friends who sign up through this link get your code filled in.',
  shareTitle: 'Join me on JC ROYAL',
  shareText: "Let's play Texas Hold'em together on JC ROYAL. Referral code {code}",
  terms: 'When a friend signs up with your code, they receive {invitee} chips and you receive {referrer} chips.',
  termsHands: 'When a friend signs up with your code and finishes {n} hands, they receive {invitee} chips and you receive {referrer} chips.',
  caps: 'Your referral rewards are limited to {daily} friends a day and {total} in total.',
  paused: 'Referral rewards are paused for now. Waiting rewards are paid once they resume.',
  off: 'Referral rewards are not offered right now. Friends who sign up with your code meanwhile receive no reward.',
  invited: 'Friends invited',
  received: 'Rewards received',
  waiting: 'Waiting',
  earned: 'Chips earned',
  waitingChips: '{amount} waiting',
  invitedBy: "You signed up with {name}'s referral code.",
  invitedByGone: 'You signed up with a referral code.',
  ownPaid: 'You received a {amount}-chip referral reward ({at}).',
  ownHands: 'Finish {n} more hands to receive a {amount}-chip referral reward.',
  ownWait: 'Your {amount}-chip referral reward is waiting: {why}',
  ownNone: 'No referral reward was paid: {why}',
  recent: 'Recent sign-ups',
  none: 'No friend has signed up with your code yet.',
  withdrawn: 'Withdrawn member',
  joined: 'Joined {at}',
  sidePaid: '+{amount}',
  sidePending: 'Waiting',
  sideCapped: 'Over limit',
  sideSkipped: 'No reward',
  sideUnpaid: 'Not paid',
  guide: 'How it works',
  g1: 'A referral code is entered once, at sign-up, and each member can be referred by one person only.',
  g2: 'Signing up again with an email used before, or with the referrer’s own email, gives no reward.',
  g3: 'When many sign-ups arrive on one code in a short time, an operator checks them before paying. Sharing an internet connection alone is never a reason to refuse.',
  g4: 'Referral rewards are separate from the welcome chips and are play-only virtual chips with no cash value.',
  loadFail: 'Could not load your referrals.',
  retry: 'Retry',
  loading: 'Loading…',
  'why.off': 'referral rewards were off when they signed up',
  'why.paused': 'payouts are paused for now',
  'why.hands': 'waiting for the new member to play their hands',
  'why.email': 'email verification was needed',
  'why.repeat_email': 'the email had been used before',
  'why.burst': 'an operator is checking it',
  'why.rejected': 'an operator decided not to pay it',
  'why.daily_cap': 'the daily limit was reached',
  'why.total_cap': 'the total limit was reached',
  'why.invitee_deleted': 'the new member withdrew',
  'why.invitee_suspended': 'the new member’s account is restricted',
  'why.referrer_deleted': 'the member who referred you withdrew',
  'why.referrer_suspended': 'nothing is paid while your account is restricted',
};

const translate = createTranslator({ ko, en });
type Tr = ReturnType<typeof translate>;

const why = (tr: Tr, f: ReferralFailure | null) => (f ? tr(`why.${f}`) : '');

/** One side's state, as a badge: paid (with the chips), waiting, or closed (with why, for the title). */
function SideBadge({ tr, r }: { tr: Tr; r: ReferralRewardDto }) {
  if (r.side === 'paid') return <Badge tone="green">{tr('sidePaid', { amount: formatChips(r.amount) })}</Badge>;
  if (r.side === 'pending') return <Badge tone="gold">{tr('sidePending')}</Badge>;
  const label = r.side === 'capped' ? tr('sideCapped') : r.side === 'skipped' ? tr('sideSkipped') : tr('sideUnpaid');
  return <Badge>{label}</Badge>;
}

/** The new member's own reward, in a sentence. */
function ownLine(tr: Tr, r: ReferralRewardDto, at: (ms: number) => string) {
  const amount = formatChips(r.amount);
  if (r.side === 'paid') return tr('ownPaid', { amount, at: at(r.paidAt ?? r.createdAt) });
  if (r.side === 'pending' && r.failure === 'hands' && (r.handsLeft ?? 0) > 0) return tr('ownHands', { n: r.handsLeft ?? 0, amount });
  if (r.side === 'pending') return tr('ownWait', { amount, why: why(tr, r.failure === 'hands' ? null : r.failure) || tr('why.paused') });
  return r.amount > 0 && r.failure ? tr('ownNone', { why: why(tr, r.failure) }) : null;
}

export function ReferralCard({ onPaid }: { onPaid?: () => unknown }) {
  const { locale } = useI18n();
  const { refresh } = useAuth();
  const tr = translate(locale);
  const [data, setData] = useState<ReferralMeDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const alive = useRef(true);
  // Read when a payout shows, so loading does not start again each time the page re-renders.
  const after = useRef({ refresh, onPaid });
  after.current = { refresh, onPaid };
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<ReferralMeDto>('/api/me/referral');
      if (!alive.current) return;
      setData(d);
      setFailed(false);
      // Opening the card pays what can be paid: then the wallet and the ledger shown follow.
      if (d.paidNow > 0) {
        void after.current.refresh().catch(() => undefined);
        void after.current.onPaid?.();
      }
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!copied) return;
    const h = setTimeout(() => setCopied(null), 2_500);
    return () => clearTimeout(h);
  }, [copied]);

  const at = (ms: number) => formatDate(ms, locale);
  const p = data?.policy;
  const on = !!p?.enabled;
  return (
    <Panel title={tr('title')}>
      <div className="flex flex-col gap-4" data-testid="referral-card" data-state={data ? (on ? (p!.paused ? 'paused' : 'on') : 'off') : failed ? 'failed' : 'loading'}>
        {!data ? (
          failed ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[#f3b0b2]">{tr('loadFail')}</span>
              <Button size="sm" variant="outline" loading={loading} onClick={() => void load()} data-testid="referral-retry">
                {tr('retry')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-400">{tr('loading')}</p>
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-ink-300">{tr('code')}</div>
                <div className="font-mono text-2xl font-semibold tracking-[0.12em] text-gold-300" data-testid="referral-my-code">
                  {data.code}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={async () => setCopied((await copyText(data.code)) ? 'ok' : 'failed')} data-testid="referral-copy-code">
                {tr('copyCode')}
              </Button>
              <span role="status" aria-live="polite" className={`text-xs ${copied === 'failed' ? 'text-[#f3b0b2]' : 'text-gold-300'}`}>
                {copied === 'ok' ? tr('codeCopied') : copied === 'failed' ? tr('codeFailed') : ''}
              </span>
            </div>
            <LinkShare data={{ title: tr('shareTitle'), text: tr('shareText', { code: data.code }), url: data.link }} label={tr('link')} hint={tr('linkHint')} testId="referral-link" />
            <div className="flex flex-col gap-1 rounded-lg border border-white/10 bg-ink-850/60 px-3 py-2.5 text-sm" data-testid="referral-terms">
              {on ? (
                <>
                  <p className="text-ink-100">
                    {p!.minHands > 0
                      ? tr('termsHands', { n: p!.minHands, invitee: formatChips(p!.inviteeAmount), referrer: formatChips(p!.referrerAmount) })
                      : tr('terms', { invitee: formatChips(p!.inviteeAmount), referrer: formatChips(p!.referrerAmount) })}
                  </p>
                  <p className="text-xs text-ink-400">{tr('caps', { daily: p!.dailyCap, total: p!.totalCap })}</p>
                  {p!.paused && <p className="text-xs text-gold-300">{tr('paused')}</p>}
                </>
              ) : (
                <p className="text-ink-300">{tr('off')}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="referral-counts">
              <Count label={tr('invited')} value={data.counts.invited} testId="referral-invited" />
              <Count label={tr('received')} value={data.counts.paid} testId="referral-paid" />
              <Count label={tr('waiting')} value={data.counts.pending} testId="referral-pending" />
              <Count
                label={tr('earned')}
                value={formatChips(data.earned)}
                sub={data.waiting > 0 ? tr('waitingChips', { amount: formatChips(data.waiting) }) : undefined}
                testId="referral-earned"
              />
            </div>
            {data.invitedBy && (
              <div className="flex flex-col gap-1 rounded-lg border border-gold-500/25 bg-gold-500/5 px-3 py-2.5 text-sm" data-testid="referral-invited-by" data-side={data.invitedBy.side}>
                <p className="text-ink-100">{data.invitedBy.nickname ? tr('invitedBy', { name: data.invitedBy.nickname }) : tr('invitedByGone')}</p>
                {ownLine(tr, data.invitedBy, at) && <p className="text-ink-200">{ownLine(tr, data.invitedBy, at)}</p>}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <div className="text-xs font-semibold text-ink-300">{tr('recent')}</div>
              {data.recent.length === 0 ? (
                <p className="text-sm text-ink-400">{tr('none')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-white/5" data-testid="referral-recent">
                  {data.recent.map((r, i) => (
                    <li key={`${r.createdAt}-${i}`} className="flex items-center justify-between gap-3 py-2 text-sm" data-side={r.side}>
                      <div className="min-w-0">
                        <div className="truncate text-ink-100">{r.nickname ?? <span className="text-ink-400">{tr('withdrawn')}</span>}</div>
                        <div className="text-xs text-ink-400">
                          {tr('joined', { at: at(r.createdAt) })}
                          {r.side !== 'paid' && r.failure ? ` · ${why(tr, r.failure)}` : ''}
                        </div>
                      </div>
                      <SideBadge tr={tr} r={r} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <details className="text-sm text-ink-300">
              <summary className="cursor-pointer text-xs font-semibold text-ink-300">{tr('guide')}</summary>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-xs text-ink-400">
                <li>{tr('g1')}</li>
                <li>{tr('g2')}</li>
                <li>{tr('g3')}</li>
                <li>{tr('g4')}</li>
              </ul>
            </details>
          </>
        )}
      </div>
    </Panel>
  );
}

function Count({ label, value, sub, testId }: { label: string; value: string | number; sub?: string; testId: string }) {
  return (
    <div className="rounded-lg bg-ink-850/80 px-3 py-2 text-center">
      <div className="text-[11px] text-ink-400">{label}</div>
      <div className="font-mono text-base font-semibold tabular-nums" data-testid={testId}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-ink-400">{sub}</div>}
    </div>
  );
}
