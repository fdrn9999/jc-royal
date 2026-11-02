/**
 * The notification inbox on screen: an item's line (InboxEntry), and what the header's bell opens: a panel (not a
 * dialog) of the newest items (BellPanel; the bell itself is components/NotificationBell.tsx). The full list is
 * /notifications (pages/Notifications.tsx). What each kind is, and what an item can show (an answered request, an
 * invite gone stale), is in packages/types/src/inbox.ts. Loaded on demand (the bell opened, or the page), so its text
 * lives here rather than in the entry chunk.
 */
import type { InboxItemDto } from '@jc/types';
import {
  CircleAlertIcon,
  createTranslator,
  CrownIcon,
  cx,
  DicesIcon,
  InfoIcon,
  LockIcon,
  MailIcon,
  MessageCircleIcon,
  TriangleAlertIcon,
  TrophyIcon,
  UserPlusIcon,
  UsersIcon,
  type LucideIcon,
} from '@jc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useI18n, type MsgKey } from '../lib/i18n';
import { fetchInbox, markInboxRead } from '../lib/inbox';
import { lastOnlineAgo, useMinuteNow } from '../lib/lastOnline';

const ko = {
  readAll: '모두 읽음',
  seeAll: '알림 전체 보기',
  loadFailed: '알림을 불러오지 못했습니다.',
  empty: '알림이 없습니다.',
  emptyUnread: '읽지 않은 알림이 없습니다.',
  unread: '읽지 않음',
  unreadOnly: '읽지 않은 알림만',
  filter: '알림 종류',
  more: '더 보기',
  retention: '알림은 30일 동안 보관되며, 로그인·비밀번호 같은 계정 보안 알림은 90일 동안 보관됩니다.',
  urgent: '[긴급]',
  'f.all': '전체',
  'f.social': '친구·대화',
  'f.game': '토너먼트',
  'f.account': '계정·쪽지',
  'f.service': '공지·점검',
  'ago.now': '방금',
  'ago.min': '{n}분 전',
  'ago.hour': '{n}시간 전',
  'ago.yesterday': '어제',
  'ago.days': '{n}일 전',
  'ago.long': '한 달 이상 전',
  'k.tournament': '토너먼트',
  'k.friend_request': '{name}님이 친구 요청을 보냈습니다',
  'k.friend_accepted': '{name}님이 친구 요청을 수락했습니다',
  'k.dm': '{name}님이 메시지를 보냈습니다',
  'k.dmN': '{name}님이 메시지 {n}개를 보냈습니다',
  'k.invite': '{name}님이 {table} 테이블로 초대했습니다',
  'k.friend_table': '{name}님이 {table} 테이블에 앉았습니다',
  'k.message': '새 쪽지 {n}통이 도착했습니다',
  'k.messageRead': '쪽지함의 쪽지를 모두 확인했습니다',
  'k.tournament_start': '{name} 토너먼트가 시작되었습니다',
  'k.tournament_cancel': '{name} 토너먼트가 취소되었습니다',
  'k.tournament_abort': '{name} 토너먼트가 중단되었습니다',
  'k.tournament_result': '{name} 토너먼트가 끝났습니다 · 최종 {place}위',
  'k.tournament_ended': '{name} 토너먼트가 끝났습니다',
  'k.vip': 'VIP 등급이 {color}(으)로 변경되었습니다',
  'k.vipOff': 'VIP 등급이 해제되었습니다',
  'k.sign_in': '새 기기에서 로그인했습니다 ({device})',
  'k.password_change': '비밀번호가 변경되었습니다',
  'k.password_reset': '비밀번호가 재설정되었습니다',
  'k.security': '계정 보안 알림',
  'k.maintenance': '서버 점검 {from} ~ {to}',
  's.pending': '대기 중',
  's.accepted': '수락됨',
  's.closed': '종료됨',
  's.joinable': '참여 가능',
  's.expired': '만료됨',
  's.running': '진행 중',
  's.ended': '종료',
  's.cancelled': '취소됨',
  's.scheduled': '예정',
  's.underway': '점검 중',
} as const;

