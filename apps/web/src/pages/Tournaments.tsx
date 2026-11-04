/**
 * Members' Sit & Go tournaments (docs/TOURNAMENT.md): the list (open and running, or ended) and one tournament with its
 * structure, clock, players and register / withdraw. Free entry, no prize: nothing here shows or moves wallet chips.
 * The server decides everything (eligibility, seats, the start); these pages only show its answers and refresh while
 * the tournament can still change. A member may open a private Sit & Go for friends (docs/TOURNAMENT.md "비공개 대회"):
 * who sees it, who may register and what its host may do are all decided by the server; its join code is answered
 * once, when made, and never put in a link.
 */
import {
  blindsAt,
  type EntryStatus,
  type FriendDto,
  type FriendsDto,
  type PrivateTemplateDto,
  type TournamentDetailDto,
  type TournamentStatus,
  type TournamentSummaryDto,
  type VipColor,
} from '@jc/types';
import { Badge, Button, cx, Empty, Field, formatChips, Input, Modal, Panel, Spinner, Tabs, TrophyIcon } from '@jc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { MemberName } from '../components/MemberName';
import { Avatar } from '../components/Social';
import { api, ApiError } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';
import { onRealtime, onRealtimeResync, useRealtimeStatus, wantTopic } from '../lib/realtime';
import { when } from '../lib/service';
import { useTn, type Tn, type TnKey } from '../game/tournament-text';

const PAGE = 20;
/** How often a page refreshes while it is visible and the tournament can still change. */
const LIST_POLL_MS = 15_000;
const DETAIL_POLL_MS = 5_000;
/**
 * While the realtime socket is up, a registration, start, bust, finish or cancel comes as an event, so the polls only
 * check now and then; a running tournament's stacks (no event per hand) are still read every RUNNING_POLL_MS.
 */
const LIVE_POLL_MS = 60_000;
const RUNNING_POLL_MS = 15_000;
/** The reads one change sets off on every page showing it are spread over this long (not all in the same second). */
const CHANGE_SPREAD_MS = 3_000;

interface ListDto {
  tournaments: TournamentSummaryDto[];
  hasMore: boolean;
  current: TournamentSummaryDto | null;
  now: number;
}

const ACTIVE: readonly TournamentStatus[] = ['registering', 'closed', 'running'];
const STATUS_TONE: Record<TournamentStatus, 'neutral' | 'gold' | 'green' | 'red' | 'blue'> = {
  registering: 'gold',
  closed: 'blue',
  running: 'green',
  finished: 'neutral',
  cancelled: 'red',
  aborted: 'red',
};
const ENTRY_TONE: Partial<Record<EntryStatus, 'neutral' | 'gold' | 'green' | 'red' | 'blue'>> = {
  registered: 'gold',
  playing: 'green',
  won: 'gold',
  eliminated: 'neutral',
  stopped: 'red',
};

/** m:ss (or h:mm:ss) for a time left. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Runs `tick` every `ms` while the page is visible, and at once when it becomes visible again. */
function useVisiblePoll(tick: () => void, ms: number, on: boolean) {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (!on) return;
    const h = setInterval(() => {
      if (document.visibilityState === 'visible') ref.current();
    }, ms);
    const wake = () => {
      if (document.visibilityState === 'visible') ref.current();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [ms, on]);
}

/**
 * Reads again (`reload`) after a random wait when a tournament this page shows (`shows`) changed, once however many
 * changes come meanwhile, and at once when the realtime socket is back after being down. A hidden page waits for its
 * poll's wake. Whether the socket is up, to pick the poll interval.
 */
function useTournamentEvents(reload: () => void, shows: (id: string) => boolean): boolean {
  const up = useRealtimeStatus() === 'open';
  const ref = useRef({ reload, shows });
  ref.current = { reload, shows };
  useEffect(() => {
    const release = wantTopic('tournaments');
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = (id: string) => {
      if (timer || document.visibilityState !== 'visible' || !ref.current.shows(id)) return;
      timer = setTimeout(() => {
        timer = null;
        ref.current.reload();
      }, Math.random() * CHANGE_SPREAD_MS);
    };
    const offs = [onRealtime('tournament.changed', (e) => changed(e.resourceId)), onRealtimeResync(() => ref.current.reload())];
    return () => {
      release();
      if (timer) clearTimeout(timer);
      for (const f of offs) f();
    };
  }, []);
  return up;
}

/** Re-renders every second while `on` (countdowns). */
function useTicker(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const h = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [on]);
}

function StatusBadge({ status }: { status: TournamentStatus }) {
  const { t } = useI18n();
  return (
    <span data-testid="tn-status" data-status={status}>
      <Badge tone={STATUS_TONE[status]}>
        {status === 'running' && <span className="size-1.5 rounded-full bg-success jc-pulse-gold" />}
        {t(`tn.status.${status}` as MsgKey)}
      </Badge>
    </span>
  );
}

