// The control center hub's rules (admin-monitor-rules.ts) and what its socket may carry (@jc/types admin-monitor): when
// a console socket is checked again, who still has table duty, the sweep's query, and the events the hub refuses. The
// handshake, the revokes and the frames themselves are tested in tests/integration/admin-monitor-socket.test.ts.
import { ADMIN_MONITOR_WATCH_MAX, AdminMonitorClientFrameSchema, AdminMonitorEventSchema, hasPrivateKey, MONITOR_PRIVATE_KEYS } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { changeKindsOf, hasTableDuty, kindsOf, liveAdminSessionsSql, MONITOR_MAX_AGE_MS, MONITOR_SWEEP_CHUNK, sameKinds, staleMonitor, watchOf } from './admin-monitor-rules';
import { revokes, type RealtimeIdentity } from './realtime-rules';

const T0 = 1_800_000_000_000;
const me = (over: Partial<RealtimeIdentity> = {}): RealtimeIdentity => ({ userId: 'a1', sessionId: 's1', authAt: T0, expiresAt: T0 + 30 * 60_000, ...over });

const row = { id: 't1', updatedAt: T0, name: 'Table', status: 'open', flags: [] };
const room = { tableId: 't1', version: 3, status: 'playing', seats: [{ seatIndex: 0, stack: 990, hasCards: true }], issues: [] };
const base = { eventId: 'e1', occurredAt: T0, resourceId: 't1', revision: 1 };

describe('staleMonitor', () => {
  it('checks a console socket again when its sign-in runs out or every half hour', () => {
    expect(staleMonitor(me(), T0 + 1000)).toBe(false);
    expect(staleMonitor(me({ expiresAt: T0 + 5000 }), T0 + 5000)).toBe(true);
    expect(staleMonitor(me({ expiresAt: T0 + 10 * 3_600_000 }), T0 + MONITOR_MAX_AGE_MS - 1)).toBe(false);
    expect(staleMonitor(me({ expiresAt: T0 + 10 * 3_600_000 }), T0 + MONITOR_MAX_AGE_MS)).toBe(true);
  });
});

describe('hasTableDuty', () => {
  it('as the api reads permissions: every duty for a super admin, the stored ones for an administrator, none for a member', () => {
    expect(hasTableDuty('super_admin', null)).toBe(true);
    expect(hasTableDuty('admin', '["tables","vip"]')).toBe(true);
    expect(hasTableDuty('admin', '["tableControl"]')).toBe(false);
    expect(hasTableDuty('admin', '[]')).toBe(false);
    expect(hasTableDuty('admin', null)).toBe(false);
    expect(hasTableDuty('admin', 'not json')).toBe(false);
    expect(hasTableDuty('admin', '{"tables":true}')).toBe(false);
    expect(hasTableDuty('user', '["tables"]')).toBe(false);
  });
});

describe("the other administrators' changes a socket hears of", () => {
  it('follows the permissions: VIP with the vip duty, tournaments with the tournaments duty, both for a super admin', () => {
    expect(changeKindsOf('super_admin', null)).toEqual(['vip', 'tournament']);
    expect(changeKindsOf('admin', '["tables","vip"]')).toEqual(['vip']);
    expect(changeKindsOf('admin', '["tables","tournaments"]')).toEqual(['tournament']);
    expect(changeKindsOf('admin', '["tables"]')).toEqual([]);
    expect(changeKindsOf('admin', 'not json')).toEqual([]);
    expect(changeKindsOf('user', '["vip","tournaments"]')).toEqual([]);
  });

  it("reads the api's list: missing is none, known kinds once in order, anything else refuses the handshake", () => {
    expect(kindsOf(null)).toEqual([]);
    expect(kindsOf('[]')).toEqual([]);
    expect(kindsOf('["tournament","vip","vip"]')).toEqual(['vip', 'tournament']);
    expect(kindsOf('["vip","reports"]')).toBeNull();
    expect(kindsOf('"vip"')).toBeNull();
    expect(kindsOf('{"vip":true}')).toBeNull();
    expect(kindsOf('vip')).toBeNull();
  });

  it('checks a socket again when its kinds are no longer what the permissions give', () => {
    expect(sameKinds(['vip'], ['vip'])).toBe(true);
    expect(sameKinds(['tournament', 'vip'], ['vip', 'tournament'])).toBe(true);
    expect(sameKinds(['vip'], ['vip', 'tournament'])).toBe(false);
    expect(sameKinds(['vip', 'tournament'], ['vip'])).toBe(false);
    expect(sameKinds(undefined, [])).toBe(true);
    expect(sameKinds(undefined, ['vip'])).toBe(false);
  });

  it('says only what changed and its version: never a reason, a color or anything else', () => {
    const changed = { ...base, resourceId: 'u1', type: 'admin.monitor.changed', kind: 'vip' };
    expect(AdminMonitorEventSchema.safeParse(changed).success).toBe(true);
    expect(AdminMonitorEventSchema.safeParse({ ...changed, kind: 'tournament' }).success).toBe(true);
    expect(AdminMonitorEventSchema.safeParse({ ...changed, kind: 'reports' }).success).toBe(false);
    expect(AdminMonitorEventSchema.safeParse({ ...changed, reason: 'chargeback' }).success).toBe(false);
    expect(AdminMonitorEventSchema.safeParse({ ...changed, color: 'gold' }).success).toBe(false);
  });
});

