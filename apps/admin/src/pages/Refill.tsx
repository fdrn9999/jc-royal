/**
 * Free chip refills (the API's lib/refill.ts and routes/admin-refill.ts): the policy and who changed it, the emergency
 * pause, what was paid per day, claims that paid nothing by reason, members who claim often, and every refill paid.
 * One member's refills are on their page (MemberRefillPanel).
 *
 * Refills paid are never edited here: one paid in error is taken back with the member's chip adjustment, which names
 * it. A policy change applies from the next claim; a wait already running keeps its time.
 */
import { Badge, Button, Empty, Field, formatChips, formatDate, Input, Panel, Stat } from '@jc/ui';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useT, type Key } from '../i18n';
import { ledgerTypeLabel, userStatusLabel, type Tr } from '../labels';
import { ApiError, errText, useAdmin, useData } from '../lib';
import { Feedback, ListState, LoadError, Modal, PageState, Pager, type Note } from '../ui';
import { Table } from './Console';

interface Policy { version: number; enabled: boolean; paused: boolean; below: number; amount: number; cooldownMs: number }
interface Version extends Policy { change: 'seed' | 'policy' | 'pause' | 'resume'; actorId: string | null; actorNickname: string | null; reason: string | null; createdAt: number }
type Range = { min: number; max: number };
interface Overview { policy: Version | null; versions: Version[]; limits: { below: Range; amount: Range; cooldownMs: Range }; runningWaits: number; now: number }
interface Stats {
  days: number;
  since: number;
  now: number;
  policy: Policy | null;
  totals: { n: number; sum: number; members: number };
  refused: Record<string, number>;
  series: { date: string; n: number; sum: number; members: number; refused: Record<string, number> }[];
  frequent: { atLeast: number; items: { userId: string; nickname: string | null; status: string | null; n: number; sum: number; firstAt: number; lastAt: number }[] };
  changes: Version[];
}
interface Claim { id: string; userId: string; nickname: string | null; seq: number; policyVersion: number; amount: number; wallet: number; tableChips: number; nextAt: number; createdAt: number }
type Reason = 'off' | 'paused' | 'cooldown' | 'above' | 'suspended' | 'held';
interface Status { policy: Policy | null; wallet: number; tables: number | null; eligible: boolean; reason: Reason | null; hold: 'busy' | 'unreachable' | 'mismatch' | null; nextAt: number | null; last: { at: number; amount: number } | null; received: number; now: number }
type MemberClaim = Omit<Claim, 'userId' | 'nickname'> & { corrections: { id: string; amount: number; at: number }[] };
interface MemberRefill { member: { nickname: string; status: string; role: string }; status: Status; items: MemberClaim[]; hasMore: boolean; limit: number; offset: number }
/** A refill an administrator is about to take back with the chip adjustment: what is left of it after earlier ones. */
export interface RefillRef { id: string; seq: number; amount: number; at: number }

const td = 'px-2 py-1.5';
const PERIODS = [7, 30, 90] as const;
const PAGE = 50;
/** Claims that paid nothing (statistics `rf_*`), and why a member's claim would be held. */
const REASON: Record<string, Key> = {
  off: 'refillReasonOff',
  paused: 'refillReasonPaused',
  cooldown: 'refillReasonCooldown',
  above: 'refillReasonAbove',
  suspended: 'refillReasonSuspended',
  held: 'refillReasonHeld',
  changed: 'refillReasonChanged',
};
const HOLD: Record<string, Key> = { busy: 'refillHoldBusy', unreachable: 'refillHoldUnreachable', mismatch: 'refillHoldMismatch' };
const CHANGE: Record<Version['change'], Key> = { seed: 'refillChangeSeed', policy: 'refillChangePolicy', pause: 'refillChangePause', resume: 'refillChangeResume' };
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type Unit = keyof typeof UNITS;
const UNIT_LABEL: Record<Unit, Key> = { m: 'refillUnitM', h: 'refillUnitH', d: 'refillUnitD' };
/** Defaults offered when there is no policy yet (the migration's seed). */
const FIRST: Omit<Policy, 'version' | 'paused'> = { enabled: true, below: 1000, amount: 2000, cooldownMs: 6 * UNITS.h };

