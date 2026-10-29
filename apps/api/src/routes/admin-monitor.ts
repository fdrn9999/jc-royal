/**
 * The control center's reads (docs/CONTROL_CENTER.md). The grid is drawn from D1 alone: one query of the open and
 * closing tables, with the counts each room last wrote. A room is asked only for the few tables an operator has on
 * screen, pinned or opened (at most MONITOR_ROOMS_MAX at once), never for every table. Both are read only: no control
 * here, and watching is not spectating (the room is asked through its internal path, never its game socket, so no
 * spectator is counted). No card a player holds, no join code or its hash and no waitlist member id leaves here.
 */
import {
  MONITOR_ROOMS_MAX,
  MONITOR_TABLES_MAX,
  type MonitorRoom,
  type MonitorRoomsResponse,
  type MonitorTable,
  type MonitorTableFlag,
  type MonitorTablesResponse,
  type MonitorTotals,
} from '@jc/types';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { parseBody } from '../lib/http';
import { roomCall, SWEEP_CLOSING_AFTER_MS } from '../lib/room';

interface Row {
  id: string;
  name: string;
  room_type: MonitorTable['roomType'];
  status: MonitorTable['status'];
  max_seats: number;
  small_blind: number;
  big_blind: number;
  is_private: number;
  allow_spectators: number;
  beginner: number;
  entry_blocked: number;
  hands_paused: number;
  bots_enabled: number;
  live_seated: number;
  live_bots: number;
  live_playing: number;
  live_waitlist: number;
  live_spectators: number;
  live_connections: number;
  hands_played: number;
  last_issue: string | null;
  live_updated_at: number | null;
  created_at: number;
  updated_at: number;
  host: string | null;
}

// The columns the grid shows, by name: never join_code_hash or live_waitlist_users.
const COLUMNS = `t.id, t.name, t.room_type, t.status, t.max_seats, t.small_blind, t.big_blind, t.is_private, t.allow_spectators,
  t.beginner, t.entry_blocked, t.hands_paused, t.bots_enabled, t.live_seated, t.live_bots, t.live_playing, t.live_waitlist,
  t.live_spectators, t.live_connections, t.hands_played, t.last_issue, t.live_updated_at, t.created_at, t.updated_at,
  CASE WHEN t.room_type = 'member' THEN u.nickname END AS host`;

/** `active`: open and closing tables (the default); `closed`: the most recently closed ones. */
const scopeOf = (v: string | undefined) => (v === 'closed' ? 'closed' : 'active');

const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export function monitorTable(r: Row, now: number, seatedOnClosed: ReadonlySet<string>): MonitorTable {
  const flags: MonitorTableFlag[] = [];
  if (r.status === 'closing' && r.updated_at < now - SWEEP_CLOSING_AFTER_MS) flags.push('close_overdue');
  if (r.status === 'closed' && seatedOnClosed.has(r.id)) flags.push('seated_on_closed');
  if (r.entry_blocked) flags.push('blocked');
  if (r.hands_paused) flags.push('paused');
  return {
    id: r.id,
    name: r.name,
    roomType: r.room_type,
    status: r.status,
    maxSeats: r.max_seats as MonitorTable['maxSeats'],
    smallBlind: r.small_blind,
    bigBlind: r.big_blind,
    isPrivate: !!r.is_private,
    allowSpectators: !!r.allow_spectators,
    beginner: !!r.beginner,
    entryBlocked: !!r.entry_blocked,
    handsPaused: !!r.hands_paused,
    botsEnabled: !!r.bots_enabled,
    seated: r.live_seated,
    bots: r.live_bots,
    playing: !!r.live_playing,
    waitlist: r.live_waitlist,
    spectators: r.live_spectators,
    connections: r.live_connections,
    handsPlayed: r.hands_played,
    lastIssue: r.last_issue,
    liveAt: r.live_updated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hostNickname: r.host,
    flags,
  };
}

export function monitorTotals(items: readonly MonitorTable[]): MonitorTotals {
  const t: MonitorTotals = { tables: 0, playing: 0, members: 0, bots: 0, spectators: 0, waitlist: 0, connections: 0, blocked: 0, paused: 0, closing: 0, flagged: 0 };
  for (const x of items) {
    t.tables += 1;
    if (x.playing) t.playing += 1;
    t.members += Math.max(0, x.seated - x.bots);
    t.bots += x.bots;
    t.spectators += x.spectators;
    t.waitlist += x.waitlist;
    t.connections += x.connections;
    if (x.entryBlocked) t.blocked += 1;
    if (x.handsPaused) t.paused += 1;
    if (x.status === 'closing') t.closing += 1;
    if (x.flags.some((f) => f === 'close_overdue' || f === 'seated_on_closed')) t.flagged += 1;
  }
  return t;
}

