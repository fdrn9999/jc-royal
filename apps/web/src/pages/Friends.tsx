import {
  INVITE_FRESH_MS,
  type BlockedUserDto,
  type ConversationDto,
  type DirectMessageDto,
  type FriendDto,
  type FriendRequestDto,
  type FriendRequestResultDto,
  type FriendsDto,
  type LobbyTableDto,
  type SocialSettingsDto,
} from '@jc/types';
import { Button, cx, Empty, formatChips, Input, Modal, Panel, Spinner } from '@jc/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { JoinCodeModal } from '../components/JoinCode';
import { Avatar, BlockConfirm, ReportModal, type ReportSubject } from '../components/Social';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { blockUser, loadBlocks, unblockUser } from '../lib/safety';
import { refreshUnread } from '../lib/unread';

const POLL_MS = 4_000;

/** Today → time; otherwise the date. */
function shortTime(ms: number, locale: string) {
  const loc = locale === 'ko' ? 'ko-KR' : 'en-US';
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? new Intl.DateTimeFormat(loc, { timeStyle: 'short' }).format(d)
    : new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric' }).format(d);
}

/**
 * Runs `fn` every `ms` while the tab is visible, and at once when it becomes visible again or the connection comes
 * back. A hidden tab does not poll.
 */
function useVisiblePoll(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') ref.current();
    };
    const h = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('online', tick);
    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('online', tick);
    };
  }, [ms]);
}

function RequestRow({ r, children }: { r: FriendRequestDto; children: React.ReactNode }) {
  const { locale } = useI18n();
  return (
    <li className="flex items-center gap-3 py-2.5" data-testid="friend-request">
      <Avatar user={r} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-ivory">{r.nickname}</span>
        <span className="text-xs text-ink-400">{shortTime(r.at, locale)}</span>
      </span>
      <span className="flex shrink-0 gap-1.5">{children}</span>
    </li>
  );
}

