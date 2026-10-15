import { describe, expect, it } from 'vitest';
import { ACK_LATE_MS, DEADLINE_MS, Heartbeat, Outbox, PONG_WAIT_MS, QUIET_MS } from '../src/game/link';

/** Pings a heartbeat sends over `ms`, ticking every 2 s, with a server message every `every` ms (0: none). */
function pingsOver(ms: number, every: number) {
  const hb = new Heartbeat();
  hb.reset(0);
  let pings = 0;
  for (let now = 2_000; now <= ms; now += 2_000) {
    if (every && now % every === 0) hb.received(now);
    const r = hb.tick(now);
    if (r === 'ping') {
      pings++;
      // The pong comes straight back.
      hb.received(now);
    }
    expect(r).not.toBe('dead');
  }
  return pings;
}

describe('Heartbeat', () => {
  it('pings a quiet connection, and not one the server keeps talking on', () => {
    // The old client pinged every 25 s whatever happened: 24 times in ten minutes.
    const old = Math.floor((10 * 60_000) / 25_000);
    // An idle table (a spectator between games): about as often, never more.
    const idle = pingsOver(10 * 60_000, 0);
    expect(idle).toBeLessThanOrEqual(old);
    expect(idle).toBeGreaterThan(old - 3);
    // A hand in play sends states every few seconds: no pings at all.
    expect(pingsOver(10 * 60_000, 6_000)).toBe(0);
    // Between the two: a message every 30 s still leaves quiet gaps worth a ping.
    expect(pingsOver(10 * 60_000, 30_000)).toBeGreaterThan(0);
  });

  it('gives up on a connection that does not answer a ping', () => {
    const hb = new Heartbeat();
    hb.reset(0);
    expect(hb.tick(QUIET_MS)).toBe('ping');
    expect(hb.tick(QUIET_MS + PONG_WAIT_MS - 1)).toBeNull();
    expect(hb.tick(QUIET_MS + PONG_WAIT_MS)).toBe('dead');
  });

  it('checks on request once at a time, and any message counts as the answer', () => {
    const hb = new Heartbeat();
    hb.reset(0);
    expect(hb.check(1_000)).toBe(true);
    expect(hb.check(2_000)).toBe(false);
    hb.received(3_000);
    expect(hb.tick(3_000 + PONG_WAIT_MS)).toBeNull();
    expect(hb.check(4_000)).toBe(true);
    expect(hb.tick(4_000 + PONG_WAIT_MS)).toBe('dead');
  });
});

describe('Outbox', () => {
  it('keeps unanswered commands with their ids for the next connection', () => {
    const box = new Outbox<{ t: string; reqId: string }, string>();
    box.add('a', { t: 'sit', reqId: 'a' }, 'sit', 0);
    box.add('b', { t: 'chat', reqId: 'b' }, 'chat', 0);
    expect(box.take('b')?.h).toBe('chat');
    box.detach();
    const again = box.resend(3_000);
    expect(again.map((o) => o.msg)).toEqual([{ t: 'sit', reqId: 'a' }]);
    expect(again[0]!.sends).toBe(2);
    expect(box.take('a')).toBeDefined();
    expect(box.size).toBe(0);
  });

  it('reports a late answer once per send, and drops commands past the deadline', () => {
    const box = new Outbox<string, null>();
    box.add('a', 'x', null, 0);
    expect(box.sweep(ACK_LATE_MS - 1).late).toBe(false);
    expect(box.sweep(ACK_LATE_MS).late).toBe(true);
    expect(box.sweep(ACK_LATE_MS + 1_000).late).toBe(false);
    // Waiting for a connection is not "late": nothing is in flight.
    box.detach();
    expect(box.sweep(ACK_LATE_MS * 2).late).toBe(false);
    box.resend(ACK_LATE_MS * 2);
    expect(box.sweep(ACK_LATE_MS * 3).late).toBe(true);
    const { expired } = box.sweep(DEADLINE_MS);
    expect(expired.map((o) => o.id)).toEqual(['a']);
    expect(box.size).toBe(0);
  });

  it('drains everything when the connection ends for good', () => {
    const box = new Outbox<string, null>();
    box.add('a', 'x', null, 0);
    box.add('b', 'y', null, 0);
    expect(box.drain().map((o) => o.id)).toEqual(['a', 'b']);
    expect(box.size).toBe(0);
  });
});
