import { MailIcon, MessageCircleIcon, UserPlusIcon, XIcon, type LucideIcon } from '@jc/ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useI18n, type MsgKey } from '../lib/i18n';
import { onUnreadRise, type UnreadKind } from '../lib/unread';

/** How long a notice stays while nobody points at or focuses it. */
export const ARRIVAL_MS = 6_000;

const KIND: Record<UnreadKind, { icon: LucideIcon; to: string; title: MsgKey; count: MsgKey; open: MsgKey }> = {
  unread: { icon: MailIcon, to: '/messages', title: 'arrival.message', count: 'arrival.messageCount', open: 'arrival.openMessages' },
  dmUnread: { icon: MessageCircleIcon, to: '/friends', title: 'arrival.dm', count: 'arrival.dmCount', open: 'arrival.openFriends' },
  friendRequests: { icon: UserPlusIcon, to: '/friends', title: 'arrival.request', count: 'arrival.requestCount', open: 'arrival.openFriends' },
};

/** The friend whose conversation `path` opens (`/friends/:userId`), if it opens one. */
const conversationOf = (path: string) => {
  const m = /^\/friends\/([^/]+)$/.exec(path);
  return m && m[1] !== 'settings' ? decodeURIComponent(m[1]!) : null;
};

/**
 * Whether the page open now already shows what arrived (no notice for what is on screen). For 1:1 messages, `from` is
 * whose they may be (onUnreadRise): an open conversation shows only its friend's, so a message from anyone else, or
 * one from no one known, is still news there.
 */
export function listedHere(kind: UnreadKind, path: string, from: readonly string[] = []): boolean {
  if (kind === 'unread') return path === '/messages' || path.startsWith('/messages/');
  if (kind === 'dmUnread') {
    // The friends page lists the conversations.
    if (path === '/friends') return true;
    const open = conversationOf(path);
    return open !== null && from.length > 0 && from.every((p) => p === open);
  }
  return path === '/friends';
}

interface Arrival {
  kind: UnreadKind;
  n: number;
  /** Raised by each arrival of its kind: restarts its clock. */
  seq: number;
  /** For 1:1 messages: whose they may be, over every arrival the notice told of; null once one was from no one known. */
  from: string[] | null;
}

/** Who a notice told of is from, now that it tells of one more (from `dmFrom`; none known makes it no one known). */
const fromOf = (before: Arrival | undefined, dmFrom: readonly string[]): string[] | null => {
  if (!dmFrom.length || (before && before.from === null)) return null;
  return [...new Set([...(before?.from ?? []), ...dmFrom])];
};

/**
 * Says that something new arrived (an inbox message, a 1:1 message, a friend request) when the header's counters go up,
 * with a link to where it is. One notice per kind (a newer arrival updates it); each goes after ARRIVAL_MS, and stays
 * while pointed at or focused. Nothing for what the page open shows already, and never at a table (the table pages are
 * outside the app shell this lives in). The counters are the server's (lib/unread.ts); this keeps nothing of its own.
 */
export function Arrivals() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const [list, setList] = useState<Arrival[]>([]);
  const [held, setHeld] = useState(false);
  const path = useRef(pathname);
  path.current = pathname;

  useEffect(
    () =>
      onUnreadRise((kinds, counts, dmFrom) => {
        const fresh = kinds.filter((k) => !listedHere(k, path.current, k === 'dmUnread' ? dmFrom : []));
        if (!fresh.length) return;
        setList((cur) => {
          const next = cur.filter((a) => !fresh.includes(a.kind));
          for (const k of fresh) {
            const before = cur.find((a) => a.kind === k);
            next.push({ kind: k, n: counts[k], seq: (before?.seq ?? 0) + 1, from: k === 'dmUnread' ? fromOf(before, dmFrom) : null });
          }
          return next;
        });
      }),
    [],
  );
  // Opening the page that shows it is having seen it.
  useEffect(() => {
    const seen = (a: Arrival) => listedHere(a.kind, pathname, a.from ?? []);
    setList((cur) => (cur.some(seen) ? cur.filter((a) => !seen(a)) : cur));
  }, [pathname]);
  // The last one gone under the pointer or with the focus (a removed button never blurs): the next starts its clock.
  useEffect(() => {
    if (!list.length) setHeld(false);
  }, [list.length]);

  const close = (kind: UnreadKind) => setList((cur) => cur.filter((a) => a.kind !== kind));
  // Kept on the page while empty: a screen reader reads what is added to a live region it already knew. Not a status
  // role: that is the page's own message (a page shows one of its own), and being atomic it would read every notice
  // still up each time one is added; a polite region reads the one added.
  return (
    <div
      className="fixed inset-x-4 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-80"
      aria-live="polite"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false);
      }}
      data-testid="arrivals"
    >
      {list.map((a) => (
        <Notice key={a.kind} arrival={a} held={held} onClose={() => close(a.kind)} t={t} />
      ))}
    </div>
  );
}

function Notice({ arrival, held, onClose, t }: { arrival: Arrival; held: boolean; onClose: () => void; t: ReturnType<typeof useI18n>['t'] }) {
  const { icon: Icon, to, title, count, open } = KIND[arrival.kind];
  const done = useRef(onClose);
  done.current = onClose;
  // A newer arrival of the kind, or letting go of the notices, starts its clock again.
  useEffect(() => {
    if (held) return;
    const h = setTimeout(() => done.current(), ARRIVAL_MS);
    return () => clearTimeout(h);
  }, [held, arrival.seq]);
  return (
    // Opaque, like the other panels drawn over the page: what is under it never shows through the words.
    <div className="flex items-start gap-3 rounded-xl border border-gold-500/30 bg-ink-900 p-3 shadow-panel motion-safe:animate-rise" data-testid={`arrival-${arrival.kind}`}>
      <Icon className="mt-0.5 size-5 shrink-0 text-gold-300" />
      <Link to={to} onClick={onClose} className="min-w-0 flex-1 rounded-sm" data-testid={`arrival-${arrival.kind}-open`}>
        <span className="block text-sm font-semibold text-ivory">{t(title)}</span>
        <span className="mt-0.5 block text-xs text-ink-300">
          {t(count, { n: arrival.n > 99 ? '99+' : arrival.n })} · <span className="text-gold-300 underline-offset-2 hover:underline">{t(open)}</span>
        </span>
      </Link>
      <button type="button" onClick={onClose} className="-m-1 shrink-0 rounded-full p-1 text-ink-300 hover:text-ivory" aria-label={t('common.close')} data-testid={`arrival-${arrival.kind}-close`}>
        <XIcon className="size-4" />
      </button>
    </div>
  );
}
