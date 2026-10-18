/**
 * Referral rewards (the API's lib/referral.ts and routes/admin-referral.ts): the policy and who changed it, the emergency
 * pause, referrals by state and the chips paid (checked against the ledger), the period's signups and why some were not
 * paid, the referrers with the most signups, and every referral with its review. One member's referrals are on their
 * page (MemberReferralPanel).
 *
 * Rewards paid are never edited here: one paid in error is taken back with the member's chip adjustment. Rejecting closes
 * only the sides not paid yet. No e-mail address or network is shown: only whether the referrer was seen on the new
 * member's network, which alone never refuses a referral.
 */
import { Badge, Button, Empty, Field, formatChips, formatDate, Input, Panel, Stat } from '@jc/ui';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useT, type Key } from '../i18n';
import { userStatusLabel, type Tr } from '../labels';
import { ApiError, canDo, errText, useAdmin, useData } from '../lib';
import { Feedback, ListState, LoadError, Modal, PageState, Pager, type Note } from '../ui';
import { Table } from './Console';

interface Policy { version: number; enabled: boolean; paused: boolean; referrerAmount: number; inviteeAmount: number; dailyCap: number; totalCap: number; minHands: number; burstLimit: number }
interface Version extends Policy { change: 'seed' | 'policy' | 'pause' | 'resume'; actorId: string | null; actorNickname: string | null; reason: string | null; createdAt: number }
type Range = { min: number; max: number };
type Limits = Record<'amount' | 'dailyCap' | 'totalCap' | 'minHands' | 'burstLimit', Range>;
const STATUSES = ['pending', 'review', 'settled', 'unpaid'] as const;
type Status = (typeof STATUSES)[number];
const FAILURES = ['off', 'paused', 'hands', 'email', 'repeat_email', 'burst', 'rejected', 'daily_cap', 'total_cap', 'invitee_deleted', 'invitee_suspended', 'referrer_deleted', 'referrer_suspended'] as const;
type Side = 'pending' | 'paid' | 'capped' | 'skipped' | 'unpaid';
interface Overview {
  policy: Version | null;
  versions: Version[];
  limits: Limits;
  counts: Record<Status, number>;
  paid: { invitees: number; inviteeChips: number; referrers: number; referrerChips: number; chips: number };
  integrity: { ledgerRows: number; ledgerSum: number; paidRows: number; paidSum: number; unlinked: number; ok: boolean };
  period: { days: number; since: number; created: number; review: number; sameIp: number; inviteesPaid: number; referrersPaid: number; failures: Record<string, number> };
  top: { userId: string; nickname: string | null; status: string | null; n: number; paid: number; review: number; sameIp: number; lastAt: number }[];
  now: number;
}
interface Item {
  id: string;
  code: string;
  status: Status;
  referrerId: string;
  referrerNickname: string | null;
  referrerAccount: string | null;
  inviteeId: string;
  inviteeNickname: string | null;
  inviteeAccount: string | null;
  referrerStatus: Side;
  inviteeStatus: Side;
  referrerAmount: number;
  inviteeAmount: number;
  policyVersion: number;
  minHands: number;
  failure: string | null;
  sameIp: boolean;
  emailVerified: boolean;
  referrerPaidAt: number | null;
  inviteePaidAt: number | null;
  reviewerNickname: string | null;
  reviewReason: string | null;
  reviewedAt: number | null;
  createdAt: number;
}
interface MemberReferral {
  member: { nickname: string; status: string; role: string };
  code: { code: string; createdAt: number } | null;
  invitedBy: Item | null;
  totals: { invited: number; paid: number; pending: number; review: number; earned: number };
  items: Item[];
  hasMore: boolean;
}
type Paid = { invitee: number; referrer: number };

const td = 'px-2 py-1.5';
const selectCls = 'h-11 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm';
const PERIODS = [7, 30, 90] as const;
const PAGE = 50;
const STATUS: Record<Status, Key> = { pending: 'referralStPending', review: 'referralStReview', settled: 'referralStSettled', unpaid: 'referralStUnpaid' };
const STATUS_TONE: Record<Status, 'gold' | 'red' | 'green' | 'neutral'> = { pending: 'gold', review: 'red', settled: 'green', unpaid: 'neutral' };
const SIDE: Record<Side, Key> = { pending: 'referralSidePending', paid: 'referralSidePaid', capped: 'referralSideCapped', skipped: 'referralSideSkipped', unpaid: 'referralSideUnpaid' };
const FAILURE: Record<(typeof FAILURES)[number], Key> = {
  off: 'referralWhyOff',
  paused: 'referralWhyPaused',
  hands: 'referralWhyHands',
  email: 'referralWhyEmail',
  repeat_email: 'referralWhyRepeatEmail',
  burst: 'referralWhyBurst',
  rejected: 'referralWhyRejected',
  daily_cap: 'referralWhyDailyCap',
  total_cap: 'referralWhyTotalCap',
  invitee_deleted: 'referralWhyInviteeDeleted',
  invitee_suspended: 'referralWhyInviteeSuspended',
  referrer_deleted: 'referralWhyReferrerDeleted',
  referrer_suspended: 'referralWhyReferrerSuspended',
};
const CHANGE: Record<Version['change'], Key> = { seed: 'refillChangeSeed', policy: 'refillChangePolicy', pause: 'refillChangePause', resume: 'refillChangeResume' };
/** Defaults offered when there is no policy yet: development values, never decided for the service here. */
const FIRST: Omit<Policy, 'version' | 'paused'> = { enabled: false, referrerAmount: 0, inviteeAmount: 0, dailyCap: 5, totalCap: 50, minHands: 1, burstLimit: 3 };

