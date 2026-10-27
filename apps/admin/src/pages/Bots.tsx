/**
 * Table bots (the API's routes/admin-bots.ts; the game worker's bots.ts and room.ts): the service-wide policy and who
 * changed it, the emergency stop, the bot fund and the bots' result against members, the tables that allow bots with
 * the bots seated there, the period's play, the operations log and the books check. Which tables allow bots, and how,
 * is each table's setting (the table page).
 *
 * The fund's books are only read here: a correction goes through reconciliation like any other. A policy change
 * applies at each table between hands; a bot in a hand plays it out.
 */
import { Badge, Button, Empty, Field, formatChips, formatDate, Input, Panel, Stat } from '@jc/ui';
import { BOT_BUY_IN_BB, BOT_LEVELS, BOT_STYLES, type BotLevel, type BotPlay, type BotProfile, type BotStyle, type BotTableStyle } from '@jc/types';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useT, type Key } from '../i18n';
import { botEventCodeLabel, botEventKindLabel, botLevelLabel, botStyleLabel, userStatusLabel } from '../labels';
import { ApiError, errText, useAdmin, useData } from '../lib';
import { Feedback, ListState, LoadError, Modal, PageState, Pager, type Note } from '../ui';
import { Table } from './Console';

interface Policy { version: number; enabled: boolean; fundLimit: number; maxBots: number }
interface Version extends Policy { change: 'seed' | 'policy' | 'stop'; actorId: string | null; actorNickname: string | null; reason: string | null; createdAt: number }
type Range = { min: number; max: number };
interface SeatedBot { tableId: string; botId: string; nickname: string; seatIndex: number; buyIn: number; since: number }
interface BotTable {
  id: string;
  name: string;
  status: 'open' | 'closing';
  maxSeats: number;
  bigBlind: number;
  level: string;
  minHumans: number;
  max: number;
  fillTo: number;
  yieldSeat: boolean;
  /** Everyone seated, bots included (the room's last report). */
  seated: number;
  bots: number;
  playing: boolean;
  seatedBots: SeatedBot[];
}
interface Overview {
  now: number;
  days: number;
  since: number;
  policy: Version | null;
  versions: Version[];
  limits: { fundLimit: Range; maxBots: Range };
  fund: { issued: number; limit: number; left: number; updatedAt: number | null };
  chips: { accounts: number; wallets: number; atTables: number; seated: number; result: number };
  tables: BotTable[];
  elsewhere: SeatedBot[];
  byLevel: { level: string; hands: number; net: number }[];
  series: { date: string; hands: number; tables: number }[];
  events: Record<string, number>;
  /** Absent from an API older than this page (shown as nothing recorded). */
  play?: LevelPlay[];
}
/** How a level played over the period (the API's botPlay): counters only, each rate over its own chances. */
interface LevelPlay {
  level: string;
  hands: number;
  vpipOpp: number;
  vpip: number;
  pfr: number;
  threeBetOpp: number;
  threeBet: number;
  bbStealOpp: number;
  bbFoldToSteal: number;
  foldToOverbetOpp: number;
  foldToOverbet: number;
  decisions: number;
  fallbacks: number;
  failures: number;
  lagMs: number;
  slow: number;
}
interface RoomsReached { tables: number; reached: number; unreached: string[] }
interface BotEvent { id: string; tableId: string; tableName: string | null; botId: string | null; nickname: string | null; kind: string; code: string | null; createdAt: number }
interface Integrity {
  ok: boolean;
  checkedAt: number;
  fund: { issued: number; ledger: number; diff: number };
  accounts: number;
  walletMismatches: { id: string; nickname: string; balance: number; ledger: number; diff: number }[];
  doubleSeated: { botId: string; nickname: string; n: number }[];
  onClosedTables: { botId: string; nickname: string; tableId: string; tableName: string }[];
  result: { wallets: number; atTables: number; issued: number; net: number };
  rowsRead: number;
}

const td = 'px-2 py-1.5';
const PERIODS = [7, 30] as const;
const PAGE = 50;
const KINDS = ['join', 'leave', 'fund_exhausted', 'join_failed', 'action_failed'] as const;
const CHANGE: Record<Version['change'], Key> = { seed: 'refillChangeSeed', policy: 'refillChangePolicy', stop: 'botsChangeStop' };
const selectCls = 'h-11 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm';
const signed = (n: number) => `${n > 0 ? '+' : ''}${formatChips(n)}`;

function BotLink({ id, name }: { id: string | null; name: string | null }) {
  if (!id) return <span className="text-ink-400">—</span>;
  return <Link to={`/users/${id}`} className="text-gold-300 hover:underline">{name ?? id}</Link>;
}

function OnBadge({ on }: { on: boolean }) {
  const { t } = useT();
  return <Badge tone={on ? 'green' : 'neutral'}>{on ? t('refillOn') : t('refillOff')}</Badge>;
}

/** What a policy change or stop reached: the tables told to reload, and those that did not answer (they learn later). */
function roomsText(t: ReturnType<typeof useT>['t'], done: Key, rooms: RoomsReached) {
  const base = `${t(done)} ${t('botsRoomsReached', { reached: rooms.reached, tables: rooms.tables })}`;
  return rooms.unreached.length ? `${base} ${t('botsRoomsUnreached', { n: rooms.unreached.length })}` : base;
}

export function BotsPage() {
  const { t } = useT();
  const { me } = useAdmin();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const overview = useData<Overview>(`/api/admin/bots?days=${days}`);
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
      <h1 className="text-xl font-extrabold">{t('botsTitle')}</h1>
      <Link to="/tables" className="text-sm text-gold-300 hover:underline">{t('tables')} →</Link>
      <Button className="ml-auto" size="sm" variant="subtle" onClick={() => void overview.reload()} loading={overview.loading} data-testid="bots-reload">{t('refresh')}</Button>
    </div>
  );
  if (!overview.data) return <div className="flex flex-col gap-4">{header}<PageState error={overview.error} onRetry={overview.reload} /></div>;
  const o = overview.data;
  return (
    <div className="flex flex-col gap-6">
      {header}
      <p className="text-sm text-ink-300">{t('botsIntro')}</p>
      <Feedback note={note} testid="bots-feedback" pin />
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
            <p className="text-sm text-ink-400" data-testid="bots-edit-super-only">{t('botsEditSuperOnly')}</p>
          )}
        </Panel>
      </div>
      <FundPanel o={o} />
      <TablesPanel o={o} />
      <PlayPanel o={o} days={days} setDays={setDays} loading={overview.loading} />
      <AccountsPanel days={days} onNote={setNote} />
      <Panel title={t('refillVersions')}>
        <VersionTable rows={o.versions} />
      </Panel>
      <EventList key={`e${rev}`} tables={o.tables} />
      <IntegrityPanel />
    </div>
  );
}

