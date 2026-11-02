// The page's realtime socket (src/lib/realtime.ts): the hub keeps no events for a socket that is not there yet, so what
// changed before an opening (after the screens' first read, or while it was down) arrives as nothing. Every opening, the
// first one too, has the screens read what they show once more.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRealtimeResync, realtimeUp, startRealtime, stopRealtime } from '../src/lib/realtime';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  sent: string[] = [];
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {}
  hello() {
    this.readyState = FakeSocket.OPEN;
    this.onmessage?.({ data: JSON.stringify({ t: 'hello', v: 1 }) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  pong() {
    this.onmessage?.({ data: '{"t":"pong"}' });
  }
}

const latest = () => FakeSocket.all[FakeSocket.all.length - 1]!;
let off: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  off();
  stopRealtime();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('realtime socket openings', () => {
  it('the first opening reads again: a change between the first read and the hello is not missed', () => {
    const read = vi.fn();
    off = onRealtimeResync(read);
    startRealtime('A', () => {});
    expect(read).not.toHaveBeenCalled();
    latest().hello();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a socket that never opened, then one that does, reads again once', () => {
    const read = vi.fn();
    off = onRealtimeResync(read);
    startRealtime('B', () => {});
    latest().drop();
    vi.advanceTimersByTime(1_000);
    latest().drop();
    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.all).toHaveLength(3);
    expect(read).not.toHaveBeenCalled();
    latest().hello();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('each opening again reads once more', () => {
    const read = vi.fn();
    off = onRealtimeResync(read);
    startRealtime('C', () => {});
    latest().hello();
    latest().drop();
    vi.advanceTimersByTime(1_000);
    latest().hello();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('a sign-in that is gone, and a socket that died while the page slept', () => {
  it('a socket refused before it opens has the account read (an expired sign-in shows only as 1006), at most once a minute', () => {
    const check = vi.fn();
    startRealtime('D', check);
    latest().drop();
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    latest().drop();
    vi.advanceTimersByTime(2_000);
    latest().drop();
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    latest().drop();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('a socket that was open and closes is not a sign-in question', () => {
    const check = vi.fn();
    startRealtime('E', check);
    latest().hello();
    latest().drop();
    expect(check).not.toHaveBeenCalled();
  });

  it('back on the page with the socket thought open: a ping at once, and without an answer a new socket within the wait', () => {
    startRealtime('F', () => {});
    latest().hello();
    const first = latest();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(first.sent).toContain('{"t":"ping"}');
    vi.advanceTimersByTime(10_000);
    expect(realtimeUp()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    // The dead one is let go: nothing it says later counts.
    first.drop();
    latest().hello();
    expect(realtimeUp()).toBe(true);
  });

  it('back on the page with a live socket: the pong keeps it', () => {
    startRealtime('G', () => {});
    latest().hello();
    window.dispatchEvent(new Event('online'));
    latest().pong();
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(realtimeUp()).toBe(true);
  });
});
