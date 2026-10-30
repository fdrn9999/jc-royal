// The header's unread counters (src/lib/unread.ts): another account's are never shown, a late answer about the account
// before is dropped, and a sign-in that is gone shows none. And the arrival notice (src/components/Arrivals.tsx): only a
// counter going up after the first read is news, and nothing is said about what the page open shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listedHere } from '../src/components/Arrivals';
import { heardDm, onUnreadRise, refreshUnread, risen, unreadOf, watchUnread, type UnreadKind } from '../src/lib/unread';

const NONE = { unread: 0, dmUnread: 0, friendRequests: 0 };
let pending: ((r: Response | Error) => void)[];
let stop: (() => void) | null = null;

const counts = (unread: number, dmUnread = 0, friendRequests = 0) => new Response(JSON.stringify({ unread, dmUnread, friendRequests }), { status: 200 });
/** Answers the oldest request still waiting. */
async function answer(r: Response | Error) {
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
  pending.shift()!(r);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  pending = [];
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('fetch', () => new Promise<Response>((resolve, reject) => pending.push((r) => (r instanceof Error ? reject(r) : resolve(r)))));
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
});

describe('unread counters', () => {
  it("another account signing in sees none of the one before's, and a late answer about the one before is dropped", async () => {
    stop = watchUnread('A', 30_000);
    await answer(counts(2, 1));
    expect(unreadOf('A')).toEqual({ unread: 2, dmUnread: 1, friendRequests: 0 });
    // Not B's, even before B's watch starts.
    expect(unreadOf('B')).toEqual(NONE);
    void refreshUnread();
    stop();
    stop = watchUnread('B', 30_000);
    expect(unreadOf('B')).toEqual(NONE);
    // The question asked with A's sign-in comes back after B's started: dropped.
    await answer(counts(9, 9, 9));
    expect(unreadOf('B')).toEqual(NONE);
    await answer(counts(1));
    expect(unreadOf('B')).toEqual({ unread: 1, dmUnread: 0, friendRequests: 0 });
    expect(unreadOf('A')).toEqual(NONE);
  });

  it('offline keeps what was shown; a sign-in that is gone (401) shows none', async () => {
    stop = watchUnread('C', 30_000);
    await answer(counts(3, 2, 1));
    void refreshUnread();
    await answer(new TypeError('offline'));
    expect(unreadOf('C')).toEqual({ unread: 3, dmUnread: 2, friendRequests: 1 });
    void refreshUnread();
    await answer(new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'x' } }), { status: 401 }));
    expect(unreadOf('C')).toEqual(NONE);
  });
});

describe('arrivals', () => {
  const unauthorized = () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'x' } }), { status: 401 });

  it('names the counters that went up, not the ones that went down or stayed', () => {
    expect(risen({ unread: 1, dmUnread: 2, friendRequests: 0 }, { unread: 2, dmUnread: 1, friendRequests: 0 })).toEqual(['unread']);
    expect(risen(NONE, { unread: 0, dmUnread: 3, friendRequests: 1 })).toEqual(['dmUnread', 'friendRequests']);
    expect(risen({ unread: 4, dmUnread: 0, friendRequests: 0 }, { unread: 4, dmUnread: 0, friendRequests: 0 })).toEqual([]);
  });

  it('the first read of an account, and the first after its sign-in was gone, is where the counters start: never news', async () => {
    const heard: [UnreadKind[], number][] = [];
    const off = onUnreadRise((kinds, c) => heard.push([kinds, c.unread]));
    try {
      stop = watchUnread('D', 30_000);
      // Unread waiting from before: not something that just arrived.
      await answer(counts(5, 1, 1));
      expect(heard).toEqual([]);
      void refreshUnread();
      await answer(counts(6, 1, 1));
      expect(heard).toEqual([[['unread'], 6]]);
      // Read elsewhere, then the same again: nothing new.
      void refreshUnread();
      await answer(counts(2, 0, 1));
      void refreshUnread();
      await answer(counts(2, 0, 1));
      expect(heard).toHaveLength(1);
      void refreshUnread();
      await answer(counts(2, 1, 2));
      expect(heard.at(-1)).toEqual([['dmUnread', 'friendRequests'], 2]);
      // Offline in between changes nothing.
      void refreshUnread();
      await answer(new TypeError('offline'));
      void refreshUnread();
      await answer(counts(3, 1, 2));
      expect(heard.at(-1)).toEqual([['unread'], 3]);

      // Signed out, and in again: what waits then is where it starts again.
      void refreshUnread();
      await answer(unauthorized());
      void refreshUnread();
      await answer(counts(9, 9, 9));
      expect(heard).toHaveLength(3);

      // Another account: its first read is where it starts too, and a late answer about the one before is not news.
      void refreshUnread();
      stop();
      stop = watchUnread('E', 30_000);
      await answer(counts(20));
      await answer(counts(1));
      expect(heard).toHaveLength(3);
      expect(unreadOf('E').unread).toBe(1);
    } finally {
      off();
    }
  });

  it('a rise of 1:1 messages names whose the socket told of, until a read begun after it ends; a poll alone names no one', async () => {
    const from: (readonly string[])[] = [];
    const off = onUnreadRise((kinds, _c, dmFrom) => {
      if (kinds.includes('dmUnread')) from.push(dmFrom);
    });
    try {
      stop = watchUnread('F', 30_000);
      await answer(counts(0, 0));
      heardDm('u1');
      void refreshUnread();
      await answer(counts(0, 1));
      expect(from).toEqual([['u1']]);
      // That read held it: the next rise is not put on u1.
      void refreshUnread();
      await answer(counts(0, 2));
      expect(from.at(-1)).toEqual([]);
      // Told of while a read was out, which may not hold it: the read after names it too.
      void refreshUnread();
      heardDm('u2');
      await answer(counts(0, 2));
      void refreshUnread();
      await answer(counts(0, 3));
      expect(from.at(-1)).toEqual(['u2']);
      // Another account hears nothing the one before was told of.
      heardDm('u3');
      stop();
      stop = watchUnread('G', 30_000);
      await answer(counts(0, 1));
      void refreshUnread();
      await answer(counts(0, 2));
      expect(from.at(-1)).toEqual([]);
    } finally {
      off();
    }
  });

  it('says nothing about what the page open shows already', () => {
    expect(listedHere('unread', '/messages')).toBe(true);
    expect(listedHere('unread', '/friends')).toBe(false);
    expect(listedHere('unread', '/')).toBe(false);
    expect(listedHere('dmUnread', '/friends')).toBe(true);
    expect(listedHere('dmUnread', '/friends', ['u2'])).toBe(true);
    // An open conversation shows its friend's messages only: anyone else's, or no one known's, is news there.
    expect(listedHere('dmUnread', '/friends/u9', ['u9'])).toBe(true);
    expect(listedHere('dmUnread', '/friends/u9', ['u2'])).toBe(false);
    expect(listedHere('dmUnread', '/friends/u9', ['u9', 'u2'])).toBe(false);
    expect(listedHere('dmUnread', '/friends/u9')).toBe(false);
    expect(listedHere('dmUnread', '/friends/settings', ['settings'])).toBe(false);
    expect(listedHere('dmUnread', '/messages')).toBe(false);
    expect(listedHere('friendRequests', '/friends')).toBe(true);
    expect(listedHere('friendRequests', '/friends/u9')).toBe(false);
    expect(listedHere('friendRequests', '/')).toBe(false);
  });
});