/** Picks an open table and sends the friend an invite to it. */
function InvitePicker({ friend, onClose, onSent }: { friend: FriendDto | null; onClose: () => void; onSent: (table: LobbyTableDto) => void }) {
  const { t, err } = useI18n();
  const [tables, setTables] = useState<LobbyTableDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!friend) return;
    setTables(null);
    setError(null);
    api<LobbyTableDto[]>('/api/tables')
      .then((rows) => setTables(rows.filter((tb) => tb.status === 'open' && !tb.entryBlocked)))
      .catch((x) => setError(err(x instanceof ApiError ? x.code : null)));
  }, [friend, err]);

  async function pick(tb: LobbyTableDto) {
    if (!friend || busy) return;
    setBusy(tb.id);
    setError(null);
    try {
      await api(`/api/friends/${friend.id}/invite`, { body: { tableId: tb.id } });
      onSent(tb);
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={!!friend} onClose={onClose} title={t('invite.pickTitle', { name: friend?.nickname ?? '' })}>
      <div className="flex flex-col gap-3" data-testid="invite-picker">
        <p className="text-sm text-ink-300">{t('invite.pickHint')}</p>
        {!tables && !error && <div className="flex justify-center py-6 text-gold-400"><Spinner /></div>}
        {tables && tables.length === 0 && <Empty>{t('invite.noTables')}</Empty>}
        {tables && tables.length > 0 && (
          <ul className="-mx-2 flex max-h-[50dvh] flex-col overflow-y-auto">
            {tables.map((tb) => {
              const full = tb.seated >= tb.maxSeats;
              return (
                <li key={tb.id}>
                  <button
                    type="button"
                    disabled={full || !!busy}
                    onClick={() => void pick(tb)}
                    className="jc-tap flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="invite-table"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-ivory">{tb.name}</span>
                      <span className="block truncate text-xs text-ink-400">
                        {t('lobby.blinds')} {formatChips(tb.smallBlind)}/{formatChips(tb.bigBlind)}
                        {tb.host && ` · ${t('room.hostedBy', { name: tb.host.nickname })}`}
                        {tb.isPrivate && ` · 🔒 ${t('invite.private')}`}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-sm tabular-nums text-gold-300">
                      {busy === tb.id ? <Spinner /> : full ? <span className="font-sans text-xs text-ink-400">{t('lobby.full')}</span> : `${tb.seated}/${tb.maxSeats}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function FriendsPage() {
  const { t, err, locale } = useI18n();
  const [data, setData] = useState<FriendsDto | null>(null);
  const [nick, setNick] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState<FriendDto | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<FriendsDto>('/api/friends'));
    } catch {
      /* offline: keep the last list */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useVisiblePoll(() => void load(), 15_000);

  async function act(fn: () => Promise<unknown>) {
    setNote(null);
    try {
      await fn();
    } catch (x) {
      setNote({ ok: false, text: err(x instanceof ApiError ? x.code : null) });
    }
    await load();
    void refreshUnread();
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    const nickname = nick.trim();
    if (!nickname) return;
    setBusy(true);
    await act(async () => {
      const r = await api<FriendRequestResultDto>('/api/friends/requests', { body: { nickname } });
      setNick('');
      setNote({ ok: true, text: t(r.status === 'accepted' ? 'friends.nowFriends' : 'friends.sent', { name: r.user.nickname }) });
    });
    setBusy(false);
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{t('friends.title')}</h1>
        <Link to="/friends/settings" className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-semibold text-gold-300 hover:bg-white/5" data-testid="friends-settings">
          {t('friends.settings')}
        </Link>
      </div>
      <form className="flex flex-col gap-2" onSubmit={add}>
        <div className="flex gap-2">
          <Input value={nick} maxLength={32} onChange={(e) => setNick(e.target.value)} placeholder={t('friends.addPlaceholder')} aria-label={t('friends.add')} data-testid="friend-nickname" />
          <Button type="submit" disabled={!nick.trim()} loading={busy} data-testid="friend-add">{t('friends.send')}</Button>
        </div>
        {note && <p className={cx('text-sm', note.ok ? 'text-gold-300' : 'text-danger')} role={note.ok ? 'status' : 'alert'}>{note.text}</p>}
      </form>

      {!data ? (
        <div className="flex justify-center py-12 text-gold-400"><Spinner /></div>
      ) : (
        <>
          {data.incoming.length > 0 && (
            <Panel title={`${t('friends.incoming')} ${data.incoming.length}`}>
              <ul className="divide-y divide-white/5" data-testid="incoming-requests">
                {data.incoming.map((r) => (
                  <RequestRow key={r.id} r={r}>
                    <Button size="sm" onClick={() => act(() => api(`/api/friends/${r.id}/accept`, { body: {} }))} data-testid="friend-accept">{t('friends.accept')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => act(() => api(`/api/friends/${r.id}`, { method: 'DELETE' }))}>{t('friends.decline')}</Button>
                  </RequestRow>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title={t('friends.list', { n: data.friends.length })}>
            {data.friends.length === 0 ? (
              <Empty>{t('friends.empty')}</Empty>
            ) : (
              <ul className="-mx-2 divide-y divide-white/5" data-testid="friend-list">
                {data.friends.map((f) => (
                  <li key={f.id} className="flex items-center gap-1" data-testid="friend-item">
                    <Link to={`/friends/${f.id}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-white/[0.03]" data-testid="friend-row">
                      <Avatar user={f} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ivory">{f.nickname}</span>
                        <span className={cx('block truncate text-xs', f.unread ? 'font-semibold text-ink-100' : 'text-ink-400')}>
                          {f.lastMessage
                            ? `${f.lastMessage.fromMe ? `${t('friends.me')}: ` : ''}${f.lastMessage.kind === 'invite' ? t('invite.preview', { name: f.lastMessage.body }) : f.lastMessage.body}`
                            : t('friends.noMessages')}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {f.lastMessage && <span className="text-[11px] text-ink-400">{shortTime(f.lastMessage.at, locale)}</span>}
                        {f.unread > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-bold leading-5 text-white" data-testid="friend-unread">{f.unread > 99 ? '99+' : f.unread}</span>}
                      </span>
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0 whitespace-nowrap px-2.5 text-gold-300"
                      onClick={() => setInviting(f)}
                      aria-label={t('invite.playWith', { name: f.nickname })}
                      data-testid="friend-invite"
                    >
                      {t('invite.play')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {data.outgoing.length > 0 && (
            <Panel title={`${t('friends.outgoing')} ${data.outgoing.length}`}>
              <ul className="divide-y divide-white/5" data-testid="outgoing-requests">
                {data.outgoing.map((r) => (
                  <RequestRow key={r.id} r={r}>
                    <Button size="sm" variant="ghost" onClick={() => act(() => api(`/api/friends/${r.id}`, { method: 'DELETE' }))}>{t('friends.cancel')}</Button>
                  </RequestRow>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
      <InvitePicker
        friend={inviting}
        onClose={() => setInviting(null)}
        onSent={(tb) => {
          setNote({ ok: true, text: `${t('invite.sentNote', { name: inviting?.nickname ?? '', table: tb.name })}${tb.isPrivate ? ` ${t('invite.private')}` : ''}` });
          setInviting(null);
          void load();
        }}
      />
    </div>
  );
}

function SettingToggle({ label, hint, checked, onChange, testId }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start justify-between gap-4 py-2">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ivory">{label}</span>
        <span className="mt-0.5 block text-xs text-ink-400">{hint}</span>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 size-5 shrink-0 accent-[var(--color-gold-500)]" data-testid={testId} />
    </label>
  );
}

/** Who can reach me, header alerts for 1:1 messages, and the players I blocked. */
export function FriendSettingsPage() {
  const { t, err, locale } = useI18n();
  const { me } = useAuth();
  const [settings, setSettings] = useState<SocialSettingsDto | null>(null);
  const [blocks, setBlocks] = useState<BlockedUserDto[] | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!me) return;
    void api<SocialSettingsDto>('/api/friends/settings').then(setSettings, () => setNote({ ok: false, text: t('common.error') }));
    void loadBlocks(me.id).then(setBlocks, () => setBlocks([]));
  }, [me, t]);

  async function save(patch: Partial<SocialSettingsDto>) {
    setNote(null);
    try {
      setSettings(await api<SocialSettingsDto>('/api/friends/settings', { method: 'PATCH', body: patch }));
      setNote({ ok: true, text: t('social.saved') });
      void refreshUnread();
    } catch (x) {
      setNote({ ok: false, text: err(x instanceof ApiError ? x.code : null) });
    }
  }
  async function unblock(u: BlockedUserDto) {
    setNote(null);
    try {
      await unblockUser(u.id);
      setBlocks((b) => b?.filter((x) => x.id !== u.id) ?? null);
      setNote({ ok: true, text: t('block.undone', { name: u.nickname }) });
    } catch (x) {
      setNote({ ok: false, text: err(x instanceof ApiError ? x.code : null) });
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex items-center gap-2">
        <Link to="/friends" className="grid size-10 place-items-center rounded-full text-gold-300 hover:bg-white/5" aria-label={t('friends.title')}>←</Link>
        <h1 className="text-xl font-extrabold tracking-[0.04em] jc-gold-text">{t('social.settingsTitle')}</h1>
      </header>
      {note && <p className={cx('text-sm', note.ok ? 'text-gold-300' : 'text-danger')} role={note.ok ? 'status' : 'alert'}>{note.text}</p>}
      <Panel title={t('social.receive')}>
        {!settings ? (
          <div className="flex justify-center py-6 text-gold-400"><Spinner /></div>
        ) : (
          <div className="divide-y divide-white/5">
            <SettingToggle
              label={t('social.friendRequests')}
              hint={t('social.friendRequestsHint')}
              checked={settings.friendRequests === 'everyone'}
              onChange={(v) => void save({ friendRequests: v ? 'everyone' : 'nobody' })}
              testId="settings-friend-requests"
            />
            <SettingToggle
              label={t('social.dmNotifications')}
              hint={t('social.dmNotificationsHint')}
              checked={settings.dmNotifications}
              onChange={(v) => void save({ dmNotifications: v })}
              testId="settings-dm-notifications"
            />
          </div>
        )}
      </Panel>
      <Panel title={t('social.blocked', { n: blocks?.length ?? 0 })}>
        {!blocks ? (
          <div className="flex justify-center py-6 text-gold-400"><Spinner /></div>
        ) : blocks.length === 0 ? (
          <Empty>{t('social.blockedEmpty')}</Empty>
        ) : (
          <ul className="divide-y divide-white/5" data-testid="blocked-list">
            {blocks.map((u) => (
              <li key={u.id} className="flex items-center gap-3 py-2.5" data-testid="blocked-row">
                <Avatar user={u} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-ivory">{u.nickname}</span>
                  <span className="text-xs text-ink-400">{shortTime(u.at, locale)}</span>
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  <Link to={`/friends/${u.id}`} className="inline-flex h-9 items-center rounded-lg px-3 text-xs font-semibold text-ink-200 hover:bg-white/5">{t('social.viewConversation')}</Link>
                  <Button size="sm" variant="outline" onClick={() => void unblock(u)} data-testid="blocked-unblock">{t('block.unblock')}</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-ink-400">{t('social.blockedHint')}</p>
        <p className="mt-1 text-xs text-ink-400">{t('social.muteHint')}</p>
      </Panel>
    </div>
  );
}

const dayKey = (ms: number) => new Date(ms).toDateString();

/** A 1:1 conversation. New messages arrive by polling while the tab is visible. */
/**
 * An invite to a table. Joining checks the table first so a closed or full table says so here; the table itself
 * still checks seats and the join code.
 */
function InviteCard({ m }: { m: DirectMessageDto }) {
  const { t, err } = useI18n();
  const nav = useNavigate();
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'checking' } | { kind: 'closed' } | { kind: 'full'; spectate: boolean } | { kind: 'error'; text: string }>({ kind: 'idle' });
  const [codeFor, setCodeFor] = useState<LobbyTableDto | null>(null);
  const expired = Date.now() - m.at > INVITE_FRESH_MS;

  async function join() {
    if (!m.tableId) return;
    setState({ kind: 'checking' });
    let tb: LobbyTableDto;
    try {
      tb = await api<LobbyTableDto>(`/api/tables/${m.tableId}`);
    } catch (x) {
      if (x instanceof ApiError && x.status === 404) setState({ kind: 'closed' });
      else setState({ kind: 'error', text: err(x instanceof ApiError ? x.code : null) });
      return;
    }
    if (tb.status !== 'open' || tb.entryBlocked) return setState({ kind: 'closed' });
    if (tb.seated >= tb.maxSeats) return setState({ kind: 'full', spectate: tb.allowSpectators });
    setState({ kind: 'idle' });
    if (tb.isPrivate) setCodeFor(tb);
    else nav(`/table/${tb.id}?sit=1`);
  }

  return (
    <div className={cx('w-64 max-w-full rounded-2xl border px-3 py-2.5 text-sm', m.fromMe ? 'rounded-br-sm border-gold-500/50 bg-gold-500/10' : 'rounded-bl-sm border-gold-500/30 bg-ink-700')} data-testid="dm-invite">
      <p className="text-[11px] font-semibold tracking-wider text-gold-300">♠ {t('invite.title')}</p>
      <p className="mt-0.5 break-words font-bold text-ivory">{m.body}</p>
      {m.fromMe ? (
        <p className="mt-1 text-xs text-ink-400">{t('invite.sent')}</p>
      ) : expired ? (
        <p className="mt-1 text-xs text-ink-400" data-testid="dm-invite-expired">{t('invite.expired')}</p>
      ) : (
        <Button size="sm" className="mt-2 w-full" loading={state.kind === 'checking'} onClick={() => void join()} data-testid="dm-invite-join">
          {t('invite.join')}
        </Button>
      )}
      {(state.kind === 'closed' || state.kind === 'full' || state.kind === 'error') && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#f0a0a2]" role="status" data-testid="dm-invite-status">
          <span>{state.kind === 'closed' ? t('invite.closed') : state.kind === 'full' ? t('invite.full') : state.text}</span>
          {state.kind === 'full' && state.spectate && (
            <Button size="sm" variant="outline" onClick={() => nav(`/table/${m.tableId}`)} data-testid="dm-invite-spectate">
              {t('invite.spectate')}
            </Button>
          )}
        </div>
      )}
      <JoinCodeModal table={codeFor} onClose={() => setCodeFor(null)} />
    </div>
  );
}

export function ConversationPage() {
  const { userId = '' } = useParams();
  const { t, err, locale } = useI18n();
  const nav = useNavigate();
  const [conv, setConv] = useState<Omit<ConversationDto, 'messages' | 'peerRead'> | null>(null);
  const [msgs, setMsgs] = useState<DirectMessageDto[]>([]);
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  // A message from them that was tapped, to report it.
  const [selected, setSelected] = useState<string | null>(null);
  const [reporting, setReporting] = useState<ReportSubject | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // How the list should scroll after the next render: to the bottom, or keep the view while older messages load.
  const scroll = useRef<{ kind: 'bottom' } | { kind: 'keep'; height: number } | null>(null);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  // Highest seq the server has returned here. Polls continue from it rather than from a message sent locally, so one
  // the other player saved just before mine is not skipped.
  const synced = useRef(0);
  const sync = (list: DirectMessageDto[]) => {
    for (const m of list) synced.current = Math.max(synced.current, m.seq);
  };
  // The conversation on screen: a request still running for one left behind must not touch it.
  const current = useRef(userId);
  current.current = userId;
  const polling = useRef(false);

  /** Marks their messages read up to the newest one shown, so one that lands meanwhile stays unread. */
  const markRead = useCallback(
    async (upToSeq: number) => {
      await api(`/api/dm/${userId}/read`, { body: { upToSeq } }).catch(() => {});
      void refreshUnread();
    },
    [userId],
  );

  /** Adds or replaces messages by id in seq order, and applies how far the other player has read mine. */
  const merge = useCallback((incoming: DirectMessageDto[], read?: ConversationDto['peerRead']) => {
    const nowRead = (m: DirectMessageDto) => !!read && m.fromMe && !m.readAt && m.seq <= read.seq;
    setMsgs((cur) => {
      if (!incoming.length && !cur.some(nowRead)) return cur;
      const map = new Map(cur.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, m);
      return [...map.values()].map((m) => (nowRead(m) ? { ...m, readAt: read!.at } : m)).sort((a, b) => a.seq - b.seq);
    });
  }, []);

  useEffect(() => {
    let live = true;
    setConv(null);
    setMsgs([]);
    setMissing(false);
    synced.current = 0;
    void api<ConversationDto>(`/api/dm/${userId}`)
      .then(({ messages, peerRead: _, ...rest }) => {
        if (!live) return;
        setConv(rest);
        scroll.current = { kind: 'bottom' };
        sync(messages);
        setMsgs(messages);
        if (messages.some((m) => !m.fromMe && !m.readAt)) void markRead(synced.current);
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [userId, markRead]);

  const poll = useCallback(async () => {
    // One at a time: a slow request is not stacked under the next tick.
    if (polling.current) return;
    polling.current = true;
    const id = userId;
    const cur = msgsRef.current;
    try {
      // A burst, or a while offline, can leave more than a page: keep going from the last one received.
      const got: DirectMessageDto[] = [];
      let r: ConversationDto;
      let pages = 0;
      do {
        r = await api<ConversationDto>(`/api/dm/${id}?afterSeq=${synced.current}`);
        if (current.current !== id) return;
        sync(r.messages);
        got.push(...r.messages);
      } while (r.hasMore && ++pages < 10);
      const el = box.current;
      const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      const fresh = got.filter((m) => !cur.some((x) => x.id === m.id));
      if (fresh.length && nearBottom) scroll.current = { kind: 'bottom' };
      merge(got, r.peerRead);
      setConv((c) => (c ? { ...c, isFriend: r.isFriend, blocked: r.blocked } : c));
      if (fresh.some((m) => !m.fromMe && !m.readAt)) void markRead(synced.current);
    } catch {
      /* offline: the next tick, or the connection coming back, continues from the same seq */
    } finally {
      polling.current = false;
    }
  }, [userId, merge, markRead]);
  useVisiblePoll(() => {
    if (conv) void poll();
  }, POLL_MS);

  useLayoutEffect(() => {
    const el = box.current;
    const s = scroll.current;
    if (!el || !s) return;
    el.scrollTop = s.kind === 'bottom' ? el.scrollHeight : el.scrollHeight - s.height;
    scroll.current = null;
  }, [msgs]);

  async function older() {
    const first = msgs[0];
    if (!first) return;
    const r = await api<ConversationDto>(`/api/dm/${userId}?beforeSeq=${first.seq}`);
    scroll.current = { kind: 'keep', height: (box.current?.scrollHeight ?? 0) - (box.current?.scrollTop ?? 0) };
    merge(r.messages);
    setConv((c) => (c ? { ...c, hasMore: r.hasMore } : c));
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    setError(null);
    try {
      const m = await api<DirectMessageDto>(`/api/dm/${userId}`, { body: { text: v } });
      setText('');
      scroll.current = { kind: 'bottom' };
      merge([m]);
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
      if (x instanceof ApiError && x.code === 'not_friends') setConv((c) => (c ? { ...c, isFriend: false } : c));
    } finally {
      setSending(false);
    }
  }

  async function unfriend() {
    if (!conv || !confirm(t('friends.removeConfirm', { name: conv.user.nickname }))) return;
    await api(`/api/friends/${userId}`, { method: 'DELETE' }).catch(() => {});
    nav('/friends');
  }

  async function setBlocked(on: boolean) {
    if (!conv) return;
    setBlockBusy(true);
    setError(null);
    try {
      if (on) await blockUser(userId);
      else await unblockUser(userId);
      // A block ends the friendship; unblocking does not bring it back.
      setConv((c) => (c ? { ...c, blocked: on, isFriend: false } : c));
      setConfirmBlock(false);
      void refreshUnread();
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBlockBusy(false);
    }
  }

  if (missing) return <Empty>{t('notFound')}</Empty>;
  if (!conv) return <div className="flex justify-center py-12 text-gold-400"><Spinner /></div>;
  const lastMine = msgs.filter((m) => m.fromMe).at(-1);
  const timeFmt = new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { timeStyle: 'short' });
  const dateFmt = new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'medium' });
  return (
    <div className="mx-auto flex h-[calc(100dvh-11.5rem)] min-h-[22rem] w-full max-w-3xl flex-col gap-3 sm:h-[calc(100dvh-8rem)]">
      <header className="flex shrink-0 items-center gap-3">
        <Link to="/friends" className="grid size-10 place-items-center rounded-full text-gold-300 hover:bg-white/5" aria-label={t('friends.title')}>←</Link>
        <Avatar user={conv.user} />
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-ivory" data-testid="dm-title">{conv.user.nickname}</h1>
        {conv.isFriend && (
          <Button size="sm" variant="ghost" className="text-ink-300" onClick={unfriend} data-testid="unfriend">{t('friends.remove')}</Button>
        )}
        {!conv.blocked && (
          <Button size="sm" variant="ghost" className="text-[#f0a0a2]" onClick={() => setConfirmBlock((v) => !v)} aria-expanded={confirmBlock} data-testid="dm-block">{t('block.action')}</Button>
        )}
      </header>
      {confirmBlock && <BlockConfirm name={conv.user.nickname} busy={blockBusy} onConfirm={() => void setBlocked(true)} onCancel={() => setConfirmBlock(false)} />}
      {msgs.some((m) => !m.fromMe) && <p className="-mt-1 shrink-0 text-[11px] text-ink-400">{t('dm.reportTip')}</p>}

      <div ref={box} className="jc-panel min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4" data-testid="dm-messages">
        {conv.hasMore && (
          <div className="mb-3 text-center">
            <Button size="sm" variant="subtle" onClick={older}>{t('dm.older')}</Button>
          </div>
        )}
        {msgs.length === 0 && <p className="py-10 text-center text-sm text-ink-400">{t('dm.empty')}</p>}
        <ol className="flex flex-col gap-1.5">
          {msgs.map((m, i) => {
            const newDay = i === 0 || dayKey(msgs[i - 1]!.at) !== dayKey(m.at);
            return (
              <li key={m.id} className="flex flex-col">
                {newDay && <div className="my-2 self-center rounded-full bg-white/5 px-3 py-0.5 text-[11px] text-ink-400">{dateFmt.format(m.at)}</div>}
                <div className={cx('flex max-w-[85%] items-end gap-1.5 sm:max-w-[70%]', m.fromMe ? 'flex-row-reverse self-end' : 'self-start')} data-testid={m.fromMe ? 'dm-mine' : 'dm-theirs'}>
                  {m.kind === 'invite' ? (
                    <InviteCard m={m} />
                  ) : m.fromMe ? (
                    <p className="whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-gold-500/90 px-3 py-2 text-sm text-ink-950">{m.body}</p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setSelected((s) => (s === m.id ? null : m.id))}
                      aria-pressed={selected === m.id}
                      className={cx('whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-ink-700 px-3 py-2 text-left text-sm text-ink-100', selected === m.id && 'ring-2 ring-danger/60')}
                    >
                      {m.body}
                    </button>
                  )}
                  <span className="flex shrink-0 flex-col pb-0.5 text-[10px] leading-tight text-ink-400">
                    {m === lastMine && m.readAt && <span className="text-gold-300" data-testid="dm-read">{t('dm.read')}</span>}
                    {timeFmt.format(m.at)}
                  </span>
                  {selected === m.id && (
                    <button
                      type="button"
                      className="jc-tap shrink-0 self-center rounded-full border border-danger/50 px-3 py-1.5 text-xs font-semibold text-[#f0a0a2] hover:bg-danger/10"
                      onClick={() => setReporting({ type: 'dm', id: m.id, label: m.body.length > 120 ? `${m.body.slice(0, 120)}…` : m.body })}
                      data-testid="dm-report"
                    >
                      {t('report.action')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {conv.blocked ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-ink-100" data-testid="dm-blocked">
          <span className="min-w-0 flex-1">{t('block.banner')}</span>
          <Button size="sm" variant="outline" loading={blockBusy} onClick={() => void setBlocked(false)} data-testid="dm-unblock">{t('block.unblock')}</Button>
        </div>
      ) : conv.isFriend ? (
        <form className="flex shrink-0 flex-col gap-1" onSubmit={send}>
          <div className="flex gap-2">
            <Input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder={t('dm.placeholder')} aria-label={t('dm.placeholder')} className="text-base sm:text-sm" data-testid="dm-input" />
            <Button type="submit" disabled={!text.trim()} loading={sending} data-testid="dm-send">{t('dm.send')}</Button>
          </div>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        </form>
      ) : (
        <p className="shrink-0 rounded-lg border border-white/5 bg-black/20 px-3 py-2.5 text-sm text-ink-300" data-testid="dm-not-friends">{t('dm.notFriends')}</p>
      )}
      {(conv.blocked || !conv.isFriend) && error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <ReportModal
        subject={reporting}
        onClose={() => {
          setReporting(null);
          setSelected(null);
        }}
      />
    </div>
  );
}
