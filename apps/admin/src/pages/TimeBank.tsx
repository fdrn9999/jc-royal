/**
 * Time bank administration (the API's routes/admin-timebank.ts): the policy and who changed it, where a change applies
 * (each table's next hand: a hand being played, and its running turn's deadline, keep their rules), the open tables it
 * reaches, and the period's use from the daily counters.
 *
 * No member's time is edited here or anywhere: a turn whose timer failed is recovered from the table's page (its
 * diagnosis), by the room's own rules.
 */
import { Badge, Button, Empty, Field, formatDate, Input, Panel, Stat } from '@jc/ui';
import { timeBankProblem } from '@jc/types';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useT, type Key } from '../i18n';
import type { Tr } from '../labels';
import { ApiError, canDo, errText, useAdmin, useData } from '../lib';
import { Feedback, LoadError, Modal, PageState, type Note } from '../ui';
import { Table } from './Console';

interface Settings { enabled: boolean; memberRooms: boolean; initialMs: number; maxMs: number; unitMs: number; refillHands: number; refillMs: number }
interface Policy extends Settings { version: number }
interface Version extends Policy { change: string; actorId: string | null; actorNickname: string | null; reason: string | null; createdAt: number }
type Range = { min: number; max: number };
type Limits = Record<'initialMs' | 'maxMs' | 'unitMs' | 'refillHands' | 'refillMs', Range>;
const METRICS = ['tb_use', 'tb_sec', 'tb_empty', 'tb_expired', 'tb_late', 'tb_recover', 'tb_timeout'] as const;
type Metric = (typeof METRICS)[number];
interface Overview {
  now: number;
  days: number;
  policy: Version | null;
  versions: Version[];
  limits: Limits;
  minUseMs: number;
  appliesFrom: 'next_hand';
  tables: { official: number; member: number; playing: number };
  usage: Record<Metric, number>;
  series: ({ date: string } & Partial<Record<Metric, number>>)[];
}
interface Preview { from: Policy | null; to: Policy; appliesFrom: 'next_hand'; tables: number; playing: number; cutToMax: boolean }

const td = 'px-2 py-1.5';
const PERIODS = [7, 30] as const;
const METRIC: Record<Metric, Key> = { tb_use: 'tbUses', tb_sec: 'tbSecondsUsed', tb_empty: 'tbEmpty', tb_expired: 'tbExpired', tb_late: 'tbLate', tb_recover: 'tbRecovered', tb_timeout: 'tbTimeout' };
const METRIC_HINT: Record<Metric, Key> = { tb_use: 'tbUsesHint', tb_sec: 'tbSecondsUsedHint', tb_empty: 'tbEmptyHint', tb_expired: 'tbExpiredHint', tb_late: 'tbLateHint', tb_recover: 'tbRecoveredHint', tb_timeout: 'tbTimeoutHint' };
/** Defaults offered when there is no policy yet (the migration's seed). */
const FIRST: Settings = { enabled: true, memberRooms: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 };

const sec = (t: Tr, ms: number) => t('tbSeconds', { n: Math.round(ms / 1000) });

function PolicyBadges({ p }: { p: Settings }) {
  const { t } = useT();
  return (
    <>
      <Badge tone={p.enabled ? 'green' : 'neutral'}>{p.enabled ? t('refillOn') : t('refillOff')}</Badge>
      {p.enabled && <Badge tone={p.memberRooms ? 'blue' : 'neutral'}>{p.memberRooms ? t('tbMemberRoomsOn') : t('tbMemberRoomsOff')}</Badge>}
    </>
  );
}