export function referralWhy(t: Tr, failure: string | null | undefined): string {
  if (!failure) return '';
  return Object.hasOwn(FAILURE, failure) ? t(FAILURE[failure as keyof typeof FAILURE]) : failure;
}

function UserLink({ id, name, account }: { id: string; name: string | null; account?: string | null }) {
  const { t } = useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Link to={`/users/${id}`} className="text-gold-300 hover:underline">{name ?? id}</Link>
      {account && account !== 'active' && <Badge tone="red">{userStatusLabel(t, account)}</Badge>}
    </span>
  );
}

function PolicyBadges({ p }: { p: Pick<Policy, 'enabled' | 'paused'> }) {
  const { t } = useT();
  return (
    <>
      <Badge tone={p.enabled ? 'green' : 'neutral'}>{p.enabled ? t('refillOn') : t('refillOff')}</Badge>
      {p.paused && <Badge tone="red">{t('referralPausedBadge')}</Badge>}
    </>
  );
}

function StatusBadge({ s }: { s: Status }) {
  const { t } = useT();
  return <Badge tone={STATUS_TONE[s]}>{t(STATUS[s])}</Badge>;
}

/** Both sides of a referral: the amount promised and what became of it. */
function Sides({ r }: { r: Item }) {
  const { t, locale } = useT();
  const line = (who: Key, side: Side, amount: number, at: number | null) => (
    <li className="whitespace-nowrap" data-side={side}>
      <span className="text-ink-400">{t(who)}</span> <span className="font-mono">{formatChips(amount)}</span> · <span className={side === 'paid' ? 'text-success' : side === 'pending' ? 'text-gold-300' : 'text-ink-300'}>{t(SIDE[side])}</span>
      {at ? <span className="text-ink-400"> · {formatDate(at, locale)}</span> : null}
    </li>
  );
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {line('referralReferrer', r.referrerStatus, r.referrerAmount, r.referrerPaidAt)}
      {line('referralInvitee', r.inviteeStatus, r.inviteeAmount, r.inviteePaidAt)}
    </ul>
  );
}

function Signals({ r }: { r: Item }) {
  const { t } = useT();
  return (
    <span className="flex flex-wrap gap-1">
      {r.sameIp && <Badge tone="gold">{t('referralSameIp')}</Badge>}
      {!r.emailVerified && <Badge>{t('referralNotVerified')}</Badge>}
      {r.minHands > 0 && <Badge>{t('referralHandsN', { n: r.minHands })}</Badge>}
    </span>
  );
}

function paidText(t: Tr, paid: Paid): string {
  return paid.invitee + paid.referrer > 0 ? t('referralPaidNow', { referrer: formatChips(paid.referrer), invitee: formatChips(paid.invitee) }) : t('referralPaidNothing');
}

