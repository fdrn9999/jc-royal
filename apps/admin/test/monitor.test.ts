// The control center's model (src/monitor.ts): the address, filters and order, problems, how current the data is, and
// how a snapshot and the socket's events combine without ever taking a table back, the alerts and the timeline.
import type { AdminMonitorEvent, MonitorRoom, MonitorTable } from '@jc/types';
import { describe, expect, it } from 'vitest';
import {
  alertChanges,
  alertOrder,
  applyEvent,
  applyRooms,
  applySnapshot,
  CLOSED_LINGER_MS,
  compare,
  DEFAULT_VIEW,
  freshnessOf,
  handleAlert,
  handStarted,
  keeps,
  levelOf,
  lingers,
  linkOf,
  mergeTable,
  paramsOf,
  problemsOf,
  pushCapped,
  RESOLVE_AFTER_MS,
  RESOLVED_KEEP_MS,
  RESOLVED_MAX,
  ROOMS_CHANGED_EVERY_MS,
  roomsToRead,
  seatPoint,
  SeenEvents,
  skewOf,
  STALE_AFTER_MS,
  tableChanges,
  tablesPath,
  timelineLine,
  toggleFocus,
  togglePin,
  totalsOf,
  trackAlerts,
  viewOf,
  withCounts,
  type CcView,
  type Judged,
  type Reading,
  type RoomEntry,
} from '../src/monitor';

const table = (o: Partial<MonitorTable> = {}): MonitorTable => ({
  id: 't1',
  name: 'Table',
  roomType: 'official',
  status: 'open',
  maxSeats: 6,
  smallBlind: 1,
  bigBlind: 2,
  isPrivate: false,
  allowSpectators: true,
  beginner: false,
  entryBlocked: false,
  handsPaused: false,
  botsEnabled: true,
  seated: 0,
  bots: 0,
  playing: false,
  waitlist: 0,
  spectators: 0,
  connections: 0,
  handsPlayed: 0,
  lastIssue: null,
  liveAt: 1_000,
  createdAt: 100,
  updatedAt: 500,
  hostNickname: null,
  flags: [],
  ...o,
});

const room = (o: Partial<MonitorRoom> = {}): MonitorRoom => ({
  tableId: 't1',
  version: 1,
  status: 'playing',
  handNumber: 3,
  hand: null,
  nextHandAt: null,
  paused: false,
  maintenance: false,
  entryBlocked: false,
  waitlist: 0,
  spectators: 0,
  connections: 0,
  reservation: null,
  tournament: null,
  seats: [],
  issues: [],
  at: 2_000,
  ...o,
});

const judged = (t: MonitorTable, entry?: RoomEntry): Judged => {
  const problems = problemsOf(t, entry);
  return { table: t, problems, level: levelOf(problems), fresh: freshnessOf(t, 'live', entry) };
};

const ev = (e: Record<string, unknown>) => ({ eventId: Math.random().toString(36), occurredAt: 1, ...e }) as unknown as AdminMonitorEvent;

describe('the address', () => {
  it('reads a view and writes back only what is not the default', () => {
    const v = viewOf(new URLSearchParams('type=member&state=warnings&sort=name&tab=pinned&size=l&q=%20Gold%20&member=kim&focus=a,b,a,c,d,e'));
    expect(v).toEqual({ type: 'member', state: 'warnings', sort: 'name', tab: 'pinned', size: 'l', q: 'Gold', member: 'kim', focus: ['a', 'b', 'c', 'd'] });
    expect(viewOf(new URLSearchParams(paramsOf(v)))).toEqual(v);
    expect(paramsOf(DEFAULT_VIEW).toString()).toBe('');
  });

  it('ignores what it does not know', () => {
    expect(viewOf(new URLSearchParams('type=x&state=y&sort=z&tab=w&size=xl'))).toEqual(DEFAULT_VIEW);
  });

  it('asks the server only for what it narrows by', () => {
    expect(tablesPath(DEFAULT_VIEW)).toBe('/api/admin/monitor/tables');
    expect(tablesPath({ state: 'closed', q: 'a b', member: 'kim' })).toBe('/api/admin/monitor/tables?scope=closed&q=a+b&member=kim');
    expect(tablesPath({ state: 'warnings', q: '', member: '' })).toBe('/api/admin/monitor/tables');
  });

  it('opens one table alone, or beside the others up to four', () => {
    expect(toggleFocus(['a'], 'b', false)).toEqual(['b']);
    expect(toggleFocus(['a', 'b', 'c', 'd'], 'e', true)).toEqual(['b', 'c', 'd', 'e']);
    expect(toggleFocus(['a', 'b'], 'a', true)).toEqual(['b']);
  });
});

