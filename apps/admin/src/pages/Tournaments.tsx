/**
 * Tournament operations (the API's routes/admin-tournaments.ts; the rules are docs/TOURNAMENT.md): the list with what
 * needs an operator, one tournament's controls (registration, start, cancel before the start, pause from the next hand,
 * resume, abort, asking the room to recover) and the templates tournaments are opened from.
 *
 * Every control names the version the page showed: a change by someone else meanwhile is refused and the page loads
 * again. Another administrator's change is heard on the control center's socket (adminChanges.ts): the list and the
 * tournament are read again, and an open dialog says it is behind (keeping what was typed). Nothing here edits a stack, a card, a winner or a place: the table decides them and the room reports them.
 */
import { Badge, Button, Empty, Field, formatChips, formatDate, Input, Panel, Stat, TrophyIcon, XIcon } from '@jc/ui';
import {
  TIME_BANK_LIMITS,
  TOURNAMENT_LIMITS,
  TOURNAMENT_STATUSES,
  TournamentStructureSchema,
  tournamentStructureProblem,
  type AdminTournamentRow,
  type BlindLevel,
  type EntryStatus,
  type TournamentStatus,
  type TournamentStructure,
  type TournamentTemplateDto,
  type TournamentTimeBank,
} from '@jc/types';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAdminChanges, useHeardRevision } from '../adminChanges';
import { REASONS, type AdminTemplate } from '../adminTemplates';
import { useT, type Key } from '../i18n';
import {
  auditActionLabel,
  startDroppedLabel,
  structureProblemLabel,
  tableIssueLabel,
  tnEndReasonLabel,
  tnEntryStatusLabel,
  tnRecoveryLabel,
  tnStatusLabel,
  type Tr,
} from '../labels';
import { ApiError, canDo, errText, useAdmin, useData } from '../lib';
import { AdminReasonField } from '../templateFields';
import { ChangedNotice, Feedback, ListState, LoadError, Modal, PageState, Pager, type Note } from '../ui';
import { Table } from './Console';

type Tone = 'neutral' | 'gold' | 'green' | 'red' | 'blue';
const STATUS_TONE: Record<TournamentStatus, Tone> = { registering: 'blue', closed: 'gold', running: 'green', finished: 'neutral', cancelled: 'neutral', aborted: 'red' };
const ENTRY_TONE: Record<EntryStatus, Tone> = { registered: 'blue', unregistered: 'neutral', dropped: 'neutral', playing: 'green', eliminated: 'neutral', won: 'gold', stopped: 'red' };
const ACTIVE: readonly TournamentStatus[] = ['registering', 'closed', 'running'];
const PAGE = 30;
const td = 'px-2 py-1.5';
const selectCls = 'h-11 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm';
const checkbox = 'size-4 cursor-pointer accent-gold-500';