function MyBadge({ me }: { me: TournamentSummaryDto['me'] }) {
  const { t } = useI18n();
  const tr = useTn();
  if (!me || me.status === 'unregistered' || me.status === 'dropped') return null;
  return (
    <span data-testid="tn-mine" data-status={me.status}>
      <Badge tone={ENTRY_TONE[me.status] ?? 'neutral'}>
        {tr('you')} · {me.place !== null ? tr('place', { n: me.place }) : tr(`entry.${me.status}` as TnKey)}
      </Badge>
    </span>
  );
}

/** What kind of tournament beyond its status: multi-table, private (and whose). */
function KindBadges({ s }: { s: TournamentSummaryDto }) {
  const tr = useTn();
  return (
    <>
      {s.mtt && (
        <span data-testid="tn-mtt">
          <Badge tone="blue">{tr('mtt')}</Badge>
        </span>
      )}
      {s.private && (
        <span data-testid="tn-private" data-mine={s.private.mine}>
          <Badge tone="gold">{s.private.mine ? tr('private.mine') : tr('private.by', { host: s.private.host })}</Badge>
        </span>
      )}
    </>
  );
}

/** A trophy and "Won by {name}", with the winner's VIP color and mark on the name only (the sentence comes from the translation). */
function WonBy({ tr, name, vip, className }: { tr: Tn; name: string; vip?: VipColor; className?: string }) {
  const MARK = '\u0000';
  const [before = '', after = ''] = tr('wonBy', { name: MARK }).split(MARK);
  return (
    <p className={cx('flex min-w-0 items-center', className)} data-testid="tn-winner">
      <TrophyIcon className="mr-1 size-3.5 text-gold-300" />
      <span className="shrink-0 whitespace-pre">{before}</span>
      <MemberName name={name} vip={vip} />
      {after && <span className="shrink-0 whitespace-pre">{after}</span>}
    </p>
  );
}

function SummaryCard({ s, highlight }: { s: TournamentSummaryDto; highlight?: boolean }) {
  const { t, locale } = useI18n();
  const tr = useTn();
  const ended = !ACTIVE.includes(s.status);
  return (
    <Link
      to={`/tournaments/${s.id}`}
      className={cx('jc-panel jc-tap group flex flex-col gap-3 p-4 transition hover:border-gold-500/40', highlight && 'border-gold-500/40')}
      data-testid="tn-card"
      data-id={s.id}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-ivory">{s.name}</h2>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <StatusBadge status={s.status} />
            <MyBadge me={s.me} />
            <KindBadges s={s} />
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-xl font-semibold tabular-nums text-gold-300">
            {s.status === 'running' && s.playersLeft !== null ? s.playersLeft : s.registered}
            <span className="text-sm text-ink-400">/{s.status === 'running' ? s.registered : s.capacity}</span>
          </div>
          <div className="text-[11px] text-ink-400">{s.status === 'running' ? tr('leftLabel') : tr('entries')}</div>
        </div>
      </header>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-lg bg-black/25 px-2.5 py-1.5">
          <dt className="text-[10px] text-ink-400">{tr('startStack')}</dt>
          <dd className="font-mono font-semibold tabular-nums">{formatChips(s.startStack)}</dd>
        </div>
        <div className="rounded-lg bg-black/25 px-2.5 py-1.5">
          <dt className="text-[10px] text-ink-400">{tr('firstBlinds')}</dt>
          <dd className="font-mono font-semibold tabular-nums">
            {formatChips(s.firstLevel.sb)}/{formatChips(s.firstLevel.bb)}
          </dd>
        </div>
        <div className="rounded-lg bg-black/25 px-2.5 py-1.5">
          <dt className="text-[10px] text-ink-400">{tr('levelLength')}</dt>
          <dd className="font-mono font-semibold tabular-nums">{tr('minutes', { n: s.levelMinutes })}</dd>
        </div>
      </dl>
      <p className="flex flex-wrap justify-between gap-x-3 text-[11px] text-ink-400">
        <span>{tr('free')}</span>
        <span>
          {ended && s.endedAt
            ? tr('endedAt', { at: when(s.endedAt, locale) })
            : s.startedAt
              ? tr('startedAt', { at: when(s.startedAt, locale) })
              : tr('createdAt', { at: when(s.createdAt, locale) })}
        </span>
      </p>
      {s.status === 'finished' && s.winner && <WonBy tr={tr} name={s.winner} vip={s.winnerVip} className="text-xs text-gold-300" />}
    </Link>
  );
}