describe('problems', () => {
  it('reads D1: closed with someone seated is urgent, closing late a warning, an old problem only information', () => {
    expect(problemsOf(table({ status: 'closed', flags: ['seated_on_closed'] }))).toEqual([{ code: 'seated_on_closed', level: 4, source: 'd1' }]);
    expect(levelOf(problemsOf(table({ status: 'closing', flags: ['close_overdue'] })))).toBe(3);
    expect(problemsOf(table({ lastIssue: '2026-10-29T00:00:00Z settle: x' }))).toEqual([{ code: 'last_issue', level: 1, source: 'd1' }]);
  });

  it('a switch an administrator set is a state, not a problem', () => {
    expect(problemsOf(table({ entryBlocked: true, handsPaused: true, flags: ['blocked', 'paused'] }))).toEqual([]);
  });

  it('counts members without a connection as a lower bound from D1 and exactly from the room', () => {
    expect(problemsOf(table({ seated: 4, bots: 1, connections: 1 }))).toEqual([{ code: 'disconnected', level: 2, source: 'd1', n: 2 }]);
    expect(problemsOf(table({ seated: 2, bots: 0, connections: 5 }))).toEqual([]);
    const r = room({
      seats: [
        { seatIndex: 0, state: 'active', userId: 'u1', stack: 100, streetBet: 0, connected: false, lastAction: null, hasCards: true, leaving: null, timeouts: 0, sitOutSince: null, phase: null, topUp: null },
        { seatIndex: 1, state: 'active', userId: 'b1', bot: 'normal', stack: 100, streetBet: 0, connected: true, lastAction: null, hasCards: true, leaving: null, timeouts: 0, sitOutSince: null, phase: null, topUp: null },
        { seatIndex: 2, state: 'empty', stack: 0, streetBet: 0, connected: false, lastAction: null, hasCards: false, leaving: null, timeouts: 0, sitOutSince: null, phase: null, topUp: null },
      ] as MonitorRoom['seats'],
    });
    expect(problemsOf(table({ seated: 2, bots: 1, connections: 0 }), { room: r, at: 1 })).toEqual([{ code: 'disconnected', level: 2, source: 'room', n: 1 }]);
  });

  it('ranks the room issues, with a code it does not know as a warning', () => {
    const ps = problemsOf(table(), { room: room({ issues: ['pending_seat', 'turn_overdue', 'something_new'] }), at: 1 });
    expect(ps.map((p) => [p.code, p.level])).toEqual([['turn_overdue', 4], ['something_new', 3], ['pending_seat', 2]]);
  });

  it('a room that did not answer is a warning and its data unknown; a closed table is never asked', () => {
    const e: RoomEntry = { error: 'room_unavailable', at: 1 };
    expect(levelOf(problemsOf(table(), e))).toBe(3);
    expect(freshnessOf(table(), 'live', e)).toBe('unknown');
    expect(problemsOf(table({ status: 'closed' }), e)).toEqual([]);
  });
});

describe('how current', () => {
  it('is live on the socket, then polling, then stale after two missed reads', () => {
    expect(linkOf('open', null, 0)).toBe('connecting');
    expect(linkOf('open', 0, 10 * STALE_AFTER_MS)).toBe('live');
    expect(linkOf('down', 0, STALE_AFTER_MS - 1)).toBe('polling');
    expect(linkOf('down', 0, STALE_AFTER_MS)).toBe('stale');
  });

  it('an idle table whose counts have not changed for an hour is current', () => {
    expect(freshnessOf(table({ liveAt: 0 }), 'live')).toBe('live');
    expect(freshnessOf(table({ status: 'closing' }), 'live')).toBe('closing');
    expect(freshnessOf(table({ status: 'closed' }), 'stale')).toBe('closed');
    expect(freshnessOf(table(), 'stale')).toBe('stale');
  });
});

