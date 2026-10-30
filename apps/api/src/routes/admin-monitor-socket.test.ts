// The control center socket's handshake to the hub (hubHeaders): every header the hub reads is the api's, whatever the
// page sent under those names, and the sweep's period exists only where the api has one (local tests).
import { describe, expect, it } from 'vitest';
import { hubHeaders } from './admin-monitor-socket';

const identity = { userId: 'a1', sessionId: 's1', authAt: 1, expiresAt: 2 };
const forged = () =>
  new Headers({
    upgrade: 'websocket',
    'x-jc-internal': 'guess',
    'x-jc-identity': encodeURIComponent(JSON.stringify({ ...identity, userId: 'someone-else' })),
    'x-jc-monitor-kinds': '["vip","tournament"]',
    'x-jc-sweep-ms': '1000',
  });

describe('hubHeaders', () => {
  it('replaces what a page sent under the hub’s names, and drops a sweep period outside local tests', () => {
    const h = hubHeaders(forged(), { INTERNAL_SECRET: 'secret' }, identity, ['tables']);
    expect(h.get('upgrade')).toBe('websocket');
    expect(h.get('x-jc-internal')).toBe('secret');
    expect(JSON.parse(decodeURIComponent(h.get('x-jc-identity')!))).toEqual(identity);
    expect(JSON.parse(h.get('x-jc-monitor-kinds')!)).toEqual([]);
    expect(h.has('x-jc-sweep-ms')).toBe(false);
  });

  it('the kinds are the grants’, and a local test’s sweep period is the api’s', () => {
    const h = hubHeaders(forged(), { INTERNAL_SECRET: 'secret', REALTIME_SWEEP_MS: '15000' }, identity, ['tables', 'tournaments']);
    expect(JSON.parse(h.get('x-jc-monitor-kinds')!)).toEqual(['tournament']);
    expect(h.get('x-jc-sweep-ms')).toBe('15000');
    expect(JSON.parse(hubHeaders(new Headers(), { INTERNAL_SECRET: 's' }, identity, ['vip', 'tournaments']).get('x-jc-monitor-kinds')!)).toEqual(['vip', 'tournament']);
  });
});