const en: Record<keyof typeof ko, string> = {
  readAll: 'Mark all read',
  seeAll: 'See all notifications',
  loadFailed: 'Notifications could not be loaded.',
  empty: 'No notifications.',
  emptyUnread: 'No unread notifications.',
  unread: 'Unread',
  unreadOnly: 'Unread only',
  filter: 'Notification type',
  more: 'Show more',
  retention: 'Notifications are kept for 30 days; account security ones (sign-ins, passwords) for 90 days.',
  urgent: '[Urgent]',
  'f.all': 'All',
  'f.social': 'Friends & chat',
  'f.game': 'Tournaments',
  'f.account': 'Account & inbox',
  'f.service': 'Notices',
  'ago.now': 'just now',
  'ago.min': '{n} min ago',
  'ago.hour': '{n} h ago',
  'ago.yesterday': 'yesterday',
  'ago.days': '{n} days ago',
  'ago.long': 'over a month ago',
  'k.tournament': 'Tournament',
  'k.friend_request': '{name} sent you a friend request',
  'k.friend_accepted': '{name} accepted your friend request',
  'k.dm': '{name} sent you a message',
  'k.dmN': '{name} sent you {n} messages',
  'k.invite': '{name} invited you to table {table}',
  'k.friend_table': '{name} sat down at table {table}',
  'k.message': '{n} new inbox messages',
  'k.messageRead': 'All inbox messages read',
  'k.tournament_start': '{name} has started',
  'k.tournament_cancel': '{name} was cancelled',
  'k.tournament_abort': '{name} was stopped',
  'k.tournament_result': '{name} has ended · you placed #{place}',
  'k.tournament_ended': '{name} has ended',
  'k.vip': 'Your VIP tier is now {color}',
  'k.vipOff': 'Your VIP tier was removed',
  'k.sign_in': 'New sign-in from {device}',
  'k.password_change': 'Your password was changed',
  'k.password_reset': 'Your password was reset',
  'k.security': 'Account security notice',
  'k.maintenance': 'Maintenance {from} – {to}',
  's.pending': 'Pending',
  's.accepted': 'Accepted',
  's.closed': 'Closed',
  's.joinable': 'Open',
  's.expired': 'Expired',
  's.running': 'Running',
  's.ended': 'Ended',
  's.cancelled': 'Cancelled',
  's.scheduled': 'Scheduled',
  's.underway': 'Underway',
};

const translate = createTranslator({ ko, en });

/** The inbox's own text (`tr`), and the app's (`t`) for what it shares with other screens (a title, VIP colours). */
export function useInboxText() {
  const { t, locale } = useI18n();
  return { t, tr: translate(locale), locale };
}
type Texts = ReturnType<typeof useInboxText>;

const ICON: Record<InboxItemDto['kind'], LucideIcon> = {
  friend_request: UserPlusIcon,
  friend_accepted: UserPlusIcon,
  friend_table: UsersIcon,
  dm: MessageCircleIcon,
  invite: DicesIcon,
  message: MailIcon,
  tournament_start: TrophyIcon,
  tournament_cancel: TrophyIcon,
  tournament_result: TrophyIcon,
  vip: CrownIcon,
  security: LockIcon,
  notice: InfoIcon,
  maintenance: TriangleAlertIcon,
};

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);

/** How long ago, short ("5분 전"). */
export function agoText({ tr }: Texts, at: number, now: number) {
  const a = lastOnlineAgo(at, now);
  return 'n' in a ? tr(`ago.${a.key}`, { n: a.n }) : tr(`ago.${a.key}`);
}

/** What an item says, and what became of it (where it can be answered or end): never more than the server sent. */
export function inboxText({ t, tr, locale }: Texts, i: InboxItemDto, now: number): { text: string; state?: string; done?: boolean; urgent?: boolean } {
  const p = i.params;
  const name = i.actor?.nickname ?? '';
  const tname = str(p.name) ?? tr('k.tournament');
  const time = (ms: number | null) => (ms == null ? '' : new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms));
  switch (i.kind) {
    case 'friend_request':
      return {
        text: tr('k.friend_request', { name }),
        state: tr(i.state === 'open' ? 's.pending' : i.state === 'done' ? 's.accepted' : 's.closed'),
        done: i.state !== 'open',
      };
    case 'friend_accepted':
      return { text: tr('k.friend_accepted', { name }) };
    case 'dm':
      return { text: i.count > 1 && !i.readAt ? tr('k.dmN', { name, n: i.count }) : tr('k.dm', { name }) };
    case 'invite':
      return {
        text: tr('k.invite', { name, table: str(p.table) ?? '' }),
        state: tr(i.state === 'open' ? 's.joinable' : 's.expired'),
        done: i.state !== 'open',
      };
    case 'friend_table':
      return {
        text: tr('k.friend_table', { name, table: str(p.name) ?? '' }),
        state: tr(i.state === 'open' ? 's.joinable' : 's.closed'),
        done: i.state !== 'open',
      };
    case 'message':
      return { text: i.readAt ? tr('k.messageRead') : tr('k.message', { n: i.count }) };
    case 'tournament_start':
      return { text: tr('k.tournament_start', { name: tname }), state: tr(i.state === 'open' ? 's.running' : 's.ended'), done: i.state !== 'open' };
    case 'tournament_cancel':
      return { text: tr(p.aborted === true ? 'k.tournament_abort' : 'k.tournament_cancel', { name: tname }) };
    case 'tournament_result': {
      const place = num(p.place);
      return { text: place ? tr('k.tournament_result', { name: tname, place }) : tr('k.tournament_ended', { name: tname }) };
    }
    case 'vip': {
      const color = str(p.color);
      return { text: color ? tr('k.vip', { color: t(`vip.color.${color}` as MsgKey) }) : tr('k.vipOff') };
    }
    case 'security': {
      const ev = str(p.event);
      if (ev === 'sign_in') return { text: tr('k.sign_in', { device: str(p.device) ?? '' }) };
      if (ev === 'password_change') return { text: tr('k.password_change') };
      if (ev === 'password_reset') return { text: tr('k.password_reset') };
      return { text: tr('k.security') };
    }
    case 'notice':
      return { text: str(locale === 'en' ? p.titleEn : p.titleKo) ?? str(p.titleKo) ?? '', urgent: p.urgent === true };
    case 'maintenance': {
      const starts = num(p.startsAt);
      return {
        text: tr('k.maintenance', { from: time(starts), to: time(num(p.endsAt)) }),
        state: tr(i.state === 'expired' ? 's.cancelled' : i.state === 'done' ? 's.ended' : starts != null && starts > now ? 's.scheduled' : 's.underway'),
        done: i.state !== 'open',
        urgent: !!p.blockLogin && i.state === 'open',
      };
    }
  }
}