describe('filters and order', () => {
  const v = (o: Partial<CcView>): CcView => ({ ...DEFAULT_VIEW, ...o });
  const none = new Set<string>();

  it('keeps by type, tab and state', () => {
    const member = judged(table({ id: 'm', roomType: 'member', seated: 2, connections: 2 }));
    const full = judged(table({ id: 'f', seated: 6, connections: 6, playing: true }));
    const broken = judged(table({ id: 'b', status: 'closing', flags: ['close_overdue'] }));
    expect(keeps(member, v({ type: 'member' }), none)).toBe(true);
    expect(keeps(full, v({ type: 'member' }), none)).toBe(false);
    expect(keeps(member, v({ state: 'waiting' }), none)).toBe(true);
    expect(keeps(full, v({ state: 'full' }), none)).toBe(true);
    expect(keeps(full, v({ state: 'playing' }), none)).toBe(true);
    expect(keeps(broken, v({ state: 'warnings' }), none)).toBe(true);
    expect(keeps(member, v({ state: 'warnings' }), none)).toBe(false);
    expect(keeps(broken, v({ tab: 'problems' }), none)).toBe(true);
    expect(keeps(member, v({ tab: 'pinned' }), new Set(['m']))).toBe(true);
    expect(keeps(full, v({ tab: 'pinned' }), new Set(['m']))).toBe(false);
    expect(keeps(judged(table({ seated: 3, bots: 0, connections: 1 })), v({ state: 'connection' }), none)).toBe(true);
  });

  it('sorts worst first, and ties never reshuffle when only a count changes', () => {
    const a = judged(table({ id: 'a', createdAt: 3 }));
    const b = judged(table({ id: 'b', createdAt: 2, status: 'closing', flags: ['close_overdue'] }));
    const c = judged(table({ id: 'c', createdAt: 1 }));
    const order = (js: Judged[], s: Parameters<typeof compare>[0]) => [...js].sort(compare(s, 'ko')).map((j) => j.table.id);
    expect(order([a, b, c], 'severity')).toEqual(['b', 'a', 'c']);
    const a2 = judged({ ...a.table, seated: 5, connections: 5 });
    expect(order([c, a2, b], 'severity')).toEqual(['b', 'a', 'c']);
    expect(order([a, b, c], 'created')).toEqual(['a', 'b', 'c']);
  });

  it('totals the open tables the page holds', () => {
    const t = totalsOf([
      judged(table({ id: 'a', seated: 3, bots: 1, connections: 2, spectators: 4, playing: true })),
      judged(table({ id: 'b', status: 'closing', flags: ['close_overdue'], entryBlocked: true })),
      judged(table({ id: 'c', status: 'closed', seated: 9 })),
    ]);
    expect(t).toMatchObject({ tables: 2, playing: 1, members: 2, bots: 1, spectators: 4, connections: 2, blocked: 1, closing: 1, problems: 1, urgent: 0 });
  });
});

describe('the oval', () => {
  it('puts seat 0 at the bottom and spaces the others evenly', () => {
    expect(seatPoint(0, 6)).toEqual({ x: 50, y: 90 });
    expect(seatPoint(1, 2)).toEqual({ x: 50, y: 10 });
    for (const max of [2, 6, 9]) for (let i = 0; i < max; i++) {
      const p = seatPoint(i, max);
      expect(p.x).toBeGreaterThanOrEqual(6);
      expect(p.x).toBeLessThanOrEqual(94);
    }
  });
});