export function TimeBankPage() {
  const { t } = useT();
  const { me } = useAdmin();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const overview = useData<Overview>(`/api/admin/time-bank?days=${days}`);
  const [note, setNote] = useState<Note>(null);
  const superAdmin = canDo(me, 'timebank.policy');
  const changed = async (n: Note) => {
    setNote(n);
    await overview.reload();
  };
  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-extrabold">{t('tbTitle')}</h1>
      <Link to="/tables" className="text-sm text-gold-300 hover:underline">{t('tables')} →</Link>
      <Button className="ml-auto" size="sm" variant="subtle" onClick={() => void overview.reload()} loading={overview.loading} data-testid="tb-reload">{t('refresh')}</Button>
    </div>
  );
  if (!overview.data) return <div className="flex flex-col gap-4">{header}<PageState error={overview.error} onRetry={overview.reload} /></div>;
  const o = overview.data;
  return (
    <div className="flex flex-col gap-6">
      {header}
      <p className="text-sm text-ink-300">{t('tbIntro')}</p>
      <Feedback note={note} testid="tb-feedback" pin />
      {overview.error && <LoadError error={overview.error} onRetry={overview.reload} />}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel title={t('refillPolicy')}>
          <PolicyView o={o} />
        </Panel>
        <Panel title={t('refillEdit')}>
          {superAdmin ? (
            // A new version starts the form again from what is now in force.
            <PolicyForm key={o.policy?.version ?? 0} o={o} onChanged={changed} />
          ) : (
            <p className="text-sm text-ink-400" data-testid="tb-edit-super-only">{t('tbEditSuperOnly')}</p>
          )}
        </Panel>
      </div>
      <Usage o={o} days={days} setDays={setDays} loading={overview.loading} />
      <Panel title={t('refillVersions')}>
        <VersionTable rows={o.versions} />
      </Panel>
    </div>
  );
}

function PolicyView({ o }: { o: Overview }) {
  const { t, locale } = useT();
  const p = o.policy;
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="tb-policy">
      {!p ? (
        <p className="text-ink-400" data-testid="tb-no-policy">{t('tbNoPolicy')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-ink-400">{t('refillVersion', { n: p.version })}</span>
            <PolicyBadges p={p} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('tbInitial')} value={sec(t, p.initialMs)} />
            <Stat label={t('tbMax')} value={sec(t, p.maxMs)} />
            <Stat label={t('tbUnit')} value={sec(t, p.unitMs)} />
            <Stat label={t('tbRefill')} value={<span className="text-base break-keep">{t('tbRefillRule', { hands: p.refillHands, n: Math.round(p.refillMs / 1000) })}</span>} />
          </div>
          <p className="text-xs text-ink-300">
            {t('refillLastChange', { kind: t(p.change === 'seed' ? 'refillChangeSeed' : 'refillChangePolicy'), at: formatDate(p.createdAt, locale), who: p.actorNickname ?? t('refillSystem') })}
            {p.reason ? ` · ${p.reason}` : ''}
          </p>
        </>
      )}
      <p className="rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="tb-boundary">{t('tbBoundary')}</p>
      <p className="text-xs text-ink-400" data-testid="tb-tables">{t('tbTables', { official: o.tables.official, member: o.tables.member, playing: o.tables.playing })}</p>
      <ul className="list-disc space-y-1 pl-4 text-xs text-ink-400">
        <li>{t('tbRules', { n: Math.round(o.minUseMs / 1000) })}</li>
        <li>{t('tbBotsRule')}</li>
        <li>{t('tbNoEdit')}</li>
      </ul>
    </div>
  );
}

