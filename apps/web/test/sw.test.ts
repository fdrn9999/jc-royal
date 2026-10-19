// The push service worker (public/sw.js), run with stand-ins for what a browser gives it: a push is shown only to the
// member signed in here, also when the account changes while the worker is still asking the site about a push.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

type Shown = { title: string; data: { url: string; to: string }; closed: boolean };
type Answer = { status: number; body?: unknown };

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

/** The worker in a browser with one tab: `answer` settles the worker's question to the site about the latest push. */
function worker(opts: { onShow?: (kv: Map<string, unknown>) => void } = {}) {
  const kv = new Map<string, unknown>();
  const listeners = new Map<string, (e: unknown) => void>();
  const shown: Shown[] = [];
  const asked: ((a: Answer) => void)[] = [];
  const self = {
    addEventListener: (type: string, f: (e: unknown) => void) => listeners.set(type, f),
    skipWaiting: () => undefined,
    navigator: {},
    location: { origin: 'https://jc-royal.site' },
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => null },
    registration: {
      showNotification: async (title: string, o: { data: Shown['data'] }) => {
        shown.push({ title, data: o.data, closed: false });
        opts.onShow?.(kv);
      },
      getNotifications: async () => shown.filter((n) => !n.closed).map((n) => ({ data: n.data, close: () => void (n.closed = true) })),
    },
  };
  const fetch = vi.fn(
    () =>
      new Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>((resolve) =>
        asked.push((a) => resolve({ status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body })),
      ),
  );
  new Function('self', 'indexedDB', 'fetch', src)(self, fakeIndexedDb(kv), fetch);
  const dispatch = (type: string, e: object): Promise<unknown> => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...e, waitUntil: (p: Promise<unknown>) => void (done = p) });
    return done;
  };
  return {
    kv,
    shown,
    fetch,
    tell: (uid: string | null) => dispatch('message', { data: { type: 'jc-owner', uid } }),
    push: (to: string) => dispatch('push', { data: { json: () => ({ to, title: 'JC ROYAL', body: 'New message', url: '/friends?dm=x', tag: 'dm:x' }) } }),
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
});