export function ReferralsPage() {
  const { t } = useT();
  const { me } = useAdmin();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const overview = useData<Overview>(`/api/admin/referrals?days=${days}`);
  const [note, setNote] = useState<Note>(null);
  const [params] = useSearchParams();
  const [user, setUser] = useState(params.get('user')?.trim() ?? '');
  const superAdmin = canDo(me, 'referral.policy');
  // Every change reloads the policy, the totals and the list.
  const [rev, setRev] = useState(0);
  const changed = async (n: Note) => {
    setNote(n);
    setRev((x) => x + 1);
    await overview.reload();
  };
  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-extrabold">{t('referralTitle')}</h1>
      <Link to="/economy" className="text-sm text-gold-300 hover:underline">{t('economy')} →</Link>
      <Button className="ml-auto" size="sm" variant="subtle" onClick={() => void overview.reload()} loading={overview.loading} data-testid="referral-reload">{t('refresh')}</Button>
    </div>
  );
  if (!overview.data) return <div className="flex flex-col gap-4">{header}<PageState error={overview.error} onRetry={overview.reload} /></div>;
  const o = overview.data;
  return (
    <div className="flex flex-col gap-6">
      {header}
      <p className="text-sm text-ink-300">{t('referralIntro')}</p>
      <Feedback note={note} testid="referral-feedback" pin />
      {overview.error && <LoadError error={overview.error} onRetry={overview.reload} />}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel title={t('refillPolicy')}>
          <PolicyView o={o} superAdmin={superAdmin} onChanged={changed} />
        </Panel>
        <Panel title={t('refillEdit')}>
          {superAdmin ? (
            // A new version starts the form again from what is now in force.
            <PolicyForm key={o.policy?.version ?? 0} o={o} onChanged={changed} />
          ) : (
            <p className="text-sm text-ink-400" data-testid="referral-edit-super-only">{t('referralEditSuperOnly')}</p>
          )}
        </Panel>
      </div>
      <Totals o={o} />
      <Period o={o} days={days} setDays={setDays} loading={overview.loading} onPick={setUser} />
      <ReferralList key={`l${rev}`} user={user} setUser={setUser} onChanged={changed} />
      <Panel title={t('refillVersions')}>
        <VersionTable rows={o.versions} />
      </Panel>
    </div>
  );
}

