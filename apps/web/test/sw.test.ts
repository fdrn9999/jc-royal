// The push service worker (public/sw.js), run with stand-ins for what a browser gives it: a push is shown only to the
// member signed in here, also when the account changes while the worker is still asking the site about a push; a
// tapped push opens its page without taking a window away from a game table. The page's side of a tap: push-nav.ts;
// of a read conversation: push.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeReadPushes } from '../src/lib/push';
import { followPushTaps } from '../src/lib/push-nav';

const src = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

type Shown = { title: string; tag?: string; data: { url: string; to: string }; closed: boolean };
type Answer = { status: number; body?: unknown };
type Port = { postMessage: (data: unknown) => void };

/** An open window of a browser, as the worker sees it; `answers` is what its page says when asked to go somewhere. */
interface Win {
  url: string;
  visibilityState: 'visible' | 'hidden';
  answers: 'went' | 'stays' | 'nothing';
  /** Whether the worker may take it somewhere itself (a window it controls). */
  controlled: boolean;
  focused: number;
  asked: string[];
  navigated: string[];
  /** What its page does while the window comes forward (it may move on meanwhile). */
  onFocus?: () => void;
}
const win = (url: string, o: Partial<Pick<Win, 'visibilityState' | 'answers' | 'controlled'>> = {}): Win => ({
  url: `https://jc-royal.site${url}`,
  visibilityState: 'visible',
  answers: 'went',
  controlled: true,
  focused: 0,
  asked: [],
  navigated: [],
  ...o,
});

/** MessageChannel as far as the worker uses it: what goes into port2 comes out of port1. */
class FakeChannel {
  port1: { onmessage: ((e: { data: unknown }) => void) | null; close: () => void } = { onmessage: null, close: () => undefined };
  port2: Port = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
}

