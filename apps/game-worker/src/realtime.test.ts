// The realtime hub's rules (realtime-rules.ts): which sign-out ends which socket, when a socket is checked again, which
// public events a page gets, and the shard a member's sockets live on. The api side and the sockets themselves are
// tested in tests/integration/realtime.test.ts.
import { REALTIME_SHARDS, RealtimeClientFrameSchema, RealtimeEventSchema, realtimeShardOf, type RealtimeEvent } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { parseIdentity, REALTIME_MAX_AGE_MS, revokes, stale, wants, type RealtimeIdentity } from './realtime-rules';

const T0 = 1_800_000_000_000;
const me = (over: Partial<RealtimeIdentity> = {}): RealtimeIdentity => ({ userId: 'u1', sessionId: 's1', authAt: T0, expiresAt: T0 + 86_400_000, ...over });
const ev = (type: RealtimeEvent['type'], over: Record<string, unknown> = {}) =>
  RealtimeEventSchema.parse({ eventId: 'e1', occurredAt: T0, scope: type === 'service.changed' || type === 'inbox.broadcast' ? 'service' : 'lobby', type, ...over });

describe('revokes', () => {
  it('ends only that member, and only the sessions the sign-out names', () => {
    expect(revokes({ user: 'u2', at: T0 }, me())).toBe(false);
    expect(revokes({ user: 'u1', at: T0 }, me())).toBe(true);
    expect(revokes({ user: 'u1', session: 's1', at: T0 }, me())).toBe(true);
    expect(revokes({ user: 'u1', session: 's2', at: T0 }, me())).toBe(false);
    // "sign out the other devices" keeps the page that asked for it
    expect(revokes({ user: 'u1', except: 's1', at: T0 }, me())).toBe(false);
    expect(revokes({ user: 'u1', except: 's1', at: T0 }, me({ sessionId: 's2' }))).toBe(true);
  });

  it('turns away a handshake checked before the sign-out, not one signed in after it', () => {
    // the api read the session, then the logout landed, then the handshake reached the hub
    expect(revokes({ user: 'u1', at: T0 }, me({ authAt: T0 - 50 }), true)).toBe(true);
    // a new sign-in a few seconds later is a new session and a later check
    expect(revokes({ user: 'u1', at: T0 }, me({ authAt: T0 + 5_000, sessionId: 's9' }), true)).toBe(false);
    // an open socket is ended whenever it was opened
    expect(revokes({ user: 'u1', at: T0 }, me({ authAt: T0 + 5_000 }))).toBe(true);
  });
});

describe('stale', () => {
  it('is due when the session would have expired, or an hour after the check', () => {
    expect(stale(me(), T0 + 1)).toBe(false);
    expect(stale(me({ expiresAt: T0 + 10 }), T0 + 10)).toBe(true);
    expect(stale(me(), T0 + REALTIME_MAX_AGE_MS - 1)).toBe(false);
    expect(stale(me(), T0 + REALTIME_MAX_AGE_MS)).toBe(true);
  });
});

describe('wants', () => {
  const patch = { id: 't1', rev: 1, seated: 2, bots: 0, playing: true, waitlist: 0, spectators: 1, status: 'open' };
  it('sends lobby and tournament events only to pages that asked, service events to every page', () => {
    const lobby = ev('lobby.table.changed', { resourceId: 't1', payload: patch });
    const tour = ev('tournament.changed', { resourceId: 'x1' });
    const service = ev('service.changed', { payload: { rev: 3, spreadMs: 1000 } });
    expect(wants({ topics: [] }, lobby)).toBe(false);
    expect(wants({ topics: ['lobby'] }, lobby)).toBe(true);
    expect(wants({ topics: ['lobby'] }, tour)).toBe(false);
    expect(wants({ topics: ['tournaments'] }, tour)).toBe(true);
    expect(wants({ topics: [] }, service)).toBe(true);
  });
});

describe('protocol', () => {
  it('carries only counts in a lobby patch: who sits or waits is not a field', () => {
    const parsed = RealtimeEventSchema.parse({
      eventId: 'e1',
      occurredAt: T0,
      scope: 'lobby',
      type: 'lobby.table.changed',
      resourceId: 't1',
      payload: { id: 't1', rev: 1, seated: 2, bots: 0, playing: false, waitlist: 1, spectators: 0, status: 'open', waitlistUsers: ['u9'], myParticipation: { status: 'seated' } },
    });
    expect(Object.keys(parsed.type === 'lobby.table.changed' ? parsed.payload : {}).sort()).toEqual(['bots', 'id', 'playing', 'rev', 'seated', 'spectators', 'status', 'waitlist']);
  });

  it('refuses a personal event marked public and an unknown type', () => {
    expect(RealtimeEventSchema.safeParse({ eventId: 'e1', occurredAt: T0, scope: 'lobby', type: 'wallet.changed' }).success).toBe(false);
    expect(RealtimeEventSchema.safeParse({ eventId: 'e1', occurredAt: T0, scope: 'user', type: 'wallet.credit', payload: { amount: 1e9 } }).success).toBe(false);
  });

  it('reads nothing from a page but the topics it wants', () => {
    expect(RealtimeClientFrameSchema.safeParse({ t: 'sub', topics: ['lobby'] }).success).toBe(true);
    expect(RealtimeClientFrameSchema.safeParse({ t: 'sub', topics: ['admin'] }).success).toBe(false);
    expect(RealtimeClientFrameSchema.safeParse({ t: 'publish', e: {} }).success).toBe(false);
  });

  it('takes the identity the api verified, and nothing malformed', () => {
    const ok = me();
    expect(parseIdentity(encodeURIComponent(JSON.stringify(ok)))).toEqual(ok);
    expect(parseIdentity(null)).toBeNull();
    expect(parseIdentity('%E0%A4%A')).toBeNull();
    expect(parseIdentity(encodeURIComponent(JSON.stringify({ userId: 'u1', sessionId: '', authAt: T0, expiresAt: T0 })))).toBeNull();
    expect(parseIdentity(encodeURIComponent(JSON.stringify({ userId: 'u1', sessionId: 's1', authAt: 'now', expiresAt: T0 })))).toBeNull();
  });
});

describe('realtimeShardOf', () => {
  it('is stable and spreads random ids over every hub', () => {
    expect(realtimeShardOf('abc')).toBe(realtimeShardOf('abc'));
    const counts = new Array<number>(REALTIME_SHARDS).fill(0);
    for (let i = 0; i < 4000; i++) counts[realtimeShardOf(crypto.randomUUID())]!++;
    for (const n of counts) expect(n).toBeGreaterThan((4000 / REALTIME_SHARDS) * 0.8);
    expect(realtimeShardOf('abc', 1)).toBe(0);
  });
});