function PolicyView({ o, superAdmin, onChanged }: { o: Overview; superAdmin: boolean; onChanged: (n: Note) => Promise<void> }) {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const p = o.policy;
  const [ask, setAsk] = useState<'pause' | 'resume' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const to = ask;
    if (!to) return;
    setBusy(true);
    try {
      await api(`/api/admin/referrals/${to}`, { body: { reason: reason.trim() } });
      setAsk(null);
      setReason('');
      await onChanged({ ok: true, text: t(to === 'pause' ? 'referralPausedDone' : 'referralResumedDone') });
    } catch (e) {
      setAsk(null);
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) await onChanged({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  if (!p) return <p className="text-sm text-ink-400" data-testid="referral-no-policy">{t('referralNoPolicy')}</p>;
  const waiting = o.counts.pending + o.counts.review;
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="referral-policy" data-paused={p.paused ? 'true' : 'false'} data-enabled={p.enabled ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-ink-400">{t('refillVersion', { n: p.version })}</span>
        <PolicyBadges p={p} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t('referralReferrerAmount')} value={formatChips(p.referrerAmount)} />
        <Stat label={t('referralInviteeAmount')} value={formatChips(p.inviteeAmount)} />
        <Stat label={t('referralMinHands')} value={p.minHands} />
        <Stat label={t('referralDailyCap')} value={p.dailyCap} />
        <Stat label={t('referralTotalCap')} value={p.totalCap} />
        <Stat label={t('referralBurst')} value={p.burstLimit} />
      </div>
      <p className="text-xs text-ink-300">
        {t('refillLastChange', { kind: t(CHANGE[p.change]), at: formatDate(p.createdAt, locale), who: p.actorNickname ?? t('refillSystem') })}
        {p.reason ? ` · ${p.reason}` : ''}
      </p>
      <p className="text-xs text-ink-400" data-testid="referral-waiting">{t('referralWaitingLine', { n: waiting })}</p>
      <div className="flex flex-col gap-2 rounded-xl border border-white/10 p-3">
        {p.paused ? (
          superAdmin ? (
            <Button variant="gold" onClick={() => setAsk('resume')} data-testid="referral-resume">{t('referralResume')}</Button>
          ) : (
            <p className="text-xs text-ink-400">{t('referralResumeSuperOnly')}</p>
          )
        ) : (
          <Button variant="danger" onClick={() => setAsk('pause')} data-testid="referral-pause">{t('referralPause')}</Button>
        )}
        <p className="text-xs text-ink-400">{t('referralPauseHint')}</p>
      </div>
      <Modal
        open={ask !== null}
        onClose={() => setAsk(null)}
        title={ask === 'resume' ? t('referralResume') : t('referralPause')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsk(null)}>{t('cancel')}</Button>
            <Button variant={ask === 'resume' ? 'gold' : 'danger'} disabled={reason.trim().length < 2} loading={busy} onClick={submit} data-testid="referral-switch-confirm">{t('confirm')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>{ask === 'resume' ? t('referralResumeConfirm', { n: waiting }) : t('referralPauseConfirm', { n: waiting })}</p>
          <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="referral-switch-reason" />}</Field>
        </div>
      </Modal>
    </div>
  );
}

interface PolicyPreview { from: Policy | null; to: Policy; appliesFrom: { terms: 'next_signup'; caps: 'next_payout' }; waiting: number }
type NumKey = 'referrerAmount' | 'inviteeAmount' | 'minHands' | 'dailyCap' | 'totalCap' | 'burstLimit';
const FIELDS: [NumKey, Key, keyof Limits, string][] = [
  ['referrerAmount', 'referralReferrerAmount', 'amount', 'referral-referrer-amount'],
  ['inviteeAmount', 'referralInviteeAmount', 'amount', 'referral-invitee-amount'],
  ['minHands', 'referralMinHands', 'minHands', 'referral-min-hands'],
  ['dailyCap', 'referralDailyCap', 'dailyCap', 'referral-daily-cap'],
  ['totalCap', 'referralTotalCap', 'totalCap', 'referral-total-cap'],
  ['burstLimit', 'referralBurst', 'burstLimit', 'referral-burst'],
];

function PolicyForm({ o, onChanged }: { o: Overview; onChanged: (n: Note) => Promise<void> }) {
  const { t } = useT();
  const { api } = useAdmin();
  const base = o.policy ?? { ...FIRST, version: 0, paused: false };
  const [enabled, setEnabled] = useState(base.enabled);
  const [v, setV] = useState<Record<NumKey, string>>(() => Object.fromEntries(FIELDS.map(([k]) => [k, String(base[k])])) as Record<NumKey, string>);
  const [pv, setPv] = useState<PolicyPreview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const num = (k: NumKey) => Number(v[k]);
  const inRange = (n: number, r: Range) => Number.isInteger(n) && n >= r.min && n <= r.max;
  const bad = Object.fromEntries(FIELDS.map(([k, , l]) => [k, v[k] === '' || !inRange(num(k), o.limits[l])])) as Record<NumKey, boolean>;
  // The API's own checks (lib/referral.ts policyIssue), told before asking it.
  const nothing = enabled && num('referrerAmount') + num('inviteeAmount') <= 0;
  const capsOrder = !bad.dailyCap && !bad.totalCap && num('dailyCap') > num('totalCap');
  const invalid = Object.values(bad).some(Boolean) || nothing || capsOrder;
  const next = { baseVersion: base.version, enabled, ...(Object.fromEntries(FIELDS.map(([k]) => [k, num(k)])) as Record<NumKey, number>) };
  const fail = async (e: unknown) => {
    setPv(null);
    if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
    // Someone else's change came first: the page shows the policy now in force, and this form starts again from it.
    if (e instanceof ApiError && e.code === 'referral_policy_conflict') return onChanged({ ok: false, text: errText(e, t) });
    setError(errText(e, t));
  };
  const preview = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setReason('');
    setBusy(true);
    try {
      setPv(await api<PolicyPreview>('/api/admin/referrals/policy', { method: 'PUT', body: { ...next, preview: true } }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      await api('/api/admin/referrals/policy', { method: 'PUT', body: { ...next, reason: reason.trim() } });
      setPv(null);
      await onChanged({ ok: true, text: t('referralPolicySaved') });
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const rows: [Key, (p: Policy) => string][] = [
    ['referralEnabled', (p) => (p.enabled ? t('refillOn') : t('refillOff'))],
    ...FIELDS.map(([k, label]): [Key, (p: Policy) => string] => [label, (p) => (k.endsWith('Amount') ? formatChips(p[k]) : String(p[k]))]),
  ];
  return (
    <form className="flex flex-col gap-3" onSubmit={preview} data-testid="referral-form">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 cursor-pointer accent-gold-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="referral-enabled" />
        {t('referralEnabled')}
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map(([k, label, l, testid]) => (
          <Field key={k} label={t(label)} hint={t('refillRange', { min: formatChips(o.limits[l].min), max: formatChips(o.limits[l].max) })} error={bad[k] ? t('refillOutOfRange') : null}>
            {(fid) => <Input id={fid} inputMode="numeric" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value.replace(/\D/g, '') })} data-testid={testid} />}
          </Field>
        ))}
      </div>
      <ul className="flex flex-col gap-1 text-xs text-ink-400">
        <li>{t('referralHelpHands')}</li>
        <li>{t('referralHelpCaps')}</li>
        <li>{t('referralHelpBurst')}</li>
      </ul>
      {(nothing || capsOrder) && (
        <p className="text-sm text-danger" role="alert" data-testid="referral-form-issue">{t(nothing ? 'errReferralNothingToPay' : 'errReferralCapsOrder')}</p>
      )}
      <p className="text-xs text-ink-400">{t('referralEditHint')}</p>
      {error && <p className="text-sm text-danger" role="alert" data-testid="referral-form-error">{error}</p>}
      <Button type="submit" disabled={invalid} loading={busy && !pv} data-testid="referral-preview">{t('refillPreviewBtn')}</Button>
      <Modal
        open={pv !== null}
        onClose={() => setPv(null)}
        title={t('refillPreviewTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPv(null)}>{t('cancel')}</Button>
            <Button variant="gold" disabled={reason.trim().length < 2} loading={busy} onClick={apply} data-testid="referral-apply">{t('confirm')}</Button>
          </>
        }
      >
        {pv && (
          <div className="flex flex-col gap-3 text-sm" data-testid="referral-change">
            <p className="font-mono text-xs text-ink-400">{t('refillVersionChange', { from: pv.from?.version ?? 0, to: pv.to.version })}</p>
            <ul className="flex flex-col gap-1">
              {rows.map(([k, show]) => {
                const from = pv.from ? show(pv.from) : '—';
                const to = show(pv.to);
                return (
                  <li key={k} className={from === to ? 'text-ink-400' : 'font-semibold'} data-changed={from !== to}>
                    <span className="font-normal text-ink-400">{t(k)}:</span> {from === to ? to : t('histChange', { from, to })}
                  </li>
                );
              })}
            </ul>
            <p className="rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="referral-applies">{t('referralApplies', { n: pv.waiting })}</p>
            {pv.to.paused && <p className="text-xs text-danger">{t('referralPausedKept')}</p>}
            {pv.from?.enabled && !pv.to.enabled && <p className="text-xs text-ink-300">{t('referralTurnOffNote')}</p>}
            <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="referral-reason" />}</Field>
            <p className="text-xs text-ink-400">{t('pvBasis')}</p>
          </div>
        )}
      </Modal>
    </form>
  );
}

