// The persistent alerts and the operations log in words, and one table's health (src/opsText.ts): what the room has not
// told the console reads as unknown, never as fine.
import type { MonitorRoom, MonitorSeat, MonitorTable, OpsAlertDto } from '@jc/types';
import { describe, expect, it } from 'vitest';
import type { Key } from '../src/i18n';
import type { RoomEntry } from '../src/monitor';
import { healthOf, metricLabel, opsAlertText, opsEventText, type HealthItem } from '../src/opsText';

// The words are the key and its values: what is said, not how.
const t = (k: Key, v?: Record<string, string | number>) => (v ? `${k}${JSON.stringify(v)}` : k);

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
  seated: 3,
  bots: 1,
  playing: true,
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
const seat = (i: number, o: Partial<MonitorSeat> = {}): MonitorSeat => ({
  seatIndex: i,
  state: 'active',
  userId: `u${i}`,
  nickname: `n${i}`,
  stack: 100,
  streetBet: 0,
  connected: true,
  lastAction: null,
  hasCards: true,
  ...o,
}) as MonitorSeat;
const NOW = 100_000;
const room = (o: Partial<MonitorRoom> = {}): MonitorRoom => ({
  tableId: 't1',
  version: 1,
  status: 'playing',
  handNumber: 3,
  hand: {
    stage: 'flop',
    buttonSeat: 0,
    sbSeat: 1,
    bbSeat: 2,
    board: [],
    potTotal: 6,
    actorSeat: 1,
    turn: { startedAt: NOW - 5_000, baseMs: 30_000, extraMs: 0, deadline: NOW + 25_000 },
  },
  nextHandAt: null,
  paused: false,
  maintenance: false,
  entryBlocked: false,
  waitlist: 0,
  spectators: 2,
  connections: 4,
  reservation: null,
  tournament: null,
  seats: [seat(0), seat(1, { connected: false }), seat(2), seat(3, { bot: 'normal' as MonitorSeat['bot'], userId: undefined }), seat(4, { state: 'empty', userId: undefined })],
  issues: [],
  at: NOW,
  ...o,
}) as MonitorRoom;
const answered = (r: MonitorRoom): RoomEntry => ({ room: r, at: NOW - 1_000 });
const byKey = (items: HealthItem[]) => Object.fromEntries(items.map((h) => [h.key, h]));
const alert = (o: Partial<Pick<OpsAlertDto, 'code' | 'severity' | 'detail'>> = {}) => ({ code: 'room_issue' as const, severity: 'warning' as const, detail: {}, ...o });

