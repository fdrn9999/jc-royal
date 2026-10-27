import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ me: null }) }));

/**
 * The server's clock as the turn clocks and notices count it (serverNow), against a device 30 s behind: measured from
 * /api/service/status at the middle of the request's round trip, so a slow answer does not add its delay, and measured
 * again when the device clock is set or the device slept.
 */
const AHEAD = 30_000;
/** `mono` is performance.now(), `wall` Date.now(); `set` is how far the device clock was set by hand. */
const clock = { mono: 1_000, wall: 1_800_000_000_000, set: 0 };
const truth = () => clock.wall - clock.set + AHEAD;
const tick = (ms: number) => {
  clock.mono += ms;
  clock.wall += ms;
};

/** Requests waiting for their answer, each to be answered with the server's time when it read it. */
let asked: ((stamp: number) => void)[] = [];
const answer = async (stamp: number) => {
  asked.shift()!(stamp);
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** The server reads its clock `readAfter` ms after the request is sent, and the answer is back `total` ms after it. */
async function reply(readAfter: number, total: number) {
  tick(readAfter);
  const stamp = truth();
  tick(total - readAfter);
  await answer(stamp);
}

describe('serverNow: the server’s clock on a device whose clock is off', () => {
  let svc: typeof import('../src/lib/service');
  const measure = (readAfter: number, total: number) => {
    svc.refreshService();
    return reply(readAfter, total);
  };
  beforeEach(async () => {
    asked = [];
    Object.assign(clock, { mono: 1_000, wall: 1_800_000_000_000, set: 0 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    vi.spyOn(performance, 'now').mockImplementation(() => clock.mono);
    vi.spyOn(Date, 'now').mockImplementation(() => clock.wall);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            asked.push((now) => resolve({ ok: true, text: async () => JSON.stringify({ now, rev: 1, notices: [], maintenance: null, refreshAt: null }) }));
          }),
      ),
    );
    vi.resetModules();
    svc = await import('../src/lib/service');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a slow answer is off by half its round trip at most (it was the whole delay), and is measured again soon', async () => {
    // Read 50 ms after the request, answered 5 s after it: taken as read at the middle.
    await measure(50, 5_000);
    expect(Math.abs(svc.serverNow() - truth())).toBeLessThanOrEqual(2_500);
    // A slow measure is taken again; a quick one replaces it.
    expect(asked).toHaveLength(0);
    vi.advanceTimersByTime(5_000);
    expect(asked).toHaveLength(1);
    await reply(20, 40);
    expect(Math.abs(svc.serverNow() - truth())).toBeLessThanOrEqual(20);
  });

  it('keeps the closest measure: a later slow answer does not replace a quick one', async () => {
    await measure(30, 60);
    expect(Math.abs(svc.serverNow() - truth())).toBeLessThanOrEqual(30);
    await measure(100, 4_000);
    expect(Math.abs(svc.serverNow() - truth())).toBeLessThanOrEqual(30);
    // Nothing is asked again for a quick measure.
    vi.advanceTimersByTime(60_000);
    expect(asked).toHaveLength(0);
  });

  it('the device clock set after it was measured: asks the server again once, and takes its answer whatever its round trip', async () => {
    await measure(30, 60);
    for (const by of [3_600_000, -7_200_000]) {
      clock.wall += by;
      clock.set += by;
      tick(1_000);
      svc.serverNow();
      svc.serverNow();
      expect(asked).toHaveLength(1);
      await reply(400, 800);
      expect(Math.abs(svc.serverNow() - truth())).toBeLessThanOrEqual(400);
      expect(asked).toHaveLength(0);
    }
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it('the device slept with performance.now() paused: still right on the device clock, and measured again', async () => {
    await measure(30, 60);
    clock.wall += 600_000;
    expect(Math.abs(svc.serverNow() - truth())).toBeLessThanOrEqual(30);
    expect(asked).toHaveLength(1);
    await reply(30, 60);
    expect(Math.abs(svc.serverNow() - truth())).toBeLessThanOrEqual(30);
  });

  it('before any answer, the device clock as it is', () => {
    expect(svc.serverNow()).toBe(clock.wall);
    clock.wall += 3_600_000;
    expect(svc.serverNow()).toBe(clock.wall);
    expect(asked).toHaveLength(0);
  });
});