describe('snapshot and events', () => {
  it('a slow snapshot never takes counts or settings back', () => {
    const now = table({ seated: 3, liveAt: 2_000, updatedAt: 900, name: 'New' });
    const old = table({ seated: 1, liveAt: 1_000, updatedAt: 500, name: 'Old' });
    const m = applySnapshot(new Map([['t1', now]]), [old]);
    expect(m.get('t1')).toMatchObject({ seated: 3, liveAt: 2_000, name: 'New' });
  });

  it('the snapshot says which tables there are', () => {
    const m = applySnapshot(new Map([['gone', table({ id: 'gone' })]]), [table({ id: 'x' })]);
    expect([...m.keys()]).toEqual(['x']);
  });

  it('a table that just closed stays through a read that no longer lists it, when asked to', () => {
    const closed = table({ id: 'c', status: 'closed', updatedAt: 1_000, liveAt: 1_000 });
    const prev = new Map([['c', closed], ['gone', table({ id: 'gone' })]]);
    const keepAt = (now: number) => (t: Parameters<typeof lingers>[0]) => t.status === 'closed' && lingers(t, 'active', now);
    const m = applySnapshot(prev, [table({ id: 'x' })], keepAt(1_000 + CLOSED_LINGER_MS - 1));
    expect([...m.keys()].sort()).toEqual(['c', 'x']);
    expect([...applySnapshot(prev, [], keepAt(1_000 + CLOSED_LINGER_MS)).keys()]).toEqual([]);
  });

  it('counts apply once and only forward', () => {
    const t = table({ liveAt: 1_000 });
    const counts = { seated: 2, bots: 0, playing: true, waitlist: 0, spectators: 1, connections: 3, status: 'open' as const, issue: null };
    expect(withCounts(t, counts, 1_000)).toBe(t);
    expect(withCounts(t, counts, 999)).toBe(t);
    expect(withCounts(t, counts, 1_001)).toMatchObject({ seated: 2, playing: true, liveAt: 1_001 });
    expect(withCounts(table({ lastIssue: 'old' }), { ...counts, issue: null }, 2_000).lastIssue).toBe('old');
  });

  it('closed is final', () => {
    const closed = table({ status: 'closed' });
    expect(mergeTable(closed, table({ status: 'open', updatedAt: 9_999 })).status).toBe('closed');
    const c = { seated: 0, bots: 0, playing: false, waitlist: 0, spectators: 0, connections: 0, status: 'open' as const, issue: null };
    expect(withCounts(closed, c, 9_999).status).toBe('closed');
  });

  it('applies events to known tables, adds an open one, and flags counts for one it does not hold', () => {
    const prev = new Map([['t1', table()]]);
    const r1 = applyEvent(prev, ev({ type: 'admin.monitor.table', resourceId: 't2', revision: 1, table: table({ id: 't2' }) }), 'active');
    expect([...r1.tables.keys()]).toEqual(['t1', 't2']);
    const r2 = applyEvent(prev, ev({ type: 'admin.monitor.table', resourceId: 't3', revision: 1, table: table({ id: 't3', status: 'closed' }) }), 'active');
    expect(r2.tables).toBe(prev);
    const counts = { seated: 1, bots: 0, playing: false, waitlist: 0, spectators: 0, connections: 1, status: 'open' as const, issue: null };
    expect(applyEvent(prev, ev({ type: 'admin.monitor.counts', resourceId: 't9', revision: 5, counts }), 'active')).toEqual({ tables: prev, unknown: true });
    expect(applyEvent(prev, ev({ type: 'admin.monitor.counts', resourceId: 't9', revision: 5, counts: { ...counts, status: 'closed' } }), 'active').unknown).toBe(false);
    const narrowed = applyEvent(prev, ev({ type: 'admin.monitor.table', resourceId: 't2', revision: 1, table: table({ id: 't2' }) }), null);
    expect(narrowed.tables).toBe(prev);
    expect(applyEvent(prev, ev({ type: 'admin.monitor.counts', resourceId: 't9', revision: 5, counts }), null).unknown).toBe(false);
    const same = applyEvent(prev, ev({ type: 'admin.monitor.table', resourceId: 't1', revision: 1, table: table() }), 'active');
    expect(same.tables).toBe(prev);
  });

  it('a room summary is kept only when it is not older', () => {
    const prev = new Map<string, RoomEntry>([['t1', { room: room({ version: 5, at: 100 }), at: 1 }]]);
    const older = applyRooms(prev, { rooms: { t1: { room: room({ version: 4, at: 900 }), ms: 1 } }, at: 0 }, 2);
    expect((older.get('t1') as { room: MonitorRoom }).room.version).toBe(5);
    const later = applyRooms(prev, { rooms: { t1: { room: room({ version: 5, at: 200 }), ms: 1 } }, at: 0 }, 3);
    expect((later.get('t1') as { room: MonitorRoom }).room.at).toBe(200);
    const failed = applyRooms(prev, { rooms: { t1: { error: 'room_unavailable', ms: 1 } }, at: 0 }, 4);
    expect(failed.get('t1')).toEqual({ error: 'room_unavailable', at: 4, ms: 1 });
  });

  it('a table that closes stays two minutes on the open list, then leaves it', () => {
    const closed = table({ status: 'closed', liveAt: 10_000, updatedAt: 5_000 });
    expect(lingers(closed, 'active', 10_000 + CLOSED_LINGER_MS - 1)).toBe(true);
    expect(lingers(closed, 'active', 10_000 + CLOSED_LINGER_MS)).toBe(false);
    expect(lingers(closed, 'closed', 10 ** 12)).toBe(true);
    expect(lingers(table(), 'active', 10 ** 12)).toBe(true);
  });

  it('an event id applies once', () => {
    const s = new SeenEvents(2);
    expect(s.add('a')).toBe(true);
    expect(s.add('a')).toBe(false);
    s.add('b');
    s.add('c');
    expect(s.add('a')).toBe(true);
  });
});