function PolicyForm({ o, onChanged }: { o: Overview; onChanged: (n: Note) => Promise<void> }) {
  const { t } = useT();
  const { api } = useAdmin();
  const base: Policy = o.policy ?? { ...FIRST, version: 0 };
  const [enabled, setEnabled] = useState(base.enabled);
  const [memberRooms, setMemberRooms] = useState(base.memberRooms);
  const [v, setV] = useState({
    initial: String(base.initialMs / 1000),
    max: String(base.maxMs / 1000),
    unit: String(base.unitMs / 1000),
    hands: String(base.refillHands),
    refill: String(base.refillMs / 1000),
  });
  const [pv, setPv] = useState<Preview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const L = o.limits;
  const next = {
    baseVersion: base.version,
    enabled,
    memberRooms,
    initialMs: Number(v.initial) * 1000,
    maxMs: Number(v.max) * 1000,
    unitMs: Number(v.unit) * 1000,
    refillHands: Number(v.hands),
    refillMs: Number(v.refill) * 1000,
  };
  const inRange = (x: number, r: Range) => Number.isInteger(x) && x >= r.min && x <= r.max;
  const bad = {
    initial: !v.initial || !inRange(next.initialMs, L.initialMs),
    max: !v.max || !inRange(next.maxMs, L.maxMs),
    unit: !v.unit || !inRange(next.unitMs, L.unitMs),
    hands: !v.hands || !inRange(next.refillHands, L.refillHands),
    refill: !v.refill || !inRange(next.refillMs, L.refillMs),
  };
  const anyBad = Object.values(bad).some(Boolean);
  const problem = anyBad ? null : timeBankProblem(next);
  const fail = async (e: unknown) => {
    setPv(null);
    if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
    // Someone else's change came first: the page shows the policy now in force, and this form starts again from it.
    if (e instanceof ApiError && e.code === 'time_bank_policy_conflict') return onChanged({ ok: false, text: errText(e, t) });
    setError(errText(e, t));
  };
  const preview = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setReason('');
    setBusy(true);
    try {
      setPv(await api<Preview>('/api/admin/time-bank/policy', { method: 'PUT', body: { ...next, preview: true } }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<{ rooms: { tables: number; reached: number; more: boolean } }>('/api/admin/time-bank/policy', { method: 'PUT', body: { ...next, reason: reason.trim() } });
      setPv(null);
      await onChanged({ ok: true, text: `${t('tbSaved')} ${t('tbRoomsTold', { n: r.rooms.reached, of: r.rooms.tables })}` });
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const num = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value.replace(/\D/g, '') });
  const secRange = (r: Range) => t('refillRange', { min: sec(t, r.min), max: sec(t, r.max) });
  const rows: [Key, (p: Policy) => string][] = [
    ['tbEnabled', (p) => (p.enabled ? t('refillOn') : t('refillOff'))],
    ['tbMemberRooms', (p) => (p.memberRooms ? t('yes') : t('no'))],
    ['tbInitial', (p) => sec(t, p.initialMs)],
    ['tbMax', (p) => sec(t, p.maxMs)],
    ['tbUnit', (p) => sec(t, p.unitMs)],
    ['tbRefill', (p) => t('tbRefillRule', { hands: p.refillHands, n: Math.round(p.refillMs / 1000) })],
  ];
  return (
    <form className="flex flex-col gap-3" onSubmit={preview} data-testid="tb-form">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 cursor-pointer accent-gold-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="tb-enabled" />
        {t('tbEnabled')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 cursor-pointer accent-gold-500" checked={memberRooms} disabled={!enabled} onChange={(e) => setMemberRooms(e.target.checked)} data-testid="tb-member-rooms" />
        {t('tbMemberRooms')}
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('tbInitialSec')} hint={secRange(L.initialMs)} error={bad.initial ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={v.initial} onChange={num('initial')} data-testid="tb-initial" />}
        </Field>
        <Field label={t('tbMaxSec')} hint={secRange(L.maxMs)} error={bad.max ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={v.max} onChange={num('max')} data-testid="tb-max" />}
        </Field>
        <Field label={t('tbUnitSec')} hint={secRange(L.unitMs)} error={bad.unit ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={v.unit} onChange={num('unit')} data-testid="tb-unit" />}
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('tbRefillHands')} hint={t('refillRange', { min: L.refillHands.min, max: L.refillHands.max })} error={bad.hands ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={v.hands} onChange={num('hands')} data-testid="tb-refill-hands" />}
        </Field>
        <Field label={t('tbRefillSec')} hint={secRange(L.refillMs)} error={bad.refill ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={v.refill} onChange={num('refill')} data-testid="tb-refill-sec" />}
        </Field>
      </div>
      {problem && <p className="text-sm text-danger" role="alert" data-testid="tb-problem">{t(problem === 'initial_over_max' ? 'tbInitialOverMax' : problem === 'unit_over_max' ? 'tbUnitOverMax' : 'tbWholeSeconds')}</p>}
      <p className="text-xs text-ink-400">{t('tbEditHint')}</p>
      {error && <p className="text-sm text-danger" role="alert" data-testid="tb-form-error">{error}</p>}
      <Button type="submit" disabled={anyBad || !!problem} loading={busy && !pv} data-testid="tb-preview">{t('refillPreviewBtn')}</Button>
      <Modal
        open={pv !== null}
        onClose={() => setPv(null)}
        title={t('refillPreviewTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPv(null)}>{t('cancel')}</Button>
            <Button variant="gold" disabled={reason.trim().length < 2} loading={busy} onClick={apply} data-testid="tb-apply">{t('confirm')}</Button>
          </>
        }
      >
        {pv && (
          <div className="flex flex-col gap-3 text-sm" data-testid="tb-change">
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
            <p className="rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="tb-applies">{t('tbApplies', { tables: pv.tables, playing: pv.playing })}</p>
            {pv.cutToMax && <p className="text-xs text-gold-200" data-testid="tb-cut">{t('tbCutToMax', { n: Math.round(pv.to.maxMs / 1000) })}</p>}
            <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="tb-reason" />}</Field>
            <p className="text-xs text-ink-400">{t('pvBasis')}</p>
          </div>
        )}
      </Modal>
    </form>
  );
}

