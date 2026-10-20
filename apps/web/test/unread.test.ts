// The header's unread counters (src/lib/unread.ts): another account's are never shown, a late answer about the account
// before is dropped, and a sign-in that is gone shows none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshUnread, unreadOf, watchUnread } from '../src/lib/unread';

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