describe('which rooms to read', () => {
  it('pinned first, then on screen; never a closed one, a recent one or one opened in the panel', () => {
    const tables = new Map([
      ['p', table({ id: 'p' })],
      ['v', table({ id: 'v' })],
      ['c', table({ id: 'c', status: 'closed' })],
      ['r', table({ id: 'r' })],
      ['f', table({ id: 'f' })],
    ]);
    const rooms = new Map<string, RoomEntry>([['r', { room: room(), at: 50_000 }]]);
    expect(roomsToRead({ pinned: ['p'], visible: ['v', 'c', 'r', 'f', 'p', 'gone'], focus: ['f'], tables, rooms, now: 60_000 })).toEqual(['p', 'v']);
    expect(roomsToRead({ pinned: [], visible: ['r'], focus: [], tables, rooms, now: 110_000 })).toEqual(['r']);
  });

  it('a room whose counts changed is read again sooner, but not at once', () => {
    const tables = new Map([['r', table({ id: 'r' })]]);
    const rooms = new Map<string, RoomEntry>([['r', { room: room(), at: 50_000 }]]);
    const changed = new Set(['r']);
    expect(roomsToRead({ pinned: [], visible: ['r'], focus: [], tables, rooms, changed, now: 50_000 + ROOMS_CHANGED_EVERY_MS - 1 })).toEqual([]);
    expect(roomsToRead({ pinned: [], visible: ['r'], focus: [], tables, rooms, changed, now: 50_000 + ROOMS_CHANGED_EVERY_MS })).toEqual(['r']);
  });
});

describe('small things', () => {
  it('pins newest first, and a second press unpins', () => {
    expect(togglePin(['a'], 'b')).toEqual(['b', 'a']);
    expect(togglePin(['b', 'a'], 'b')).toEqual(['a']);
  });

  it('the clock difference from one answer', () => {
    expect(skewOf(10_500, 1_000, 1_200)).toBe(9_400);
  });
});

