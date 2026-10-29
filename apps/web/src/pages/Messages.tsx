import type { MessageDto } from '@jc/types';
import { Badge, Button, Empty, formatDate } from '@jc/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoadFailed, Loading } from '../components/Loading';
import { api } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';
import { coalesced, onRealtimeResync, useRealtime } from '../lib/realtime';
import { refreshUnread } from '../lib/unread';

const tone = { system: 'neutral', event: 'green', sanction: 'red', notice: 'gold', admin: 'blue' } as const;

export function MessagesPage() {
  const { t, locale } = useI18n();
  const [list, setList] = useState<MessageDto[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const fetchList = useCallback(async () => {
    setFailed(false);
    try {
      setList(await api<MessageDto[]>('/api/messages'));
      return true;
    } catch {
      // A list already shown stays; with none, the page says it could not load.
      setFailed(true);
      return false;
    }
  }, []);
  const load = useCallback(async () => {
    if (await fetchList()) void refreshUnread();
  }, [fetchList]);
  useEffect(() => { void load(); }, [load]);
  // A message that arrived, or one read or deleted on another device: the list again, once for a burst (the header's
  // count follows the same events by itself). An announcement to many waits a random while first, as the count does.
  const reload = useMemo(() => coalesced(fetchList), [fetchList]);
  const later = useRef(new Set<ReturnType<typeof setTimeout>>());
  const spread = useCallback(
    (ms: number) => {
      if (!ms) return void reload();
      const h = setTimeout(() => {
        later.current.delete(h);
        void reload();
      }, Math.random() * ms);
      later.current.add(h);
    },
    [reload],
  );
  useEffect(() => () => later.current.forEach(clearTimeout), []);
  useRealtime('message.changed', (e) => spread(e.payload?.spreadMs ?? 0));
  useRealtime('inbox.broadcast', (e) => spread(e.payload.spreadMs));
  useEffect(() => onRealtimeResync(() => void reload()), [reload]);

  async function expand(m: MessageDto) {
    setOpen((o) => (o === m.id ? null : m.id));
    if (!m.readAt) {
      await api(`/api/messages/${m.id}/read`, { body: {} });
      setList((l) => l?.map((x) => (x.id === m.id ? { ...x, readAt: Date.now() } : x)) ?? null);
      void refreshUnread();
    }
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{t('msg.title')}</h1>
        <Button size="sm" variant="subtle" onClick={async () => { await api('/api/messages/read-all', { body: {} }); await load(); }}>{t('msg.readAll')}</Button>
      </div>
      <p className="text-xs text-ink-400">{t('msg.oneWay')}</p>
      {!list ? failed ? <LoadFailed onRetry={() => void load()} /> : <Loading /> : list.length === 0 ? <Empty>{t('msg.empty')}</Empty> : (
        <ul className="jc-panel divide-y divide-white/5 overflow-hidden">
          {list.map((m) => (
            <li key={m.id} data-testid="message">
              <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03]" onClick={() => expand(m)} aria-expanded={open === m.id}>
                {!m.readAt && <span className="size-2 shrink-0 rounded-full bg-gold-400" role="img" aria-label={t('msg.unread')} />}
                <Badge tone={tone[m.category]}>{t(`msg.cat.${m.category}` as MsgKey)}</Badge>
                <span className={`min-w-0 flex-1 truncate ${m.readAt ? 'text-ink-200' : 'font-bold text-ivory'}`}>{m.title}</span>
                <span className="shrink-0 text-xs text-ink-400">{formatDate(m.createdAt, locale)}</span>
              </button>
              {open === m.id && (
                <div className="border-t border-white/5 bg-black/20 px-4 py-3">
                  <div className="mb-2 text-xs text-ink-400">{t('msg.from')}: {m.fromAdmin ?? t('msg.system')}</div>
                  <p className="whitespace-pre-wrap break-words text-sm text-ink-100">{m.body}</p>
                  <div className="mt-3 text-right">
                    <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/messages/${m.id}`, { method: 'DELETE' }); await load(); }}>{t('msg.delete')}</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