/** Referrals by state, the chips paid, and whether the ledger's referral rows say the same. */
function Totals({ o }: { o: Overview }) {
  const { t } = useT();
  const i = o.integrity;
  return (
    <Panel title={t('referralTotals')}>
      <div className="flex flex-col gap-4 text-sm" data-testid="referral-totals">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {STATUSES.map((s) => (
            <Stat key={s} label={t(STATUS[s])} value={<span data-testid={`referral-count-${s}`}>{formatChips(o.counts[s])}</span>} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat label={t('referralPaidChips')} value={<span data-testid="referral-paid-chips">{formatChips(o.paid.chips)}</span>} />
          <Stat label={t('referralPaidReferrers')} value={formatChips(o.paid.referrerChips)} sub={t('referralSidesN', { n: formatChips(o.paid.referrers) })} />
          <Stat label={t('referralPaidInvitees')} value={formatChips(o.paid.inviteeChips)} sub={t('referralSidesN', { n: formatChips(o.paid.invitees) })} />
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 p-3" data-testid="referral-integrity" data-ok={i.ok && i.unlinked === 0 ? 'true' : 'false'}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold">{t('referralIntegrity')}</h3>
            <Badge tone={i.ok && i.unlinked === 0 ? 'green' : 'red'}>{i.ok && i.unlinked === 0 ? t('botsIntegrityOk') : t('botsIntegrityBad')}</Badge>
          </div>
          <p className="font-mono text-xs text-ink-300">{t('referralIntegrityLine', { ledgerRows: formatChips(i.ledgerRows), ledgerSum: formatChips(i.ledgerSum), paidRows: formatChips(i.paidRows), paidSum: formatChips(i.paidSum) })}</p>
          {i.unlinked > 0 && <p className="text-xs text-danger">{t('referralUnlinked', { n: i.unlinked })}</p>}
          <p className="text-xs text-ink-400">{t('referralIntegrityHint')}</p>
        </div>
      </div>
    </Panel>
  );
}

function Period({ o, days, setDays, loading, onPick }: { o: Overview; days: number; setDays: (d: (typeof PERIODS)[number]) => void; loading: boolean; onPick: (userId: string) => void }) {
  const { t, locale } = useT();
  const p = o.period;
  const failures = Object.entries(p.failures).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return (
    <Panel
      title={t('referralPeriodTitle', { n: days })}
      actions={
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('econPeriod')}>
          {PERIODS.map((n) => (
            <Button key={n} size="sm" variant={days === n ? 'gold' : 'outline'} aria-pressed={days === n} onClick={() => setDays(n)} data-testid={`referral-days-${n}`}>{t('daysN', { n })}</Button>
          ))}
        </div>
      }
    >
      <div className={`flex flex-col gap-6 text-sm transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading} data-testid="referral-period">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label={t('referralSignups')} value={<span data-testid="referral-period-created">{formatChips(p.created)}</span>} />
          <Stat label={t('referralPaidReferrers')} value={formatChips(p.referrersPaid)} />
          <Stat label={t('referralPaidInvitees')} value={formatChips(p.inviteesPaid)} />
          <Stat label={t('referralStReview')} value={formatChips(p.review)} />
          <Stat label={t('referralSameIp')} value={formatChips(p.sameIp)} />
        </div>
        <p className="text-xs text-ink-400">{t('referralSameIpHint')}</p>
        <div className="flex flex-col gap-2" data-testid="referral-failures">
          <h3 className="text-sm font-bold">{t('referralFailures')}</h3>
          {failures.length === 0 ? (
            <p className="text-ink-400">{t('noneFound')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {failures.map(([k, n]) => (
                <li key={k} data-failure={k}><Badge tone={k === 'burst' || k === 'rejected' ? 'gold' : 'neutral'}>{referralWhy(t, k)} {formatChips(n)}</Badge></li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-2" data-testid="referral-top">
          <h3 className="text-sm font-bold">{t('referralTop')}</h3>
          <p className="text-xs text-ink-400">{t('referralTopHint')}</p>
          {o.top.length === 0 ? (
            <p className="text-ink-400">{t('noneFound')}</p>
          ) : (
            <Table head={[t('colUser'), t('referralSignups'), t('referralSidePaid'), t('referralStReview'), t('referralSameIp'), t('referralLastAt'), '']}>
              {o.top.map((r) => (
                <tr key={r.userId}>
                  <td className={td}><UserLink id={r.userId} name={r.nickname} account={r.status} /></td>
                  <td className={`${td} font-mono`}>{r.n}</td>
                  <td className={`${td} font-mono`}>{r.paid}</td>
                  <td className={`${td} font-mono ${r.review ? 'text-danger' : ''}`}>{r.review}</td>
                  <td className={`${td} font-mono`}>{r.sameIp}</td>
                  <td className={`${td} text-xs text-ink-400`}>{formatDate(r.lastAt, locale)}</td>
                  <td className={td}><Button size="sm" variant="outline" onClick={() => onPick(r.userId)} data-testid="referral-top-pick">{t('referralShowList')}</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </div>
    </Panel>
  );
}

type Act = { kind: 'approve' | 'reject'; item: Item };

function ReferralList({ user, setUser, onChanged }: { user: string; setUser: (u: string) => void; onChanged: (n: Note) => Promise<void> }) {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  const [sameIp, setSameIp] = useState(false);
  const [text, setText] = useState(user);
  const [offset, setOffset] = useState(0);
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (status) q.set('status', status);
  if (failure) q.set('failure', failure);
  if (user) q.set('user', user);
  if (sameIp) q.set('sameIp', '1');
  const { data, error, loading, reload } = useData<{ items: Item[]; hasMore: boolean }>(`/api/admin/referrals/list?${q}`);
  const rows = data?.items ?? [];
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };
  const filtered = !!(status || failure || user || sameIp);
  const reset = () => {
    setStatus('');
    setFailure('');
    setSameIp(false);
    setText('');
    setUser('');
    setOffset(0);
  };
  const [act, setAct] = useState<Act | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, path: string, body: unknown, done: (r: { paid?: Paid }) => string) => {
    setBusy(id);
    try {
      const r = await api<{ paid?: Paid }>(`/api/admin/referrals/${encodeURIComponent(id)}/${path}`, body === undefined ? { method: 'POST' } : { body });
      setAct(null);
      setReason('');
      await onChanged({ ok: true, text: done(r) });
    } catch (e) {
      setAct(null);
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) await onChanged({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(null);
    }
  };
  const confirm = () => {
    if (!act) return;
    const { kind, item } = act;
    void run(item.id, kind, { reason: reason.trim() }, (r) => (kind === 'approve' ? `${t('referralApproved')} ${paidText(t, r.paid ?? { invitee: 0, referrer: 0 })}` : t('referralRejected')));
  };
  return (
    <Panel title={t('referralList')} className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-ink-400">{t('referralListHint')}</p>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); filter(setUser)(text.trim()); }}>
          <select aria-label={t('status')} value={status} onChange={(e) => filter(setStatus)(e.target.value)} className={selectCls} data-testid="referral-filter-status">
            <option value="">{t('status')}: {t('statusAll')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t('status')}: {t(STATUS[s])}</option>)}
          </select>
          <select aria-label={t('referralWhy')} value={failure} onChange={(e) => filter(setFailure)(e.target.value)} className={selectCls} data-testid="referral-filter-failure">
            <option value="">{t('referralWhy')}: {t('statusAll')}</option>
            {FAILURES.map((f) => <option key={f} value={f}>{t('referralWhy')}: {referralWhy(t, f)}</option>)}
          </select>
          <label className="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm">
            <input type="checkbox" className="size-4 cursor-pointer accent-gold-500" checked={sameIp} onChange={(e) => filter(setSameIp)(e.target.checked)} data-testid="referral-filter-same-ip" />
            {t('referralSameIp')}
          </label>
          <Input className="min-w-0 flex-1 basis-56" placeholder={t('referralUserFilter')} aria-label={t('referralUserFilter')} value={text} maxLength={64} onChange={(e) => setText(e.target.value)} data-testid="referral-filter-user" />
          <Button type="submit" variant="subtle">{t('searchBtn')}</Button>
          {filtered && <Button type="button" variant="ghost" onClick={reset} data-testid="referral-filter-reset">{t('auditReset')}</Button>}
        </form>
        {error && <LoadError error={error} onRetry={reload} />}
        <ListState loading={loading} empty={rows.length === 0} />
        {rows.length > 0 && (
          <div data-testid="referral-list">
            <Table head={[t('time'), t('referralReferrer'), t('referralInvitee'), t('status'), t('referralRewards'), t('referralSignals'), t('referralReview'), '']}>
              {rows.map((r) => (
                <tr key={r.id} data-referral={r.id} data-status={r.status}>
                  <td className={`${td} text-xs text-ink-400`}>
                    {formatDate(r.createdAt, locale)}
                    <div className="font-mono">{r.code} · v{r.policyVersion}</div>
                  </td>
                  <td className={td}><UserLink id={r.referrerId} name={r.referrerNickname} account={r.referrerAccount} /></td>
                  <td className={td}><UserLink id={r.inviteeId} name={r.inviteeNickname} account={r.inviteeAccount} /></td>
                  <td className={td}>
                    <StatusBadge s={r.status} />
                    {r.failure && <div className="mt-1 text-xs text-ink-300" data-testid="referral-why">{referralWhy(t, r.failure)}</div>}
                  </td>
                  <td className={td}><Sides r={r} /></td>
                  <td className={td}><Signals r={r} /></td>
                  <td className={`${td} text-xs`}>
                    {r.reviewedAt ? (
                      <span className="text-ink-300">{r.reviewerNickname ?? '—'} · {formatDate(r.reviewedAt, locale)}<span className="block break-all text-ink-400">{r.reviewReason}</span></span>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className={td}>
                    <span className="flex flex-wrap justify-end gap-1">
                      {r.status === 'review' && (
                        <Button size="sm" variant="gold" onClick={() => { setReason(''); setAct({ kind: 'approve', item: r }); }} data-testid="referral-approve">{t('referralApprove')}</Button>
                      )}
                      {r.status === 'pending' && (
                        <Button size="sm" variant="outline" loading={busy === r.id} onClick={() => void run(r.id, 'settle', undefined, (x) => paidText(t, x.paid ?? { invitee: 0, referrer: 0 }))} data-testid="referral-settle">{t('referralSettle')}</Button>
                      )}
                      {(r.status === 'review' || r.status === 'pending') && (
                        <Button size="sm" variant="danger" onClick={() => { setReason(''); setAct({ kind: 'reject', item: r }); }} data-testid="referral-reject">{t('referralReject')}</Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        )}
        {(offset > 0 || rows.length > 0) && (
          <Pager
            label={t('referralList')}
            testid="referral-list-pager"
            range={rows.length ? t('auditRangeNoTotal', { from: offset + 1, to: offset + rows.length }) : ''}
            prev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null}
            next={data?.hasMore ? () => setOffset(offset + PAGE) : null}
            busy={loading}
          />
        )}
      </div>
      <Modal
        open={act !== null}
        onClose={() => setAct(null)}
        title={act?.kind === 'approve' ? t('referralApprove') : t('referralReject')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAct(null)}>{t('cancel')}</Button>
            <Button variant={act?.kind === 'approve' ? 'gold' : 'danger'} disabled={reason.trim().length < 2} loading={!!act && busy === act.item.id} onClick={confirm} data-testid="referral-act-confirm">{t('confirm')}</Button>
          </>
        }
      >
        {act && (
          <div className="flex flex-col gap-3 text-sm" data-testid="referral-act">
            <p className="text-ink-200">
              {t('referralActWho', { referrer: act.item.referrerNickname ?? act.item.referrerId, invitee: act.item.inviteeNickname ?? act.item.inviteeId })}
            </p>
            <Sides r={act.item} />
            <p>{act.kind === 'approve' ? t('referralApproveConfirm') : t('referralRejectConfirm')}</p>
            <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="referral-act-reason" />}</Field>
          </div>
        )}
      </Modal>
    </Panel>
  );
}

function VersionTable({ rows }: { rows: Version[] }) {
  const { t, locale } = useT();
  if (rows.length === 0) return <Empty>{t('noneFound')}</Empty>;
  return (
    <div data-testid="referral-versions">
      <Table head={[t('refillColVersion'), t('time'), t('colKind'), t('refillColState'), t('referralReferrerAmount'), t('referralInviteeAmount'), t('referralMinHands'), t('referralCapsShort'), t('referralBurst'), t('actor'), t('reason')]}>
        {rows.map((v) => (
          <tr key={v.version}>
            <td className={`${td} font-mono`}>v{v.version}</td>
            <td className={`${td} text-xs text-ink-400`}>{formatDate(v.createdAt, locale)}</td>
            <td className={td}>{t(CHANGE[v.change])}</td>
            <td className={`${td} whitespace-nowrap`}><PolicyBadges p={v} /></td>
            <td className={`${td} font-mono`}>{formatChips(v.referrerAmount)}</td>
            <td className={`${td} font-mono`}>{formatChips(v.inviteeAmount)}</td>
            <td className={`${td} font-mono`}>{v.minHands}</td>
            <td className={`${td} font-mono`}>{v.dailyCap} / {v.totalCap}</td>
            <td className={`${td} font-mono`}>{v.burstLimit}</td>
            <td className={`${td} text-xs`}>{v.actorNickname ?? (v.actorId ? v.actorId : t('refillSystem'))}</td>
            <td className={`${td} break-all text-xs text-ink-300`}>{v.reason ?? ''}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

/**
 * One member's referrals on their page: their code (if they have made one), who invited them and the members they
 * invited. Read only: opening it neither makes a code nor pays anything; reviews are on the referrals page.
 */
export function MemberReferralPanel({ userId }: { userId: string }) {
  const { t, locale } = useT();
  const [offset, setOffset] = useState(0);
  const PER = 20;
  const { data, error, loading, reload } = useData<MemberReferral>(`/api/admin/users/${userId}/referral?limit=${PER}&offset=${offset}`);
  const manage = <Link to={`/referrals?user=${encodeURIComponent(userId)}`} className="text-xs text-gold-300 hover:underline">{t('referralManage')} →</Link>;
  if (!data) {
    return (
      <Panel title={t('referralMemberTitle')} actions={manage}>
        <PageState error={error} onRetry={reload} />
      </Panel>
    );
  }
  const by = data.invitedBy;
  const s = data.totals;
  return (
    <Panel title={t('referralMemberTitle')} actions={manage}>
      <div className={`flex flex-col gap-4 text-sm transition-opacity ${loading ? 'opacity-60' : ''}`} data-testid="member-referral">
        {error && <LoadError error={error} onRetry={reload} />}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label={t('referralCode')} value={<span className="font-mono text-base" data-testid="member-referral-code">{data.code?.code ?? '—'}</span>} sub={data.code ? formatDate(data.code.createdAt, locale) : t('referralNoCode')} />
          <Stat label={t('referralSignups')} value={s.invited} />
          <Stat label={t('referralSidePaid')} value={s.paid} sub={t('referralEarned', { n: formatChips(s.earned) })} />
          <Stat label={t('referralSidePending')} value={s.pending} />
          <Stat label={t('referralStReview')} value={s.review} />
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 p-3" data-testid="member-referral-by">
          <h3 className="text-sm font-bold">{t('referralInvitedBy')}</h3>
          {by ? (
            <div className="flex flex-wrap items-start gap-3">
              <UserLink id={by.referrerId} name={by.referrerNickname} account={by.referrerAccount} />
              <span className="font-mono text-xs text-ink-400">{by.code} · {formatDate(by.createdAt, locale)}</span>
              <StatusBadge s={by.status} />
              {by.failure && <span className="text-xs text-ink-300">{referralWhy(t, by.failure)}</span>}
              <Sides r={by} />
              <Signals r={by} />
            </div>
          ) : (
            <p className="text-ink-400">{t('referralNotInvited')}</p>
          )}
        </div>
        <h3 className="text-sm font-bold">{t('referralInvitedList')}</h3>
        {data.items.length === 0 && offset === 0 ? (
          <p className="text-ink-400">{t('referralNoneInvited')}</p>
        ) : (
          <Table head={[t('time'), t('referralInvitee'), t('status'), t('referralRewards'), t('referralSignals')]}>
            {data.items.map((r) => (
              <tr key={r.id} data-referral={r.id} data-status={r.status}>
                <td className={`${td} text-xs text-ink-400`}>{formatDate(r.createdAt, locale)}</td>
                <td className={td}><UserLink id={r.inviteeId} name={r.inviteeNickname} account={r.inviteeAccount} /></td>
                <td className={td}>
                  <StatusBadge s={r.status} />
                  {r.failure && <div className="mt-1 text-xs text-ink-300">{referralWhy(t, r.failure)}</div>}
                </td>
                <td className={td}><Sides r={r} /></td>
                <td className={td}><Signals r={r} /></td>
              </tr>
            ))}
          </Table>
        )}
        {(offset > 0 || data.hasMore) && (
          <Pager
            label={t('referralMemberTitle')}
            testid="member-referral-pager"
            range={data.items.length ? t('auditRangeNoTotal', { from: offset + 1, to: offset + data.items.length }) : ''}
            prev={offset > 0 ? () => setOffset(Math.max(0, offset - PER)) : null}
            next={data.hasMore ? () => setOffset(offset + PER) : null}
            busy={loading}
          />
        )}
        <p className="text-xs text-ink-400">{t('referralMemberHint')}</p>
      </div>
    </Panel>
  );
}