/** One item: its mark, its line, when, and its state; unread ones stand out (a dot, bold). Opening it reads it. */
export function InboxEntry({ item, now, onOpen, compact }: { item: InboxItemDto; now: number; onOpen: (i: InboxItemDto) => void; compact?: boolean }) {
  const texts = useInboxText();
  const { tr } = texts;
  const Icon = ICON[item.kind] ?? CircleAlertIcon;
  const { text, state, done, urgent } = inboxText(texts, item, now);
  const unread = !item.readAt;
  return (
    <button
      type="button"
      className={cx('flex w-full items-start gap-3 text-left hover:bg-white/[0.04]', compact ? 'px-3 py-2.5' : 'px-4 py-3')}
      onClick={() => onOpen(item)}
      data-testid="inbox-item"
      data-kind={item.kind}
      data-unread={unread || undefined}
    >
      <span className={cx('mt-0.5 grid size-8 shrink-0 place-items-center rounded-full', urgent ? 'bg-danger-strong/20 text-danger' : 'bg-white/5 text-gold-300')}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx('block break-words text-sm leading-snug', unread ? 'font-semibold text-ivory' : 'text-ink-200')}>
          {urgent && item.kind === 'notice' && <span className="mr-1 font-bold text-danger">{tr('urgent')}</span>}
          {text}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-400">
          <span>{agoText(texts, item.at, now)}</span>
          {state && <span className={cx('rounded-full border px-1.5 leading-4', done ? 'border-white/10 text-ink-400' : 'border-gold-500/40 text-gold-300')}>{state}</span>}
        </span>
      </span>
      {unread && <span className="mt-2 size-2 shrink-0 rounded-full bg-gold-400" role="img" aria-label={tr('unread')} />}
    </button>
  );
}

/** Opening an item: it is read (if it was not), then its page, where it has one. */
export function useOpenInboxItem(after?: () => void) {
  const nav = useNavigate();
  return useCallback(
    (i: InboxItemDto) => {
      if (!i.readAt) void markInboxRead({ ids: [i.id] }).catch(() => undefined);
      after?.();
      if (i.href) nav(i.href);
    },
    [nav, after],
  );
}

/** How many of the newest items the bell's panel shows. */
const RECENT = 8;

/**
 * Inside the bell's panel: the newest items, read again whenever the count changes while it is open (an item came or
 * was read elsewhere), with "all read" and the way to all of them.
 */
export function BellPanel({ count: notifications, close }: { count: number; close: () => void }) {
  const { t, tr } = useInboxText();
  const [items, setItems] = useState<InboxItemDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const now = useMinuteNow();
  const asks = useRef(0);
  const load = useCallback(async () => {
    const ask = ++asks.current;
    try {
      const r = await fetchInbox({ limit: RECENT });
      // An answer to an older read than the last one asked changes nothing.
      if (ask !== asks.current) return;
      setItems(r.items);
      setFailed(false);
    } catch {
      if (ask === asks.current) setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [notifications, load]);
  const openItem = useOpenInboxItem(close);
  async function readAll() {
    setItems((l) => l?.map((i) => (i.readAt ? i : { ...i, readAt: Date.now() })) ?? null);
    await markInboxRead({ all: true }).catch(() => undefined);
    void load();
  }
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
        <h2 className="text-sm font-bold text-ivory">{t('inbox.title')}</h2>
        <button type="button" className="rounded px-2 py-1 text-xs font-semibold text-gold-300 hover:text-gold-200 disabled:text-ink-500" onClick={() => void readAll()} disabled={!notifications} data-testid="bell-read-all">
          {tr('readAll')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!items ? (
          <p className="px-3 py-6 text-center text-sm text-ink-400">{failed ? tr('loadFailed') : t('common.loading')}</p>
        ) : items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-ink-400">{tr('empty')}</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {items.map((i) => (
              <li key={i.id}>
                <InboxEntry item={i} now={now} onOpen={openItem} compact />
              </li>
            ))}
          </ul>
        )}
      </div>
      <Link to="/notifications" className="block border-t border-white/5 px-3 py-2.5 text-center text-sm font-semibold text-gold-300 hover:bg-white/[0.04]" onClick={close} data-testid="bell-see-all">
        {tr('seeAll')}
      </Link>
    </>
  );
}