function Usage({ o, days, setDays, loading }: { o: Overview; days: number; setDays: (n: (typeof PERIODS)[number]) => void; loading: boolean }) {
  const { t } = useT();
  const max = Math.max(1, ...o.series.map((s) => s.tb_use ?? 0));
  return (
    <Panel
      title={t('tbUsageTitle', { n: days })}
      actions={
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('econPeriod')}>
          {PERIODS.map((n) => (
            <Button key={n} size="sm" variant={days === n ? 'gold' : 'outline'} aria-pressed={days === n} onClick={() => setDays(n)} data-testid={`tb-days-${n}`}>{t('daysN', { n })}</Button>
          ))}
        </div>
      }
    >
      <div className={`flex flex-col gap-4 text-sm transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading} data-testid="tb-usage">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {METRICS.map((m) => (
            <Stat key={m} label={t(METRIC[m])} value={<span data-testid={`tb-${m}`}>{o.usage[m] ?? 0}</span>} sub={t(METRIC_HINT[m])} />
          ))}
        </div>
        <figure>
          <div role="img" aria-label={`${t('tbUses')}: ${o.usage.tb_use ?? 0}`} className="flex h-20 items-end gap-px border-b border-white/10">
            {o.series.map((s) => (
              <span
                key={s.date}
                title={t('tbDay', { date: s.date, n: s.tb_use ?? 0, sec: s.tb_sec ?? 0 })}
                className={`min-w-0 flex-1 rounded-t-sm ${s.tb_use ? 'bg-gold-500/70' : 'bg-white/5'}`}
                style={{ height: s.tb_use ? `${Math.max(6, (s.tb_use / max) * 100)}%` : '2px' }}
              />
            ))}
          </div>
          <figcaption className="mt-1.5 flex flex-wrap justify-between gap-2 text-[11px] text-ink-400">
            <span>{o.series[0]?.date} – {o.series[o.series.length - 1]?.date}</span>
            <span>{t('refillDaysKst')}</span>
          </figcaption>
        </figure>
        <p className="text-xs text-ink-400">{t('tbUsageHint')}</p>
      </div>
    </Panel>
  );
}

function VersionTable({ rows }: { rows: Version[] }) {
  const { t, locale } = useT();
  if (rows.length === 0) return <Empty>{t('noneFound')}</Empty>;
  return (
    <div data-testid="tb-versions">
      <Table head={[t('refillColVersion'), t('time'), t('colKind'), t('refillColState'), t('tbInitial'), t('tbMax'), t('tbUnit'), t('tbRefill'), t('actor'), t('reason')]}>
        {rows.map((v) => (
          <tr key={v.version}>
            <td className={`${td} font-mono`}>v{v.version}</td>
            <td className={`${td} text-xs text-ink-400`}>{formatDate(v.createdAt, locale)}</td>
            <td className={td}>{t(v.change === 'seed' ? 'refillChangeSeed' : 'refillChangePolicy')}</td>
            <td className={`${td} whitespace-nowrap`}><PolicyBadges p={v} /></td>
            <td className={`${td} font-mono`}>{sec(t, v.initialMs)}</td>
            <td className={`${td} font-mono`}>{sec(t, v.maxMs)}</td>
            <td className={`${td} font-mono`}>{sec(t, v.unitMs)}</td>
            <td className={`${td} text-xs`}>{t('tbRefillRule', { hands: v.refillHands, n: Math.round(v.refillMs / 1000) })}</td>
            <td className={`${td} text-xs`}>{v.actorNickname ?? (v.actorId ? v.actorId : t('refillSystem'))}</td>
            <td className={`${td} break-all text-xs text-ink-300`}>{v.reason ?? ''}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