export function TournamentsPage() {
  const { t } = useI18n();
  const tr = useTn();
  const [tab, setTab] = useState<'active' | 'ended'>('active');
  const [data, setData] = useState<ListDto | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const seq = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      const mine = ++seq.current;
      if (!quiet) {
        setData(null);
        setError(false);
      }
      try {
        const r = await api<ListDto>(`/api/tournaments?status=${tab}&limit=${PAGE}`);
        // Only the latest request is applied (a tab change or a refresh replaces an older one).
        if (mine !== seq.current) return;
        setData((d) => (quiet && d && d.tournaments.length > PAGE ? { ...r, tournaments: [...r.tournaments, ...d.tournaments.slice(PAGE)], hasMore: d.hasMore } : r));
        setError(false);
      } catch {
        if (mine === seq.current) setError(true);
      }
    },
    [tab],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const up = useTournamentEvents(() => void load(true), () => true);
  useVisiblePoll(() => void load(true), up ? LIVE_POLL_MS : LIST_POLL_MS, tab === 'active');

  async function more() {
    if (!data) return;
    setLoadingMore(true);
    try {
      const r = await api<ListDto>(`/api/tournaments?status=${tab}&limit=${PAGE}&offset=${data.tournaments.length}`);
      setData((d) => (d ? { ...d, hasMore: r.hasMore, tournaments: [...d.tournaments, ...r.tournaments.filter((x) => !d.tournaments.some((y) => y.id === x.id))] } : d));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const list = data?.tournaments ?? [];
  const current = data?.current ?? null;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{tr('title')}</h1>
          <p className="mt-1 text-sm text-ink-300">{tr('subtitle')}</p>
        </div>
        <Link to="/leaderboard" className="jc-tap inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border border-gold-500/40 px-3 py-2 text-xs font-semibold text-gold-300 hover:bg-gold-500/10" data-testid="tn-leaderboard">
          <TrophyIcon className="size-4" />
          {t('player.leaderboard')}
        </Link>
      </div>

      {current && (
        <section className="flex flex-col gap-2" data-testid="tn-current">
          <h2 className="text-xs font-bold tracking-[0.08em] text-gold-300">{tr('current')}</h2>
          <SummaryCard s={current} highlight />
          {current.status === 'running' && (current.tableId ?? current.me?.tableId) && current.me?.status === 'playing' && (
            <Link to={`/table/${current.tableId ?? current.me.tableId}`} className="jc-tap self-start rounded-lg bg-gold-500 px-4 py-2 text-sm font-bold text-ink-950 hover:bg-gold-400" data-testid="tn-current-table">
              {t('tn.toTable')} →
            </Link>
          )}
        </section>
      )}

      <div className="flex flex-wrap gap-2" data-testid="tn-private-actions">
        <Button size="sm" variant="outline" className="min-h-10" onClick={() => setCreating(true)} data-testid="tn-private-open">
          {tr('private.open')}
        </Button>
        <Button size="sm" variant="outline" className="min-h-10" onClick={() => setJoining(true)} data-testid="tn-join-open">
          {tr('private.join')}
        </Button>
      </div>

      <Tabs className="-mx-4 px-4" value={tab} onChange={setTab} items={(['active', 'ended'] as const).map((k) => ({ key: k, testid: `tn-tab-${k}`, label: tr(`tab.${k}` as TnKey) }))} />

      {!data && !error && (
        <div className="flex justify-center py-16 text-gold-400">
          <Spinner />
        </div>
      )}
      {!data && error && (
        <Empty>
          <span className="flex flex-col items-center gap-3" role="alert" data-testid="tn-error">
            {tr('loadFailed')}
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          </span>
        </Empty>
      )}
      {data && error && (
        <p className="rounded-lg border border-gold-500/25 bg-gold-500/10 px-3 py-2 text-sm text-gold-300" role="status" data-testid="tn-stale">
          {tr('stale')}
        </p>
      )}
      {data && list.length === 0 && (
        <div data-testid="tn-empty">
          <Empty>{tab === 'active' ? tr('none') : tr('noneEnded')}</Empty>
        </div>
      )}
      {list.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="tn-list">
          {list.map((s) => (
            <SummaryCard key={s.id} s={s} />
          ))}
        </div>
      )}
      {data?.hasMore && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" loading={loadingMore} onClick={() => void more()} data-testid="tn-more">
            {tr('more')}
          </Button>
        </div>
      )}
      <CreatePrivate open={creating} onClose={() => setCreating(false)} />
      <JoinByCode open={joining} onClose={() => setJoining(false)} />
    </div>
  );
}

interface PrivateTemplatesDto {
  templates: PrivateTemplateDto[];
  openPerHost: number;
}

/**
 * Opens a private Sit & Go from a template operators made. The server checks it all again (the template, the host's
 * other tournaments, their eligibility); the join code it answers once is handed to the tournament page in memory.
 */