const RoomsSchema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(MONITOR_ROOMS_MAX) });

/** Mounted inside the admin router (requireAdmin and the permission rules already applied: the `tables` grant). */
export const adminMonitorRoutes = new Hono<AppEnv>()
  /**
   * Every open and closing table (or, with scope=closed, the latest closed ones), closing first and then newest. `q`
   * narrows by name or exact id, `member` to the tables where the member with that nickname sits now.
   */
  .get('/monitor/tables', async (c) => {
    const scope = scopeOf(c.req.query('scope'));
    const q = (c.req.query('q') ?? '').trim().slice(0, 64);
    const member = (c.req.query('member') ?? '').trim().slice(0, 32);
    const at = Date.now();
    const where = [scope === 'closed' ? `t.status = 'closed'` : `t.status IN ('open', 'closing')`];
    const binds: unknown[] = [];
    if (q) {
      binds.push(likeOf(q), q);
      where.push(`(t.name LIKE ?${binds.length - 1} ESCAPE '\\' OR t.id = ?${binds.length})`);
    }
    if (member) {
      binds.push(member);
      where.push(
        `t.id IN (SELECT s.table_id FROM table_sessions s JOIN users m ON m.id = s.user_id WHERE lower(m.nickname) = lower(?${binds.length}) AND s.status = 'seated')`,
      );
    }
    const list = c.env.DB.prepare(
      `SELECT ${COLUMNS} FROM tables t LEFT JOIN users u ON u.id = t.created_by WHERE ${where.join(' AND ')}
       ORDER BY (t.status = 'closing') DESC, t.created_at DESC, t.id LIMIT ${MONITOR_TABLES_MAX + 1}`,
    ).bind(...binds);
    // Closed tables that still have seated rows (the dashboard's seatedOnClosed): a seat no room will ever cash out.
    const stuck = c.env.DB.prepare(
      `SELECT DISTINCT s.table_id AS id FROM table_sessions s JOIN tables t ON t.id = s.table_id WHERE s.status = 'seated' AND t.status = 'closed' LIMIT 50`,
    );
    const [rows, seated] = await c.env.DB.batch<Row | { id: string }>([list, stuck]);
    const d1Ms = Date.now() - at;
    const onClosed = new Set((seated!.results as { id: string }[]).map((r) => r.id));
    const all = rows!.results as Row[];
    const items = all.slice(0, MONITOR_TABLES_MAX).map((r) => monitorTable(r, at, onClosed));
    const out: MonitorTablesResponse = {
      items,
      totals: monitorTotals(items),
      truncated: all.length > MONITOR_TABLES_MAX,
      ...(member ? { memberTables: items.map((x) => x.id) } : {}),
      seatedOnClosed: [...onClosed],
      at,
      d1Ms,
    };
    c.header('Cache-Control', 'no-store');
    return c.json(out);
  })
  /**
   * The live summary of a few rooms (what a spectator at each table sees, with the room's own issues). A table D1 says
   * is closed, or does not have, is not woken; a room that does not answer is reported as such, never guessed.
   */
  .post('/monitor/rooms', async (c) => {
    const { ids } = await parseBody(c, RoomsSchema);
    const unique = [...new Set(ids)];
    const { results } = await c.env.DB.prepare(`SELECT id, status FROM tables WHERE id IN (${unique.map((_, i) => `?${i + 1}`).join(', ')})`)
      .bind(...unique)
      .all<{ id: string; status: string }>();
    const statusOf = new Map(results.map((r) => [r.id, r.status]));
    const rooms: MonitorRoomsResponse['rooms'] = {};
    await Promise.all(
      unique.map(async (id) => {
        const status = statusOf.get(id);
        if (!status) return void (rooms[id] = { error: 'not_found' });
        if (status === 'closed') return void (rooms[id] = { error: 'closed' });
        const started = Date.now();
        const room = (await roomCall(c, id, 'monitor')) as MonitorRoom | null;
        const ms = Date.now() - started;
        rooms[id] = room ? { room, ms } : { error: 'room_unavailable', ms };
      }),
    );
    c.header('Cache-Control', 'no-store');
    return c.json({ rooms, at: Date.now() } satisfies MonitorRoomsResponse);
  });
