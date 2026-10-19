// This page's side of friends' status (src/lib/presence.ts): when it beats, what it sends, what it never sends. The
// server's side is apps/game-worker/src/presence.test.ts and tests/integration/presence.test.ts.
import { PRESENCE_ACTIVITY_BEAT_MS, PRESENCE_AWAY_MS, PRESENCE_HEARTBEAT_MS, PRESENCE_IDLE_STOP_MS } from '@jc/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPresenceView, sortFriends, startPresence } from '../src/lib/presence';

interface Call {
  url: string;
  body: Record<string, unknown> | null;
  keepalive: boolean;
}

let calls: Call[];
let answer: () => Response;
let win: EventTarget;
let doc: EventTarget & { visibilityState: string };
let stop: (() => void) | null = null;

const beats = () => calls.filter((c) => c.url === '/api/me/presence/heartbeat');
const fire = (target: EventTarget, type: string, extra: Record<string, unknown> = {}) => target.dispatchEvent(Object.assign(new Event(type), extra));

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 19, 3) });
  calls = [];
  answer = () => new Response(JSON.stringify({ mode: 'auto', state: 'online' }), { status: 200 });
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null, keepalive: !!init.keepalive });
    return answer();
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('presence beats', () => {
  it('beats at once, then every PRESENCE_HEARTBEAT_MS, with how long the member has been idle', async () => {
    stop = startPresence('u1');
    await vi.advanceTimersByTimeAsync(0);
    expect(beats()).toHaveLength(1);
    const first = beats()[0]!.body!;
    expect(first).toMatchObject({ idleMs: 0, visible: true });
    expect(String(first.conn)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 3);
    expect(beats()).toHaveLength(4);
    // The same device id all along; the idle time grows while nothing happens.
    expect(new Set(beats().map((b) => b.body!.conn)).size).toBe(1);
    expect(beats()[3]!.body!.idleMs).toBe(PRESENCE_HEARTBEAT_MS * 3);
  });

  it('activity sends nothing by itself: a thousand pointer moves are not one request more', async () => {
    stop = startPresence('u1');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 1_000; i++) {
      fire(win, i % 2 ? 'pointermove' : 'keydown');
      await vi.advanceTimersByTimeAsync(20);
    }
    // 20 seconds of constant activity: still only the regular beat (none due yet).
    expect(beats()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS - 20_000);
    expect(beats()).toHaveLength(2);
    expect(beats()[1]!.body!.idleMs).toBeLessThan(PRESENCE_HEARTBEAT_MS);
  });

  it('back after five quiet minutes: a beat soon, not waiting for the regular one', async () => {
    stop = startPresence('u1');
    await vi.advanceTimersByTimeAsync(PRESENCE_AWAY_MS + 5_000);
    const before = beats().length;
    fire(win, 'pointerdown');
    await vi.advanceTimersByTimeAsync(PRESENCE_ACTIVITY_BEAT_MS);
    expect(beats().length).toBe(before + 1);
    expect(beats().at(-1)!.body!.idleMs).toBeLessThan(PRESENCE_ACTIVITY_BEAT_MS + 1);
  });

  it('stops beating after PRESENCE_IDLE_STOP_MS without activity, and starts again on the next', async () => {
    stop = startPresence('u1');
    await vi.advanceTimersByTimeAsync(PRESENCE_IDLE_STOP_MS + PRESENCE_HEARTBEAT_MS);
    const n = beats().length;
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 10);
    expect(beats()).toHaveLength(n);
    fire(win, 'keydown');
    await vi.advanceTimersByTimeAsync(PRESENCE_ACTIVITY_BEAT_MS);
    expect(beats()).toHaveLength(n + 1);
    expect(beats().at(-1)!.body!.idleMs).toBeLessThan(PRESENCE_ACTIVITY_BEAT_MS + 1);
  });

  it('the page closing says so at once, with keepalive, for this device only', async () => {
    stop = startPresence('u1');
    await vi.advanceTimersByTimeAsync(0);
    fire(win, 'pagehide', { persisted: false });
    const leave = calls.find((c) => c.url === '/api/me/presence/leave');
    expect(leave).toMatchObject({ keepalive: true, body: { conn: beats()[0]!.body!.conn } });
    expect(Object.keys(leave!.body!)).toEqual(['conn']);
  });

  it('too many: waits a minute; another failure backs off; stopping sends nothing more', async () => {
    answer = () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'x' } }), { status: 429 });
    stop = startPresence('u1');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(beats()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(beats()).toHaveLength(2);
    answer = () => new Response(JSON.stringify({ error: { code: 'presence_unavailable', message: 'x' } }), { status: 503 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beats()).toHaveLength(3);
    // Third failure in a row: twice and then four times the interval.
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 4 - 1);
    expect(beats()).toHaveLength(3);
    stop();
    stop = null;
    const n = calls.length;
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 20);
    fire(win, 'pagehide', { persisted: false });
    expect(calls).toHaveLength(n);
  });

  it('a conversation on screen goes with the next beat (soon), and is gone once it closes', async () => {
    stop = startPresence('u1');
    await vi.advanceTimersByTimeAsync(5_000);
    const clear = setPresenceView('dm:friend-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(beats().at(-1)!.body!.view).toBe('dm:friend-1');
    clear();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(beats().at(-1)!.body).not.toHaveProperty('view');
  });

  it('a hidden page beats as hidden; another account starts from a new device', async () => {
    stop = startPresence('u1');
    await vi.advanceTimersByTimeAsync(5_000);
    doc.visibilityState = 'hidden';
    fire(doc, 'visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(beats().at(-1)!.body!.visible).toBe(false);
    const conn = beats()[0]!.body!.conn;
    stop();
    stop = startPresence('u2');
    await vi.advanceTimersByTimeAsync(0);
    expect(beats().at(-1)!.body!.conn).not.toBe(conn);
  });
});

describe('sortFriends', () => {
  const list = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  it('online, then away, then offline, each in the order given (the latest conversation first)', () => {
    const seen = { a: 'offline', b: 'away', c: 'online', d: 'away', e: 'online' } as const;
    expect(sortFriends(list, seen).map((f) => f.id)).toEqual(['c', 'e', 'b', 'd', 'a']);
  });
  it('unknown status counts as offline; no status at all keeps the order', () => {
    expect(sortFriends(list, { e: 'online' }).map((f) => f.id)).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(sortFriends(list, null)).toBe(list);
  });
});
