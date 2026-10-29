/**
 * The control center's reads (docs/CONTROL_CENTER.md). The grid is drawn from D1 alone: one query of the open and
 * closing tables, with the counts each room last wrote. A room is asked only for the few tables an operator has on
 * screen, pinned or opened (at most MONITOR_ROOMS_MAX at once), never for every table. Both are read only: no control
 * here, and watching is not spectating (the room is asked through its internal path, never its game socket, so no
 * spectator is counted). No card a player holds, no join code or its hash and no waitlist member id leaves here.
 */
import { ADMIN_MONITOR_WATCH_MAX, MONITOR_ROOMS_MAX, MONITOR_TABLES_MAX, type MonitorRoom, type MonitorRoomsResponse, type MonitorTablesResponse } from '@jc/types';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { MONITOR_COLUMNS, monitorTable, monitorTotals, type MonitorRow } from '../lib/admin-monitor';
import { fail, parseBody } from '../lib/http';
import { roomCall } from '../lib/room';

/** `active`: open and closing tables (the default); `closed`: the most recently closed ones. */
const scopeOf = (v: string | undefined) => (v === 'closed' ? 'closed' : 'active');

const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/**
 * `follow`: the page has these tables open and wants their changes on its socket too (each room pushes its summary to
 * the console for a while, FOLLOW_MS, and the page asks again before that runs out). Only a few at once.
 */
const RoomsSchema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(MONITOR_ROOMS_MAX), follow: z.boolean().optional() });
/** How long one rooms read with `follow` has the room push its changes: past the page's re-ask (60 s), short of the room's cap. */
const FOLLOW_MS = '75000';

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
      `SELECT ${MONITOR_COLUMNS} FROM tables t LEFT JOIN users u ON u.id = t.created_by WHERE ${where.join(' AND ')}
       ORDER BY (t.status = 'closing') DESC, t.created_at DESC, t.id LIMIT ${MONITOR_TABLES_MAX + 1}`,
    ).bind(...binds);
    // Closed tables that still have seated rows (the dashboard's seatedOnClosed): a seat no room will ever cash out.
    const stuck = c.env.DB.prepare(
      `SELECT DISTINCT s.table_id AS id FROM table_sessions s JOIN tables t ON t.id = s.table_id WHERE s.status = 'seated' AND t.status = 'closed' LIMIT 50`,
    );
    const [rows, seated] = await c.env.DB.batch<MonitorRow | { id: string }>([list, stuck]);
    const d1Ms = Date.now() - at;
    const onClosed = new Set((seated!.results as { id: string }[]).map((r) => r.id));
    const all = rows!.results as MonitorRow[];
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
    const { ids, follow } = await parseBody(c, RoomsSchema);
    const unique = [...new Set(ids)];
    if (follow && unique.length > ADMIN_MONITOR_WATCH_MAX) fail(400, 'bad_request', `at most ${ADMIN_MONITOR_WATCH_MAX} rooms are followed at once`);
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
        const room = (await roomCall(c, id, 'monitor', follow ? { follow: FOLLOW_MS } : {})) as MonitorRoom | null;
        const ms = Date.now() - started;
        rooms[id] = room ? { room, ms } : { error: 'room_unavailable', ms };
      }),
    );
    c.header('Cache-Control', 'no-store');
    return c.json({ rooms, at: Date.now() } satisfies MonitorRoomsResponse);
  });