/** IndexedDB as far as the worker uses it: one store; a request's result arrives a turn later, as in a browser. */
function fakeIndexedDb(kv: Map<string, unknown>) {
  const later = (f: () => void) => setTimeout(f, 0);
  let made = false;
  const db = {
    createObjectStore: () => {
      made = true;
    },
    transaction: () => {
      const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null; error: null; objectStore: () => unknown } = {
        oncomplete: null,
        onerror: null,
        error: null,
        objectStore: () => store,
      };
      let pending = 0;
      let done = false;
      const settle = () =>
        later(() => {
          if (pending || done) return;
          done = true;
          tx.oncomplete?.();
        });
      const request = (run: () => unknown) => {
        const req: { result: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = { result: undefined, onsuccess: null, onerror: null };
        pending++;
        later(() => {
          req.result = run();
          req.onsuccess?.();
          pending--;
          settle();
        });
        return req;
      };
      const store = {
        get: (k: string) => request(() => kv.get(k)),
        put: (v: unknown, k: string) => request(() => void kv.set(k, structuredClone(v))),
        delete: (k: string) => request(() => void kv.delete(k)),
      };
      settle();
      return tx;
    },
  };
  return {
    open: () => {
      const req: { result: typeof db; onupgradeneeded: (() => void) | null; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
        result: db,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      later(() => {
        if (!made) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

/**
 * The worker in a browser with the given windows (none: one tab without the site): `answer` settles the worker's
 * question to the site about the latest push.
 */
function worker(opts: { onShow?: (kv: Map<string, unknown>) => void; windows?: Win[] } = {}) {
  const kv = new Map<string, unknown>();
  const listeners = new Map<string, (e: unknown) => void>();
  const shown: Shown[] = [];
  const asked: ((a: Answer) => void)[] = [];
  const opened: string[] = [];
  const windows = opts.windows ?? [];
  const client = (w: Win) => ({
    id: String(windows.indexOf(w)),
    url: w.url,
    visibilityState: w.visibilityState,
    focus: async () => {
      w.focused++;
      w.onFocus?.();
    },
    postMessage: (m: { type: string; url: string }, ports: Port[]) => {
      w.asked.push(m.url);
      if (w.answers !== 'nothing') ports[0]!.postMessage({ ok: w.answers === 'went' });
    },
    navigate: async (url: string) => {
      if (!w.controlled) throw new TypeError('not controlled');
      w.navigated.push(url);
      return client(w);
    },
  });
  const self = {
    addEventListener: (type: string, f: (e: unknown) => void) => listeners.set(type, f),
    skipWaiting: () => undefined,
    navigator: {},
    location: { origin: 'https://jc-royal.site' },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows.map(client),
      // A window as it is now (its page may have moved on since it was listed).
      get: async (id: string) => (windows[Number(id)] ? client(windows[Number(id)]!) : undefined),
      openWindow: async (url: string) => void opened.push(url),
    },
    registration: {
      showNotification: async (title: string, o: { tag?: string; data: Shown['data'] }) => {
        shown.push({ title, tag: o.tag, data: o.data, closed: false });
        opts.onShow?.(kv);
      },
      getNotifications: async () => shown.filter((n) => !n.closed).map((n) => ({ tag: n.tag ?? '', data: n.data, close: () => void (n.closed = true) })),
    },
  };
  const fetch = vi.fn(
    () =>
      new Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>((resolve) =>
        asked.push((a) => resolve({ status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body })),
      ),
  );
  new Function('self', 'indexedDB', 'fetch', 'MessageChannel', src)(self, fakeIndexedDb(kv), fetch, FakeChannel);
  const dispatch = (type: string, e: object): Promise<unknown> => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...e, waitUntil: (p: Promise<unknown>) => void (done = p) });
    return done;
  };
  return {
    kv,
    shown,
    fetch,
    opened,
    /** Taps a notification shown about `url`: the notification, and the worker's handling of the tap. */
    tap: (url: string) => {
      const n = { data: { url, to: 'A' }, closed: false, close: () => void (n.closed = true) };
      return { n, done: dispatch('notificationclick', { notification: n }) };
    },
    tell: (uid: string | null) => dispatch('message', { data: { type: 'jc-owner', uid } }),
    push: (to: string, tag = 'dm:x') => dispatch('push', { data: { json: () => ({ to, title: 'JC ROYAL', body: 'New message', url: '/friends?dm=x', tag }) } }),
    read: (tags: unknown) => dispatch('message', { data: { type: 'jc-read', tags } }),
    /** Waits for the worker to ask the site about a push, then answers. */
    answer: async (a: Answer) => {
      await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
      asked.shift()!(a);
    },
    owner: () => {
      const v = kv.get('owner') as string | { uid?: string | null } | undefined;
      return typeof v === 'string' ? v : (v?.uid ?? null);
    },
  };
}

describe('push service worker', () => {
  it("shows a push for the member signed in here, after the site says they still are; another member's is not shown", async () => {
    const w = worker();
    await w.tell('A');
    const p = w.push('A');
    await w.answer({ status: 200, body: { id: 'A' } });
    await p;
    expect(w.shown).toMatchObject([{ title: 'JC ROYAL', data: { to: 'A', url: '/friends?dm=x' }, closed: false }]);
    await w.push('B');
    expect(w.fetch).toHaveBeenCalledTimes(1);
    expect(w.shown).toHaveLength(1);
  });

  it('signed out elsewhere: the push is not shown, and nothing of theirs shows until a page tells who is signed in', async () => {
    const w = worker();
    await w.tell('A');
    const p = w.push('A');
    await w.answer({ status: 401 });
    await p;
    expect(w.shown).toHaveLength(0);
    expect(w.owner()).toBeNull();
  });

  it("another account signing in while the worker asks about A's push: A's push is not shown to B", async () => {
    const w = worker();
    await w.tell('A');
    const p = w.push('A');
    await vi.waitFor(() => expect(w.fetch).toHaveBeenCalledTimes(1));
    await w.tell('B');
    // The site answered for A: the question went out with A's sign-in.
    await w.answer({ status: 200, body: { id: 'A' } });
    await p;
    expect(w.shown).toHaveLength(0);
    expect(w.owner()).toBe('B');
  });

  it('a late "not signed in" about the account before never signs out the one signed in now', async () => {
    const w = worker();
    await w.tell('A');
    const p = w.push('A');
    await vi.waitFor(() => expect(w.fetch).toHaveBeenCalledTimes(1));
    await w.tell(null);
    await w.tell('B');
    await w.answer({ status: 401 });
    await p;
    expect(w.owner()).toBe('B');
  });

  it("signed out, then back in as the same member while asking: the answer is about an earlier sign-in, so it is not shown", async () => {
    const w = worker();
    await w.tell('A');
    const p = w.push('A');
    await vi.waitFor(() => expect(w.fetch).toHaveBeenCalledTimes(1));
    await w.tell(null);
    await w.tell('A');
    await w.answer({ status: 200, body: { id: 'A' } });
    await p;
    expect(w.shown).toHaveLength(0);
    expect(w.owner()).toBe('A');
  });

  it("another account told while a push is being shown (another copy of the worker): what was shown for A goes", async () => {
    const w = worker({ onShow: (kv) => kv.set('owner', { uid: 'B', gen: 99 }) });
    await w.tell('A');
    const p = w.push('A');
    await w.answer({ status: 200, body: { id: 'A' } });
    await p;
    expect(w.shown).toMatchObject([{ data: { to: 'A' }, closed: true }]);
  });

  it("being told the same member again keeps what was shown for them; another account closes it", async () => {
    const w = worker();
    await w.tell('A');
    const p = w.push('A');
    await w.answer({ status: 200, body: { id: 'A' } });
    await p;
    await w.tell('A');
    expect(w.shown[0]!.closed).toBe(false);
    await w.tell('B');
    expect(w.shown[0]!.closed).toBe(true);
  });

  it("a conversation read on a page: that friend's message and invite pushes go, anyone else's stay", async () => {
    const w = worker();
    await w.tell('A');
    for (const tag of ['dm:x', 'invite:x', 'dm:y', 'fr:z']) {
      const p = w.push('A', tag);
      await w.answer({ status: 200, body: { id: 'A' } });
      await p;
    }
    await w.read(['dm:x', 'invite:x', 'fr:z', 42]);
    expect(w.shown.map((n) => [n.tag, n.closed])).toEqual([
      ['dm:x', true],
      ['invite:x', true],
      ['dm:y', false],
      // Only a friend's messages and invites close this way.
      ['fr:z', false],
    ]);
    await w.read('dm:y');
    expect(w.shown[2]!.closed).toBe(false);
  });
});

describe('a tapped push', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens its page in the site's window on screen, whose page says it went there; the push goes", async () => {
    const hidden = win('/me', { visibilityState: 'hidden' });
    const shown = win('/');
    const w = worker({ windows: [hidden, shown] });
    const { n, done } = w.tap('/friends/f1');
    await done;
    expect(shown).toMatchObject({ focused: 1, asked: ['/friends/f1'], navigated: [] });
    expect(hidden).toMatchObject({ focused: 0, asked: [] });
    expect(n.closed).toBe(true);
    expect(w.opened).toEqual([]);
  });

  it('never takes a window away from a game table: another window of the site goes there, even one off screen', async () => {
    const table = win('/table/t1');
    const other = win('/friends', { visibilityState: 'hidden' });
    const w = worker({ windows: [table, other] });
    const { n, done } = w.tap('/friends/f1');
    await done;
    expect(table).toMatchObject({ focused: 0, asked: [], navigated: [] });
    expect(other).toMatchObject({ focused: 1, asked: ['/friends/f1'] });
    expect(n.closed).toBe(true);
  });

  it('only tables open: one comes forward, nothing goes anywhere and no window opens; the push stays shown for later', async () => {
    const back = win('/table/t2', { visibilityState: 'hidden' });
    const table = win('/table/t1');
    const w = worker({ windows: [back, table] });
    const { n, done } = w.tap('/friends/f1');
    await done;
    expect(table).toMatchObject({ focused: 1, asked: [], navigated: [] });
    expect(back).toMatchObject({ focused: 0, asked: [], navigated: [] });
    expect(w.opened).toEqual([]);
    expect(n.closed).toBe(false);
  });

  it('a page that went to a table meanwhile says it stays: it is not taken anywhere, and the push stays shown', async () => {
    const page = win('/', { answers: 'stays' });
    const w = worker({ windows: [page] });
    const { n, done } = w.tap('/friends/f1');
    await done;
    expect(page).toMatchObject({ asked: ['/friends/f1'], navigated: [] });
    expect(n.closed).toBe(false);
    expect(w.opened).toEqual([]);
  });

  it('a page that does not answer (the app not started there yet, or from before this worker) is taken there by the worker', async () => {
    vi.useFakeTimers();
    const page = win('/', { answers: 'nothing' });
    const w = worker({ windows: [page] });
    const { n, done } = w.tap('/friends/f1');
    await vi.advanceTimersByTimeAsync(2_900);
    expect(page.navigated).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(page).toMatchObject({ asked: ['/friends/f1'], navigated: ['/friends/f1'] });
    expect(n.closed).toBe(true);
    expect(w.opened).toEqual([]);
  });

  it('a silent page that went to a game table while the worker waited is not taken anywhere; the push stays shown', async () => {
    vi.useFakeTimers();
    const page = win('/', { answers: 'nothing' });
    const w = worker({ windows: [page] });
    const { n, done } = w.tap('/friends/f1');
    await vi.advanceTimersByTimeAsync(1_000);
    page.url = 'https://jc-royal.site/table/t1';
    await vi.advanceTimersByTimeAsync(2_100);
    await done;
    expect(page).toMatchObject({ asked: ['/friends/f1'], navigated: [] });
    expect(n.closed).toBe(false);
    expect(w.opened).toEqual([]);
  });

  it('a window that went to a game table while it came forward is not asked to go (a page from before this worker would follow blindly)', async () => {
    const page = win('/', { answers: 'nothing' });
    page.onFocus = () => void (page.url = 'https://jc-royal.site/table/t1');
    const w = worker({ windows: [page] });
    const { n, done } = w.tap('/friends/f1');
    await done;
    expect(page).toMatchObject({ focused: 1, asked: [], navigated: [] });
    expect(n.closed).toBe(false);
    expect(w.opened).toEqual([]);
  });

  it('a silent page from before this worker that went there itself is not loaded there a second time', async () => {
    vi.useFakeTimers();
    const page = win('/', { answers: 'nothing' });
    const w = worker({ windows: [page] });
    const { n, done } = w.tap('/friends?dm=f1');
    page.url = 'https://jc-royal.site/friends?dm=f1';
    await vi.advanceTimersByTimeAsync(3_100);
    await done;
    expect(page).toMatchObject({ asked: ['/friends?dm=f1'], navigated: [] });
    expect(n.closed).toBe(true);
    expect(w.opened).toEqual([]);
  });

  it('a silent window the worker cannot take anywhere (not its own): a new window instead', async () => {
    vi.useFakeTimers();
    const page = win('/', { answers: 'nothing', controlled: false });
    const w = worker({ windows: [page] });
    const { done } = w.tap('/friends/f1');
    await vi.advanceTimersByTimeAsync(3_100);
    await done;
    expect(page.navigated).toEqual([]);
    expect(w.opened).toEqual(['/friends/f1']);
  });

  it('no window of the site: a new one, at a path of this site only', async () => {
    const w = worker({ windows: [{ ...win('/'), url: 'https://elsewhere.example/' }] });
    const { n, done } = w.tap('https://elsewhere.example/phish');
    await done;
    expect(w.opened).toEqual(['/']);
    expect(n.closed).toBe(true);
  });

  it("the page's side: goes to the push's page and says so; at a table, or for a path outside the site, stays and says so", () => {
    const sw = new EventTarget();
    const loc = { pathname: '/' };
    vi.stubGlobal('navigator', { serviceWorker: sw });
    vi.stubGlobal('location', loc);
    const went: string[] = [];
    followPushTaps((url) => went.push(url));
    const ask = (url: string) => {
      const replies: unknown[] = [];
      sw.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'jc-navigate', url }, ports: [{ postMessage: (r: unknown) => replies.push(r) }] }));
      return replies;
    };
    expect(ask('/friends/f1')).toEqual([{ ok: true }]);
    expect(ask('//elsewhere.example/x')).toEqual([{ ok: false }]);
    loc.pathname = '/table/t1';
    expect(ask('/friends/f2')).toEqual([{ ok: false }]);
    expect(went).toEqual(['/friends/f1']);
    // An older worker asks without a port: followed all the same. Other messages are not about this.
    loc.pathname = '/me';
    sw.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'jc-navigate', url: '/friends/f3' }, ports: [] }));
    sw.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'jc-owner', uid: 'A' }, ports: [] }));
    expect(went).toEqual(['/friends/f1', '/friends/f3']);
  });
});

describe("the page's side of a read conversation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the friend's pushes go only if the conversation is still read there once the worker is found", async () => {
    const posted: unknown[] = [];
    const found: ((r: unknown) => void)[] = [];
    vi.stubGlobal('window', { PushManager: {}, Notification: {} });
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: () => new Promise((r) => found.push(r)) } });
    const reg = { active: { postMessage: (m: unknown) => posted.push(m) } };
    let reading = true;
    const left = closeReadPushes('f1', () => reading);
    reading = false;
    found.shift()!(reg);
    await left;
    expect(posted).toEqual([]);
    reading = true;
    const still = closeReadPushes('f1', () => reading);
    found.shift()!(reg);
    await still;
    expect(posted).toEqual([{ type: 'jc-read', tags: ['dm:f1', 'invite:f1'] }]);
  });
});