describe('alerts', () => {
  const read = (t: MonitorTable, entry?: RoomEntry): Reading => ({ table: t, problems: problemsOf(t, entry), roomAt: entry && 'room' in entry ? entry.at : null });
  // Two of three seated members without a connection (D1's counts): a caution, from the row alone.
  const off = table({ seated: 3, connections: 1 });

  it('one active alert per table and problem: read again, it keeps when it was first seen and moves when it was last seen', () => {
    const a = trackAlerts([], [read(off)], 10_000);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ key: 't1:disconnected', code: 'disconnected', level: 2, source: 'd1', n: 2, firstSeen: 10_000, lastSeen: 10_000, handling: 'new', resolvedAt: null });
    const b = trackAlerts(a, [read(table({ seated: 4, connections: 1 }))], 14_000);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ id: a[0]!.id, firstSeen: 10_000, lastSeen: 14_000, n: 3 });
    // Nothing new to read: the same list back, so the page does not draw it again.
    const c = trackAlerts(b, [read(table({ seated: 4, connections: 1 }))], 14_000);
    expect(c).toBe(b);
  });

  it('noting an alert as seen changes the note only: the problem stays active and shown, and it resolves only when the readings stop showing it', () => {
    let a = trackAlerts([], [read(off)], 10_000);
    a = handleAlert(a, a[0]!.id, 'ack');
    a = trackAlerts(a, [read(off)], 20_000);
    expect(a[0]).toMatchObject({ handling: 'ack', resolvedAt: null, lastSeen: 20_000 });
    a = handleAlert(a, a[0]!.id, 'dismissed');
    a = trackAlerts(a, [read(off)], 30_000);
    expect(a[0]).toMatchObject({ handling: 'dismissed', resolvedAt: null });
  });

  it('a problem gone for less than the window is the same alert when it comes back; gone for the window, it resolves from when it went', () => {
    const fine = table({ seated: 3, connections: 3 });
    let a = trackAlerts([], [read(off)], 10_000);
    a = trackAlerts(a, [read(fine)], 12_000);
    expect(a[0]).toMatchObject({ clearSince: 12_000, resolvedAt: null });
    a = trackAlerts(a, [read(off)], 13_000);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ clearSince: null, firstSeen: 10_000 });
    a = trackAlerts(a, [read(fine)], 15_000);
    a = trackAlerts(a, [read(fine)], 15_000 + RESOLVE_AFTER_MS - 1);
    expect(a[0]!.resolvedAt).toBeNull();
    a = trackAlerts(a, [read(fine)], 15_000 + RESOLVE_AFTER_MS);
    expect(a[0]).toMatchObject({ resolvedAt: 15_000, resolvedBy: 'cleared' });
    // Back after it resolved: a new alert, first seen now.
    a = trackAlerts(a, [read(off)], 40_000);
    expect(a.filter((x) => x.resolvedAt === null)).toEqual([expect.objectContaining({ firstSeen: 40_000, handling: 'new' })]);
    expect(a.filter((x) => x.resolvedAt !== null)).toHaveLength(1);
  });

  it('a room that stops answering hides its issues, it does not fix them: they resolve only on a newer answer without them', () => {
    const stuck: RoomEntry = { room: room({ issues: ['turn_overdue'] }), at: 10_000 };
    let a = trackAlerts([], [read(table(), stuck)], 10_500);
    expect(a[0]).toMatchObject({ code: 'turn_overdue', level: 4, source: 'room', firstSeen: 10_000 });
    // No answer now: the alert stays as it was (the room's own failure is an alert of its own).
    a = trackAlerts(a, [read(table(), { error: 'room_unavailable', at: 20_000 })], 60_000);
    expect(a.find((x) => x.code === 'turn_overdue')).toMatchObject({ resolvedAt: null, clearSince: null });
    expect(a.find((x) => x.code === 'room_unavailable')).toMatchObject({ level: 3, resolvedAt: null });
    // An answer without it: resolved once the window passed since that answer.
    a = trackAlerts(a, [read(table(), { room: room({ version: 2 }), at: 70_000 })], 70_000 + RESOLVE_AFTER_MS);
    expect(a.find((x) => x.code === 'turn_overdue')).toMatchObject({ resolvedAt: 70_000, resolvedBy: 'cleared' });
  });

  it('a worse level shows as new again; a table that left the list resolves its alerts as gone', () => {
    const pending: RoomEntry = { room: room({ issues: ['pending_seat'] }), at: 1_000 };
    let a = trackAlerts([], [read(table(), pending)], 1_000);
    a = handleAlert(a, a[0]!.id, 'investigating');
    expect(a[0]!.handling).toBe('investigating');
    a = trackAlerts(a, [], 2_000);
    expect(a[0]).toMatchObject({ resolvedAt: 2_000, resolvedBy: 'gone' });
    // A resolved alert keeps its note; a note on it changes nothing.
    expect(handleAlert(a, a[0]!.id, 'ack')[0]!.handling).toBe('investigating');
  });

  it('resolved alerts are kept a while, the latest at most RESOLVED_MAX', () => {
    const many = Array.from({ length: RESOLVED_MAX + 5 }, (_, i) => table({ id: `t${i}`, seated: 1 }));
    let a = trackAlerts([], many.map((t) => read(t)), 1_000);
    expect(a).toHaveLength(RESOLVED_MAX + 5);
    a = trackAlerts(a, [], 2_000);
    expect(a).toHaveLength(RESOLVED_MAX);
    expect(trackAlerts(a, [], 2_000 + RESOLVED_KEEP_MS)).toEqual([]);
  });

  it('listed active first and worst first, and only caution and worse make a timeline line', () => {
    const a = trackAlerts([], [read(table({ id: 'a', seated: 1, lastIssue: 'x' })), read(table({ id: 'b', flags: ['close_overdue'], status: 'closing' }))], 1_000);
    expect([...a].sort(alertOrder).map((x) => `${x.tableId}:${x.code}`)).toEqual(['b:close_overdue', 'a:disconnected', 'a:last_issue']);
    const { raised } = alertChanges([], a);
    expect(raised.map((x) => x.code).sort()).toEqual(['close_overdue', 'disconnected']);
  });
});