describe('liveAdminSessionsSql', () => {
  it('numbers the ids, then the clock and the absolute limit, and reads console sign-ins of active administrators only', () => {
    const sql = liveAdminSessionsSql(3);
    expect(sql).toContain('IN (?1, ?2, ?3)');
    expect(sql).toContain('s.expires_at > ?4');
    expect(sql).toContain('s.created_at > ?5');
    expect(sql).toContain("s.kind = 'admin'");
    expect(sql).toContain("u.status = 'active'");
    expect(sql).toContain("u.role IN ('admin', 'super_admin')");
    // a D1 statement binds at most 100 values
    expect(MONITOR_SWEEP_CHUNK + 2).toBeLessThanOrEqual(100);
    expect(liveAdminSessionsSql(MONITOR_SWEEP_CHUNK)).toContain(`?${MONITOR_SWEEP_CHUNK + 2}`);
  });
});

describe('revokes on the console hub', () => {
  it('a logout ends that sign-in only; ending the other sessions keeps the page that asked', () => {
    expect(revokes({ user: 'a1', session: 's1', at: T0 }, me())).toBe(true);
    expect(revokes({ user: 'a1', session: 's2', at: T0 }, me())).toBe(false);
    expect(revokes({ user: 'a1', except: 's1', at: T0 }, me())).toBe(false);
    expect(revokes({ user: 'a1', except: 's1', at: T0 }, me({ sessionId: 's2' }))).toBe(true);
    // a member's sign-out names a member session: no console socket has it
    expect(revokes({ user: 'a1', session: 'member-session', at: T0 }, me())).toBe(false);
    expect(revokes({ user: 'a2', at: T0 }, me())).toBe(false);
  });
});

describe('watchOf', () => {
  it('keeps each room once, in the order asked', () => {
    expect(watchOf(['t2', 't1', 't2'])).toEqual(['t2', 't1']);
    expect(watchOf([])).toEqual([]);
  });
});

describe('what the socket carries', () => {
  it('finds a private field at any depth', () => {
    for (const k of MONITOR_PRIVATE_KEYS) {
      expect(hasPrivateKey({ [k]: 1 })).toBe(true);
      expect(hasPrivateKey({ seats: [{ nested: { [k]: null } }] })).toBe(true);
    }
    expect(hasPrivateKey(room)).toBe(false);
    expect(hasPrivateKey('holeCards')).toBe(false);
  });

  it('refuses what nests too deep to be read through, rather than letting a field below the limit pass', () => {
    const nest = (inner: unknown, n: number) => Array.from({ length: n }).reduce<unknown>((x) => ({ x }), inner);
    expect(hasPrivateKey(nest({ deck: [] }, 12))).toBe(true);
    expect(hasPrivateKey(nest(1, 12))).toBe(true);
    expect(hasPrivateKey(nest(1, 8))).toBe(false);
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.room', room: { ...room, extra: nest({ deck: [] }, 12) } }).success).toBe(false);
  });

  it('refuses a table row or a room summary with a card, a join code or who waits', () => {
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.table', table: row }).success).toBe(true);
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.room', room }).success).toBe(true);
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.table', table: { ...row, join_code_hash: 'x' } }).success).toBe(false);
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.table', table: { ...row, live_waitlist_users: '["u1"]' } }).success).toBe(false);
    const peek = { ...room, seats: [{ ...room.seats[0], holeCards: ['As', 'Kd'] }] };
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.room', room: peek }).success).toBe(false);
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.room', room: { ...room, deck: [] } }).success).toBe(false);
    // the row must name its table and version
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.room', room: { version: 1 } }).success).toBe(false);
  });

  it('drops anything but the counts from a counts event (never who waits)', () => {
    const counts = { seated: 3, bots: 1, playing: true, waitlist: 2, spectators: 0, connections: 3, status: 'open', issue: null };
    const parsed = AdminMonitorEventSchema.parse({ ...base, type: 'admin.monitor.counts', counts: { ...counts, waitlistUsers: ['u1'] }, extra: 1 });
    expect(parsed).toEqual({ ...base, type: 'admin.monitor.counts', counts });
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.counts', counts: { ...counts, seated: -1 } }).success).toBe(false);
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'admin.monitor.counts', counts: { ...counts, issue: 'x'.repeat(301) } }).success).toBe(false);
    // the member hub's events are not the console's
    expect(AdminMonitorEventSchema.safeParse({ ...base, type: 'lobby.table.updated', counts }).success).toBe(false);
  });

  it('a page only says which rooms it follows, a few at most', () => {
    const ids = Array.from({ length: ADMIN_MONITOR_WATCH_MAX }, (_, i) => `t${i}`);
    expect(AdminMonitorClientFrameSchema.safeParse({ t: 'watch', tables: ids }).success).toBe(true);
    expect(AdminMonitorClientFrameSchema.safeParse({ t: 'watch', tables: [...ids, 'tx'] }).success).toBe(false);
    expect(AdminMonitorClientFrameSchema.safeParse({ t: 'control', action: 'pause', tables: [] }).success).toBe(false);
  });
});