/** A wait in days, hours and minutes. */
export function waitText(t: Tr, ms: number): string {
  const total = Math.round(ms / UNITS.m);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const parts = [d ? t('refillWaitD', { n: d }) : '', h ? t('refillWaitH', { n: h }) : '', m ? t('refillWaitM', { n: m }) : ''].filter(Boolean);
  return parts.length ? parts.join(' ') : t('refillWaitM', { n: 0 });
}

export function refillReasonText(t: Tr, reason: string | null, hold?: string | null): string {
  if (!reason) return '';
  const r = t(REASON[reason] ?? 'refillReasonOff');
  return hold && HOLD[hold] ? `${r} · ${t(HOLD[hold])}` : r;
}

function UserLink({ id, name }: { id: string; name: string | null }) {
  return <Link to={`/users/${id}`} className="text-gold-300 hover:underline">{name ?? id}</Link>;
}

function PolicyBadges({ p }: { p: Policy }) {
  const { t } = useT();
  return (
    <>
      <Badge tone={p.enabled ? 'green' : 'neutral'}>{p.enabled ? t('refillOn') : t('refillOff')}</Badge>
      {p.paused && <Badge tone="red">{t('refillPausedBadge')}</Badge>}
    </>
  );
}

export function RefillPage() {
  const { t } = useT();
  const { me } = useAdmin();
  const overview = useData<Overview>('/api/admin/refill');
  const [note, setNote] = useState<Note>(null);
  const superAdmin = me?.user.role === 'super_admin';
  // Every change reloads the policy and the lists under it.
  const [rev, setRev] = useState(0);
  const changed = async (n: Note) => {
    setNote(n);
    setRev((x) => x + 1);
    await overview.reload();
  };
  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-extrabold">{t('refill')}</h1>
      <Link to="/economy" className="text-sm text-gold-300 hover:underline">{t('economy')} →</Link>
      <Button className="ml-auto" size="sm" variant="subtle" onClick={() => void overview.reload()} loading={overview.loading} data-testid="refill-reload">{t('refresh')}</Button>
    </div>
  );
  if (!overview.data) return <div className="flex flex-col gap-4">{header}<PageState error={overview.error} onRetry={overview.reload} /></div>;
  const o = overview.data;
  return (
    <div className="flex flex-col gap-6">
      {header}
      <p className="text-sm text-ink-300">{t('refillIntro')}</p>
      <Feedback note={note} testid="refill-feedback" pin />
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
            <p className="text-sm text-ink-400" data-testid="refill-edit-super-only">{t('refillEditSuperOnly')}</p>
          )}
        </Panel>
      </div>
      <RefillStats key={`s${rev}`} />
      <Panel title={t('refillVersions')}>
        <VersionTable rows={o.versions} />
      </Panel>
      <ClaimList key={`c${rev}`} />
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
      await api(`/api/admin/refill/${to}`, { body: { reason: reason.trim() } });
      setAsk(null);
      setReason('');
      await onChanged({ ok: true, text: t(to === 'pause' ? 'refillPausedDone' : 'refillResumedDone') });
    } catch (e) {
      setAsk(null);
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) await onChanged({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  if (!p) return <p className="text-sm text-ink-400" data-testid="refill-no-policy">{t('refillNoPolicy')}</p>;
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="refill-policy" data-paused={p.paused ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-ink-400">{t('refillVersion', { n: p.version })}</span>
        <PolicyBadges p={p} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label={t('refillBelow')} value={formatChips(p.below)} />
        <Stat label={t('refillAmount')} value={formatChips(p.amount)} />
        <Stat label={t('refillCooldown')} value={<span className="text-base">{waitText(t, p.cooldownMs)}</span>} />
      </div>
      <p className="text-xs text-ink-300">
        {t('refillLastChange', { kind: t(CHANGE[p.change]), at: formatDate(p.createdAt, locale), who: p.actorNickname ?? t('refillSystem') })}
        {p.reason ? ` · ${p.reason}` : ''}
      </p>
      <p className="text-xs text-ink-400" data-testid="refill-running">{t('refillRunning', { n: o.runningWaits })}</p>
      <div className="flex flex-col gap-2 rounded-xl border border-white/10 p-3">
        {p.paused ? (
          superAdmin ? (
            <Button variant="gold" onClick={() => setAsk('resume')} data-testid="refill-resume">{t('refillResume')}</Button>
          ) : (
            <p className="text-xs text-ink-400">{t('refillResumeSuperOnly')}</p>
          )
        ) : (
          <Button variant="danger" onClick={() => setAsk('pause')} data-testid="refill-pause">{t('refillPause')}</Button>
        )}
        <p className="text-xs text-ink-400">{t('refillPauseHint')}</p>
      </div>
      <Modal
        open={ask !== null}
        onClose={() => setAsk(null)}
        title={ask === 'resume' ? t('refillResume') : t('refillPause')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsk(null)}>{t('cancel')}</Button>
            <Button variant={ask === 'resume' ? 'gold' : 'danger'} disabled={reason.trim().length < 2} loading={busy} onClick={submit} data-testid="refill-switch-confirm">{t('confirm')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>{ask === 'resume' ? t('refillResumeConfirm') : t('refillPauseConfirm')}</p>
          <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="refill-switch-reason" />}</Field>
        </div>
      </Modal>
    </div>
  );
}

/** The wait in the largest unit it fits exactly. */
function splitWait(ms: number): { n: string; unit: Unit } {
  if (ms % UNITS.d === 0) return { n: String(ms / UNITS.d), unit: 'd' };
  if (ms % UNITS.h === 0) return { n: String(ms / UNITS.h), unit: 'h' };
  return { n: String(Math.round(ms / UNITS.m)), unit: 'm' };
}

interface PolicyPreview { from: Policy | null; to: Policy; appliesFrom: 'next_claim'; runningWaits: number }

function PolicyForm({ o, onChanged }: { o: Overview; onChanged: (n: Note) => Promise<void> }) {
  const { t } = useT();
  const { api } = useAdmin();
  const base = o.policy ?? { ...FIRST, version: 0, paused: false };
  const start = splitWait(base.cooldownMs);
  const [enabled, setEnabled] = useState(base.enabled);
  const [below, setBelow] = useState(String(base.below));
  const [amount, setAmount] = useState(String(base.amount));
  const [wait, setWait] = useState(start.n);
  const [unit, setUnit] = useState<Unit>(start.unit);
  const [pv, setPv] = useState<PolicyPreview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const L = o.limits;
  const cooldownMs = Math.round(Number(wait) * UNITS[unit]);
  const inRange = (v: number, r: Range) => Number.isInteger(v) && v >= r.min && v <= r.max;
  const bad = {
    below: !inRange(Number(below), L.below),
    amount: !inRange(Number(amount), L.amount),
    wait: !wait || !inRange(cooldownMs, L.cooldownMs),
  };
  const next = { baseVersion: base.version, enabled, below: Number(below), amount: Number(amount), cooldownMs };
  const fail = async (e: unknown) => {
    setPv(null);
    if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
    // Someone else's change came first: the page shows the policy now in force, and this form starts again from it.
    if (e instanceof ApiError && e.code === 'refill_policy_conflict') return onChanged({ ok: false, text: errText(e, t) });
    setError(errText(e, t));
  };
  const preview = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setReason('');
    setBusy(true);
    try {
      setPv(await api<PolicyPreview>('/api/admin/refill/policy', { method: 'PUT', body: { ...next, preview: true } }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      await api('/api/admin/refill/policy', { method: 'PUT', body: { ...next, reason: reason.trim() } });
      setPv(null);
      await onChanged({ ok: true, text: t('refillPolicySaved') });
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const rows: [Key, (p: Policy) => string][] = [
    ['refillEnabled', (p) => (p.enabled ? t('refillOn') : t('refillOff'))],
    ['refillBelow', (p) => formatChips(p.below)],
    ['refillAmount', (p) => formatChips(p.amount)],
    ['refillCooldown', (p) => waitText(t, p.cooldownMs)],
  ];
  return (
    <form className="flex flex-col gap-3" onSubmit={preview} data-testid="refill-form">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 cursor-pointer accent-gold-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="refill-enabled" />
        {t('refillEnabled')}
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('refillBelow')} hint={t('refillRange', { min: formatChips(L.below.min), max: formatChips(L.below.max) })} error={bad.below ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={below} onChange={(e) => setBelow(e.target.value.replace(/\D/g, ''))} data-testid="refill-below" />}
        </Field>
        <Field label={t('refillAmount')} hint={t('refillRange', { min: formatChips(L.amount.min), max: formatChips(L.amount.max) })} error={bad.amount ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} data-testid="refill-amount" />}
        </Field>
      </div>
      <Field label={t('refillCooldown')} hint={t('refillRange', { min: waitText(t, L.cooldownMs.min), max: waitText(t, L.cooldownMs.max) })} error={bad.wait ? t('refillOutOfRange') : null}>
        {(fid) => (
          <div className="flex gap-2">
            <Input id={fid} className="min-w-0 flex-1" inputMode="decimal" value={wait} onChange={(e) => setWait(e.target.value.replace(/[^\d.]/g, ''))} data-testid="refill-wait" />
            <select aria-label={t('refillUnit')} value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className="h-11 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm" data-testid="refill-unit">
              {(Object.keys(UNITS) as Unit[]).map((u) => <option key={u} value={u}>{t(UNIT_LABEL[u])}</option>)}
            </select>
          </div>
        )}
      </Field>
      <p className="text-xs text-ink-400">{t('refillEditHint')}</p>
      {error && <p className="text-sm text-danger" role="alert" data-testid="refill-form-error">{error}</p>}
      <Button type="submit" disabled={bad.below || bad.amount || bad.wait} loading={busy && !pv} data-testid="refill-preview">{t('refillPreviewBtn')}</Button>
      <Modal
        open={pv !== null}
        onClose={() => setPv(null)}
        title={t('refillPreviewTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPv(null)}>{t('cancel')}</Button>
            <Button variant="gold" disabled={reason.trim().length < 2} loading={busy} onClick={apply} data-testid="refill-apply">{t('confirm')}</Button>
          </>
        }
      >
        {pv && (
          <div className="flex flex-col gap-3 text-sm" data-testid="refill-change">
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
            <p className="rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="refill-applies">{t('refillApplies', { n: pv.runningWaits })}</p>
            {pv.to.paused && <p className="text-xs text-danger">{t('refillPausedKept')}</p>}
            <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="refill-reason" />}</Field>
            <p className="text-xs text-ink-400">{t('pvBasis')}</p>
          </div>
        )}
      </Modal>
    </form>
  );
}

function VersionTable({ rows }: { rows: Version[] }) {
  const { t, locale } = useT();
  if (rows.length === 0) return <Empty>{t('noneFound')}</Empty>;
  return (
    <div data-testid="refill-versions">
      <Table head={[t('refillColVersion'), t('time'), t('colKind'), t('refillColState'), t('refillBelow'), t('refillAmount'), t('refillCooldown'), t('actor'), t('reason')]}>
        {rows.map((v) => (
          <tr key={v.version}>
            <td className={`${td} font-mono`}>v{v.version}</td>
            <td className={`${td} text-xs text-ink-400`}>{formatDate(v.createdAt, locale)}</td>
            <td className={td}>{t(CHANGE[v.change])}</td>
            <td className={`${td} whitespace-nowrap`}><PolicyBadges p={v} /></td>
            <td className={`${td} font-mono`}>{formatChips(v.below)}</td>
            <td className={`${td} font-mono`}>{formatChips(v.amount)}</td>
            <td className={`${td} text-xs`}>{waitText(t, v.cooldownMs)}</td>
            <td className={`${td} text-xs`}>{v.actorNickname ?? (v.actorId ? v.actorId : t('refillSystem'))}</td>
            <td className={`${td} break-all text-xs text-ink-300`}>{v.reason ?? ''}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function RefillStats() {
  const { t, locale } = useT();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const { data, error, loading, reload } = useData<Stats>(`/api/admin/refill/stats?days=${days}`);
  const refusedTotal = data ? Object.values(data.refused).reduce((s, n) => s + n, 0) : 0;
  const max = data ? Math.max(1, ...data.series.map((s) => s.sum)) : 1;
  return (
    <Panel
      title={t('refillStatsTitle', { n: days })}
      actions={
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('econPeriod')}>
          {PERIODS.map((n) => (
            <Button key={n} size="sm" variant={days === n ? 'gold' : 'outline'} aria-pressed={days === n} onClick={() => setDays(n)} data-testid={`refill-days-${n}`}>{t('daysN', { n })}</Button>
          ))}
        </div>
      }
    >
      {!data ? (
        <PageState error={error} onRetry={reload} />
      ) : (
        <div className={`flex flex-col gap-6 text-sm transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading} data-testid="refill-stats">
          {error && <LoadError error={error} onRetry={reload} />}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('refillPaidN')} value={<span data-testid="refill-paid-n">{formatChips(data.totals.n)}</span>} />
            <Stat label={t('refillPaidSum')} value={<span data-testid="refill-paid-sum">{formatChips(data.totals.sum)}</span>} />
            <Stat label={t('refillMembers')} value={formatChips(data.totals.members)} />
            <Stat label={t('refillRefused')} value={formatChips(refusedTotal)} />
          </div>
          <figure>
            <div role="img" aria-label={`${t('refillPaidSum')}: ${formatChips(data.totals.sum)}`} className="flex h-24 items-end gap-px border-b border-white/10" data-testid="refill-chart">
              {data.series.map((s) => (
                <span
                  key={s.date}
                  title={t('refillDay', { date: s.date, n: s.n, sum: formatChips(s.sum), members: s.members })}
                  className={`min-w-0 flex-1 rounded-t-sm ${s.sum === 0 ? 'bg-white/5' : 'bg-gold-500/70'}`}
                  style={{ height: s.sum ? `${Math.max(6, (s.sum / max) * 100)}%` : '2px' }}
                />
              ))}
            </div>
            <figcaption className="mt-1.5 flex flex-wrap justify-between gap-2 text-[11px] text-ink-400">
              <span>{data.series[0]?.date} – {data.series[data.series.length - 1]?.date}</span>
              <span>{t('refillDaysKst')}</span>
            </figcaption>
          </figure>
          <div className="flex flex-col gap-2" data-testid="refill-refused">
            <h3 className="text-sm font-bold">{t('refillRefused')}</h3>
            <p className="text-xs text-ink-400">{t('refillRefusedHint')}</p>
            {refusedTotal === 0 ? (
              <p className="text-ink-400">{t('noneFound')}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {Object.entries(data.refused).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                  <li key={k} data-reason={k}><Badge tone={k === 'held' || k === 'changed' ? 'gold' : 'neutral'}>{refillReasonText(t, k)} {formatChips(n)}</Badge></li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-2" data-testid="refill-frequent">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-bold">{t('refillFrequent')}</h3>
              <Badge tone={data.frequent.items.length ? 'gold' : 'neutral'}>{data.frequent.items.length}</Badge>
            </div>
            <p className="text-xs text-ink-400">{t('refillFrequentHint', { n: data.frequent.atLeast })}</p>
            {data.frequent.items.length === 0 ? (
              <p className="text-ink-400">{t('noneFound')}</p>
            ) : (
              <Table head={[t('colUser'), t('status'), t('econTimes'), t('econSum'), t('refillFirstLast')]}>
                {data.frequent.items.map((r) => (
                  <tr key={r.userId}>
                    <td className={td}><UserLink id={r.userId} name={r.nickname} /></td>
                    <td className={td}>{r.status && <Badge tone={r.status === 'active' ? 'green' : 'red'}>{userStatusLabel(t, r.status)}</Badge>}</td>
                    <td className={`${td} font-mono`}>{r.n}</td>
                    <td className={`${td} font-mono`}>{formatChips(r.sum)}</td>
                    <td className={`${td} text-xs text-ink-400`}>{formatDate(r.firstAt, locale)} – {formatDate(r.lastAt, locale)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
          <p className="text-xs text-ink-400">{t('refillChangesInPeriod', { n: data.changes.length })}</p>
        </div>
      )}
    </Panel>
  );
}

function ClaimList() {
  const { t, locale } = useT();
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useData<{ items: Claim[]; hasMore: boolean }>(`/api/admin/refill/claims?limit=${PAGE}&offset=${offset}`);
  const rows = data?.items ?? [];
  return (
    <Panel title={t('refillClaims')} className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
      <p className="mb-3 text-xs text-ink-400">{t('refillClaimsHint')}</p>
      {error && <LoadError error={error} onRetry={reload} />}
      <ListState loading={loading} empty={rows.length === 0} />
      {rows.length > 0 && (
        <div data-testid="refill-claims">
          <Table head={[t('time'), t('colUser'), t('refillColSeq'), t('refillAmount'), t('refillColVersion'), t('refillColHeld'), t('refillNextAt')]}>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className={`${td} text-xs text-ink-400`}>{formatDate(c.createdAt, locale)}</td>
                <td className={td}><UserLink id={c.userId} name={c.nickname} /></td>
                <td className={`${td} font-mono`}>#{c.seq}</td>
                <td className={`${td} font-mono text-success`}>+{formatChips(c.amount)}</td>
                <td className={`${td} font-mono text-xs`}>v{c.policyVersion}</td>
                <td className={`${td} font-mono text-xs`}>{t('refillHeldAt', { wallet: formatChips(c.wallet), tables: formatChips(c.tableChips) })}</td>
                <td className={`${td} text-xs text-ink-400`}>{formatDate(c.nextAt, locale)}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {(offset > 0 || rows.length > 0) && (
        <Pager
          label={t('refillClaims')}
          testid="refill-claims-pager"
          range={rows.length ? t('auditRangeNoTotal', { from: offset + 1, to: offset + rows.length }) : ''}
          prev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null}
          next={data?.hasMore ? () => setOffset(offset + PAGE) : null}
          busy={loading}
        />
      )}
    </Panel>
  );
}

/**
 * One member's refills on their page: whether one would pay now (their tables asked, as for the member) and why not,
 * when the next may come, and every refill with the adjustments that took any back. `onCorrect` fills the chip
 * adjustment with what is left of a refill to take back, linked to it.
 */
export function MemberRefillPanel({ userId, onCorrect }: { userId: string; onCorrect?: (r: RefillRef) => void }) {
  const { t, locale } = useT();
  const [offset, setOffset] = useState(0);
  const PER = 20;
  const { data, error, loading, reload } = useData<MemberRefill>(`/api/admin/users/${userId}/refill?limit=${PER}&offset=${offset}`);
  if (!data) {
    return (
      <Panel title={t('refillMemberTitle')}>
        <PageState error={error} onRetry={reload} />
      </Panel>
    );
  }
  const s = data.status;
  return (
    <Panel title={t('refillMemberTitle')} actions={<Link to="/economy/refill" className="text-xs text-gold-300 hover:underline">{t('refillManage')} →</Link>}>
      <div className={`flex flex-col gap-4 text-sm transition-opacity ${loading ? 'opacity-60' : ''}`} data-testid="member-refill">
        {error && <LoadError error={error} onRetry={reload} />}
        <div className="flex flex-wrap items-center gap-2" data-testid="member-refill-status">
          {s.eligible ? (
            <Badge tone="green">{t('refillEligible')}</Badge>
          ) : (
            <Badge tone={s.reason === 'held' ? 'gold' : 'neutral'}>{t('refillNotEligible', { reason: refillReasonText(t, s.reason, s.hold) })}</Badge>
          )}
          {s.policy && <span className="font-mono text-xs text-ink-400">{t('refillVersion', { n: s.policy.version })}</span>}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t('refillWalletNow')} value={formatChips(s.wallet)} sub={s.tables === null ? t('refillTablesUnchecked') : t('refillTablesNow', { n: formatChips(s.tables) })} />
          <Stat label={t('refillReceived')} value={formatChips(s.received)} sub={s.last ? `${formatDate(s.last.at, locale)} · +${formatChips(s.last.amount)}` : undefined} />
          <Stat label={t('refillNextAt')} value={<span className="text-sm break-keep">{s.nextAt ? formatDate(s.nextAt, locale) : t('none')}</span>} sub={s.nextAt && s.nextAt > s.now ? waitText(t, s.nextAt - s.now) : undefined} />
          <Stat label={t('refillBelow')} value={s.policy ? formatChips(s.policy.below) : '—'} sub={s.policy ? `${t('refillAmount')} ${formatChips(s.policy.amount)} · ${waitText(t, s.policy.cooldownMs)}` : undefined} />
        </div>
        {data.items.length === 0 && offset === 0 ? (
          <p className="text-ink-400">{t('refillMemberNone')}</p>
        ) : (
          <Table head={[t('refillColSeq'), t('time'), t('refillAmount'), t('refillColVersion'), t('refillColHeld'), t('refillNextAt'), t('refillColCorrections'), '']}>
            {data.items.map((c) => {
              const takenBack = c.corrections.reduce((x, k) => x + k.amount, 0);
              const left = c.amount + takenBack;
              return (
                <tr key={c.id} data-claim={c.id}>
                  <td className={`${td} font-mono`}>#{c.seq}</td>
                  <td className={`${td} text-xs text-ink-400`}>{formatDate(c.createdAt, locale)}</td>
                  <td className={`${td} font-mono text-success`}>+{formatChips(c.amount)}</td>
                  <td className={`${td} font-mono text-xs`}>v{c.policyVersion}</td>
                  <td className={`${td} font-mono text-xs`}>{t('refillHeldAt', { wallet: formatChips(c.wallet), tables: formatChips(c.tableChips) })}</td>
                  <td className={`${td} text-xs text-ink-400`}>{formatDate(c.nextAt, locale)}</td>
                  <td className={`${td} text-xs`}>
                    {c.corrections.length === 0 ? (
                      <span className="text-ink-400">—</span>
                    ) : (
                      <ul data-testid="refill-corrections">
                        {c.corrections.map((k) => <li key={k.id} className="font-mono">{formatDate(k.at, locale)} · {k.amount > 0 ? '+' : ''}{formatChips(k.amount)}</li>)}
                      </ul>
                    )}
                  </td>
                  <td className={td}>
                    {onCorrect && left > 0 && (
                      <Button size="sm" variant="outline" onClick={() => onCorrect({ id: c.id, seq: c.seq, amount: left, at: c.createdAt })} data-testid="refill-correct">{t('refillCorrect')}</Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        {(offset > 0 || data.hasMore) && (
          <Pager
            label={t('refillMemberTitle')}
            testid="member-refill-pager"
            range={data.items.length ? t('auditRangeNoTotal', { from: offset + 1, to: offset + data.items.length }) : ''}
            prev={offset > 0 ? () => setOffset(Math.max(0, offset - PER)) : null}
            next={data.hasMore ? () => setOffset(offset + PER) : null}
            busy={loading}
          />
        )}
        <p className="text-xs text-ink-400">{t('refillMemberHint')}</p>
      </div>
    </Panel>
  );
}

/** The refill a chip adjustment takes back, shown with the form and in its confirmation. */
export function RefillRefLine({ r, onClear }: { r: { type: string; amount: number; createdAt: number; seq?: number }; onClear?: () => void }) {
  const { t, locale } = useT();
  return (
    <p className="flex flex-wrap items-center gap-2 rounded-lg border border-gold-500/30 bg-gold-500/5 px-3 py-2 text-xs text-gold-200" data-testid="chip-ref">
      <span>{t('chipRefLine', { kind: `${ledgerTypeLabel(t, r.type)}${r.seq ? ` #${r.seq}` : ''}`, amount: `${r.amount > 0 ? '+' : ''}${formatChips(r.amount)}`, at: formatDate(r.createdAt, locale) })}</span>
      {onClear && <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear} data-testid="chip-ref-clear">{t('chipRefClear')}</Button>}
    </p>
  );
}