describe('the timeline', () => {
  it('what an event changed about a table, in lines; whether a hand is being played is not one', () => {
    const old = table({ seated: 1, waitlist: 0 });
    const lines = tableChanges(old, table({ seated: 2, waitlist: 1, playing: true, entryBlocked: true, handsPaused: true }), 5_000);
    expect(lines.map((l) => [l.kind, l.code, l.params])).toEqual([
      ['seat', 'seated', { from: 1, to: 2, max: 6 }],
      ['seat', 'waitlist', { from: 0, to: 1 }],
      ['table', 'blocked', undefined],
      ['table', 'paused', undefined],
    ]);
    expect(tableChanges(old, table({ seated: 1, playing: true, spectators: 4, connections: 6 }), 5_000)).toEqual([]);
    expect(tableChanges(undefined, table(), 5_000).map((l) => l.code)).toEqual(['opened']);
    expect(tableChanges(table(), table({ status: 'closing' }), 5_000).map((l) => l.code)).toEqual(['closing']);
    expect(tableChanges(table({ status: 'closing' }), table({ status: 'closed' }), 5_000).map((l) => l.code)).toEqual(['closed']);
  });

  it('an open room dealing a new hand is a line; the same hand read again is not', () => {
    const hand = { stage: 'preflop', buttonSeat: 0, sbSeat: 0, bbSeat: 1, board: [], potTotal: 15, actorSeat: 0, turn: null } as unknown as NonNullable<MonitorRoom['hand']>;
    const before: RoomEntry = { room: room({ handNumber: 3 }), at: 1 };
    expect(handStarted(before, room({ handNumber: 4, hand }), 'T', 9)).toMatchObject({ kind: 'game', code: 'hand', params: { n: 4 } });
    expect(handStarted(before, room({ handNumber: 3, hand }), 'T', 9)).toBeNull();
    expect(handStarted(undefined, room({ handNumber: 4, hand }), 'T', 9)).toBeNull();
  });

  it('new lines first, at most the cap', () => {
    const l = (n: number) => timelineLine(n, 'admin', 'pause', { id: 't', name: 'T' });
    let list = pushCapped([], [l(1), l(2)], 3);
    expect(list.map((x) => x.at)).toEqual([2, 1]);
    list = pushCapped(list, [l(3), l(4)], 3);
    expect(list.map((x) => x.at)).toEqual([4, 3, 2]);
    expect(pushCapped(list, [], 3)).toBe(list);
  });
});
