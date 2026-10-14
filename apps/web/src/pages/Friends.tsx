import type { ConversationDto, DirectMessageDto, FriendRequestDto, FriendRequestResultDto, FriendsDto } from '@jc/types';
import { Button, cx, Empty, Input, Panel, Spinner } from '@jc/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Avatar } from '../components/Social';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
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

/** Runs `fn` now, every `ms` while the tab is visible, and again when it becomes visible. */
function useVisiblePoll(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') ref.current();
    };
    const h = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', tick);
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

export function FriendsPage() {
  const { t, err, locale } = useI18n();
  const [data, setData] = useState<FriendsDto | null>(null);
  const [nick, setNick] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
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
      <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{t('friends.title')}</h1>
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
                  <li key={f.id}>
                    <Link to={`/friends/${f.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-white/[0.03]" data-testid="friend-row">
                      <Avatar user={f} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ivory">{f.nickname}</span>
                        <span className={cx('block truncate text-xs', f.unread ? 'font-semibold text-ink-100' : 'text-ink-400')}>
                          {f.lastMessage ? `${f.lastMessage.fromMe ? `${t('friends.me')}: ` : ''}${f.lastMessage.body}` : t('friends.noMessages')}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {f.lastMessage && <span className="text-[11px] text-ink-400">{shortTime(f.lastMessage.at, locale)}</span>}
                        {f.unread > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-bold leading-5 text-white" data-testid="friend-unread">{f.unread > 99 ? '99+' : f.unread}</span>}
                      </span>
                    </Link>
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
    </div>
  );
}

const dayKey = (ms: number) => new Date(ms).toDateString();

/** A 1:1 conversation. New messages arrive by polling while the tab is visible. */
export function ConversationPage() {
  const { userId = '' } = useParams();
  const { t, err, locale } = useI18n();
  const nav = useNavigate();
  const [conv, setConv] = useState<Omit<ConversationDto, 'messages'> | null>(null);
  const [msgs, setMsgs] = useState<DirectMessageDto[]>([]);
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // How the list should scroll after the next render: to the bottom, or keep the view while older messages load.
  const scroll = useRef<{ kind: 'bottom' } | { kind: 'keep'; height: number } | null>(null);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  // Newest message time the server has returned here. Polls continue from it rather than from a message sent
  // locally, so one the other player sent just before mine is not skipped.
  const synced = useRef(0);
  const sync = (list: DirectMessageDto[]) => {
    for (const m of list) synced.current = Math.max(synced.current, m.at);
  };

  const markRead = useCallback(async () => {
    await api(`/api/dm/${userId}/read`, { body: {} }).catch(() => {});
    void refreshUnread();
  }, [userId]);

  /** Adds or replaces messages by id, keeping them oldest first (by time, then id, as the server pages them). */
  const merge = useCallback((incoming: DirectMessageDto[]) => {
    if (!incoming.length) return;
    setMsgs((cur) => {
      const map = new Map(cur.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, m);
      return [...map.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    });
  }, []);

  useEffect(() => {
    let live = true;
    setConv(null);
    setMsgs([]);
    setMissing(false);
    synced.current = 0;
    void api<ConversationDto>(`/api/dm/${userId}`)
      .then(({ messages, ...rest }) => {
        if (!live) return;
        setConv(rest);
        scroll.current = { kind: 'bottom' };
        sync(messages);
        setMsgs(messages);
        if (messages.some((m) => !m.fromMe && !m.readAt)) void markRead();
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [userId, markRead]);

  const poll = useCallback(async () => {
    const cur = msgsRef.current;
    // Re-fetch from my newest message while it is unread, so its read receipt updates.
    const mine = cur.filter((m) => m.fromMe).at(-1);
    const since = Math.min(synced.current, mine && !mine.readAt ? mine.at : Infinity);
    try {
      const r = await api<ConversationDto>(`/api/dm/${userId}${since ? `?after=${since}` : ''}`);
      sync(r.messages);
      const el = box.current;
      const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      const fresh = r.messages.filter((m) => !cur.some((x) => x.id === m.id));
      if (fresh.length && nearBottom) scroll.current = { kind: 'bottom' };
      merge(r.messages);
      setConv((c) => (c ? { ...c, isFriend: r.isFriend } : c));
      if (fresh.some((m) => !m.fromMe)) void markRead();
    } catch {
      /* offline: try again on the next tick */
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
    const r = await api<ConversationDto>(`/api/dm/${userId}?before=${first.at}&beforeId=${first.id}`);
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
      </header>

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
                  <p className={cx('whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm', m.fromMe ? 'rounded-br-sm bg-gold-500/90 text-ink-950' : 'rounded-bl-sm bg-ink-700 text-ink-100')}>{m.body}</p>
                  <span className="flex shrink-0 flex-col pb-0.5 text-[10px] leading-tight text-ink-400">
                    {m === lastMine && m.readAt && <span className="text-gold-300" data-testid="dm-read">{t('dm.read')}</span>}
                    {timeFmt.format(m.at)}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {conv.isFriend ? (
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
    </div>
  );
}