/** m:ss (or h:mm:ss). */
function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** The server's clock, from the `now` of the last answer, moving every second while `on`. */
function useServerNow(serverNow: number | undefined, on: boolean): number {
  const [base, setBase] = useState({ server: serverNow ?? Date.now(), local: Date.now() });
  const [, tick] = useState(0);
  useEffect(() => {
    if (serverNow !== undefined) setBase({ server: serverNow, local: Date.now() });
  }, [serverNow]);
  useEffect(() => {
    if (!on) return;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [on]);
  return base.server + (Date.now() - base.local);
}

/** Where the level clock is (docs/TOURNAMENT.md "레벨 시계"): running, stopped with the time left kept, or the last level. */
function clockLine(t: Tr, r: AdminTournamentRow, now: number): string {
  if (r.status !== 'running') return '—';
  if (r.levelEndsAt !== null) return t('tnNextIn', { time: clockText(r.levelEndsAt - now) });
  if (r.levelLeftMs !== null) return t('tnClockStopped', { time: clockText(r.levelLeftMs) });
  return t('tnLastLevel');
}

function StatusBadges({ r }: { r: AdminTournamentRow }) {
  const { t } = useT();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={STATUS_TONE[r.status]}>{tnStatusLabel(t, r.status)}</Badge>
      {r.status === 'running' && r.pauseRequested && <Badge tone="gold">{t(r.clockStoppedAt !== null ? 'tnPaused' : 'tnPausePending')}</Badge>}
      {r.recovery.map((c) => (
        <Badge key={c} tone="red">{tnRecoveryLabel(t, c)}</Badge>
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ list
interface ListData {
  now: number;
  tournaments: AdminTournamentRow[];
  hasMore: boolean;
  counts: { registering: number; closed: number; running: number; recovery: number };
}

export function TournamentsPage() {
  const { t, locale } = useT();
  const [status, setStatus] = useState('active');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [offset, setOffset] = useState(0);
  const [note, setNote] = useState<Note>(null);
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  if (recovery) params.set('recovery', '1');
  const { data, error, loading, reload } = useData<ListData>(`/api/admin/tournaments?${params}`);
  // A tournament someone else changed: the list is read again, once for the changes of a second.
  const again = useRef(reload);
  again.current = reload;
  const soon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useAdminChanges(true, (e) => {
    if (e.type !== 'admin.monitor.changed' || e.kind !== 'tournament' || soon.current !== undefined) return;
    soon.current = setTimeout(() => {
      soon.current = undefined;
      void again.current();
    }, 1_000);
  });
  useEffect(() => () => clearTimeout(soon.current), []);
  const now = useServerNow(data?.now, !!data?.tournaments.some((r) => r.status === 'running' && r.levelEndsAt !== null));
  // Any change to what is searched starts again from the first page.
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };
  const filtered = status !== 'active' || !!q || recovery;
  const reset = () => {
    setStatus('active');
    setText('');
    setQ('');
    setRecovery(false);
    setOffset(0);
  };
  const rows = data?.tournaments ?? [];
  const c = data?.counts;
  const countStat = (label: Key, n: number | undefined, pick: () => void, testid: string, tone?: string) => (
    <button type="button" className="text-left" onClick={pick} data-testid={testid}>
      <Stat label={t(label)} value={<span className={tone}>{n ?? '—'}</span>} />
    </button>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-extrabold">{t('tnTitle')}</h1>
        <Link to="/tournaments/templates" className="text-sm text-gold-300 hover:underline" data-testid="tn-templates-link">{t('tnTemplates')} →</Link>
        <Button className="ml-auto" size="sm" variant="subtle" onClick={() => void reload()} loading={loading} data-testid="tn-reload">{t('refresh')}</Button>
      </div>
      <p className="text-sm text-ink-300">{t('tnIntro')}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {countStat('tnStRegistering', c?.registering, () => { reset(); setStatus('registering'); }, 'tn-count-registering')}
        {countStat('tnStClosed', c?.closed, () => { reset(); setStatus('closed'); }, 'tn-count-closed')}
        {countStat('tnStRunning', c?.running, () => { reset(); setStatus('running'); }, 'tn-count-running')}
        {countStat('tnRecoveryNeeded', c?.recovery, () => { reset(); setStatus(''); setRecovery(true); }, 'tn-count-recovery', c?.recovery ? 'text-danger' : undefined)}
      </div>
      <Feedback note={note} testid="tn-feedback" pin />
      <CreatePanel onCreated={setNote} />
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); filter(setQ)(text.trim()); }}>
        <Input className="min-w-0 flex-1 basis-56" placeholder={t('tnSearch')} aria-label={t('tnSearch')} value={text} maxLength={60} onChange={(e) => setText(e.target.value)} data-testid="tn-q" />
        <select aria-label={t('status')} value={status} onChange={(e) => filter(setStatus)(e.target.value)} className={selectCls} data-testid="tn-status">
          <option value="active">{t('status')}: {t('tnActive')}</option>
          <option value="ended">{t('status')}: {t('tnEnded')}</option>
          <option value="">{t('status')}: {t('statusAll')}</option>
          {TOURNAMENT_STATUSES.map((s) => <option key={s} value={s}>{t('status')}: {tnStatusLabel(t, s)}</option>)}
        </select>
        <label className="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm">
          <input type="checkbox" className={checkbox} checked={recovery} onChange={(e) => filter(setRecovery)(e.target.checked)} data-testid="tn-recovery" />
          {t('tnRecoveryOnly')}
        </label>
        <Button type="submit" variant="subtle">{t('searchBtn')}</Button>
        {filtered && <Button type="button" variant="ghost" onClick={reset} data-testid="tn-reset">{t('auditReset')}</Button>}
      </form>
      {error && <LoadError error={error} onRetry={reload} />}
      <Panel className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        {rows.length === 0 ? (
          <ListState loading={loading || !data} empty>{filtered ? t('noMatch') : t('tnNone')}</ListState>
        ) : (
          <Table stack head={[t('name'), t('status'), t('tnColPlayers'), t('tnColLevel'), t('tnColClock'), t('time')]}>
            {rows.map((r) => (
              <tr key={r.id} className="max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-2 max-sm:py-2" data-testid="tn-row" data-status={r.status}>
                <td className={`${td} font-semibold max-sm:col-span-2`}>
                  <Link to={`/tournaments/${r.id}`} className="text-gold-300 hover:underline">{r.name}</Link>
                  <span className="block font-mono text-[10px] text-ink-400">{r.id}</span>
                </td>
                <td className={`${td} max-sm:col-span-2`}><StatusBadges r={r} /></td>
                <td className={`${td} whitespace-nowrap`}>
                  {r.status === 'running' || r.endedAt !== null && r.playersLeft !== null
                    ? t('tnLeftOf', { n: r.playersLeft ?? 0, total: r.registered })
                    : t('tnRegisteredOf', { n: r.registered, cap: r.capacity })}
                </td>
                <td className={`${td} whitespace-nowrap font-mono max-sm:text-right`}>
                  {t('tnLevelN', { n: r.level + 1, total: r.levelCount })} · {formatChips(r.smallBlind)}/{formatChips(r.bigBlind)}
                </td>
                <td className={`${td} whitespace-nowrap font-mono text-xs`}>{clockLine(t, r, now)}</td>
                <td className={`${td} text-xs text-ink-400 max-sm:text-right`}>
                  {formatDate(r.endedAt ?? r.startedAt ?? r.createdAt, locale)}
                  {r.endReason && <span className="block">{tnEndReasonLabel(t, r.endReason)}{r.winner && (
                    <>
                      {' · '}
                      <TrophyIcon className="inline size-3 align-[-2px] text-gold-300" /> {r.winner}
                    </>
                  )}</span>}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {data && (rows.length > 0 || offset > 0) && (
          <Pager
            label={t('tnTitle')}
            testid="tn-pager"
            range={rows.length ? t('auditRangeNoTotal', { from: offset + 1, to: offset + rows.length }) : ''}
            prev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null}
            next={data.hasMore ? () => setOffset(offset + PAGE) : null}
            busy={loading}
          />
        )}
      </Panel>
    </div>
  );
}

interface CreatePreview {
  preview: true;
  template: TournamentTemplateDto;
  summary: TournamentStructure;
  open: number;
  openMax: number;
}

/** Opens a tournament from an active template: the summary is read back from the server and confirmed before it is made. */
function CreatePanel({ onCreated }: { onCreated: (n: Note) => void }) {
  const { t } = useT();
  const { api } = useAdmin();
  const nav = useNavigate();
  const templates = useData<{ templates: TournamentTemplateDto[]; hasMore: boolean }>('/api/admin/tournament-templates?status=active&limit=100');
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [pv, setPv] = useState<CreatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = templates.data?.templates ?? [];
  const tpl = list.find((x) => x.id === templateId) ?? list[0] ?? null;
  const nameOk = !name.trim() || (name.trim().length >= TOURNAMENT_LIMITS.name.min && name.trim().length <= TOURNAMENT_LIMITS.name.max);
  const body = tpl ? { templateId: tpl.id, templateVersion: tpl.version, ...(name.trim() ? { name: name.trim() } : {}) } : null;
  const fail = async (e: unknown) => {
    setPv(null);
    if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
    // The template changed or was archived meanwhile: the list loads again and the summary is asked for again.
    if (e instanceof ApiError && (e.code === 'tournament_template_conflict' || e.code === 'tournament_template_archived')) await templates.reload();
    setError(errText(e, t));
  };
  const preview = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!body) return;
    setError(null);
    setBusy(true);
    try {
      setPv(await api<CreatePreview>('/api/admin/tournaments', { body: { ...body, preview: true } }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (!body) return;
    setBusy(true);
    try {
      const r = await api<{ tournament: AdminTournamentRow }>('/api/admin/tournaments', { body });
      setPv(null);
      setName('');
      onCreated({ ok: true, text: t('tnCreated', { name: r.tournament.name }) });
      nav(`/tournaments/${r.tournament.id}`);
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={t('tnCreateTitle')}>
      {templates.error && !templates.data ? (
        <LoadError error={templates.error} onRetry={templates.reload} />
      ) : !templates.data ? (
        <p className="text-sm text-ink-400">{t('loading')}</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-400" data-testid="tn-no-template">{t('tnNoActiveTemplate')} <Link to="/tournaments/templates" className="text-gold-300 hover:underline">{t('tnTemplates')} →</Link></p>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={preview} data-testid="tn-create">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('tnTemplate')}>
              {(fid) => (
                <select id={fid} className={selectCls} value={tpl?.id ?? ''} onChange={(e) => setTemplateId(e.target.value)} data-testid="tn-create-template">
                  {list.map((x) => <option key={x.id} value={x.id}>{x.name} · v{x.version}</option>)}
                </select>
              )}
            </Field>
            <Field label={t('tnNameOptional')} hint={tpl ? t('tnNameDefault', { name: tpl.name }) : undefined} error={nameOk ? null : t('tnNameLength')}>
              {(fid) => <Input id={fid} value={name} maxLength={TOURNAMENT_LIMITS.name.max} onChange={(e) => setName(e.target.value)} data-testid="tn-create-name" />}
            </Field>
          </div>
          <p className="text-xs text-ink-400">{t('tnCreateHint')}</p>
          {error && <p className="text-sm text-danger" role="alert" data-testid="tn-create-error">{error}</p>}
          <Button type="submit" className="self-start" disabled={!body || !nameOk} loading={busy && !pv} data-testid="tn-create-preview">{t('tnCreatePreview')}</Button>
        </form>
      )}
      <Modal
        open={pv !== null}
        onClose={() => setPv(null)}
        title={t('tnCreateConfirm')}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setPv(null)}>{t('cancel')}</Button>
            <Button variant="gold" loading={busy} disabled={!!pv && pv.open >= pv.openMax} onClick={create} data-testid="tn-create-apply">{t('tnCreateBtn')}</Button>
          </>
        }
      >
        {pv && (
          <div className="flex flex-col gap-3 text-sm" data-testid="tn-create-summary">
            <p className="font-mono text-xs text-ink-400">{pv.template.name} · v{pv.template.version}</p>
            <StructureView s={pv.summary} />
            <p className={pv.open >= pv.openMax ? 'text-danger' : 'text-xs text-ink-300'} data-testid="tn-create-open">{t('tnOpenCount', { n: pv.open, max: pv.openMax })}</p>
            <p className="text-xs text-ink-400">{t('tnFreeNote')}</p>
            <p className="text-xs text-ink-400">{t('pvBasis')}</p>
          </div>
        )}
      </Modal>
    </Panel>
  );
}

/** A structure as rows (the create summary, a tournament's own copy, a template). */
function StructureView({ s, compact = false }: { s: TournamentStructure; compact?: boolean }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {structureRows(t, s).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-ink-400">{t(k)}</dt>
            <dd className="font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      {!compact && <LevelsTable levels={s.levels} minutes={s.levelMinutes} />}
    </div>
  );
}

function tbText(t: Tr, tb: TournamentTimeBank): string {
  if (!tb.enabled) return t('refillOff');
  return t('tnTimeBankRule', { initial: Math.round(tb.initialMs / 1000), max: Math.round(tb.maxMs / 1000), unit: Math.round(tb.unitMs / 1000), hands: tb.refillHands, refill: Math.round(tb.refillMs / 1000) });
}

function structureRows(t: Tr, s: TournamentStructure): [Key, string][] {
  return [
    ['name', s.name],
    ['tnCapacity', t('tnPlayersN', { n: s.capacity })],
    ['tnMinPlayers', t('tnPlayersN', { n: s.minPlayers })],
    ['tnStartStack', formatChips(s.startStack)],
    ['tnLevelMinutes', t('tnMinutesN', { n: s.levelMinutes })],
    ['tnLevels', t('tnLevelsSummary', { n: s.levels.length, first: `${formatChips(s.levels[0]?.sb ?? 0)}/${formatChips(s.levels[0]?.bb ?? 0)}`, last: `${formatChips(s.levels[s.levels.length - 1]?.sb ?? 0)}/${formatChips(s.levels[s.levels.length - 1]?.bb ?? 0)}` })],
    ['turnSeconds', t('tbSeconds', { n: s.turnSeconds })],
    ['tnTimeBank', tbText(t, s.timeBank)],
    ['tnMinHands', s.minHands > 0 ? t('tnHandsN', { n: s.minHands }) : t('none')],
    ['tnRequireVerified', s.requireVerified ? t('yes') : t('no')],
    ['tnAutoStart', s.autoStart ? t('tnAutoStartOn') : t('tnAutoStartOff')],
  ];
}

function LevelsTable({ levels, minutes, current }: { levels: BlindLevel[]; minutes: number; current?: number }) {
  const { t } = useT();
  return (
    <details className="rounded-lg border border-white/10 px-3 py-2" open={current !== undefined}>
      <summary className="cursor-pointer text-xs font-semibold text-ink-300">{t('tnLevelsTitle', { n: levels.length, min: minutes })}</summary>
      <ol className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-xs sm:grid-cols-4" data-testid="tn-levels">
        {levels.map((l, i) => (
          <li key={i} className={i === current ? 'font-bold text-gold-300' : 'text-ink-200'} aria-current={i === current ? 'step' : undefined}>
            {i + 1}. {formatChips(l.sb)}/{formatChips(l.bb)}
          </li>
        ))}
      </ol>
    </details>
  );
}

// ------------------------------------------------------------------ one tournament
type DetailRow = AdminTournamentRow & {
  levels: BlindLevel[];
  levelMinutes: number;
  turnSeconds: number;
  timeBank: TournamentTimeBank;
  minHands: number;
  requireVerified: boolean;
  endNote: string | null;
  endedBy: string | null;
  createdBy: string | null;
};
interface Entry {
  userId: string;
  nickname: string | null;
  status: EntryStatus;
  seat: number | null;
  stack: number | null;
  place: number | null;
  registeredAt: number;
  eliminatedAt: number | null;
  eliminatedHand: number | null;
  updatedAt: number;
  connected: boolean | null;
}
interface LiveSeat { seatIndex: number; userId: string; nickname: string; stack: number; connected: boolean; sittingOut: boolean; inHand: boolean; timeouts: number; timeBank: { ms: number } | null }
interface Live { answered: boolean; handInProgress: boolean | null; handNumber: number | null; connections: number | null; issues: string[]; seats: LiveSeat[]; alarmAt: number | null }
interface HistoryItem { id: string; action: string; outcome: 'ok' | 'failed'; createdAt: number; actor: { id: string; nickname: string | null; role: string | null }; detail: unknown }
interface DetailData { now: number; tournament: DetailRow; entries: Entry[]; live: Live | null; history: HistoryItem[] }

type Act = 'close' | 'open' | 'start' | 'cancel' | 'pause' | 'resume' | 'abort' | 'recover';
/** What each control asks: a reason (required, optional or none) and, to abort, the name typed again. */
const ACT: Record<Act, { title: Key; hint: Key; reason: 'required' | 'optional' | 'none'; danger?: boolean }> = {
  close: { title: 'tnActClose', hint: 'tnHintClose', reason: 'none' },
  open: { title: 'tnActOpen', hint: 'tnHintOpen', reason: 'none' },
  start: { title: 'tnActStart', hint: 'tnHintStart', reason: 'optional' },
  cancel: { title: 'tnActCancel', hint: 'tnHintCancel', reason: 'required', danger: true },
  pause: { title: 'tnActPause', hint: 'tnHintPause', reason: 'optional' },
  resume: { title: 'tnActResume', hint: 'tnHintResume', reason: 'optional' },
  abort: { title: 'tnActAbort', hint: 'tnHintAbort', reason: 'required', danger: true },
  recover: { title: 'tnActRecover', hint: 'tnHintRecover', reason: 'optional' },
};
/** The reasons offered for each control that asks one (opening and closing registration ask none). */
const ACT_REASONS: Partial<Record<Act, AdminTemplate[]>> = REASONS.tournamentAct;
/** The codes after which what the page shows is out of date: it loads again. */
const STALE = new Set(['tournament_conflict', 'tournament_state', 'tournament_started', 'tournament_not_found', 'tournament_not_ready']);

interface StartResponse { started: boolean; players: number; dropped: { userId: string; reason: string }[]; roomConfirmed: boolean }

export function TournamentDetailPage() {
  const { id = '' } = useParams();
  const { t, locale } = useT();
  const { api } = useAdmin();
  const { data, error, loading, reload, setData } = useData<DetailData>(`/api/admin/tournaments/${id}`);
  const [note, setNote] = useState<Note>(null);
  const [act, setAct] = useState<{ act: Act; version: number } | null>(null);
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const r = data?.tournament;
  const active = !!r && ACTIVE.includes(r.status);
  const now = useServerNow(data?.now, !!r && r.status === 'running' && r.levelEndsAt !== null);
  // A tournament still to be played or being played is looked at again every 15 seconds (while the page is visible).
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 15_000);
    return () => clearInterval(h);
  }, [active, reload]);
  // Someone else's change to it (adminChanges.ts) is read at once, as the 15-second look would. A dialog opened before
  // it names the older version, so it says it is behind and its confirm waits until it is read again (what was typed
  // stays); the server refuses an older version either way.
  const heard = useHeardRevision(id || null, (e) => e.type === 'admin.monitor.changed' && e.kind === 'tournament' && e.resourceId === id);
  const shown = r?.version;
  useEffect(() => {
    if (heard !== null && shown !== undefined && heard > shown && !busy) void reload();
  }, [heard, shown, busy, reload]);
  const [reading, setReading] = useState(false);
  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <Link to="/tournaments" className="text-sm text-gold-300 hover:underline">← {t('tnTitle')}</Link>
      <Button className="ml-auto" size="sm" variant="subtle" onClick={() => void reload()} loading={loading} data-testid="tn-detail-reload">{t('refresh')}</Button>
    </div>
  );
  if (!data || !r) return <div className="flex flex-col gap-4">{header}<PageState error={error} onRetry={reload} /></div>;
  const ask = (a: Act) => {
    setAct({ act: a, version: r.version });
    setReason('');
    setConfirmName('');
    setActError(null);
  };
  const spec = act ? ACT[act.act] : null;
  const behind = act !== null && !busy && Math.max(heard ?? 0, r.version) > act.version;
  const again = async () => {
    setReading(true);
    try {
      const fresh = await api<DetailData>(`/api/admin/tournaments/${id}`);
      setData(fresh);
      setAct((a) => a && { act: a.act, version: fresh.tournament.version });
      setActError(null);
    } catch (e) {
      setActError(errText(e, t));
    } finally {
      setReading(false);
    }
  };
  const reasonOk = !spec || spec.reason === 'none' || (spec.reason === 'optional' ? reason.trim().length === 0 || reason.trim().length >= 2 : reason.trim().length >= 2);
  const nameOk = act?.act !== 'abort' || confirmName.trim() === r.name.trim();
  const run = async () => {
    if (!act) return;
    const a = act.act;
    const why = reason.trim() || undefined;
    const base = `/api/admin/tournaments/${id}`;
    setBusy(true);
    setActError(null);
    try {
      let text = t('saved');
      if (a === 'close' || a === 'open') {
        await api(`${base}/registration`, { body: { action: a, baseVersion: act.version } });
        text = t(a === 'close' ? 'tnDoneClose' : 'tnDoneOpen');
      } else if (a === 'start') {
        const s = await api<StartResponse>(`${base}/start`, { body: { baseVersion: act.version, reason: why } });
        text = [
          t('tnDoneStart', { n: s.players }),
          s.dropped.length ? t('tnDroppedN', { n: s.dropped.length, why: [...new Set(s.dropped.map((d) => startDroppedLabel(t, d.reason)))].join(', ') }) : '',
          s.roomConfirmed ? '' : t('tnRoomLater'),
        ].filter(Boolean).join(' ');
      } else if (a === 'cancel') {
        const s = await api<{ notified: number }>(`${base}/cancel`, { body: { baseVersion: act.version, reason: why } });
        text = t('tnDoneCancel', { n: s.notified });
      } else if (a === 'pause' || a === 'resume') {
        const s = await api<{ appliesFrom: 'next_hand' | 'now'; roomConfirmed: boolean }>(`${base}/${a}`, { body: { baseVersion: act.version, reason: why } });
        text = [t(a === 'pause' ? (s.appliesFrom === 'next_hand' ? 'tnDonePauseNext' : 'tnDonePauseNow') : 'tnDoneResume'), s.roomConfirmed ? '' : t('tnRoomLater')].filter(Boolean).join(' ');
      } else if (a === 'abort') {
        const s = await api<{ notified: number; roomConfirmed: boolean }>(`${base}/abort`, { body: { baseVersion: act.version, reason: why, confirmName: confirmName.trim() } });
        text = [t('tnDoneAbort', { n: s.notified }), s.roomConfirmed ? '' : t('tnRoomLater')].filter(Boolean).join(' ');
      } else {
        await api(`${base}/recover`, { body: { reason: why } });
        text = t('tnDoneRecover');
      }
      // The page has the new version before it says it is done: a control opened next names that version, not the
      // one this change replaced (which the server would refuse as someone else's change). Once more when that look
      // did not land (it failed, or the 15-second one took over); failing again, the server's refusal is the backstop.
      if (!(await reload())) await reload();
      setAct(null);
      setNote({ ok: true, text });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
      if (e instanceof ApiError && STALE.has(e.code)) {
        // Someone (or the table) changed it first: the page shows it as it is now, and the dialog closes.
        await reload();
        setAct(null);
        const d = e.details as { eligible?: number; minPlayers?: number; dropped?: { reason: string }[] } | undefined;
        const text =
          e.code === 'tournament_not_ready' && typeof d?.eligible === 'number'
            ? [
                t('tnNotReady', { n: d.eligible, min: d.minPlayers ?? r.minPlayers }),
                d.dropped?.length ? t('tnDroppedN', { n: d.dropped.length, why: [...new Set(d.dropped.map((x) => startDroppedLabel(t, x.reason)))].join(', ') }) : '',
              ].filter(Boolean).join(' ')
            : errText(e, t);
        setNote({ ok: false, text });
        return;
      }
      setActError(errText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const btn = (a: Act, variant: 'gold' | 'outline' | 'danger' = 'outline') => (
    <Button key={a} variant={variant} onClick={() => ask(a)} data-testid={`tn-act-${a}`}>{t(ACT[a].title)}</Button>
  );
  const actions: ReactNode[] = [];
  if (r.status === 'registering') actions.push(btn('start', 'gold'), btn('close'), btn('cancel', 'danger'));
  if (r.status === 'closed') actions.push(btn('start', 'gold'), btn('open'), btn('cancel', 'danger'));
  if (r.status === 'running') actions.push(btn(r.pauseRequested ? 'resume' : 'pause', r.pauseRequested ? 'gold' : 'outline'), btn('recover'), btn('abort', 'danger'));
  if ((r.status === 'finished' || r.status === 'aborted') && r.tableId && r.tableStatus && r.tableStatus !== 'closed') actions.push(btn('recover'));
  const ended = r.status === 'finished' || r.status === 'cancelled' || r.status === 'aborted';
  return (
    <div className="flex flex-col gap-6">
      {header}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-extrabold" data-testid="tn-name">{r.name}</h1>
        <StatusBadges r={r} />
        <span className="font-mono text-xs text-ink-400">{r.id} · v{r.version}</span>
      </div>
      <Feedback note={note} testid="tn-detail-feedback" pin />
      {error && <LoadError error={error} onRetry={reload} />}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="tn-stats">
        <Stat label={t('tnColPlayers')} value={<span className="break-keep font-sans text-lg">{r.status === 'running' || ended ? t('tnLeftOf', { n: r.playersLeft ?? 0, total: r.registered }) : t('tnRegisteredOf', { n: r.registered, cap: r.capacity })}</span>} sub={r.status === 'registering' || r.status === 'closed' ? t('tnMinPlayersN', { n: r.minPlayers }) : undefined} />
        <Stat label={t('tnLevelN', { n: r.level + 1, total: r.levelCount })} value={<span className="font-mono">{formatChips(r.smallBlind)}/{formatChips(r.bigBlind)}</span>} />
        <Stat label={t('tnColClock')} value={<span className="break-keep font-sans text-base" data-testid="tn-clock">{clockLine(t, r, now)}</span>} sub={r.status === 'running' && r.clockStoppedAt !== null ? t('tnStoppedSince', { time: formatDate(r.clockStoppedAt, locale) }) : undefined} />
        <Stat label={t('colHands')} value={r.hands} sub={r.roomSeenAt ? t('tnRoomSeen', { time: formatDate(r.roomSeenAt, locale) }) : undefined} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('tnControls')}>
          <div className="flex flex-col gap-3" data-testid="tn-controls">
            {actions.length > 0 ? <div className="flex flex-wrap gap-2">{actions}</div> : <p className="text-sm text-ink-400">{t('tnNoControls')}</p>}
            {r.recovery.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-sm" data-testid="tn-recovery-list">
                {r.recovery.map((c) => <li key={c}><span className="font-semibold text-danger">{tnRecoveryLabel(t, c)}</span> — {t(`tnRecoveryHint_${c}` as Key)}</li>)}
              </ul>
            )}
            <ul className="list-disc space-y-1 pl-4 text-xs text-ink-400">
              <li>{t('tnRulePause')}</li>
              <li>{t('tnRuleClock')}</li>
              <li>{t('tnRuleNoEdit')}</li>
              <li>{t('tnRuleAbort')}</li>
            </ul>
          </div>
        </Panel>
        <Panel title={t('tnStructure')}>
          <div className="flex flex-col gap-2 text-sm">
            <StructureView s={r} compact />
            <LevelsTable levels={r.levels} minutes={r.levelMinutes} current={r.status === 'running' ? r.level : undefined} />
            <p className="text-xs text-ink-400">{t('tnCreatedBy', { who: r.createdBy ?? '—', at: formatDate(r.createdAt, locale) })}{r.startedAt ? ` · ${t('tnStartedAt', { at: formatDate(r.startedAt, locale) })}` : ''}</p>
          </div>
        </Panel>
      </div>
      {ended && (
        <Panel title={t('tnResult')}>
          <div className="flex flex-col gap-2 text-sm" data-testid="tn-result" data-end={r.endReason ?? ''}>
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={r.endReason === 'completed' ? 'gold' : r.endReason === 'aborted' ? 'red' : 'neutral'}>{tnEndReasonLabel(t, r.endReason ?? r.status)}</Badge>
              {r.endReason === 'completed' && r.winner && <span className="font-semibold text-gold-300">
                  <TrophyIcon className="mr-1 inline size-3.5 align-[-2px]" />
                  {r.winner}
                </span>}
              {r.endedAt && <span className="text-xs text-ink-400">{formatDate(r.endedAt, locale)}</span>}
            </p>
            {r.endReason === 'aborted' && <p className="text-ink-200">{t('tnAbortedResult')}</p>}
            {r.endReason === 'cancelled' && <p className="text-ink-200">{t('tnCancelledResult')}</p>}
            {(r.endNote || r.endedBy) && <p className="text-xs text-ink-300">{t('tnEndBy', { who: r.endedBy ?? '—' })}{r.endNote ? ` · ${t('reason')}: ${r.endNote}` : ''}</p>}
          </div>
        </Panel>
      )}
      <Panel title={t('tnEntries', { n: data.entries.length })}>
        <EntriesTable entries={data.entries} running={r.status === 'running'} />
      </Panel>
      {data.live && <LivePanel live={data.live} tableId={r.tableId} tableStatus={r.tableStatus} />}
      <Panel title={t('audit')} actions={<Link to={`/audit?targetType=tournament&targetId=${encodeURIComponent(r.id)}`} className="text-sm text-gold-300 hover:underline" data-testid="tn-audit-link">{t('tnAllHistory')} →</Link>}>
        <HistoryTable items={data.history} />
      </Panel>
      <Modal
        open={act !== null}
        onClose={() => setAct(null)}
        title={spec ? t(spec.title) : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAct(null)}>{t('cancel')}</Button>
            <Button variant={spec?.danger ? 'danger' : 'gold'} disabled={behind || !reasonOk || !nameOk} loading={busy} onClick={run} data-testid="tn-act-confirm">{spec ? t(spec.title) : t('confirm')}</Button>
          </>
        }
      >
        {act && spec && (
          <div className="flex flex-col gap-3 text-sm" data-testid="tn-act-dialog" data-act={act.act}>
            {behind && <ChangedNotice onRefresh={() => void again()} busy={reading} testid="tn-changed" />}
            <p className="text-ink-200">{t(spec.hint)}</p>
            {act.act === 'start' && <p className="text-xs text-ink-300">{t('tnStartCheck', { n: r.registered, min: r.minPlayers, cap: r.capacity })}</p>}
            {(act.act === 'cancel' || act.act === 'abort') && <p className="text-xs text-gold-200">{t('tnNotifyNote')}</p>}
            {spec.reason !== 'none' && (
              <AdminReasonField
                label={t(spec.reason === 'required' ? 'reasonRequired' : 'tnReasonOptional')}
                templates={ACT_REASONS[act.act] ?? []}
                value={reason}
                onChange={setReason}
                maxLength={200}
                testid="tn-act-reason"
              />
            )}
            {act.act === 'abort' && (
              // Not a Field: its label is set in capitals, and the name must be typed exactly as it is.
              <div className="flex flex-col gap-1.5">
                <label htmlFor="tn-act-name" className="text-xs font-semibold text-ink-300">
                  {t('tnTypeName', { name: r.name })}
                </label>
                <Input id="tn-act-name" value={confirmName} maxLength={60} autoComplete="off" onChange={(e) => setConfirmName(e.target.value)} data-testid="tn-act-name" />
                {confirmName && !nameOk && <p className="text-xs text-danger">{t('tnNameMismatch')}</p>}
              </div>
            )}
            {(act.act === 'cancel' || act.act === 'abort') && <p className="text-xs text-ink-400">{t('tnReauthNote')}</p>}
            {actError && <p className="text-sm text-danger" role="alert" data-testid="tn-act-error">{actError}</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}

function EntriesTable({ entries, running }: { entries: Entry[]; running: boolean }) {
  const { t, locale } = useT();
  if (entries.length === 0) return <Empty>{t('tnNoEntries')}</Empty>;
  return (
    <div data-testid="tn-entries">
      <Table stack head={[t('nickname'), t('status'), t('tnSeat'), t('tnStack'), t('tnPlace'), t('time')]}>
        {entries.map((e) => (
          <tr key={e.userId} className="max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-2 max-sm:py-1.5" data-testid="tn-entry" data-status={e.status}>
            <td className={`${td} max-sm:col-span-2`}>
              <Link to={`/users/${e.userId}`} className="text-gold-300 hover:underline">{e.nickname ?? e.userId}</Link>
              {running && e.status === 'playing' && e.connected === false && <Badge className="ml-1">{t('offline')}</Badge>}
            </td>
            <td className={td}><Badge tone={ENTRY_TONE[e.status]}>{tnEntryStatusLabel(t, e.status)}</Badge></td>
            <td className={`${td} font-mono max-sm:text-right`}>{e.seat === null ? '—' : `#${e.seat + 1}`}</td>
            <td className={`${td} font-mono`}>{e.stack === null ? '—' : formatChips(e.stack)}</td>
            <td className={`${td} font-mono max-sm:text-right`}>{e.place === null ? '—' : t('tnPlaceN', { n: e.place })}</td>
            <td className={`${td} text-xs text-ink-400 max-sm:col-span-2`}>
              {e.eliminatedAt ? t('tnOutAt', { at: formatDate(e.eliminatedAt, locale), hand: e.eliminatedHand ?? '—' }) : t('tnRegisteredAt', { at: formatDate(e.registeredAt, locale) })}
            </td>
          </tr>
        ))}
      </Table>
      <p className="mt-2 text-xs text-ink-400">{t('tnEntriesNote')}</p>
    </div>
  );
}

/** The table room as it answered this load: connections, seats, what it reports wrong. Read only; no cards. */
function LivePanel({ live, tableId, tableStatus }: { live: Live; tableId: string | null; tableStatus: string | null }) {
  const { t, locale } = useT();
  return (
    <Panel title={t('tnLive')} actions={tableId ? <Link to={`/tables/${tableId}`} className="text-sm text-gold-300 hover:underline" data-testid="tn-table-link">{t('tnTablePage')} →</Link> : undefined}>
      <div className="flex flex-col gap-3 text-sm" data-testid="tn-live" data-answered={live.answered}>
        {!live.answered ? (
          <p className="text-danger">{tableStatus === 'closed' ? t('tnTableClosed') : t('tnRoomSilent')}</p>
        ) : (
          <>
            <p>{t('tnLiveLine', { hand: live.handNumber ?? 0, state: live.handInProgress ? t('inHand') : t('idleState'), ws: live.connections ?? 0 })}</p>
            {live.issues.length > 0 && (
              <ul className="flex flex-col gap-1">
                {live.issues.map((x) => <li key={x} className="flex items-start gap-2 text-danger"><span aria-hidden>●</span><span>{tableIssueLabel(t, x)}</span></li>)}
              </ul>
            )}
            <ul className="divide-y divide-white/5">
              {live.seats.map((s) => (
                <li key={s.seatIndex} className="flex justify-between gap-2 py-1.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    #{s.seatIndex + 1} {s.nickname}
                    {!s.connected && <Badge>{t('offline')}</Badge>}
                    {s.sittingOut && <Badge tone="gold">{t('tnAway')}</Badge>}
                    {!!s.timeouts && <Badge>{t('timeoutsN', { n: s.timeouts })}</Badge>}
                    {s.timeBank && <Badge>{t('tbSeatBank', { n: Math.floor(s.timeBank.ms / 1000) })}</Badge>}
                  </span>
                  <span className="shrink-0 font-mono">{formatChips(s.stack)}</span>
                </li>
              ))}
            </ul>
            {live.alarmAt && <p className="text-xs text-ink-400">{t('diagAlarm')}: {formatDate(live.alarmAt, locale)}</p>}
            <p className="text-xs text-ink-400">{t('holeCardsHidden')} {t('tnAwayNote')}</p>
          </>
        )}
      </div>
    </Panel>
  );
}

/** The detail of an operator action as a short line (its reason first). */
function historyText(d: unknown): string {
  if (!d || typeof d !== 'object') return typeof d === 'string' ? d : '';
  const o = d as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.reason === 'string') parts.push(o.reason);
  for (const [k, v] of Object.entries(o)) {
    if (k === 'reason' || k === 'structure' || k === 'from' && typeof v === 'object' || k === 'to' && typeof v === 'object') continue;
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(' · ');
}

function HistoryTable({ items }: { items: HistoryItem[] }) {
  const { t, locale } = useT();
  if (items.length === 0) return <Empty>{t('noneFound')}</Empty>;
  return (
    <div data-testid="tn-history">
      <Table stack head={[t('time'), t('actor'), t('action'), t('colDetail')]}>
        {items.map((a) => (
          <tr key={a.id} className={`max-sm:grid max-sm:grid-cols-2 max-sm:py-1.5 ${a.outcome === 'failed' ? 'bg-danger/5' : ''}`}>
            <td className={`${td} whitespace-nowrap text-xs text-ink-400`}>{formatDate(a.createdAt, locale)}</td>
            <td className={`${td} text-xs max-sm:text-right`}>{a.actor.nickname ?? a.actor.id}</td>
            <td className={`${td} text-xs max-sm:col-span-2`}>
              <span className="flex flex-wrap items-center gap-1">
                {auditActionLabel(t, a.action)}
                {a.outcome === 'failed' && <Badge tone="red">{t('outcomeFailed')}</Badge>}
              </span>
            </td>
            <td className={`${td} break-all text-xs text-ink-300 max-sm:col-span-2`}>{historyText(a.detail)}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

// ------------------------------------------------------------------ templates
interface TemplateDiff { preview: true; from?: TournamentStructure; to: TournamentStructure; version?: number; openTournaments?: number }

/** Defaults for a new template (the migration's seed, shorter). */
const NEW_TEMPLATE: TournamentStructure = {
  name: '',
  capacity: 6,
  minPlayers: 2,
  startStack: 1500,
  levels: [
    { sb: 10, bb: 20 },
    { sb: 15, bb: 30 },
    { sb: 25, bb: 50 },
    { sb: 50, bb: 100 },
    { sb: 75, bb: 150 },
    { sb: 100, bb: 200 },
  ],
  levelMinutes: 5,
  turnSeconds: 20,
  timeBank: { enabled: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: true,
};

const structureOf = (x: TournamentStructure): TournamentStructure => ({
  name: x.name,
  capacity: x.capacity,
  minPlayers: x.minPlayers,
  startStack: x.startStack,
  levels: x.levels.map((l) => ({ sb: l.sb, bb: l.bb })),
  levelMinutes: x.levelMinutes,
  turnSeconds: x.turnSeconds,
  timeBank: { ...x.timeBank },
  minHands: x.minHands,
  requireVerified: x.requireVerified,
  autoStart: x.autoStart,
});

export function TournamentTemplatesPage() {
  const { t, locale } = useT();
  const { me } = useAdmin();
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useData<{ templates: TournamentTemplateDto[]; hasMore: boolean }>(`/api/admin/tournament-templates?status=${status}&limit=${PAGE}&offset=${offset}`);
  const [note, setNote] = useState<Note>(null);
  const [editing, setEditing] = useState<TournamentTemplateDto | 'new' | null>(null);
  const [statusAct, setStatusAct] = useState<TournamentTemplateDto | null>(null);
  const superAdmin = canDo(me, 'tournament.structure');
  const changed = async (n: Note) => {
    setNote(n);
    setEditing(null);
    setStatusAct(null);
    await reload();
  };
  const rows = data?.templates ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/tournaments" className="text-sm text-gold-300 hover:underline">← {t('tnTitle')}</Link>
        <h1 className="text-xl font-extrabold">{t('tnTemplates')}</h1>
        <div className="ml-auto flex flex-wrap gap-2">
          {superAdmin && <Button size="sm" onClick={() => setEditing('new')} data-testid="tpl-new">{t('tplNew')}</Button>}
          <Button size="sm" variant="subtle" onClick={() => void reload()} loading={loading}>{t('refresh')}</Button>
        </div>
      </div>
      <p className="text-sm text-ink-300">{t('tplIntro')}</p>
      {!superAdmin && <p className="text-sm text-ink-400" data-testid="tpl-super-only">{t('tplSuperOnly')}</p>}
      <Feedback note={note} testid="tpl-feedback" pin />
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('status')}>
        {(['active', 'archived'] as const).map((s) => (
          <Button key={s} size="sm" variant={status === s ? 'gold' : 'outline'} aria-pressed={status === s} onClick={() => { setStatus(s); setOffset(0); }} data-testid={`tpl-tab-${s}`}>
            {t(s === 'active' ? 'tplActive' : 'tplArchived')}
          </Button>
        ))}
      </div>
      {error && <LoadError error={error} onRetry={reload} />}
      {rows.length === 0 ? (
        <Panel><ListState loading={loading || !data} empty>{t('tplNone')}</ListState></Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((x) => (
            <Panel
              key={x.id}
              title={x.name}
              actions={
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={x.status === 'active' ? 'green' : 'neutral'}>{t(x.status === 'active' ? 'tplActive' : 'tplArchived')}</Badge>
                  <span className="font-mono text-xs text-ink-400">v{x.version}</span>
                </span>
              }
            >
              <div className="flex flex-col gap-3 text-sm" data-testid="tpl-card" data-id={x.id}>
                <StructureView s={x} />
                <p className="text-xs text-ink-400">{t('tplUpdated', { at: formatDate(x.updatedAt, locale), who: x.updatedBy ?? '—' })} · <span className="font-mono">{x.id}</span></p>
                {superAdmin && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(x)} data-testid="tpl-edit">{t('edit')}</Button>
                    <Button size="sm" variant={x.status === 'active' ? 'danger' : 'outline'} onClick={() => setStatusAct(x)} data-testid="tpl-status">{t(x.status === 'active' ? 'tplArchive' : 'tplActivate')}</Button>
                    <Link to={`/audit?targetType=tournament_template&targetId=${encodeURIComponent(x.id)}`} className="self-center text-xs text-gold-300 hover:underline">{t('audit')} →</Link>
                  </div>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}
      {data && (rows.length > 0 || offset > 0) && (
        <Pager
          label={t('tnTemplates')}
          testid="tpl-pager"
          range={rows.length ? t('auditRangeNoTotal', { from: offset + 1, to: offset + rows.length }) : ''}
          prev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null}
          next={data.hasMore ? () => setOffset(offset + PAGE) : null}
          busy={loading}
        />
      )}
      {editing && <TemplateEditor key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`} tpl={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onChanged={changed} />}
      {statusAct && <TemplateStatusDialog tpl={statusAct} onClose={() => setStatusAct(null)} onChanged={changed} />}
    </div>
  );
}

function TemplateStatusDialog({ tpl, onClose, onChanged }: { tpl: TournamentTemplateDto; onClose: () => void; onChanged: (n: Note) => Promise<void> }) {
  const { t } = useT();
  const { api } = useAdmin();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const to = tpl.status === 'active' ? 'archived' : 'active';
  const apply = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/tournament-templates/${tpl.id}/status`, { body: { status: to, baseVersion: tpl.version, reason: reason.trim() } });
      await onChanged({ ok: true, text: t(to === 'archived' ? 'tplArchivedDone' : 'tplActivatedDone', { name: tpl.name }) });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
      if (e instanceof ApiError && (e.code === 'tournament_template_conflict' || e.code === 'tournament_template_state')) return onChanged({ ok: false, text: errText(e, t) });
      setError(errText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t(to === 'archived' ? 'tplArchive' : 'tplActivate')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button variant={to === 'archived' ? 'danger' : 'gold'} disabled={reason.trim().length < 2} loading={busy} onClick={apply} data-testid="tpl-status-apply">{t('confirm')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-ink-200">{t(to === 'archived' ? 'tplArchiveHint' : 'tplActivateHint', { name: tpl.name })}</p>
        <AdminReasonField label={t('reasonRequired')} templates={REASONS.tournamentTplStatus[to]} value={reason} onChange={setReason} maxLength={200} testid="tpl-status-reason" />
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/** Text inputs for a structure (numbers kept as typed until the preview). */
interface Draft {
  name: string;
  capacity: string;
  minPlayers: string;
  startStack: string;
  levelMinutes: string;
  turnSeconds: string;
  levels: { sb: string; bb: string }[];
  tbEnabled: boolean;
  tbInitial: string;
  tbMax: string;
  tbUnit: string;
  tbHands: string;
  tbRefill: string;
  minHands: string;
  requireVerified: boolean;
  autoStart: boolean;
}

const draftOf = (s: TournamentStructure): Draft => ({
  name: s.name,
  capacity: String(s.capacity),
  minPlayers: String(s.minPlayers),
  startStack: String(s.startStack),
  levelMinutes: String(s.levelMinutes),
  turnSeconds: String(s.turnSeconds),
  levels: s.levels.map((l) => ({ sb: String(l.sb), bb: String(l.bb) })),
  tbEnabled: s.timeBank.enabled,
  tbInitial: String(s.timeBank.initialMs / 1000),
  tbMax: String(s.timeBank.maxMs / 1000),
  tbUnit: String(s.timeBank.unitMs / 1000),
  tbHands: String(s.timeBank.refillHands),
  tbRefill: String(s.timeBank.refillMs / 1000),
  minHands: String(s.minHands),
  requireVerified: s.requireVerified,
  autoStart: s.autoStart,
});

const structureFrom = (d: Draft): TournamentStructure => ({
  name: d.name.trim(),
  capacity: Number(d.capacity),
  minPlayers: Number(d.minPlayers),
  startStack: Number(d.startStack),
  levels: d.levels.map((l) => ({ sb: Number(l.sb), bb: Number(l.bb) })),
  levelMinutes: Number(d.levelMinutes),
  turnSeconds: Number(d.turnSeconds),
  timeBank: { enabled: d.tbEnabled, initialMs: Number(d.tbInitial) * 1000, maxMs: Number(d.tbMax) * 1000, unitMs: Number(d.tbUnit) * 1000, refillHands: Number(d.tbHands), refillMs: Number(d.tbRefill) * 1000 },
  minHands: Number(d.minHands),
  requireVerified: d.requireVerified,
  autoStart: d.autoStart,
});

function TemplateEditor({ tpl, onClose, onChanged }: { tpl: TournamentTemplateDto | null; onClose: () => void; onChanged: (n: Note) => Promise<void> }) {
  const { t } = useT();
  const { api } = useAdmin();
  const [d, setD] = useState<Draft>(() => draftOf(tpl ? structureOf(tpl) : NEW_TEMPLATE));
  const [pv, setPv] = useState<TemplateDiff | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const L = TOURNAMENT_LIMITS;
  const T = TIME_BANK_LIMITS;
  const s = structureFrom(d);
  const parsed = TournamentStructureSchema.safeParse(s);
  const bad = new Set(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.')));
  const problem = parsed.success ? tournamentStructureProblem(parsed.data) : null;
  const path = tpl ? `/api/admin/tournament-templates/${tpl.id}` : '/api/admin/tournament-templates';
  const method = tpl ? 'PUT' : 'POST';
  const base = tpl ? { baseVersion: tpl.version } : {};
  const fail = async (e: unknown) => {
    setPv(null);
    if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
    // Someone else changed it first: the list shows the template as it is now and this editor closes.
    if (e instanceof ApiError && e.code === 'tournament_template_conflict') return onChanged({ ok: false, text: errText(e, t) });
    setError(e instanceof ApiError && e.code === 'tournament_structure_invalid' && typeof (e.details as { problem?: string } | undefined)?.problem === 'string' ? structureProblemLabel(t, (e.details as { problem: string }).problem) : errText(e, t));
  };
  const preview = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setReason('');
    setBusy(true);
    try {
      setPv(await api<TemplateDiff>(path, { method, body: { ...s, ...base, preview: true } }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      await api(path, { method, body: { ...s, ...base, reason: reason.trim() } });
      await onChanged({ ok: true, text: t(tpl ? 'tplSaved' : 'tplCreated', { name: s.name }) });
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: k === 'name' ? e.target.value : e.target.value.replace(/\D/g, '') });
  const flag = (k: 'tbEnabled' | 'requireVerified' | 'autoStart') => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: e.target.checked });
  const setLevel = (i: number, k: 'sb' | 'bb', v: string) => setD({ ...d, levels: d.levels.map((l, j) => (j === i ? { ...l, [k]: v.replace(/\D/g, '') } : l)) });
  const addLevel = () => {
    const last = d.levels[d.levels.length - 1];
    const sb = Number(last?.sb ?? 10) || 10;
    const bb = Number(last?.bb ?? 20) || 20;
    setD({ ...d, levels: [...d.levels, { sb: String(sb * 2), bb: String(bb * 2) }] });
  };
  const range = (r: { min: number; max: number }) => t('refillRange', { min: r.min, max: r.max });
  const secRange = (r: { min: number; max: number }) => t('refillRange', { min: t('tbSeconds', { n: r.min / 1000 }), max: t('tbSeconds', { n: r.max / 1000 }) });
  const err = (k: string) => (bad.has(k) ? t('refillOutOfRange') : null);
  const num = (k: keyof Draft, label: Key, hint: string, testid: string) => (
    <Field label={t(label)} hint={hint} error={err(k === 'tbInitial' ? 'timeBank.initialMs' : k === 'tbMax' ? 'timeBank.maxMs' : k === 'tbUnit' ? 'timeBank.unitMs' : k === 'tbHands' ? 'timeBank.refillHands' : k === 'tbRefill' ? 'timeBank.refillMs' : k)}>
      {(fid) => <Input id={fid} inputMode="numeric" value={d[k] as string} onChange={set(k)} disabled={k.startsWith('tb') && !d.tbEnabled} data-testid={testid} />}
    </Field>
  );
  const rows: [Key, (x: TournamentStructure) => string][] = [
    ['name', (x) => x.name],
    ['tnCapacity', (x) => String(x.capacity)],
    ['tnMinPlayers', (x) => String(x.minPlayers)],
    ['tnStartStack', (x) => formatChips(x.startStack)],
    ['tnLevelMinutes', (x) => t('tnMinutesN', { n: x.levelMinutes })],
    ['tnLevels', (x) => x.levels.map((l) => `${l.sb}/${l.bb}`).join(', ')],
    ['turnSeconds', (x) => t('tbSeconds', { n: x.turnSeconds })],
    ['tnTimeBank', (x) => tbText(t, x.timeBank)],
    ['tnMinHands', (x) => String(x.minHands)],
    ['tnRequireVerified', (x) => (x.requireVerified ? t('yes') : t('no'))],
    ['tnAutoStart', (x) => (x.autoStart ? t('tnAutoStartOn') : t('tnAutoStartOff'))],
  ];
  return (
    <Modal open onClose={onClose} wide title={tpl ? t('tplEditTitle', { name: tpl.name }) : t('tplNew')}>
      {!pv ? (
        <form className="flex flex-col gap-4" onSubmit={preview} data-testid="tpl-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Field label={t('name')} hint={range(L.name)} error={err('name')}>{(fid) => <Input id={fid} value={d.name} maxLength={L.name.max} onChange={set('name')} data-testid="tpl-name" />}</Field>
            </div>
            {num('capacity', 'tnCapacity', range(L.capacity), 'tpl-capacity')}
            {num('minPlayers', 'tnMinPlayers', range(L.capacity), 'tpl-min-players')}
            {num('startStack', 'tnStartStack', range(L.startStack), 'tpl-start-stack')}
            {num('levelMinutes', 'tnLevelMinutes', range(L.levelMinutes), 'tpl-level-minutes')}
            {num('turnSeconds', 'turnSeconds', range(L.turnSeconds), 'tpl-turn-seconds')}
            {num('minHands', 'tnMinHands', range(L.minHands), 'tpl-min-hands')}
          </div>
          <fieldset className="flex flex-col gap-2 rounded-lg border border-white/10 p-3">
            <legend className="px-1 text-xs font-semibold text-ink-300">{t('tnLevels')} ({d.levels.length}/{L.levels.max})</legend>
            <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="tpl-levels">
              {d.levels.map((l, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-ink-400">{i + 1}</span>
                  <Input className="min-w-0 flex-1" inputMode="numeric" aria-label={t('tnLevelSb', { n: i + 1 })} value={l.sb} onChange={(e) => setLevel(i, 'sb', e.target.value)} data-testid={`tpl-sb-${i}`} />
                  <span className="text-ink-400">/</span>
                  <Input className="min-w-0 flex-1" inputMode="numeric" aria-label={t('tnLevelBb', { n: i + 1 })} value={l.bb} onChange={(e) => setLevel(i, 'bb', e.target.value)} data-testid={`tpl-bb-${i}`} />
                  <Button type="button" size="icon" variant="ghost" disabled={d.levels.length <= L.levels.min} onClick={() => setD({ ...d, levels: d.levels.filter((_, j) => j !== i) })} aria-label={t('tnLevelRemove', { n: i + 1 })}><XIcon className="size-4" /></Button>
                </li>
              ))}
            </ol>
            <Button type="button" size="sm" variant="outline" className="self-start" disabled={d.levels.length >= L.levels.max} onClick={addLevel} data-testid="tpl-add-level">{t('tnLevelAdd')}</Button>
            <p className="text-xs text-ink-400">{t('tplLevelsHint')}</p>
          </fieldset>
          <fieldset className="flex flex-col gap-3 rounded-lg border border-white/10 p-3">
            <legend className="px-1 text-xs font-semibold text-ink-300">{t('tnTimeBank')}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className={checkbox} checked={d.tbEnabled} onChange={flag('tbEnabled')} data-testid="tpl-tb-enabled" />
              {t('tplTbEnabled')}
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {num('tbInitial', 'tbInitialSec', secRange(T.initialMs), 'tpl-tb-initial')}
              {num('tbMax', 'tbMaxSec', secRange(T.maxMs), 'tpl-tb-max')}
              {num('tbUnit', 'tbUnitSec', secRange(T.unitMs), 'tpl-tb-unit')}
              {num('tbHands', 'tbRefillHands', range(T.refillHands), 'tpl-tb-hands')}
              {num('tbRefill', 'tbRefillSec', secRange(T.refillMs), 'tpl-tb-refill')}
            </div>
            <p className="text-xs text-ink-400">{t('tplTbHint')}</p>
          </fieldset>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className={checkbox} checked={d.requireVerified} onChange={flag('requireVerified')} data-testid="tpl-verified" />
              {t('tnRequireVerified')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className={checkbox} checked={d.autoStart} onChange={flag('autoStart')} data-testid="tpl-auto-start" />
              {t('tplAutoStart')}
            </label>
          </div>
          {problem && <p className="text-sm text-danger" role="alert" data-testid="tpl-problem">{structureProblemLabel(t, problem)}</p>}
          <p className="text-xs text-ink-400">{t('tplNoPrize')}</p>
          {error && <p className="text-sm text-danger" role="alert" data-testid="tpl-error">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={!parsed.success || !!problem} loading={busy} data-testid="tpl-preview">{t('refillPreviewBtn')}</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3 text-sm" data-testid="tpl-change">
          {tpl && <p className="font-mono text-xs text-ink-400">{t('refillVersionChange', { from: tpl.version, to: pv.version ?? tpl.version + 1 })}</p>}
          <ul className="flex flex-col gap-1">
            {rows.map(([k, show]) => {
              const from = pv.from ? show(pv.from) : '—';
              const to = show(pv.to);
              const same = !!pv.from && from === to;
              return (
                <li key={k} className={same ? 'text-ink-400' : 'font-semibold'} data-changed={!same}>
                  <span className="font-normal text-ink-400">{t(k)}:</span> <span className="break-all">{same || !pv.from ? to : t('histChange', { from, to })}</span>
                </li>
              );
            })}
          </ul>
          {tpl && <p className="rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="tpl-open-note">{t('tplOpenNote', { n: pv.openTournaments ?? 0 })}</p>}
          <AdminReasonField label={t('reasonRequired')} templates={REASONS.tournamentTpl[tpl ? 'edit' : 'create']} value={reason} onChange={setReason} maxLength={200} testid="tpl-reason" />
          <p className="text-xs text-ink-400">{t('pvBasis')}</p>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setPv(null)}>{t('tplBack')}</Button>
            <Button variant="gold" disabled={reason.trim().length < 2} loading={busy} onClick={apply} data-testid="tpl-apply">{t('confirm')}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