function CreatePrivate({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, err } = useI18n();
  const tr = useTn();
  const nav = useNavigate();
  const [data, setData] = useState<PrivateTemplatesDto | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setData(null);
    setError(null);
    setName('');
    api<PrivateTemplatesDto>('/api/tournaments/private/templates')
      .then((r) => {
        setData(r);
        setPick(r.templates[0]?.id ?? null);
      })
      .catch((x) => setError(err(x instanceof ApiError ? x.code : null)));
  }, [open, err]);

  async function create() {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ok: true; id: string; code: string }>('/api/tournaments/private', { body: { templateId: pick, ...(name.trim() ? { name: name.trim() } : {}) } });
      onClose();
      nav(`/tournaments/${encodeURIComponent(r.id)}`, { state: { code: r.code } });
    } catch (x) {
      const e = x instanceof ApiError ? x : null;
      const det = (e?.details ?? {}) as { reason?: string; handsLeft?: number };
      setError(e?.code === 'tournament_ineligible' && det.reason ? ineligibleText(tr, t, det.reason, det.handsLeft) : err(e?.code));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr('private.createTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={busy} disabled={!pick || !data?.templates.length} onClick={() => void create()} data-testid="tn-private-create">
            {tr('private.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="tn-private-form">
        <p className="text-ink-300">{tr('private.createHint')}</p>
        {!data && !error && (
          <div className="flex justify-center py-6 text-gold-400">
            <Spinner />
          </div>
        )}
        {data && data.templates.length === 0 && <Empty>{tr('private.noTemplates')}</Empty>}
        {data && data.templates.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{tr('structure')}</legend>
            {data.templates.map((x) => (
              <label
                key={x.id}
                className={cx('jc-tap flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2', pick === x.id ? 'border-gold-500/60 bg-gold-500/10' : 'border-white/10 hover:border-gold-500/30')}
                data-testid="tn-private-template"
              >
                <input type="radio" name="tn-private-template" className="mt-1 accent-gold-500" checked={pick === x.id} onChange={() => setPick(x.id)} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-semibold text-ivory">{x.name}</span>
                  <span className="text-xs text-ink-300">
                    {tr('players', { n: x.minPlayers, cap: x.capacity })} · {tr('startStack')} {formatChips(x.startStack)} · {formatChips(x.firstLevel.sb)}/{formatChips(x.firstLevel.bb)} ·{' '}
                    {tr('minutes', { n: x.levelMinutes })}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {data && data.templates.length > 0 && (
          <Field label={tr('private.name')}>{(fid) => <Input id={fid} value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} data-testid="tn-private-name" />}</Field>
        )}
        {data && <p className="text-xs text-ink-400">{tr('private.limit', { n: data.openPerHost })} {tr('private.recordNote')}</p>}
        {error && (
          <p className="text-danger" role="alert" data-testid="tn-private-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Registers with a private tournament's join code (the server finds the tournament by the code's hash). */
function JoinByCode({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, err } = useI18n();
  const tr = useTn();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setCode('');
    setError(null);
  }, [open]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ok: true; id: string; started?: boolean; tableId?: string | null }>('/api/tournaments/join', { body: { code: code.trim() } });
      onClose();
      nav(r.started && r.tableId ? `/table/${r.tableId}` : `/tournaments/${encodeURIComponent(r.id)}`);
    } catch (x) {
      const e = x instanceof ApiError ? x : null;
      const det = (e?.details ?? {}) as { reason?: string; handsLeft?: number };
      setError(e?.code === 'tournament_ineligible' && det.reason ? ineligibleText(tr, t, det.reason, det.handsLeft) : err(e?.code));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr('private.joinTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={busy} disabled={code.trim().length < 4} onClick={() => void join()} data-testid="tn-join-submit">
            {tr('private.joinSubmit')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim().length >= 4 && !busy) void join();
        }}
      >
        <p className="text-ink-300">{tr('private.joinHint')}</p>
        <Field label={tr('private.code')}>
          {(fid) => (
            <Input id={fid} value={code} maxLength={20} autoComplete="off" autoCapitalize="characters" spellCheck={false} className="font-mono tracking-[0.12em]" onChange={(e) => setCode(e.target.value)} data-testid="tn-join-code" />
          )}
        </Field>
        {error && (
          <p className="text-danger" role="alert" data-testid="tn-join-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

const INELIGIBLE = ['suspended', 'bot', 'unverified', 'min_hands', 'active_elsewhere', 'full'] as const;

/** Why the viewer may not register, in their words (a reason this build doesn't know reads as the generic refusal). */
function ineligibleText(tr: Tn, t: ReturnType<typeof useI18n>['t'], reason: string, handsLeft?: number) {
  if (reason === 'min_hands') return tr('inel.min_hands', { n: handsLeft ?? 0 });
  if (!(INELIGIBLE as readonly string[]).includes(reason)) return t('err.tournament_ineligible');
  return tr(`inel.${reason}` as TnKey);
}

/**
 * Asks friends to register: an item in each one's notification inbox. It grants nothing; registering checks the friend
 * as anyone (and an invite to someone already in says so).
 */
function InviteFriends({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const { err } = useI18n();
  const tr = useTn();
  const [friends, setFriends] = useState<FriendDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, 'busy' | 'sent' | 'joined'>>({});
  useEffect(() => {
    if (!open) return;
    setFriends(null);
    setError(null);
    api<FriendsDto>('/api/friends')
      .then((r) => setFriends(r.friends))
      .catch((x) => setError(err(x instanceof ApiError ? x.code : null)));
  }, [open, err]);

  async function invite(f: FriendDto) {
    setDone((s) => ({ ...s, [f.id]: 'busy' }));
    setError(null);
    let to: 'sent' | 'joined' | null = 'sent';
    try {
      await api(`/api/tournaments/${encodeURIComponent(id)}/invite`, { body: { userId: f.id } });
    } catch (x) {
      const code = x instanceof ApiError ? x.code : null;
      to = code === 'tournament_invite_joined' ? 'joined' : null;
      if (!to) setError(code === 'not_friends' ? tr('invite.unavailable') : err(code));
    }
    setDone(({ [f.id]: _, ...rest }) => (to ? { ...rest, [f.id]: to } : rest));
  }

  return (
    <Modal open={open} onClose={onClose} title={tr('invite.title')}>
      <div className="flex flex-col gap-3" data-testid="tn-invite-picker">
        <p className="text-sm text-ink-300">{tr('invite.hint')}</p>
        {!friends && !error && (
          <div className="flex justify-center py-6 text-gold-400">
            <Spinner />
          </div>
        )}
        {friends && friends.length === 0 && <Empty>{tr('invite.none')}</Empty>}
        {friends && friends.length > 0 && (
          <ul className="-mx-2 flex max-h-[50dvh] flex-col overflow-y-auto">
            {friends.map((f) => {
              const state = done[f.id];
              return (
                <li key={f.id} className="flex min-h-12 items-center gap-3 px-2 py-1.5" data-testid="tn-invite-friend">
                  <Avatar user={f} />
                  <span className="flex min-w-0 flex-1">
                    <MemberName name={f.nickname} role={f.role} vip={f.vip} badge="wide" className="font-semibold text-ivory" />
                  </span>
                  {state === 'sent' || state === 'joined' ? (
                    <span className="shrink-0 text-xs text-ink-300" data-testid="tn-invite-state" data-state={state}>
                      {tr(state === 'sent' ? 'invite.sent' : 'invite.joined')}
                    </span>
                  ) : (
                    <Button size="sm" variant="outline" className="shrink-0" loading={state === 'busy'} onClick={() => void invite(f)} data-testid="tn-invite-send">
                      {tr('invite.send')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function TournamentPage() {
  const { id = '' } = useParams();
  const { t, err, locale } = useI18n();
  const tr = useTn();
  const nav = useNavigate();
  const [d, setD] = useState<TournamentDetailDto | null>(null);
  const [skew, setSkew] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [inviting, setInviting] = useState(false);
  // A private tournament's join code, answered once (when it was opened, handed over in memory, or a new one): it lives
  // in this page's state only, and the navigation state that carried it is cleared at once, so no link holds it.
  const loc = useLocation();
  const [code, setCode] = useState<string | null>(() => (loc.state as { code?: unknown } | null)?.code as string | null ?? null);
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if ((loc.state as { code?: unknown } | null)?.code) nav(loc.pathname, { replace: true, state: null });
  }, [loc.state, loc.pathname, nav]);

  const load = useCallback(
    async (quiet = false) => {
      const mine = ++seq.current;
      if (!quiet) setError(null);
      try {
        const r = await api<TournamentDetailDto>(`/api/tournaments/${encodeURIComponent(id)}`);
        if (mine !== seq.current) return;
        setD(r);
        setSkew(r.now - Date.now());
        setError(null);
      } catch (x) {
        if (mine !== seq.current) return;
        setError(x instanceof ApiError && x.code === 'tournament_not_found' ? err(x.code) : tr('loadFailed'));
      }
    },
    [id, err, t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const live = !d || ACTIVE.includes(d.status);
  const up = useTournamentEvents(() => void load(true), (changed) => changed === id);
  useVisiblePoll(() => void load(true), !up ? DETAIL_POLL_MS : d?.status === 'running' ? RUNNING_POLL_MS : LIVE_POLL_MS, live);
  useTicker(d?.status === 'running' && d.levelEndsAt !== null);

  async function register(on: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ ok: true; started?: boolean; tableId?: string | null }>(`/api/tournaments/${encodeURIComponent(id)}/${on ? 'register' : 'unregister'}`, { method: 'POST' });
      if (on && r.started && r.tableId) {
        nav(`/table/${r.tableId}`);
        return;
      }
      if (!on) setMsg({ tone: 'ok', text: tr('unregisteredDone') });
    } catch (x) {
      const e = x instanceof ApiError ? x : null;
      const det = (e?.details ?? {}) as { reason?: string; handsLeft?: number };
      setMsg({ tone: 'err', text: e?.code === 'tournament_ineligible' && det.reason ? ineligibleText(tr, t, det.reason, det.handsLeft) : err(e?.code) });
    } finally {
      setBusy(false);
      void load(true);
    }
  }

  /** The host's own actions on their private tournament; the server checks it is theirs and its state allows it. */
  async function host(action: 'start' | 'cancel' | 'code') {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ ok: true; started?: boolean; tableId?: string | null; code?: string }>(`/api/tournaments/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      if (action === 'start' && r.started && r.tableId) {
        nav(`/table/${r.tableId}`);
        return;
      }
      if (action === 'code' && r.code) {
        setCode(r.code);
        setCopied(false);
      }
      if (action === 'cancel') {
        setCancelling(false);
        setCode(null);
        setMsg({ tone: 'ok', text: tr('private.cancelled') });
      }
    } catch (x) {
      const e = x instanceof ApiError ? x : null;
      if (action === 'cancel') setCancelling(false);
      setMsg({ tone: 'err', text: err(e?.code) });
    } finally {
      setBusy(false);
      void load(true);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await api(`/api/tournaments/${encodeURIComponent(id)}/decline`, { method: 'POST' });
      nav('/tournaments', { replace: true });
    } catch (x) {
      setMsg({ tone: 'err', text: err(x instanceof ApiError ? x.code : null) });
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!d) {
    return (
      <div className="flex flex-col gap-5">
        <Link to="/tournaments" className="text-sm text-gold-300 hover:underline">
          ← {tr('back')}
        </Link>
        {error ? (
          <Empty>
            <span className="flex flex-col items-center gap-3" role="alert" data-testid="tn-error">
              {error}
              <Button size="sm" variant="outline" onClick={() => void load()}>
                {t('common.retry')}
              </Button>
            </span>
          </Empty>
        ) : (
          <div className="flex justify-center py-16 text-gold-400">
            <Spinner />
          </div>
        )}
      </div>
    );
  }

  const now = Date.now() + skew;
  const level = blindsAt(d.levels, d.level);
  const next = d.level < d.levels.length - 1 ? d.levels[d.level + 1]! : null;
  const mine = d.me?.status;
  const holding = mine === 'registered' || mine === 'playing';
  const tb = d.timeBank;
  const conds = [d.requireVerified ? tr('cond.verified') : null, d.minHands > 0 ? tr('cond.hands', { n: d.minHands }) : null].filter(Boolean).join(' · ') || tr('cond.none');
  const sec = (ms: number) => Math.round(ms / 1000);
  const hosting = !!d.private?.mine;
  const pending = d.status === 'registering' || d.status === 'closed';
  // A multi-table tournament has no one table: a player goes to theirs, a watcher picks one from the list below.
  const myTable = d.me?.tableId ?? null;
  const tableLink = d.tableId ?? (mine === 'playing' ? myTable : null);

  return (
    <div className="flex flex-col gap-5" data-testid="tn-detail" data-status={d.status}>
      <Link to="/tournaments" className="text-sm text-gold-300 hover:underline">
        ← {tr('back')}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{d.name}</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={d.status} />
          <MyBadge me={d.me} />
          <KindBadges s={d} />
          <Badge>{tr('free')}</Badge>
        </div>
        {d.private && !hosting && (
          <p className="text-sm text-ink-200" data-testid="tn-private-invited">
            {tr('private.invited', { host: d.private.host })}
          </p>
        )}
      </header>

      {error && (
        <p className="rounded-lg border border-gold-500/25 bg-gold-500/10 px-3 py-2 text-sm text-gold-300" role="status" data-testid="tn-stale">
          {tr('stale')}
        </p>
      )}

      {hosting && pending && (
        <div data-testid="tn-host">
          <Panel title={tr('private.hostPanel')} className="flex flex-col gap-3">
            <p className="text-sm text-ink-200" data-testid="tn-host-hint">{tr(d.registered < d.minPlayers ? 'private.startWait' : 'private.startHint', { n: d.registered, min: d.minPlayers })}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={busy} disabled={d.registered < d.minPlayers} onClick={() => void host('start')} data-testid="tn-host-start">
                {tr('private.start')}
              </Button>
              {d.status === 'registering' && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void host('code')} data-testid="tn-host-code">
                  {tr('private.newCode')}
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling(true)} data-testid="tn-host-cancel">
                {tr('private.cancel')}
              </Button>
            </div>
            {code && d.status === 'registering' && (
              <div className="flex flex-col gap-2 rounded-lg border border-gold-500/30 bg-gold-500/5 p-3" data-testid="tn-code-box">
                <span className="text-[11px] text-ink-400">{tr('private.code')}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="select-all break-all font-mono text-lg font-bold tracking-[0.16em] text-gold-300" data-testid="tn-code">
                    {code}
                  </code>
                  <Button size="sm" variant="outline" onClick={() => void copyCode()} data-testid="tn-code-copy">
                    {copied ? tr('private.copied') : tr('private.copy')}
                  </Button>
                </div>
                <p className="text-xs text-ink-300">{tr('private.codeOnce')}</p>
              </div>
            )}
            <p className="text-xs text-ink-400">{tr('private.recordNote')}</p>
          </Panel>
        </div>
      )}

      {/* What the viewer can do now */}
      <Panel className="flex flex-col gap-3">
        {d.status === 'registering' && !holding && (
          <>
            {d.eligibility && !d.eligibility.ok && (
              <p className="text-sm text-ink-200" data-testid="tn-ineligible" data-reason={d.eligibility.reason}>
                {ineligibleText(tr, t, d.eligibility.reason, d.eligibility.handsLeft)}
              </p>
            )}
            <Button className="self-start" loading={busy} disabled={!d.eligibility?.ok} onClick={() => void register(true)} data-testid="tn-register">
              {tr('register')}
            </Button>
          </>
        )}
        {(d.status === 'registering' || d.status === 'closed') && mine === 'registered' && (
          <>
            <p className="text-sm text-ink-100" data-testid="tn-registered">
              {d.autoStart ? tr('registeredAuto') : !d.private ? tr('registeredOp') : hosting ? tr('registeredMine') : tr('registeredHost')}
            </p>
            <Button className="self-start" variant="outline" loading={busy} onClick={() => void register(false)} data-testid="tn-unregister">
              {tr('unregister')}
            </Button>
          </>
        )}
        {d.status === 'registering' && d.registered < d.capacity && (!d.private || hosting) && (
          <Button className="self-start" size="sm" variant="outline" onClick={() => setInviting(true)} data-testid="tn-invite">
            {tr('invite.open')}
          </Button>
        )}
        {d.private && !hosting && !holding && pending && (
          <Button className="self-start" size="sm" variant="ghost" disabled={busy} onClick={() => void decline()} data-testid="tn-decline">
            {tr('private.decline')}
          </Button>
        )}
        {d.private && !hosting && <p className="text-xs text-ink-400">{tr('private.recordNote')}</p>}
        {d.status === 'closed' && <p className="text-sm text-ink-300">{tr('closedNote')}</p>}
        {(d.status === 'registering' || d.status === 'closed') && <p className="text-xs text-ink-400">{tr('leaveNote')}</p>}
        {d.status === 'running' && tableLink && (
          <Link
            to={`/table/${tableLink}`}
            className={cx(
              'jc-tap self-start rounded-lg px-4 py-2 text-sm font-bold',
              mine === 'playing' ? 'bg-gold-500 text-ink-950 hover:bg-gold-400' : 'border border-gold-500/50 text-gold-300 hover:bg-gold-500/10',
            )}
            data-testid="tn-table"
          >
            {mine === 'playing' ? t('tn.toTable') : tr('watch')} →
          </Link>
        )}
        {d.status === 'running' && (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-testid="tn-clock">
            <div className="rounded-lg bg-black/25 px-3 py-2">
              <div className="text-[11px] text-ink-400">{tr('level', { n: d.level + 1, total: d.levels.length })}</div>
              <div className="font-mono font-semibold tabular-nums">
                {formatChips(level.sb)}/{formatChips(level.bb)}
              </div>
            </div>
            <div className="rounded-lg bg-black/25 px-3 py-2">
              <div className="text-[11px] text-ink-400">{tr('clock')}</div>
              <div className="font-mono font-semibold tabular-nums" data-testid="tn-next">
                {d.paused
                  ? tr('pausedShort')
                  : !next
                    ? tr('lastLevel')
                    : d.levelEndsAt !== null
                      ? clockText(d.levelEndsAt - now)
                      : d.levelLeftMs !== null
                        ? tr('stoppedLeft', { time: clockText(d.levelLeftMs) })
                        : '—'}
              </div>
            </div>
            <div className="rounded-lg bg-black/25 px-3 py-2">
              <div className="text-[11px] text-ink-400">{tr('entries')}</div>
              <div className="font-mono font-semibold tabular-nums">{tr('left', { n: d.playersLeft ?? d.registered, total: d.registered })}</div>
            </div>
            {next && (
              <div className="rounded-lg bg-black/25 px-3 py-2">
                <div className="text-[11px] text-ink-400">{tr('levelN', { n: d.level + 2 })}</div>
                <div className="font-mono font-semibold tabular-nums">
                  {formatChips(next.sb)}/{formatChips(next.bb)}
                </div>
              </div>
            )}
          </div>
        )}
        {d.status === 'running' && d.paused && <p className="text-sm text-gold-300" data-testid="tn-paused">{t('tn.paused')}</p>}
        {d.status === 'finished' && d.winner && <WonBy tr={tr} name={d.winner} vip={d.winnerVip} className="text-base font-bold text-gold-300" />}
        {d.status === 'cancelled' && <p className="text-sm text-ink-200">{tr('cancelledNote')}</p>}
        {d.status === 'aborted' && <p className="text-sm text-ink-200" data-testid="tn-aborted">{tr('abortedNote')}</p>}
        {msg && (
          <p className={cx('text-sm', msg.tone === 'err' ? 'text-danger' : 'text-gold-300')} role={msg.tone === 'err' ? 'alert' : 'status'} data-testid="tn-msg">
            {msg.text}
          </p>
        )}
        <p className="text-[11px] text-ink-400">
          {d.endedAt ? tr('endedAt', { at: when(d.endedAt, locale) }) : d.startedAt ? tr('startedAt', { at: when(d.startedAt, locale) }) : tr('createdAt', { at: when(d.createdAt, locale) })}
        </p>
      </Panel>

      {d.tables && d.tables.length > 0 && (
        <div data-testid="tn-tables">
          <Panel title={tr('tables')}>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {d.tables.map((x) => (
                <li key={x.id}>
                  <Link
                    to={`/table/${x.id}`}
                    className={cx('jc-tap flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm', x.id === myTable ? 'border-gold-500/60 bg-gold-500/10' : 'border-white/10 hover:border-gold-500/40')}
                    data-testid="tn-table-link"
                    data-table={x.id}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 font-semibold">
                      {tr('tableN', { n: x.id.split('-').at(-1) ?? '' })}
                      {x.id === myTable && <span className="shrink-0 text-xs font-normal text-gold-300">({tr('myTable')})</span>}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-ink-300">{tr('tablePlayers', { n: x.players })} →</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-400">{tr('tablesNote')}</p>
          </Panel>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={`${tr('entries')} · ${d.status === 'running' || d.status === 'finished' || d.status === 'aborted' ? d.registered : tr('players', { n: d.registered, cap: d.capacity })}`}>
          {d.entries.length === 0 ? (
            <Empty>{tr('noEntries')}</Empty>
          ) : (
            <ol className="divide-y divide-white/5" data-testid="tn-entries">
              {d.entries.map((e, i) => (
                <li key={`${e.nickname}-${i}`} className={cx('flex items-center gap-3 py-2 text-sm', e.me && 'text-gold-300')} data-testid="tn-entry" data-status={e.status}>
                  <span className="w-10 shrink-0 font-mono text-xs tabular-nums text-ink-400">{e.place !== null ? tr('place', { n: e.place }) : ''}</span>
                  <span className="flex min-w-0 flex-1 items-center font-semibold">
                    <MemberName name={e.nickname} vip={e.vip} />
                    {e.me && <span className="ml-1 shrink-0 text-xs font-normal">({tr('you')})</span>}
                  </span>
                  {e.stack !== null && e.status === 'playing' && <span className="shrink-0 font-mono text-xs tabular-nums text-ink-200">{formatChips(e.stack)}</span>}
                  <Badge tone={ENTRY_TONE[e.status] ?? 'neutral'}>{tr(`entry.${e.status}` as TnKey)}</Badge>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title={tr('structure')}>
          <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-400">{tr('startStack')}</dt>
            <dd className="text-right font-mono tabular-nums">{formatChips(d.startStack)}</dd>
            <dt className="text-ink-400">{tr('levelLength')}</dt>
            <dd className="text-right">{tr('minutes', { n: d.levelMinutes })}</dd>
            <dt className="text-ink-400">{tr('turn')}</dt>
            <dd className="text-right">{tr('seconds', { n: d.turnSeconds })}</dd>
            <dt className="text-ink-400">{tr('timeBank')}</dt>
            <dd className="text-right text-xs">
              {tb.enabled ? tr('timeBankOn', { initial: sec(tb.initialMs), max: sec(tb.maxMs), unit: sec(tb.unitMs), hands: tb.refillHands, refill: sec(tb.refillMs) }) : tr('timeBankOff')}
            </dd>
            <dt className="text-ink-400">{tr('conditions')}</dt>
            <dd className="text-right">{conds}</dd>
            <dt className="text-ink-400">{tr('start')}</dt>
            <dd className="text-right">{d.autoStart ? tr('start.auto') : tr(d.private ? 'start.host' : 'start.operator', { n: d.minPlayers })}</dd>
          </dl>
          <ol className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-3" data-testid="tn-levels">
            {d.levels.map((l, i) => {
              const cur = d.status === 'running' && i === d.level;
              return (
                <li key={i} className={cx('flex items-center justify-between rounded-md px-2.5 py-1.5', cur ? 'bg-gold-500/15 text-gold-300' : 'bg-black/25 text-ink-200')}>
                  <span className="text-ink-400">{cur ? tr('nowLevel') : tr('levelN', { n: i + 1 })}</span>
                  <span className="font-mono tabular-nums">
                    {formatChips(l.sb)}/{formatChips(l.bb)}
                  </span>
                </li>
              );
            })}
          </ol>
        </Panel>
      </div>
      {/* Keyed by the tournament: who was invited here is not who was invited to another one opened from this page. */}
      <InviteFriends key={id} id={id} open={inviting} onClose={() => setInviting(false)} />
      <Modal
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={tr('private.cancel')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelling(false)}>
              {tr('private.keep')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void host('cancel')} data-testid="tn-host-cancel-confirm">
              {tr('private.cancel')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-200">{tr('private.cancelAsk')}</p>
      </Modal>
    </div>
  );
}