function PolicyView({ o, superAdmin, onChanged }: { o: Overview; superAdmin: boolean; onChanged: (n: Note) => Promise<void> }) {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const p = o.policy;
  const [ask, setAsk] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setBusy(true);
    try {
      const r = await api<{ rooms: RoomsReached }>('/api/admin/bots/stop', { body: { reason: reason.trim() } });
      setAsk(false);
      setReason('');
      await onChanged({ ok: true, text: roomsText(t, 'botsStoppedDone', r.rooms) });
    } catch (e) {
      setAsk(false);
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) await onChanged({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  if (!p) return <p className="text-sm text-ink-400" data-testid="bots-no-policy">{t('botsNoPolicy')}</p>;
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="bots-policy" data-enabled={p.enabled ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-ink-400">{t('refillVersion', { n: p.version })}</span>
        <OnBadge on={p.enabled} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label={t('botsFundLimit')} value={formatChips(p.fundLimit)} />
        <Stat label={t('botsMaxBots')} value={formatChips(p.maxBots)} />
        <Stat label={t('botsSeatedNow')} value={<span data-testid="bots-seated-now">{formatChips(o.chips.seated)}</span>} />
      </div>
      <p className="text-xs text-ink-300">
        {t('refillLastChange', { kind: t(CHANGE[p.change] ?? 'refillChangePolicy'), at: formatDate(p.createdAt, locale), who: p.actorNickname ?? t('refillSystem') })}
        {p.reason ? ` · ${p.reason}` : ''}
      </p>
      <div className="flex flex-col gap-2 rounded-xl border border-white/10 p-3">
        {p.enabled ? (
          <Button variant="danger" onClick={() => setAsk(true)} data-testid="bots-stop">{t('botsStop')}</Button>
        ) : (
          <p className="text-xs text-ink-400" data-testid="bots-off-note">{superAdmin ? t('botsOffSuper') : t('botsOffNote')}</p>
        )}
        <p className="text-xs text-ink-400">{t('botsStopHint')}</p>
      </div>
      <Modal
        open={ask}
        onClose={() => setAsk(false)}
        title={t('botsStop')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsk(false)}>{t('cancel')}</Button>
            <Button variant="danger" disabled={reason.trim().length < 2} loading={busy} onClick={stop} data-testid="bots-stop-confirm">{t('confirm')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>{t('botsStopConfirm', { n: o.chips.seated, tables: o.tables.length })}</p>
          <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="bots-stop-reason" />}</Field>
        </div>
      </Modal>
    </div>
  );
}

interface PolicyPreview { from: Policy | null; to: Policy; appliesFrom: 'between_hands'; tables: number; seatedBots: number; issued: number; fundLeft: number }

function PolicyForm({ o, onChanged }: { o: Overview; onChanged: (n: Note) => Promise<void> }) {
  const { t } = useT();
  const { api } = useAdmin();
  const base = o.policy ?? { version: 0, enabled: false, fundLimit: 0, maxBots: 0 };
  const [enabled, setEnabled] = useState(base.enabled);
  const [fundLimit, setFundLimit] = useState(String(base.fundLimit));
  const [maxBots, setMaxBots] = useState(String(base.maxBots));
  const [pv, setPv] = useState<PolicyPreview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const L = o.limits;
  const inRange = (v: number, r: Range) => Number.isInteger(v) && v >= r.min && v <= r.max;
  const bad = { fundLimit: !fundLimit || !inRange(Number(fundLimit), L.fundLimit), maxBots: !maxBots || !inRange(Number(maxBots), L.maxBots) };
  const next = { baseVersion: base.version, enabled, fundLimit: Number(fundLimit), maxBots: Number(maxBots) };
  const fail = async (e: unknown) => {
    setPv(null);
    if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
    // Someone else's change came first: the page shows the policy now in force, and this form starts again from it.
    if (e instanceof ApiError && e.code === 'bot_policy_conflict') return onChanged({ ok: false, text: errText(e, t) });
    setError(errText(e, t));
  };
  const preview = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setReason('');
    setBusy(true);
    try {
      setPv(await api<PolicyPreview>('/api/admin/bots/policy', { method: 'PUT', body: { ...next, preview: true } }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<{ rooms: RoomsReached }>('/api/admin/bots/policy', { method: 'PUT', body: { ...next, reason: reason.trim() } });
      setPv(null);
      await onChanged({ ok: true, text: roomsText(t, 'botsPolicySaved', r.rooms) });
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const rows: [Key, (p: Policy) => string][] = [
    ['botsEnabled', (p) => (p.enabled ? t('refillOn') : t('refillOff'))],
    ['botsFundLimit', (p) => formatChips(p.fundLimit)],
    ['botsMaxBots', (p) => formatChips(p.maxBots)],
  ];
  return (
    <form className="flex flex-col gap-3" onSubmit={preview} data-testid="bots-form">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 cursor-pointer accent-gold-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="bots-enabled" />
        {t('botsEnabled')}
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('botsFundLimit')} hint={t('refillRange', { min: formatChips(L.fundLimit.min), max: formatChips(L.fundLimit.max) })} error={bad.fundLimit ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={fundLimit} onChange={(e) => setFundLimit(e.target.value.replace(/\D/g, ''))} data-testid="bots-fund-limit" />}
        </Field>
        <Field label={t('botsMaxBots')} hint={t('refillRange', { min: formatChips(L.maxBots.min), max: formatChips(L.maxBots.max) })} error={bad.maxBots ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={maxBots} onChange={(e) => setMaxBots(e.target.value.replace(/\D/g, ''))} data-testid="bots-max" />}
        </Field>
      </div>
      <p className="text-xs text-ink-400">{t('botsEditHint')}</p>
      {error && <p className="text-sm text-danger" role="alert" data-testid="bots-form-error">{error}</p>}
      <Button type="submit" disabled={bad.fundLimit || bad.maxBots} loading={busy && !pv} data-testid="bots-preview">{t('refillPreviewBtn')}</Button>
      <Modal
        open={pv !== null}
        onClose={() => setPv(null)}
        title={t('refillPreviewTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPv(null)}>{t('cancel')}</Button>
            <Button variant="gold" disabled={reason.trim().length < 2} loading={busy} onClick={apply} data-testid="bots-apply">{t('confirm')}</Button>
          </>
        }
      >
        {pv && (
          <div className="flex flex-col gap-3 text-sm" data-testid="bots-change">
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
            <p className="rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="bots-applies">{t('botsApplies', { tables: pv.tables, n: pv.seatedBots })}</p>
            <p className="text-xs text-ink-300">{t('botsFundAfter', { issued: formatChips(pv.issued), left: formatChips(pv.fundLeft) })}</p>
            {pv.to.fundLimit < pv.issued && <p className="text-xs text-gold-200">{t('botsLimitUnderIssued')}</p>}
            {!pv.to.enabled && pv.from?.enabled && <p className="text-xs text-danger">{t('botsTurnOffNote')}</p>}
            <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="bots-reason" />}</Field>
            <p className="text-xs text-ink-400">{t('pvBasis')}</p>
          </div>
        )}
      </Modal>
    </form>
  );
}

/** The bot fund and the bots' chips: what the fund issued, where the bots' chips are, and their result against members. */
function FundPanel({ o }: { o: Overview }) {
  const { t, locale } = useT();
  const c = o.chips;
  return (
    <Panel title={t('botsFundTitle')}>
      <div className="flex flex-col gap-3 text-sm" data-testid="bots-fund">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t('botsIssued')} value={<span data-testid="bots-issued">{formatChips(o.fund.issued)}</span>} sub={t('botsIssuedSub', { limit: formatChips(o.fund.limit), left: formatChips(o.fund.left) })} />
          <Stat label={t('botsWallets')} value={formatChips(c.wallets)} sub={t('botsAccounts', { n: c.accounts })} />
          <Stat label={t('botsAtTables')} value={formatChips(c.atTables)} sub={t('botsAtTablesSub', { n: c.seated })} />
          <Stat
            label={t('botsResult')}
            value={<span className={c.result > 0 ? 'text-gold-200' : c.result < 0 ? 'text-info' : ''} data-testid="bots-result">{signed(c.result)}</span>}
            sub={t('botsResultSub')}
          />
        </div>
        <p className="text-xs text-ink-400">
          {t('botsFundHint')}
          {o.fund.updatedAt ? ` ${t('botsFundUpdated', { at: formatDate(o.fund.updatedAt, locale) })}` : ''}
        </p>
      </div>
    </Panel>
  );
}

function TablesPanel({ o }: { o: Overview }) {
  const { t, locale } = useT();
  return (
    <Panel title={t('botsTablesTitle', { n: o.tables.length })}>
      <p className="mb-3 text-xs text-ink-400">{t('botsTablesHint')}</p>
      {o.tables.length === 0 ? (
        <Empty>{t('botsNoTables')}</Empty>
      ) : (
        <div data-testid="bots-tables">
          <Table head={[t('name'), t('status'), t('botsLevel'), t('botsCounts'), t('botsSettings'), t('botsSeatedBots')]}>
            {o.tables.map((tb) => (
              <tr key={tb.id} data-table={tb.id}>
                <td className={td}><Link className="font-semibold text-gold-300 hover:underline" to={`/tables/${tb.id}`}>{tb.name}</Link></td>
                <td className={td}>
                  <div className="flex flex-wrap gap-1">
                    {tb.status === 'closing' ? <Badge tone="red">{t('closing')}</Badge> : <Badge tone="green">{t('open')}</Badge>}
                    {tb.playing && <Badge tone="green">{t('inHand')}</Badge>}
                  </div>
                </td>
                <td className={td}>{botLevelLabel(t, tb.level)}</td>
                <td className={`${td} whitespace-nowrap font-mono text-xs`} data-testid="bots-table-counts">{t('botsCountsLine', { humans: Math.max(0, tb.seated - tb.bots), bots: tb.bots, seats: tb.maxSeats })}</td>
                <td className={`${td} text-xs text-ink-300`}>{t('botsSettingsLine', { min: tb.minHumans, max: tb.max, fill: tb.fillTo })}{tb.yieldSeat ? ` · ${t('botsYieldShort')}` : ''}</td>
                <td className={`${td} text-xs`}>
                  {tb.seatedBots.length === 0 ? (
                    <span className="text-ink-400">—</span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {tb.seatedBots.map((b) => (
                        <li key={b.botId}>
                          <BotLink id={b.botId} name={b.nickname} /> <span className="text-ink-400">{t('botsSeatLine', { seat: b.seatIndex + 1, chips: formatChips(b.buyIn), at: formatDate(b.since, locale) })}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {o.elsewhere.length > 0 && (
        <div className="mt-4 flex flex-col gap-2" data-testid="bots-elsewhere">
          <h3 className="text-sm font-bold">{t('botsElsewhere')}</h3>
          <p className="text-xs text-ink-400">{t('botsElsewhereHint')}</p>
          <ul className="flex flex-col gap-1 text-xs">
            {o.elsewhere.map((b) => (
              <li key={`${b.tableId}:${b.botId}`}>
                <BotLink id={b.botId} name={b.nickname} /> · <Link to={`/tables/${b.tableId}`} className="text-gold-300 hover:underline">{b.tableId}</Link> · {t('botsSeatLine', { seat: b.seatIndex + 1, chips: formatChips(b.buyIn), at: formatDate(b.since, locale) })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function PlayPanel({ o, days, setDays, loading }: { o: Overview; days: number; setDays: (n: (typeof PERIODS)[number]) => void; loading: boolean }) {
  const { t } = useT();
  const hands = o.byLevel.reduce((s, r) => s + r.hands, 0);
  const net = o.byLevel.reduce((s, r) => s + r.net, 0);
  const max = Math.max(1, ...o.series.map((s) => s.hands));
  const eventsTotal = Object.values(o.events).reduce((s, n) => s + n, 0);
  return (
    <Panel
      title={t('botsPlayTitle', { n: days })}
      actions={
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('econPeriod')}>
          {PERIODS.map((n) => (
            <Button key={n} size="sm" variant={days === n ? 'gold' : 'outline'} aria-pressed={days === n} onClick={() => setDays(n)} data-testid={`bots-days-${n}`}>{t('daysN', { n })}</Button>
          ))}
        </div>
      }
    >
      <div className={`flex flex-col gap-6 text-sm transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading} data-testid="bots-play">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label={t('botsHands')} value={<span data-testid="bots-hands">{formatChips(hands)}</span>} sub={t('botsHandsSub')} />
          <Stat label={t('botsNet')} value={signed(net)} sub={t('botsNetSub')} />
          <Stat label={t('botsEventsN')} value={formatChips(eventsTotal)} />
        </div>
        {o.byLevel.length > 0 && (
          <Table head={[t('botsLevel'), t('botsHands'), t('botsNet')]}>
            {o.byLevel.map((r) => (
              <tr key={r.level}>
                <td className={td}>{botLevelLabel(t, r.level)}</td>
                <td className={`${td} font-mono`}>{formatChips(r.hands)}</td>
                <td className={`${td} font-mono`}>{signed(r.net)}</td>
              </tr>
            ))}
          </Table>
        )}
        <LevelPlayTable rows={o.play ?? []} />
        <figure>
          <div role="img" aria-label={t('botsChart')} className="flex h-24 items-end gap-px border-b border-white/10" data-testid="bots-chart">
            {o.series.map((s) => (
              <span
                key={s.date}
                title={t('botsDay', { date: s.date, hands: s.hands, tables: s.tables })}
                className={`min-w-0 flex-1 rounded-t-sm ${s.hands === 0 ? 'bg-white/5' : 'bg-gold-500/70'}`}
                style={{ height: s.hands ? `${Math.max(6, (s.hands / max) * 100)}%` : '2px' }}
              />
            ))}
          </div>
          <figcaption className="mt-1.5 flex flex-wrap justify-between gap-2 text-[11px] text-ink-400">
            <span>{o.series[0]?.date} – {o.series[o.series.length - 1]?.date}</span>
            <span>{t('botsChartHint')}</span>
          </figcaption>
        </figure>
        {eventsTotal > 0 && (
          <ul className="flex flex-wrap gap-2" data-testid="bots-event-counts">
            {Object.entries(o.events).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
              <li key={k} data-kind={k}><Badge tone={k === 'join' || k === 'leave' ? 'neutral' : 'gold'}>{botEventKindLabel(t, k)} {formatChips(n)}</Badge></li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** A rate with the chances it is out of; a dash when there were none. */
function Rate({ n, of }: { n: number; of: number }) {
  if (of <= 0) return <span className="text-ink-400">—</span>;
  return (
    <>
      {((n / of) * 100).toFixed(1)}% <span className="text-ink-400">({formatChips(of)})</span>
    </>
  );
}

function LevelPlayTable({ rows }: { rows: LevelPlay[] }) {
  const { t } = useT();
  const shown = rows.filter((r) => r.hands > 0 || r.decisions > 0);
  const pct = (n: number, of: number) => (of > 0 ? ` (${((n / of) * 100).toFixed(1)}%)` : '');
  return (
    <div className="flex flex-col gap-2" data-testid="bots-level-play">
      <h3 className="text-sm font-bold">{t('botsLevelPlay')}</h3>
      <p className="text-xs text-ink-400">{t('botsLevelPlayHint')}</p>
      {shown.length === 0 ? (
        <p className="text-xs text-ink-400">{t('botsLevelPlayEmpty')}</p>
      ) : (
        <Table
          head={[
            t('botsLevel'),
            t('botsColSeatHands'),
            t('botsColVpip'),
            t('botsColPfr'),
            t('botsCol3Bet'),
            t('botsColBbDefense'),
            t('botsColFoldOverbet'),
            t('botsColDecisions'),
            t('botsColFallback'),
            t('botsColFailures'),
            t('botsColLag'),
            t('botsColSlow'),
          ]}
        >
          {shown.map((r) => (
            <tr key={r.level} data-level={r.level}>
              <td className={td}>{botLevelLabel(t, r.level)}</td>
              <td className={`${td} font-mono`}>{formatChips(r.hands)}</td>
              <td className={`${td} whitespace-nowrap font-mono`}><Rate n={r.vpip} of={r.vpipOpp} /></td>
              <td className={`${td} whitespace-nowrap font-mono`}><Rate n={r.pfr} of={r.vpipOpp} /></td>
              <td className={`${td} whitespace-nowrap font-mono`}><Rate n={r.threeBet} of={r.threeBetOpp} /></td>
              <td className={`${td} whitespace-nowrap font-mono`}><Rate n={r.bbStealOpp - r.bbFoldToSteal} of={r.bbStealOpp} /></td>
              <td className={`${td} whitespace-nowrap font-mono`}><Rate n={r.foldToOverbet} of={r.foldToOverbetOpp} /></td>
              <td className={`${td} font-mono`}>{formatChips(r.decisions)}</td>
              <td className={`${td} whitespace-nowrap font-mono`}>{formatChips(r.fallbacks)}<span className="text-ink-400">{pct(r.fallbacks, r.decisions)}</span></td>
              <td className={`${td} whitespace-nowrap font-mono`}>{formatChips(r.failures)}<span className="text-ink-400">{pct(r.failures, r.decisions)}</span></td>
              <td className={`${td} whitespace-nowrap font-mono`}>{r.decisions > 0 ? `${formatChips(Math.round(r.lagMs / r.decisions))} ms` : '—'}</td>
              <td className={`${td} font-mono`}>{formatChips(r.slow)}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

function VersionTable({ rows }: { rows: Version[] }) {
  const { t, locale } = useT();
  if (rows.length === 0) return <Empty>{t('noneFound')}</Empty>;
  return (
    <div data-testid="bots-versions">
      <Table head={[t('refillColVersion'), t('time'), t('colKind'), t('refillColState'), t('botsFundLimit'), t('botsMaxBots'), t('actor'), t('reason')]}>
        {rows.map((v) => (
          <tr key={v.version}>
            <td className={`${td} font-mono`}>v{v.version}</td>
            <td className={`${td} text-xs text-ink-400`}>{formatDate(v.createdAt, locale)}</td>
            <td className={td}>{t(CHANGE[v.change] ?? 'refillChangePolicy')}</td>
            <td className={`${td} whitespace-nowrap`}><OnBadge on={v.enabled} /></td>
            <td className={`${td} font-mono`}>{formatChips(v.fundLimit)}</td>
            <td className={`${td} font-mono`}>{formatChips(v.maxBots)}</td>
            <td className={`${td} text-xs`}>{v.actorNickname ?? (v.actorId ? v.actorId : t('refillSystem'))}</td>
            <td className={`${td} break-all text-xs text-ink-300`}>{v.reason ?? ''}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

/** The bots' operations log; a table page links here with `?table=` to show that table's lines. */
function EventList({ tables }: { tables: BotTable[] }) {
  const { t, locale } = useT();
  const [params] = useSearchParams();
  const [table, setTable] = useState(params.get('table') ?? '');
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (table) q.set('table', table);
  if (kind) q.set('kind', kind);
  const { data, error, loading, reload } = useData<{ items: BotEvent[]; hasMore: boolean }>(`/api/admin/bots/events?${q}`);
  const rows = data?.items ?? [];
  const filter = <V,>(set: (v: V) => void) => (v: V) => {
    set(v);
    setOffset(0);
  };
  return (
    <Panel title={t('botsEvents')} className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
      <p className="mb-3 text-xs text-ink-400">{t('botsEventsHint')}</p>
      <div className="mb-3 flex flex-wrap gap-2">
        <select aria-label={t('tables')} value={table} onChange={(e) => filter(setTable)(e.target.value)} className={selectCls} data-testid="bots-events-table">
          <option value="">{t('botsAllTables')}</option>
          {tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.name}</option>)}
          {table && !tables.some((tb) => tb.id === table) && <option value={table}>{table}</option>}
        </select>
        <select aria-label={t('colKind')} value={kind} onChange={(e) => filter(setKind)(e.target.value)} className={selectCls} data-testid="bots-events-kind">
          <option value="">{t('botsAllKinds')}</option>
          {KINDS.map((k) => <option key={k} value={k}>{botEventKindLabel(t, k)}</option>)}
        </select>
      </div>
      {error && <LoadError error={error} onRetry={reload} />}
      <ListState loading={loading} empty={rows.length === 0} />
      {rows.length > 0 && (
        <div data-testid="bots-events">
          <Table head={[t('time'), t('tables'), t('botsBot'), t('colKind'), t('botsCode')]}>
            {rows.map((e) => (
              <tr key={e.id} data-kind={e.kind}>
                <td className={`${td} whitespace-nowrap text-xs text-ink-400`}>{formatDate(e.createdAt, locale)}</td>
                <td className={td}><Link to={`/tables/${e.tableId}`} className="text-gold-300 hover:underline">{e.tableName ?? e.tableId}</Link></td>
                <td className={td}><BotLink id={e.botId} name={e.nickname} /></td>
                <td className={td}><Badge tone={e.kind === 'join' || e.kind === 'leave' ? 'neutral' : 'gold'}>{botEventKindLabel(t, e.kind)}</Badge></td>
                <td className={`${td} text-xs`} title={e.code ?? undefined}>{e.code ? botEventCodeLabel(t, e.code) : <span className="text-ink-400">—</span>}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {(offset > 0 || rows.length > 0) && (
        <Pager
          label={t('botsEvents')}
          testid="bots-events-pager"
          range={rows.length ? t('auditRangeNoTotal', { from: offset + 1, to: offset + rows.length }) : ''}
          prev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null}
          next={data?.hasMore ? () => setOffset(offset + PAGE) : null}
          busy={loading}
        />
      )}
    </Panel>
  );
}

/** The fund's books, checked on request (it reads every bot's ledger rows). */
function IntegrityPanel() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [r, setR] = useState<Integrity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setR(await api<Integrity>('/api/admin/bots/integrity'));
    } catch (e) {
      setError(errText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title={t('botsIntegrity')}
      actions={<Button size="sm" variant="outline" loading={busy} onClick={() => void run()} data-testid="bots-integrity-run">{r ? t('botsIntegrityAgain') : t('botsIntegrityRun')}</Button>}
    >
      <p className="mb-3 text-xs text-ink-400">{t('botsIntegrityHint')}</p>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {r && (
        <div className="flex flex-col gap-4 text-sm" data-testid="bots-integrity" data-ok={r.ok ? 'true' : 'false'}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={r.ok ? 'green' : 'red'}>{r.ok ? t('botsIntegrityOk') : t('botsIntegrityBad')}</Badge>
            <span className="text-xs text-ink-400">{t('botsIntegrityAt', { at: formatDate(r.checkedAt, locale), n: formatChips(r.rowsRead) })}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('botsIssued')} value={formatChips(r.fund.issued)} sub={t('botsLedgerSum', { n: formatChips(r.fund.ledger) })} />
            <Stat label={t('botsFundDiff')} value={<span className={r.fund.diff ? 'text-danger' : 'text-success'} data-testid="bots-fund-diff">{signed(r.fund.diff)}</span>} />
            <Stat label={t('botsAccountsN')} value={formatChips(r.accounts)} />
            <Stat label={t('botsResult')} value={signed(r.result.net)} sub={t('botsResultLine', { wallets: formatChips(r.result.wallets), tables: formatChips(r.result.atTables), issued: formatChips(r.result.issued) })} />
          </div>
          <IssueList title={t('botsWalletMismatch')} n={r.walletMismatches.length}>
            {r.walletMismatches.map((b) => (
              <li key={b.id}><BotLink id={b.id} name={b.nickname} /> · {t('botsWalletLine', { balance: formatChips(b.balance), ledger: formatChips(b.ledger), diff: signed(b.diff) })}</li>
            ))}
          </IssueList>
          <IssueList title={t('botsDoubleSeated')} n={r.doubleSeated.length}>
            {r.doubleSeated.map((b) => <li key={b.botId}><BotLink id={b.botId} name={b.nickname} /> · {t('botsSeatsN', { n: b.n })}</li>)}
          </IssueList>
          <IssueList title={t('botsOnClosed')} n={r.onClosedTables.length}>
            {r.onClosedTables.map((b) => (
              <li key={`${b.tableId}:${b.botId}`}><BotLink id={b.botId} name={b.nickname} /> · <Link to={`/tables/${b.tableId}`} className="text-gold-300 hover:underline">{b.tableName}</Link></li>
            ))}
          </IssueList>
          {!r.ok && <p className="text-xs text-ink-300">{t('botsIntegrityFix')} <Link to="/reconcile" className="text-gold-300 hover:underline">{t('reconcile')} →</Link></p>}
        </div>
      )}
    </Panel>
  );
}

function IssueList({ title, n, children }: { title: string; n: number; children: ReactNode }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-bold">{title}</h3>
        <Badge tone={n ? 'red' : 'neutral'}>{n}</Badge>
      </div>
      {n === 0 ? <p className="text-xs text-ink-400">{t('noneFound')}</p> : <ul className="flex flex-col gap-1 text-xs">{children}</ul>}
    </div>
  );
}

interface BotAccount {
  id: string;
  nickname: string;
  status: string;
  balance: number;
  createdAt: number;
  /** The account's own settings; null (or a null field): the table's. */
  profile: BotProfile | null;
  updatedAt: number | null;
  updatedBy: string | null;
  /** The style a table on `auto` gives it. */
  auto: BotStyle;
  /** `buyIn`: the chips it sat down with there. */
  seat: { tableId: string; tableName: string; seatIndex: number; since: number; buyIn: number; table: { level: BotLevel; style: BotTableStyle } & TableBuyIn } | null;
  /** How it plays at that table from the next hand. */
  effective: BotPlay | null;
  play: { hands: number; counted: number; vpip: number; pfr: number; net: number; af: { hands: number; aggressive: number; calls: number } };
  result: number;
}
interface BotAccounts { days: number; total: number; limit: number; offset: number; afHands: number; items: BotAccount[] }
interface TableBuyIn { bigBlind: number; minBuyIn: number; maxBuyIn: number }
interface ProfileTable extends TableBuyIn { id: string; name: string; level: BotLevel; style: BotTableStyle }
/** `buyIn`: the chips it would sit down with at that table, before and after (`seated`: what it sat down with now). */
interface ProfilePreview {
  from: BotProfile;
  to: BotProfile;
  auto: BotStyle;
  table: ProfileTable | null;
  effective: { from: BotPlay; to: BotPlay } | null;
  appliesFrom: 'next_hand' | 'next_seat';
  buyIn: { from: number; to: number; seated: number } | null;
}

/** Where a level or style comes from: the account's own, the table's, or the account's auto style. */
function From({ from }: { from: BotPlay['styleFrom'] }) {
  const { t } = useT();
  if (from === 'bot') return <Badge tone="gold">{t('botsFromOwn')}</Badge>;
  return <span className="text-[11px] text-ink-400">{t(from === 'auto' ? 'botsFromAuto' : 'botsFromTable')}</span>;
}

/** Postflop aggression: bets and raises over calls, with both counts; a dash with no calls (no ratio to show). */
function Af({ af }: { af: BotAccount['play']['af'] }) {
  if (af.hands === 0 || af.aggressive + af.calls === 0) return <span className="text-ink-400">—</span>;
  return (
    <>
      {af.calls > 0 ? (af.aggressive / af.calls).toFixed(2) : <span className="text-ink-400">—</span>} <span className="text-ink-400">({formatChips(af.aggressive)}/{formatChips(af.calls)})</span>
    </>
  );
}

/** Each bot account: its own level and style over the table's, where it sits, and how it played over the period. */
function AccountsPanel({ days, onNote }: { days: number; onNote: (n: Note) => void }) {
  const { t, locale } = useT();
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useData<BotAccounts>(`/api/admin/bots/accounts?days=${days}&limit=${PAGE}&offset=${offset}`);
  const [edit, setEdit] = useState<BotAccount | null>(null);
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const done = async (n: Note) => {
    setEdit(null);
    onNote(n);
    await reload();
  };
  const level = (r: BotAccount) =>
    r.effective ? (
      <>{botLevelLabel(t, r.effective.level)} <From from={r.effective.levelFrom} /></>
    ) : r.profile?.level ? (
      <>{botLevelLabel(t, r.profile.level)} <From from="bot" /></>
    ) : (
      <span className="text-ink-400">{t('botsFollowTable')}</span>
    );
  const style = (r: BotAccount) =>
    r.effective ? (
      <>{botStyleLabel(t, r.effective.style)} <From from={r.effective.styleFrom} /></>
    ) : r.profile?.style ? (
      <>{botStyleLabel(t, r.profile.style)} <From from="bot" /></>
    ) : (
      <span className="text-ink-400">{t('botsFollowTable')}</span>
    );
  return (
    <Panel title={t('botsAcctTitle', { n: total })} className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
      <p className="mb-3 text-xs text-ink-400">{t('botsAcctHint', { days, af: data?.afHands ?? 500 })}</p>
      {error && <LoadError error={error} onRetry={reload} />}
      {data && total === 0 ? <Empty>{t('botsAcctEmpty')}</Empty> : <ListState loading={loading} empty={rows.length === 0} />}
      {rows.length > 0 && (
        <div data-testid="bots-accounts">
          <Table
            head={[
              t('botsBot'),
              t('botsColBotId'),
              t('botsLevel'),
              t('botsStyle'),
              t('botsBuyIn'),
              t('botsColTableNow'),
              t('status'),
              t('botsColHands'),
              t('botsColVpip'),
              t('botsColPfr'),
              t('botsColAf'),
              t('botsColNet'),
              t('botsColResult'),
              '',
            ]}
          >
            {rows.map((r) => (
              <tr key={r.id} data-bot={r.id} data-level={r.effective?.level ?? r.profile?.level ?? ''} data-style={r.effective?.style ?? r.profile?.style ?? ''}>
                <td className={td}><BotLink id={r.id} name={r.nickname} /></td>
                <td className={`${td} max-w-[9rem] truncate font-mono text-[11px] text-ink-400`} title={r.id}>{r.id}</td>
                <td className={`${td} whitespace-nowrap`} data-testid="bot-acct-level">{level(r)}</td>
                <td className={`${td} whitespace-nowrap`} data-testid="bot-acct-style">{style(r)}</td>
                <td className={`${td} whitespace-nowrap`} data-testid="bot-acct-buyin">
                  {r.profile?.buyInBb ? (
                    <>{t('botsBuyInBb', { n: r.profile.buyInBb })} <From from="bot" /></>
                  ) : (
                    <span className="text-ink-400">{t('botsBuyInDefault', { n: BOT_BUY_IN_BB.default })}</span>
                  )}
                  {r.seat && <p className="text-[11px] text-ink-400">{t('botsBuyInSeat', { n: formatChips(r.seat.buyIn) })}</p>}
                </td>
                <td className={`${td} text-xs`}>
                  {r.seat ? (
                    <>
                      <Link to={`/tables/${r.seat.tableId}`} className="text-gold-300 hover:underline">{r.seat.tableName}</Link>{' '}
                      <span className="whitespace-nowrap text-ink-400">{t('botsSeatN', { n: r.seat.seatIndex + 1 })}</span>
                    </>
                  ) : (
                    <span className="text-ink-400">—</span>
                  )}
                </td>
                <td className={td}>
                  <div className="flex flex-wrap gap-1">
                    {r.seat ? <Badge tone="green">{t('botsStateSeated')}</Badge> : <Badge>{t('botsStateIdle')}</Badge>}
                    {r.status !== 'active' && <Badge tone="red">{userStatusLabel(t, r.status)}</Badge>}
                  </div>
                </td>
                <td className={`${td} font-mono`}>{formatChips(r.play.hands)}</td>
                <td className={`${td} whitespace-nowrap font-mono`}><Rate n={r.play.vpip} of={r.play.counted} /></td>
                <td className={`${td} whitespace-nowrap font-mono`}><Rate n={r.play.pfr} of={r.play.counted} /></td>
                <td className={`${td} whitespace-nowrap font-mono`} data-testid="bot-acct-af"><Af af={r.play.af} /></td>
                <td className={`${td} font-mono`}>{r.play.hands > 0 ? signed(r.play.net) : <span className="text-ink-400">—</span>}</td>
                <td className={`${td} font-mono`}>{signed(r.result)}</td>
                <td className={td}>
                  <Button size="sm" variant="outline" onClick={() => setEdit(r)} data-testid="bot-acct-edit">{t('botsEdit')}</Button>
                  {r.updatedAt !== null && (
                    <p className="mt-1 whitespace-nowrap text-[11px] text-ink-400">{t('botsUpdatedBy', { who: r.updatedBy ?? t('refillSystem'), at: formatDate(r.updatedAt, locale) })}</p>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {(offset > 0 || total > rows.length) && (
        <Pager
          label={t('botsAcctTitle', { n: total })}
          testid="bots-accounts-pager"
          range={rows.length ? t('auditRangeNoTotal', { from: offset + 1, to: offset + rows.length }) : ''}
          prev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null}
          next={offset + rows.length < total ? () => setOffset(offset + PAGE) : null}
          busy={loading}
        />
      )}
      {edit && <ProfileEditor key={`${edit.id}:${edit.updatedAt ?? 0}`} bot={edit} onClose={() => setEdit(null)} onDone={done} />}
    </Panel>
  );
}

/**
 * A bot's own level, style and buy-in, each set or left to the table (the buy-in to the default): a preview of the old
 * and new values (how it plays at the table it sits at, and what it would sit down with there), then the password and a
 * reason. Another administrator's change meanwhile reloads the list.
 */
function ProfileEditor({ bot, onClose, onDone }: { bot: BotAccount; onClose: () => void; onDone: (n: Note) => Promise<void> }) {
  const { t } = useT();
  const { api } = useAdmin();
  const [level, setLevel] = useState<BotLevel | ''>(bot.profile?.level ?? '');
  const [style, setStyle] = useState<BotStyle | ''>(bot.profile?.style ?? '');
  const [bb, setBb] = useState(bot.profile?.buyInBb ? String(bot.profile.buyInBb) : '');
  const [pv, setPv] = useState<ProfilePreview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buyInBb = bb.trim() === '' ? null : Number(bb);
  const bbBad = buyInBb !== null && !(Number.isInteger(buyInBb) && buyInBb >= BOT_BUY_IN_BB.min && buyInBb <= BOT_BUY_IN_BB.max);
  const body = { baseUpdatedAt: bot.updatedAt, level: level || null, style: style || null, buyInBb };
  const same = (bot.profile?.level ?? null) === body.level && (bot.profile?.style ?? null) === body.style && (bot.profile?.buyInBb ?? null) === body.buyInBb;
  const table = bot.seat?.table ?? null;
  const bbText = (n: number | null | undefined) => (n ? t('botsBuyInBb', { n }) : t('botsBuyInDefault', { n: BOT_BUY_IN_BB.default }));
  const bbRange = t('botsBuyInRange', { min: BOT_BUY_IN_BB.min, max: BOT_BUY_IN_BB.max, n: BOT_BUY_IN_BB.default });
  const tableStyle = (s: BotTableStyle) => (s === 'auto' ? `${botStyleLabel(t, 'auto')} (${botStyleLabel(t, bot.auto)})` : botStyleLabel(t, s));
  const own = (v: string | null, label: (x: string) => string) => (v ? label(v) : t('botsFollowTable'));
  const play = (p: BotPlay) => `${botLevelLabel(t, p.level)} · ${botStyleLabel(t, p.style)}`;
  const url = `/api/admin/bots/${encodeURIComponent(bot.id)}/profile`;
  const fail = async (e: unknown) => {
    if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
    // Someone else's change came first: the list shows the settings now in force.
    if (e instanceof ApiError && e.code === 'bot_profile_conflict') return onDone({ ok: false, text: errText(e, t) });
    setPv(null);
    setError(errText(e, t));
  };
  const preview = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setReason('');
    setBusy(true);
    try {
      setPv(await api<ProfilePreview>(url, { method: 'PUT', body: { ...body, preview: true } }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<{ roomConfirmed: boolean | null }>(url, { method: 'PUT', body: { ...body, reason: reason.trim() } });
      const late = r.roomConfirmed === false ? ` ${t('botsProfileRoomLate')}` : '';
      await onDone({ ok: true, text: `${t('botsProfileSaved', { name: bot.nickname })}${late}` });
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={pv ? t('botsProfileChange') : t('botsProfileTitle', { name: bot.nickname })}
      footer={
        pv ? (
          <>
            <Button variant="ghost" onClick={() => setPv(null)}>{t('cancel')}</Button>
            <Button variant="gold" disabled={reason.trim().length < 2} loading={busy} onClick={apply} data-testid="bot-profile-apply">{t('confirm')}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" form="bot-profile-form" disabled={same || bbBad} loading={busy} data-testid="bot-profile-preview">{t('refillPreviewBtn')}</Button>
          </>
        )
      }
    >
      {pv ? (
        <div className="flex flex-col gap-3 text-sm" data-testid="bot-profile-change">
          <ul className="flex flex-col gap-1">
            {(
              [
                ['botsLevel', own(pv.from.level, (x) => botLevelLabel(t, x)), own(pv.to.level, (x) => botLevelLabel(t, x))],
                ['botsStyle', own(pv.from.style, (x) => botStyleLabel(t, x)), own(pv.to.style, (x) => botStyleLabel(t, x))],
                ['botsBuyIn', bbText(pv.from.buyInBb), bbText(pv.to.buyInBb)],
              ] as [Key, string, string][]
            ).map(([k, from, to]) => (
              <li key={k} className={from === to ? 'text-ink-400' : 'font-semibold'} data-changed={from !== to}>
                <span className="font-normal text-ink-400">{t(k)}:</span> {from === to ? to : t('histChange', { from, to })}
              </li>
            ))}
          </ul>
          {pv.table && pv.effective && (
            <p className="text-ink-200" data-testid="bot-profile-effective">
              <span className="text-ink-400">{t('botsProfilePlays', { table: pv.table.name })}:</span> {t('histChange', { from: play(pv.effective.from), to: play(pv.effective.to) })}
            </p>
          )}
          {pv.table && pv.buyIn && pv.buyIn.from !== pv.buyIn.to && (
            <p className="text-ink-200" data-testid="bot-profile-buyin-next">
              <span className="text-ink-400">{t('botsBuyInNext', { table: pv.table.name })}:</span> {t('histChange', { from: formatChips(pv.buyIn.from), to: formatChips(pv.buyIn.to) })}
            </p>
          )}
          {(pv.from.level !== pv.to.level || pv.from.style !== pv.to.style) && (
            <p className="rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="bot-profile-applies">
              {pv.table ? t('botsProfileApplyHand', { table: pv.table.name }) : t('botsProfileApplySeat')}
            </p>
          )}
          {(pv.from.buyInBb ?? null) !== (pv.to.buyInBb ?? null) && (
            <p className="rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="bot-profile-buyin-applies">
              {t('botsBuyInApplies')}
            </p>
          )}
          <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="bot-profile-reason" />}</Field>
          <p className="text-xs text-ink-400">{t('pvBasis')}</p>
        </div>
      ) : (
        <form id="bot-profile-form" className="flex flex-col gap-3 text-sm" onSubmit={preview} data-testid="bot-profile-form">
          <p className="text-ink-300" data-testid="bot-profile-now">
            {bot.seat && bot.effective
              ? t('botsProfileNow', { table: bot.seat.tableName, level: botLevelLabel(t, bot.effective.level), style: botStyleLabel(t, bot.effective.style) })
              : t('botsProfileIdle')}
          </p>
          <Field label={t('botsLevel')} hint={table ? t('botsTableDefault', { v: botLevelLabel(t, table.level) }) : undefined}>
            {(id) => (
              <select id={id} className={selectCls} value={level} onChange={(e) => setLevel(e.target.value as BotLevel | '')} data-testid="bot-profile-level">
                {BOT_LEVELS.map((l) => <option key={l} value={l}>{botLevelLabel(t, l)}</option>)}
                <option value="">{t('botsFollowTable')}</option>
              </select>
            )}
          </Field>
          <Field label={t('botsStyle')} hint={table ? t('botsTableDefault', { v: tableStyle(table.style) }) : t('botsAutoStyle', { v: botStyleLabel(t, bot.auto) })}>
            {(id) => (
              <select id={id} className={selectCls} value={style} onChange={(e) => setStyle(e.target.value as BotStyle | '')} data-testid="bot-profile-style">
                {BOT_STYLES.map((st) => <option key={st} value={st}>{botStyleLabel(t, st)}</option>)}
                <option value="">{t('botsFollowTable')}</option>
              </select>
            )}
          </Field>
          <Field label={t('botsBuyIn')} hint={bbRange} error={bbBad ? bbRange : null}>
            {(id) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={BOT_BUY_IN_BB.min}
                max={BOT_BUY_IN_BB.max}
                step={1}
                value={bb}
                placeholder={bbText(null)}
                aria-invalid={bbBad}
                onChange={(e) => setBb(e.target.value)}
                data-testid="bot-profile-buyin"
              />
            )}
          </Field>
          {bot.seat && table && (
            <p className="-mt-1 text-xs text-ink-400" data-testid="bot-profile-buyin-table">
              {t('botsBuyInTable', { table: bot.seat.tableName, min: formatChips(table.minBuyIn), max: formatChips(table.maxBuyIn), now: formatChips(bot.seat.buyIn) })}
            </p>
          )}
          {bot.profile && (
            <Button
              type="button"
              variant="subtle"
              size="sm"
              className="self-start"
              disabled={level === '' && style === '' && bb === ''}
              onClick={() => {
                setLevel('');
                setStyle('');
                setBb('');
              }}
              data-testid="bot-profile-reset"
            >
              {t('botsProfileReset')}
            </Button>
          )}
          {error && <p className="text-sm text-danger" role="alert" data-testid="bot-profile-error">{error}</p>}
        </form>
      )}
    </Modal>
  );
}