describe("one table's health", () => {
  it('a room that has not answered: every reading of the room is unknown, and D1 gives only a time', () => {
    const h = byKey(healthOf({ table: table(), entry: undefined, fresh: 'live', alerts: [], now: NOW }));
    for (const k of ['members', 'spectators', 'street', 'lastAction', 'socket', 'sync', 'errors', 'timer', 'settlement'] as const) expect(h[k]!.state, k).toBe('unknown');
    expect(h.lastGood).toEqual({ key: 'lastGood', state: 'unknown', at: 1_000, code: 'd1' });
    // Nothing is said to be fine without having been seen.
    expect(Object.values(h).some((x) => x.state === 'ok')).toBe(false);
  });

  it('a room that answered: its own counts, the turn, and when it answered', () => {
    const h = byKey(healthOf({ table: table(), entry: answered(room()), fresh: 'live', alerts: [], now: NOW }));
    // Members are seated people: not the bot, not the empty seat; one of three is away.
    expect(h.members).toMatchObject({ state: 'warn', n: 2, of: 3 });
    expect(h.spectators).toMatchObject({ state: 'ok', n: 2 });
    expect(h.street).toMatchObject({ state: 'ok', code: 'flop' });
    expect(h.lastAction).toMatchObject({ state: 'ok', at: NOW - 5_000 });
    expect(h.socket).toMatchObject({ state: 'warn', n: 4, of: 1 });
    expect(h.sync).toMatchObject({ state: 'ok', code: 'live', at: NOW - 1_000 });
    expect(h.errors).toMatchObject({ state: 'ok', n: 0 });
    expect(h.timer).toMatchObject({ state: 'ok', n: 25_000 });
    expect(h.settlement).toMatchObject({ state: 'ok' });
    expect(h.lastGood).toMatchObject({ state: 'ok', at: NOW - 1_000 });
  });

  it('between hands there is no last action or turn to judge, which is not unknown either', () => {
    const h = byKey(healthOf({ table: table(), entry: answered(room({ hand: null })), fresh: 'live', alerts: [], now: NOW }));
    expect(h.street).toMatchObject({ state: 'ok', code: 'idle' });
    expect(h.lastAction!.state).toBe('none');
    expect(h.timer!.state).toBe('none');
  });

  it("the room's issues and the table's open alerts are its errors; a late turn and an unrecorded hand say where", () => {
    const late = room({ issues: ['turn_overdue', 'unrecorded_hands'], hand: { ...room().hand!, turn: { startedAt: NOW - 40_000, baseMs: 30_000, extraMs: 0, deadline: NOW - 10_000 } } });
    const h = byKey(healthOf({ table: table(), entry: answered(late), fresh: 'live', alerts: [alert({ severity: 'critical', detail: { issue: 'turn_overdue' } })], now: NOW }));
    expect(h.errors).toMatchObject({ state: 'bad', n: 3, code: 'turn_overdue' });
    expect(h.timer).toMatchObject({ state: 'bad', code: 'turn_overdue', n: 10_000 });
    expect(h.settlement).toMatchObject({ state: 'bad', code: 'unrecorded_hands' });
  });

  it('a turn past its deadline with no issue from the room yet is a caution; a buy-in being debited too', () => {
    const r = room({ issues: ['topup_debiting'], hand: { ...room().hand!, turn: { startedAt: NOW - 31_000, baseMs: 30_000, extraMs: 0, deadline: NOW - 1_000 } } });
    const h = byKey(healthOf({ table: table(), entry: answered(r), fresh: 'live', alerts: [], now: NOW }));
    expect(h.timer).toMatchObject({ state: 'warn', code: 'late', n: 1_000 });
    expect(h.settlement).toMatchObject({ state: 'warn', code: 'topup_debiting' });
  });

  it('an open alert alone (the room silent since): a warning is a caution, an error or worse is bad', () => {
    expect(byKey(healthOf({ table: table(), entry: answered(room()), fresh: 'live', alerts: [alert()], now: NOW })).errors).toMatchObject({ state: 'warn', n: 1 });
    expect(byKey(healthOf({ table: table(), entry: undefined, fresh: 'live', alerts: [alert({ code: 'table_stale', severity: 'error' })], now: NOW })).errors).toMatchObject({ state: 'bad', code: 'table_stale' });
  });

  it('a lost link or a room that could not be reached is a sync problem, not a guess', () => {
    expect(byKey(healthOf({ table: table(), entry: answered(room()), fresh: 'stale', alerts: [], now: NOW })).sync).toMatchObject({ state: 'bad', code: 'stale' });
    const h = byKey(healthOf({ table: table(), entry: { error: 'room_unavailable', at: NOW }, fresh: 'unknown', alerts: [], now: NOW }));
    expect(h.sync).toMatchObject({ state: 'bad' });
    expect(h.members!.state).toBe('unknown');
    // A page that read the room once says when.
    expect(byKey(healthOf({ table: table(), entry: answered(room()), fresh: null, alerts: [], now: NOW })).sync).toMatchObject({ state: 'ok', code: 'read', at: NOW - 1_000 });
  });

  it('seated rows on a closed table are a settlement problem without asking the room; the rest of a closed table is nothing to show', () => {
    const h = byKey(healthOf({ table: table({ status: 'closed', flags: ['seated_on_closed'] }), entry: undefined, fresh: 'closed', alerts: [], now: NOW }));
    expect(h.settlement).toMatchObject({ state: 'bad', code: 'seated_on_closed' });
    expect(h.members!.state).toBe('none');
    expect(h.sync).toMatchObject({ state: 'none', code: 'closed' });
    expect(Object.values(h).some((x) => x.state === 'unknown')).toBe(false);
  });
});

describe('alerts and log lines in words', () => {
  it('an alert from its code and numbers', () => {
    expect(opsAlertText(t, { code: 'room_issue', detail: { issue: 'stalled_hand' } })).toBe('issueStalledHand');
    expect(opsAlertText(t, { code: 'close_overdue', detail: { sinceMs: 17 * 60_000 + 20_000 } })).toBe('opsACloseOverdue{"m":17}');
    expect(opsAlertText(t, { code: 'outbox_backlog', detail: { n: 12 } })).toBe('opsAOutboxBacklog{"n":12}');
    expect(opsAlertText(t, { code: 'delivery_failed', detail: { metric: 'rt_undelivered+rt_outbox_failed', n: 30, windowMs: 5 * 60_000 } })).toBe(
      'opsAMetric{"what":"opsCode_delivery_failed","metric":"opsMetricRtUndelivered + opsMetricRtOutboxFailed","n":30,"m":5}',
    );
    expect(metricLabel(t, 'something_new')).toBe('something_new');
  });

  it('a table control: the action, what it did and how it ended', () => {
    expect(opsEventText(t, { kind: 'admin_control', code: 'table.control', summary: 'table.control pause' })).toBe('auditTableControl · opsCtl_pause · ccOutcomeOk');
    expect(opsEventText(t, { kind: 'admin_control', code: 'table.control', summary: 'table.control block saved, room did not confirm' })).toBe('auditTableControl · opsCtl_block · ccOutcomeUnconfirmed');
    expect(opsEventText(t, { kind: 'admin_control', code: 'table.close', summary: 'table.close failed 409 still_seated' })).toBe('auditTableClose · ccOutcomeFailed');
  });

  it("an alert's lines name the room's issue, also when it ended, and the handling it was given", () => {
    expect(opsEventText(t, { kind: 'alert_opened', code: 'room_issue', summary: 'room reports turn_overdue' })).toBe('opsEvOpened{"what":"opsCode_room_issue: issueTurnOverdue"}');
    expect(opsEventText(t, { kind: 'alert_resolved', code: 'room_issue', summary: 'room reports turn_overdue: no longer seen' })).toBe('opsEvResolved{"what":"opsCode_room_issue: issueTurnOverdue"}');
    expect(opsEventText(t, { kind: 'alert_handled', code: 'table_stale', summary: 'handling new -> investigating' })).toBe('opsEvHandled{"what":"opsCode_table_stale","to":"opsHandlingInvestigating"}');
  });
});
