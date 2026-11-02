/**
 * /notifications: every item of the inbox, newest first, by kind (all, social, game, account, service) and unread only if
 * asked; more at the end, a page at a time. The bell in the header shows the newest; this page the rest.
 */
import { INBOX_FILTER_NAMES, type InboxFilter, type InboxItemDto } from '@jc/types';
import { Button, cx, Empty } from '@jc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InboxEntry, useInboxText, useOpenInboxItem } from '../components/Inbox';
import { LoadFailed, Loading } from '../components/Loading';
import { useAuth } from '../lib/auth';
import { fetchInbox, markInboxRead } from '../lib/inbox';
import { useMinuteNow } from '../lib/lastOnline';
import { useUnread } from '../lib/unread';

type Tab = InboxFilter | 'all';
const TABS: Tab[] = ['all', ...INBOX_FILTER_NAMES];

export function NotificationsPage() {
  const { t, tr } = useInboxText();
  const { me } = useAuth();
  const { notifications = 0 } = useUnread(me?.id ?? '');
  const [tab, setTab] = useState<Tab>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<InboxItemDto[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const now = useMinuteNow();
  const asks = useRef(0);
  const filter = tab === 'all' ? undefined : tab;

  // The first page again (a tab or the toggle changed, or the count did: an item came or was read elsewhere). An answer
  // to an earlier ask than the last changes nothing, and neither does one while a later page is being read.
  const load = useCallback(async () => {
    const ask = ++asks.current;
    try {
      const r = await fetchInbox({ filter, unread: unreadOnly });
      if (ask !== asks.current) return;
      setItems(r.items);
      setNext(r.next);
      setFailed(false);
    } catch {
      if (ask === asks.current) setFailed(true);
    }
  }, [filter, unreadOnly]);
  useEffect(() => {
    void load();
  }, [load, notifications]);

  async function loadMore() {
    if (!next) return;
    const ask = ++asks.current;
    setMore(true);
    try {
      const r = await fetchInbox({ filter, unread: unreadOnly, before: next });
      if (ask !== asks.current) return;
      setItems((l) => [...(l ?? []), ...r.items.filter((i) => !l?.some((x) => x.id === i.id))]);
      setNext(r.next);
    } catch {
      if (ask === asks.current) setFailed(true);
    } finally {
      setMore(false);
    }
  }

  async function readAll() {
    setItems((l) => l?.map((i) => (i.readAt ? i : { ...i, readAt: Date.now() })) ?? null);
    await markInboxRead(filter ? { all: true, filter } : { all: true }).catch(() => undefined);
    void load();
  }

  const open = useOpenInboxItem();
  const openItem = useCallback(
    (i: InboxItemDto) => {
      if (!i.readAt) setItems((l) => l?.map((x) => (x.id === i.id ? { ...x, readAt: Date.now() } : x)) ?? null);
      open(i);
    },
    [open],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{t('inbox.title')}</h1>
        <Button size="sm" variant="subtle" onClick={() => void readAll()} disabled={!items?.some((i) => !i.readAt)} data-testid="inbox-read-all">
          {tr('readAll')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="-mx-4 flex min-w-0 flex-1 gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="tablist" aria-label={tr('filter')}>
          {TABS.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              data-testid={`inbox-tab-${k}`}
              className={cx('shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition', tab === k ? 'border-gold-500 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-300 hover:text-ivory')}
            >
              {tr(`f.${k}`)}
            </button>
          ))}
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-ink-300">
          <input type="checkbox" className="accent-gold-500" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} data-testid="inbox-unread-only" />
          {tr('unreadOnly')}
        </label>
      </div>
      {!items ? (
        failed ? <LoadFailed onRetry={() => void load()} /> : <Loading />
      ) : items.length === 0 ? (
        <Empty>{tr(unreadOnly ? 'emptyUnread' : 'empty')}</Empty>
      ) : (
        <>
          <ul className="jc-panel divide-y divide-white/5 overflow-hidden" data-testid="inbox-list">
            {items.map((i) => (
              <li key={i.id}>
                <InboxEntry item={i} now={now} onOpen={openItem} />
              </li>
            ))}
          </ul>
          {next && (
            <div className="text-center">
              <Button size="sm" variant="ghost" onClick={() => void loadMore()} disabled={more} data-testid="inbox-more">
                {tr('more')}
              </Button>
            </div>
          )}
        </>
      )}
      <p className="text-xs text-ink-400">{tr('retention')}</p>
    </div>
  );
}
