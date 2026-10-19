/**
 * Admin console API. Every route requires an admin session (requireAdmin) and passes its rule in lib/permissions.ts
 * (the least role, and for sensitive actions a password re-confirmed within the last minutes). All changes are written
 * to admin_audit_log, refused and failed attempts too (lib/audit.ts). Actions marked so take preview: true and answer
 * what they would change without changing it.
 */
import { applyLedger, findLedgerMismatches, schema } from '@jc/db';
import { botSettingsIssues, ChipAdjustSchema, TableInputSchema, TablePatchSchema, type AcademyStatRow } from '@jc/types';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit, auditFailures, searchAudit, AUDIT_COUNT_CAP } from '../lib/audit';
import { assertRecentReauth, requireAdmin } from '../lib/auth';
import { randomToken, sha256 } from '../lib/crypto';
import { toCsv } from '../lib/csv';
import { fail, isPreview, parseBody } from '../lib/http';
import { can, capabilitiesOf, hasGrant, matchedRoute, parseGrants, requirePermission } from '../lib/permissions';
import { adminAuthRoutes, requireAdminOrigin } from './admin-auth';
import { adminCommunityRoutes } from './admin-community';
import { adminSecurityRoutes } from './admin-security';
import { adminBotRoutes } from './admin-bots';
import { adminReferralRoutes } from './admin-referral';
import { adminSettingsRoutes } from './admin-settings';
import { adminSocialRoutes } from './admin-social';
import { adminBrandRoutes } from './admin-brand';
import { adminRefillRoutes } from './admin-refill';
import { adminTimeBankRoutes } from './admin-timebank';
import { adminVipRoutes } from './admin-vip';
import { adminTournamentRoutes } from './admin-tournaments';
import { adminServiceRoutes } from './admin-service';
import { adminStatsRoutes } from './admin-stats';
import { adminReportRoutes } from './reports';
import { sendMessages } from '../lib/community';
import { mailEnabled, passwordResetMail, sendMail } from '../lib/mail';
import { notices } from '../lib/notices';
import { looksPersonal } from '../lib/pii';
import { economy, LARGE_ADJUSTMENT } from '../lib/economy';
import { liveOps } from '../lib/ops';
import { kickEverywhere, refreshRoleEverywhere, roomCall } from '../lib/room';
import { signedOut } from '../lib/signout';

/** "Online": a member session used within this long (the dashboard counts the same way). */
const ONLINE_MS = 5 * 60_000;

const ReasonSchema = z.string().trim().min(2).max(200);
const SuspendSchema = z.object({ reason: ReasonSchema, reportId: z.string().min(1).max(64).optional() });
const DisconnectSchema = z.object({ reason: ReasonSchema, removeFromTable: z.boolean().default(false) });
const RoleSchema = z.object({ role: z.enum(['user', 'admin', 'super_admin']), reason: ReasonSchema });

/** Audit actions on a member shown on their timeline (views, lists and the note.create twin of each note are left out). */
const SANCTION_ACTIONS = ['user.suspend', 'user.unsuspend', 'user.disconnect'];
const CHIP_ACTIONS = ['user.chips', 'user.reconcile'];
const MEMBER_ACTIONS = [...SANCTION_ACTIONS, 'user.role', 'user.vip', ...CHIP_ACTIONS, 'user.reset_link', 'note.delete'];


/** Emergency table controls: `pause` lets the running hand finish and deals no new one until `resume`. */
const TableControlSchema = z.object({ action: z.enum(['pause', 'resume', 'block', 'unblock']), reason: ReasonSchema });

type LiveSeat = { userId: string; nickname: string; phase: string; tableSessionId: string } | null;

/**
 * What the room reports, held against D1: settings the room has not taken on, and seats the two disagree about. A seat
 * whose buy-in is still being confirmed has no session row yet, so it is left out. The two reads are not one snapshot:
 * a player sitting down or leaving in between can show here once; a mismatch that stays is worth a look. Nothing is
 * changed here, in the wallet or anywhere else. A tournament table has no session rows (its seats hold tournament chips,
 * not wallet chips), so its seats are not compared.
 */
async function diagnose(d1: D1Database, t: typeof schema.tables.$inferSelect, live: Record<string, unknown>) {
  const issues = Array.isArray(live.issues) ? live.issues.filter((x): x is string => typeof x === 'string') : [];
  const known = live.known as { status?: string; entryBlocked?: boolean; handsPaused?: boolean } | undefined;
  if (known && (known.status !== t.status || known.entryBlocked !== t.entryBlocked || known.handsPaused !== t.handsPaused)) issues.push('settings_not_applied');
  if (t.roomType === 'tournament') return { issues, sessionsOnlyInD1: [], seatsOnlyInRoom: [] };
  const { results: open } = await d1
    .prepare(`SELECT s.id, s.user_id AS userId, s.seat_index AS seatIndex, s.buy_in AS buyIn, s.created_at AS createdAt, u.nickname FROM table_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.table_id = ?1 AND s.status = 'seated'`)
    .bind(t.id)
    .all<{ id: string; userId: string; seatIndex: number; buyIn: number; createdAt: number; nickname: string | null }>();
  const seats = (Array.isArray(live.seats) ? (live.seats as LiveSeat[]) : []).filter((s): s is NonNullable<LiveSeat> => !!s);
  const inRoom = new Set(seats.map((s) => s.tableSessionId));
  const inD1 = new Set(open.map((s) => s.id));
  const sessionsOnlyInD1 = open.filter((s) => !inRoom.has(s.id));
  const seatsOnlyInRoom = seats.filter((s) => s.phase !== 'pending' && !inD1.has(s.tableSessionId)).map((s) => ({ userId: s.userId, nickname: s.nickname, phase: s.phase, tableSessionId: s.tableSessionId }));
  if (sessionsOnlyInD1.length) issues.push('session_without_seat');
  if (seatsOnlyInRoom.length) issues.push('seat_without_session');
  return { issues, sessionsOnlyInD1, seatsOnlyInRoom };
}

/** Ledger rows checked for a wallet mismatch, newest first. */
const EVIDENCE_ROWS = 1000;

type EvidenceRow = { seq: number; id: string; type: string; amount: number; balanceAfter: number; tableId: string | null; idempotencyKey: string; actorId: string | null; memo: string | null; createdAt: number };

/**
 * A wallet held against its ledger. Each ledger row keeps the balance it left, so a row whose balance is not the row
 * before's plus its amount marks a change to the wallet made without a ledger row, somewhere between the two; `afterLast`
 * is such a change since the latest row. A recorded difference (`reconcile:…:record`) entered the ledger without moving
 * the wallet. The latest EVIDENCE_ROWS rows are checked (`truncated`: there are older ones, and the oldest checked row
 * has no row before it to compare with).
 */
async function walletEvidence(d1: D1Database, e: typeof schema.reconciliationEvents.$inferSelect) {
  const uid = e.subjectId;
  const [member, sums, latest, sessions, corrections] = await d1.batch([
    d1.prepare(`SELECT id, nickname, status, role, balance FROM users WHERE id = ?1`).bind(uid),
    d1.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS sum FROM chip_ledger WHERE user_id = ?1`).bind(uid),
    d1.prepare(
      `SELECT rowid AS seq, id, type, amount, balance_after AS balanceAfter, table_id AS tableId, idempotency_key AS idempotencyKey, actor_id AS actorId, memo, created_at AS createdAt
         FROM chip_ledger WHERE user_id = ?1 ORDER BY rowid DESC LIMIT ?2`,
    ).bind(uid, EVIDENCE_ROWS + 1),
    d1.prepare(`SELECT id, table_id AS tableId, seat_index AS seatIndex, buy_in AS buyIn, created_at AS createdAt FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`).bind(uid),
    d1.prepare(`SELECT id, idempotency_key AS idempotencyKey, amount, balance_after AS balanceAfter, actor_id AS actorId, created_at AS createdAt FROM chip_ledger WHERE idempotency_key IN (?1, ?2)`).bind(
      `reconcile:${e.id}:record`,
      `reconcile:${e.id}:revert`,
    ),
  ]);
  const m = member?.results[0] as { id: string; nickname: string; status: string; role: string; balance: number } | undefined;
  const s = (sums?.results[0] ?? { n: 0, sum: 0 }) as { n: number; sum: number };
  const desc = (latest?.results ?? []) as EvidenceRow[];
  const truncated = desc.length > EVIDENCE_ROWS;
  const asc = desc.slice(0, EVIDENCE_ROWS).reverse();
  const isRecord = (r: EvidenceRow) => r.type === 'reconcile' && r.idempotencyKey.endsWith(':record');
  const breaks: (EvidenceRow & { expected: number; difference: number; previousAt: number | null })[] = [];
  let recorded = 0;
  for (let i = 0; i < asc.length; i++) {
    const r = asc[i]!;
    if (isRecord(r)) recorded += r.amount;
    const prev = i > 0 ? asc[i - 1]! : null;
    if (!prev && truncated) continue;
    const expected = (prev?.balanceAfter ?? 0) + (isRecord(r) ? 0 : r.amount);
    if (expected !== r.balanceAfter) breaks.push({ ...r, expected, difference: r.balanceAfter - expected, previousAt: prev?.createdAt ?? null });
  }
  const last = asc[asc.length - 1];
  return {
    member: m ?? null,
    ledger: { count: s.n, sum: s.sum, checked: asc.length, truncated },
    difference: { event: e.actual - e.expected, current: m ? m.balance - s.sum : null },
    // Newest first; a long history of breaks shows its latest 50.
    breaks: breaks.reverse().slice(0, 50),
    breakCount: breaks.length,
    afterLast: { amount: m ? m.balance - (last?.balanceAfter ?? 0) : 0, since: last?.createdAt ?? null },
    recorded,
    recent: desc.slice(0, 20),
    openSessions: sessions?.results ?? [],
    corrections: corrections?.results ?? [],
  };
}

/**
 * What suspending or disconnecting a member would end (a preview; nothing changes): their signed-in sessions and the
 * seats they hold, with the chips they brought to each.
 */
async function sanctionPreview(DB: D1Database, id: string) {
  const [sessions, seats] = await DB.batch([
    DB.prepare(`SELECT kind, COUNT(*) AS n FROM sessions WHERE user_id = ?1 AND expires_at > ?2 GROUP BY kind`).bind(id, Date.now()),
    DB.prepare(
      `SELECT s.table_id AS tableId, t.name AS tableName, s.seat_index AS seatIndex, s.buy_in AS buyIn
         FROM table_sessions s LEFT JOIN tables t ON t.id = s.table_id WHERE s.user_id = ?1 AND s.status = 'seated' ORDER BY s.created_at`,
    ).bind(id),
  ]);
  const by = Object.fromEntries(((sessions?.results ?? []) as { kind: string; n: number }[]).map((r) => [r.kind, r.n]));
  const open = (seats?.results ?? []) as { tableId: string; tableName: string | null; seatIndex: number; buyIn: number }[];
  return { sessions: { user: by.user ?? 0, admin: by.admin ?? 0 }, seats: open, buyIns: open.reduce((a, s) => a + s.buyIn, 0) };
}

/**
 * Refuses a suspension of a member who is already suspended (409 already_suspended), after asking their tables once
 * more to end their connections and seats: the request that suspended them may have stopped before every table did.
 * `details.kick` says what each table did; the refusal is recorded with it (in place of the plain failure row).
 */
async function alreadySuspended(c: Context<AppEnv>, id: string): Promise<never> {
  const kick = await kickEverywhere(c.env, id, 'suspended', true);
  const message = 'this member is already suspended';
  try {
    await audit(c, 'user.suspend.failed', { type: 'user', id }, { status: 409, code: 'already_suspended', message, route: matchedRoute(c)?.key, kick }, 'failed');
  } catch (e) {
    console.error('failure audit not written', e);
  }
  return fail(409, 'already_suspended', message, { kick });
}

const page = (c: Context<AppEnv>) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200),
  offset: Math.max(Number(c.req.query('offset') ?? 0) || 0, 0),
});

/**
 * Where a keyset page starts: "<rowid>" for a list in the order rows were written, "<time>.<rowid>" for one along a
 * (key, time) index. A cursor of the other kind, or not a cursor at all, is refused rather than read as the first page.
 */
function cursorOf(raw: string | undefined, timed: boolean): { at: number; seq: number } | null {
  if (!raw) return null;
  const m = timed ? /^(\d{1,15})\.(\d{1,15})$/.exec(raw) : /^(\d{1,15})$/.exec(raw);
  if (!m) fail(400, 'bad_request', 'invalid cursor');
  return timed ? { at: Number(m[1]), seq: Number(m[2]) } : { at: 0, seq: Number(m[1]) };
}

/** The member a list is narrowed to, by exact id, email or nickname (nicknames are unique ignoring case). */
async function findMember(d1: D1Database, q: string) {
  return d1
    .prepare(`SELECT id, nickname FROM users WHERE id = ?1 OR email = lower(?1) OR lower(nickname) = lower(?1) ORDER BY id = ?1 DESC, email = lower(?1) DESC LIMIT 1`)
    .bind(q)
    .first<{ id: string; nickname: string }>();
}

/** Table bots are run by the service: no sanction, role, chip adjustment or reset link applies to them (봇 운영 does). */
function refuseBot(u: { isBot?: boolean } | undefined) {
  if (u?.isBot) fail(409, 'bot_account', 'table bot accounts are managed from the bots page');
}

/** One page and the cursor of the next (the extra row asked for says whether there is one). */
function keysetPage<T extends { seq: number }>(rows: T[], limit: number, timeOf: ((r: T) => number) | null) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const next = rows.length > limit && last ? (timeOf ? `${timeOf(last)}.${last.seq}` : String(last.seq)) : null;
  return { items, next };
}

const LEDGER_TYPES: readonly string[] = schema.chipLedger.type.enumValues;

/**
 * The chip ledger page by page (`paged=1`), newest first. Filters: `member` (an id, email or nickname) or `userId`,
 * `type`, `from` / `to` (ms, `to` exclusive). Without a member, pages go back in the order rows were written (rowid,
 * the table's own key); with one, along the member's ledger index (time, then rowid). Either way a later page reads no
 * more than the first. No total is counted: that would read every matching row on every look. A rare type or an old
 * period without a member can still read much of the table before a page fills (docs/API.md).
 */
async function ledgerPage(c: Context<AppEnv>) {
  const d1 = c.env.DB;
  const limit = page(c).limit;
  const q = (c.req.query('userId') ?? c.req.query('member') ?? '').trim().slice(0, 254);
  const type = c.req.query('type') || undefined;
  if (type && !LEDGER_TYPES.includes(type)) fail(400, 'bad_request', 'unknown ledger type');
  const ms = (k: string) => (Number.isSafeInteger(Number(c.req.query(k))) && Number(c.req.query(k)) > 0 ? Number(c.req.query(k)) : undefined);
  const from = ms('from');
  const to = ms('to');
  const member = q ? await findMember(d1, q) : null;
  const cursor = cursorOf(c.req.query('cursor'), !!member);
  const where: string[] = [];
  const binds: (string | number)[] = [];
  const add = (cond: string, ...v: (string | number)[]) => {
    where.push(cond);
    binds.push(...v);
  };
  if (member) add('l.user_id = ?', member.id);
  if (type) add('l.type = ?', type);
  if (from) add('l.created_at >= ?', from);
  if (to) add('l.created_at < ?', to);
  if (cursor) {
    if (member) add('(l.created_at, l.rowid) < (?, ?)', cursor.at, cursor.seq);
    else add('l.rowid < ?', cursor.seq);
  }
  // Conditions are written only when present: an always-there "? IS NULL OR …" would keep the planner off the rowid range.
  type Row = { seq: number; id: string; userId: string; nickname: string; type: string; amount: number; balanceAfter: number; tableId: string | null; refId: string | null; actorId: string | null; memo: string | null; createdAt: number };
  const rows =
    q && !member
      ? []
      : ((
          await d1
            .prepare(
              `SELECT l.rowid AS seq, l.id, l.user_id AS userId, u.nickname, l.type, l.amount, l.balance_after AS balanceAfter, l.table_id AS tableId,
                      l.ref_id AS refId, l.actor_id AS actorId, l.memo, l.created_at AS createdAt
                 FROM chip_ledger l INNER JOIN users u ON u.id = l.user_id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY ${member ? 'l.created_at DESC, l.rowid DESC' : 'l.rowid DESC'} LIMIT ?`,
            )
            .bind(...binds, limit + 1)
            .all<Row>()
        ).results ?? []);
  const { items, next } = keysetPage(rows, limit, member ? (r) => r.createdAt : null);
  // The ledger is every member's balance history: every look is recorded (what was searched, which page, how many rows).
  await audit(c, 'ledger.view', member ? { type: 'user', id: member.id } : undefined, { q: q || null, found: q ? !!member : null, type: type ?? null, from: from ?? null, to: to ?? null, page: cursor ? 'next' : 'first', count: items.length });
  return c.json({ items, next, member });
}

/**
 * Finished hands page by page (`paged=1`), newest first; no cards. Filters: `tableId`, `member` (an id, email or
 * nickname) or `userId`. All hands go back in the order they were written (rowid); a table's along hands_table_idx and
 * a member's along their hand_players index (end time, then rowid). With both, the member's hands are read and the
 * table's kept. A look narrowed to a member is recorded (`hand.list`): it shows where that member played.
 */
async function handsPage(c: Context<AppEnv>) {
  const d1 = c.env.DB;
  const limit = page(c).limit;
  const tableId = (c.req.query('tableId') ?? '').trim().slice(0, 64) || undefined;
  const q = (c.req.query('userId') ?? c.req.query('member') ?? '').trim().slice(0, 254);
  const member = q ? await findMember(d1, q) : null;
  const cursor = cursorOf(c.req.query('cursor'), !!(member || tableId));
  const where: string[] = [];
  const binds: (string | number)[] = [];
  const add = (cond: string, ...v: (string | number)[]) => {
    where.push(cond);
    binds.push(...v);
  };
  const cols = `h.id, h.table_id AS tableId, t.name AS tableName, h.hand_number AS handNumber, h.started_at AS startedAt, h.ended_at AS endedAt, h.board, h.pot_total AS potTotal`;
  let stmt: string;
  if (member) {
    add('hp.user_id = ?', member.id);
    if (tableId) add('h.table_id = ?', tableId);
    if (cursor) add('(hp.ended_at, hp.rowid) < (?, ?)', cursor.at, cursor.seq);
    stmt = `SELECT hp.rowid AS seq, hp.ended_at AS at, ${cols} FROM hand_players hp INNER JOIN hands h ON h.id = hp.hand_id LEFT JOIN tables t ON t.id = h.table_id
             WHERE ${where.join(' AND ')} ORDER BY hp.ended_at DESC, hp.rowid DESC LIMIT ?`;
  } else if (tableId) {
    add('h.table_id = ?', tableId);
    if (cursor) add('(h.ended_at, h.rowid) < (?, ?)', cursor.at, cursor.seq);
    stmt = `SELECT h.rowid AS seq, h.ended_at AS at, ${cols} FROM hands h LEFT JOIN tables t ON t.id = h.table_id WHERE ${where.join(' AND ')} ORDER BY h.ended_at DESC, h.rowid DESC LIMIT ?`;
  } else {
    if (cursor) add('h.rowid < ?', cursor.seq);
    stmt = `SELECT h.rowid AS seq, h.ended_at AS at, ${cols} FROM hands h LEFT JOIN tables t ON t.id = h.table_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY h.rowid DESC LIMIT ?`;
  }
  type Row = { seq: number; at: number; id: string; tableId: string; tableName: string | null; handNumber: number; startedAt: number; endedAt: number; board: string; potTotal: number };
  const rows = q && !member ? [] : ((await d1.prepare(stmt).bind(...binds, limit + 1).all<Row>()).results ?? []);
  const { items, next } = keysetPage(rows, limit, member || tableId ? (r) => r.at : null);
  if (q) await audit(c, 'hand.list', member ? { type: 'user', id: member.id } : undefined, { q, found: !!member, tableId: tableId ?? null, page: cursor ? 'next' : 'first', count: items.length });
  return c.json({ items: items.map(({ at: _at, ...r }) => ({ ...r, board: JSON.parse(r.board) as string[] })), next, member });
}

const admin = new Hono<AppEnv>()
  .use('*', requireAdminOrigin)
  .use('*', auditFailures)
  .use('*', requireAdmin)
  .use('*', requirePermission)
  // ---------------------------------------------------------------- dashboard
  .get('/dashboard', async (c) => {
    const t0 = Date.now();
    const db = c.env.DB;
    // Members only: table bots (users.is_bot) are counted apart, as `seatedBots`.
    const [users, online, tables, hands, today, seats, issues] = await db.batch([
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE status != 'deleted' AND is_bot = 0`),
      db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE kind = 'user' AND last_seen_at > ?1`).bind(Date.now() - 5 * 60_000),
      db.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status != 'closed' THEN 1 ELSE 0 END) AS active, SUM(live_playing) AS playing, SUM(live_connections) AS conns,
                SUM(live_seated) AS seated, SUM(live_bots) AS bots FROM tables`,
      ),
      db.prepare(`SELECT COUNT(*) AS n FROM hands`),
      db.prepare(`SELECT COUNT(*) AS n FROM hands WHERE ended_at > ?1`).bind(Date.now() - 24 * 60 * 60_000),
      db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(buy_in), 0) AS chips FROM table_sessions
          WHERE status = 'seated' AND user_id NOT IN (SELECT id FROM users WHERE is_bot = 1)`,
      ),
      db.prepare(`SELECT id, name, last_issue AS issue FROM tables WHERE last_issue IS NOT NULL ORDER BY updated_at DESC LIMIT 10`),
    ]);
    const one = <T>(r: D1Result | undefined) => (r?.results[0] ?? {}) as T;
    const tb = one<{ total: number; active: number; playing: number; conns: number; seated: number; bots: number }>(tables);
    return c.json({
      users: one<{ n: number }>(users).n,
      onlineUsers: one<{ n: number }>(online).n,
      tables: { total: tb.total ?? 0, active: tb.active ?? 0, playing: tb.playing ?? 0, seatedPlayers: (tb.seated ?? 0) - (tb.bots ?? 0), seatedBots: tb.bots ?? 0 },
      websocketConnections: tb.conns ?? 0,
      handsCompleted: one<{ n: number }>(hands).n,
      handsLast24h: one<{ n: number }>(today).n,
      openTableSessions: one<{ n: number }>(seats).n,
      issues: issues?.results ?? [],
      server: { env: c.env.ENVIRONMENT, d1LatencyMs: Date.now() - t0, at: Date.now() },
    });
  })
  // The dashboard's auto-refreshed part (lib/ops.ts): one bounded D1 batch, polled only while an admin watches the page.
  .get('/ops/live', async (c) => {
    const t0 = Date.now();
    const live = await liveOps(c.env.DB, t0);
    return c.json({ ...live, server: { d1LatencyMs: Date.now() - t0, at: t0 } });
  })
  // ---------------------------------------------------------------- users
  .get('/users', async (c) => {
    const { limit, offset } = page(c);
    const q = (c.req.query('q') ?? '').trim();
    const status = c.req.query('status');
    const locale = c.req.query('locale');
    const onlineOnly = c.req.query('online') === '1';
    const role = c.req.query('role');
    // `vip=vip`: VIP members; `vip=regular`: ordinary members who are not.
    const vip = c.req.query('vip') === 'vip' || c.req.query('vip') === 'regular' ? c.req.query('vip')! : null;
    // Table bots are listed only when asked for (`bots=1`), and then alone.
    const bots = c.req.query('bots') === '1';
    const sortKey = c.req.query('sort') ?? 'created';
    const dir = c.req.query('dir') === 'asc' ? asc : desc;
    const U = schema.users;
    // The outer column is written out: in a select without joins drizzle drops the table name from columns in a
    // selected expression, and a bare "id" inside this subquery would mean sessions.id.
    const online = sql<number>`EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = "users"."id" AND s.kind = 'user' AND s.last_seen_at > ${Date.now() - ONLINE_MS})`;
    const where = and(
      q ? or(like(U.email, `%${q}%`), like(U.nickname, `%${q}%`), eq(U.id, q)) : undefined,
      status === 'active' || status === 'suspended' || status === 'deleted' ? eq(U.status, status) : undefined,
      locale === 'ko' || locale === 'en' ? eq(U.locale, locale) : undefined,
      role === 'user' || role === 'admin' || role === 'super_admin' ? eq(U.role, role) : undefined,
      vip === 'vip' ? isNotNull(U.vipColor) : vip === 'regular' ? and(eq(U.role, 'user'), isNull(U.vipColor)) : undefined,
      onlineOnly ? online : undefined,
      eq(U.isBot, bots),
    );
    // Members with no recorded sign-in sort last in both directions; ties keep the newest member first.
    const order =
      sortKey === 'balance' ? [dir(U.balance)] : sortKey === 'nickname' ? [dir(sql`lower(${U.nickname})`)] : sortKey === 'login' ? [sql`${U.lastLoginAt} IS NULL`, dir(U.lastLoginAt)] : [dir(U.createdAt)];
    const rows = await c.var.db
      .select({
        id: U.id,
        email: U.email,
        nickname: U.nickname,
        locale: U.locale,
        role: U.role,
        status: U.status,
        balance: U.balance,
        createdAt: U.createdAt,
        lastLoginAt: U.lastLoginAt,
        vipColor: U.vipColor,
        online,
      })
      .from(U)
      .where(where)
      .orderBy(...order, desc(U.createdAt), U.id)
      .limit(limit)
      .offset(offset);
    // The list shows email addresses, so every look is recorded (search terms and how many members it showed).
    await audit(c, 'user.list', undefined, { q, status: status ?? null, locale: locale ?? null, role: role ?? null, ...(vip ? { vip } : {}), online: onlineOnly, ...(bots ? { bots } : {}), sort: sortKey, offset, count: rows.length });
    const items = rows.map((r) => ({ ...r, online: !!r.online }));
    // `paged=1` adds the number of matching members for page controls; without it the plain array, as before.
    if (c.req.query('paged') !== '1') return c.json(items);
    const [count] = await c.var.db.select({ n: sql<number>`COUNT(*)` }).from(U).where(where);
    return c.json({ items, total: count?.n ?? 0, limit, offset });
  })
  /** Member data export for the selected members (super admins). The notice members accept at signup covers this use. */
  .post('/users/export', async (c) => {
    const body = await parseBody(c, z.object({ userIds: z.array(z.string().min(1).max(64)).min(1).max(1000) }));
    const ids = [...new Set(body.userIds)];
    const u = schema.users;
    const cols = {
      id: u.id,
      email: u.email,
      nickname: u.nickname,
      locale: u.locale,
      role: u.role,
      status: u.status,
      balance: u.balance,
      createdAt: u.createdAt,
      birthDate: u.birthDate,
      emailVerifiedAt: u.emailVerifiedAt,
      privacyConsentVersion: u.privacyConsentVersion,
      privacyConsentAt: u.privacyConsentAt,
      suspendedReason: u.suspendedReason,
    };
    const rows: Awaited<ReturnType<typeof selectChunk>> = [];
    // D1 caps bound parameters per statement.
    function selectChunk(chunk: string[]) {
      // (Table bots are not members: they have no data to export.)
      return c.var.db.select(cols).from(u).where(and(inArray(u.id, chunk), eq(u.isBot, false)));
    }
    for (let i = 0; i < ids.length; i += 90) rows.push(...(await selectChunk(ids.slice(i, i + 90))));
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');
    const csv = toCsv([
      ['id', 'email', 'nickname', 'language', 'role', 'status', 'balance', 'joined_at_utc', 'birth_date', 'email_verified_at_utc', 'privacy_notice_version', 'privacy_agreed_at_utc', 'suspended_reason'],
      ...rows.map((r) => [r.id, r.email, r.nickname, r.locale, r.role, r.status, r.balance, iso(r.createdAt), r.birthDate, iso(r.emailVerifiedAt), r.privacyConsentVersion, iso(r.privacyConsentAt), r.suspendedReason]),
    ]);
    await audit(c, 'user.export', undefined, { count: rows.length, userIds: rows.map((r) => r.id) });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    return c.json({ filename: `jc-royal-members-${stamp}.csv`, count: rows.length, csv });
  })
  .get('/users/:id', async (c) => {
    const id = c.req.param('id');
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id) });
    if (!u) fail(404, 'not_found', 'user not found');
    const S = schema.sessions;
    const DB = c.env.DB;
    // The ledger rows and the latest reports belong to those features: an administrator with them off sees neither here.
    const seeLedger = await hasGrant(c, 'ledger');
    const seeReports = await hasGrant(c, 'reports');
    const [ledger, seats, hands, sessions, history] = await Promise.all([
      seeLedger ? c.var.db.select().from(schema.chipLedger).where(eq(schema.chipLedger.userId, id)).orderBy(desc(schema.chipLedger.createdAt)).limit(50) : [],
      c.var.db.select().from(schema.tableSessions).where(and(eq(schema.tableSessions.userId, id), eq(schema.tableSessions.status, 'seated'))),
      DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(net), 0) AS net FROM hand_players WHERE user_id = ?1`).bind(id).first<{ n: number; net: number }>(),
      // Sign-ins only: no token, address or browser string.
      c.var.db
        .select({ kind: S.kind, createdAt: S.createdAt, lastSeenAt: S.lastSeenAt, expiresAt: S.expiresAt })
        .from(S)
        .where(and(eq(S.userId, id), gt(S.expiresAt, Date.now())))
        .orderBy(desc(S.lastSeenAt))
        .limit(20),
      // Recent tables, and reports by and about the member: counts and the latest few (no evidence or free text, which
      // the reports page shows and records the look at).
      DB.batch([
        DB.prepare(
          `SELECT s.id, s.table_id AS tableId, t.name AS tableName, t.room_type AS roomType, s.seat_index AS seatIndex, s.buy_in AS buyIn,
                  s.cash_out AS cashOut, s.status, s.created_at AS createdAt, s.closed_at AS closedAt
             FROM table_sessions s LEFT JOIN tables t ON t.id = s.table_id WHERE s.user_id = ?1 ORDER BY s.created_at DESC LIMIT 10`,
        ).bind(id),
        DB.prepare(`SELECT status, COUNT(*) AS n FROM reports WHERE reporter_id = ?1 GROUP BY status`).bind(id),
        DB.prepare(`SELECT status, COUNT(*) AS n FROM reports WHERE target_user_id = ?1 GROUP BY status`).bind(id),
        DB.prepare(
          `SELECT r.id, r.target_type AS targetType, r.reason, r.status, r.created_at AS createdAt, u.nickname AS otherNickname
             FROM reports r JOIN users u ON u.id = r.target_user_id WHERE r.reporter_id = ?1 ORDER BY r.created_at DESC LIMIT 5`,
        ).bind(id),
        DB.prepare(
          `SELECT r.id, r.target_type AS targetType, r.reason, r.status, r.created_at AS createdAt, u.nickname AS otherNickname
             FROM reports r JOIN users u ON u.id = r.reporter_id WHERE r.target_user_id = ?1 ORDER BY r.created_at DESC LIMIT 5`,
        ).bind(id),
      ]),
    ]);
    const ledgerSum = await DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM chip_ledger WHERE user_id = ?1`).bind(id).first<{ s: number }>();
    // Full profile incl. birth date and consent record.
    await audit(c, 'user.view', { type: 'user', id });
    const { passwordHash: _ph, ...safe } = u;
    const online = sessions.some((s) => s.kind === 'user' && s.lastSeenAt > Date.now() - ONLINE_MS);
    const [recentTables, filed, against, recentFiled, recentAgainst] = history;
    const counts = (r: D1Result | undefined) => {
      const by = Object.fromEntries(((r?.results ?? []) as { status: string; n: number }[]).map((x) => [x.status, x.n]));
      return { open: by.open ?? 0, resolved: by.resolved ?? 0, dismissed: by.dismissed ?? 0, total: (by.open ?? 0) + (by.resolved ?? 0) + (by.dismissed ?? 0) };
    };
    return c.json({
      user: safe,
      ledger,
      openSeats: seats,
      hands: hands ?? { n: 0, net: 0 },
      ledgerConsistent: (ledgerSum?.s ?? 0) === u.balance,
      sessions,
      online,
      recentTables: recentTables?.results ?? [],
      reports: {
        filed: counts(filed),
        against: counts(against),
        recentFiled: seeReports ? (recentFiled?.results ?? []) : [],
        recentAgainst: seeReports ? (recentAgainst?.results ?? []) : [],
      },
      // Parts left out because the feature is off for this administrator (the console says so instead of "none").
      hidden: [...(seeLedger ? [] : ['ledger']), ...(seeReports ? [] : ['reports'])],
    });
  })
  /**
   * Hands played per day over the last 7, 30 or 90 days. Days are cut at the viewer's midnight: `tz` is the minutes
   * their clock is ahead of UTC (540 in Korea). Days without hands are listed with zeros.
   */
  .get('/users/:id/activity', async (c) => {
    const id = c.req.param('id');
    const days = [7, 30, 90].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 7;
    const tz = Math.min(Math.max(Math.trunc(Number(c.req.query('tz') ?? 0)) || 0, -840), 840);
    const DAY = 86_400_000;
    const shift = tz * 60_000;
    const today = Math.floor((Date.now() + shift) / DAY);
    const since = (today - days + 1) * DAY - shift;
    const DB = c.env.DB;
    const [perDay, seated] = await DB.batch([
      DB.prepare(
        `SELECT CAST((ended_at + ?2) / 86400000 AS INTEGER) AS day, COUNT(*) AS hands, COALESCE(SUM(net), 0) AS net,
                SUM(CASE WHEN net > 0 THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN went_to_showdown THEN 1 ELSE 0 END) AS showdowns
           FROM hand_players WHERE user_id = ?1 AND ended_at >= ?3 GROUP BY day`,
      ).bind(id, shift, since),
      DB.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT table_id) AS tables, COALESCE(SUM(buy_in), 0) AS buyIn FROM table_sessions WHERE user_id = ?1 AND created_at >= ?2`).bind(id, since),
    ]);
    type Day = { day: number; hands: number; net: number; wins: number; showdowns: number };
    const byDay = new Map(((perDay?.results ?? []) as Day[]).map((d) => [d.day, d]));
    const series = Array.from({ length: days }, (_, i) => {
      const day = today - days + 1 + i;
      const d = byDay.get(day);
      return { date: new Date(day * DAY).toISOString().slice(0, 10), hands: d?.hands ?? 0, net: d?.net ?? 0, wins: d?.wins ?? 0, showdowns: d?.showdowns ?? 0 };
    });
    const sum = (k: 'hands' | 'net' | 'wins' | 'showdowns') => series.reduce((a, d) => a + d[k], 0);
    const s = (seated?.results[0] ?? {}) as { n?: number; tables?: number; buyIn?: number };
    return c.json({
      days,
      since,
      series,
      totals: { hands: sum('hands'), net: sum('net'), wins: sum('wins'), showdowns: sum('showdowns'), activeDays: series.filter((d) => d.hands > 0).length, seatings: s.n ?? 0, tables: s.tables ?? 0, buyIn: s.buyIn ?? 0 },
    });
  })
  /**
   * What administrators did to this member, newest first: sanctions, role and chip changes, reset links, decisions on
   * reports about them (not each severity, assignment or note on a report), and internal notes. `kind` = all | sanction | chips | note. Pages go back from the last item
   * shown: `before` (its time, ms) and `beforeId` (its id), so entries written in the same millisecond are not skipped.
   */
  .get('/users/:id/timeline', async (c) => {
    const id = c.req.param('id');
    const kind = c.req.query('kind') ?? 'all';
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 30) || 30, 1), 100);
    const before = Number(c.req.query('before')) || Number.MAX_SAFE_INTEGER;
    const beforeId = (c.req.query('beforeId') ?? '').slice(0, 64);
    const actions = kind === 'sanction' ? SANCTION_ACTIONS : kind === 'chips' ? CHIP_ACTIONS : kind === 'note' ? ['note.delete'] : MEMBER_ACTIONS;
    const DB = c.env.DB;
    // Newest first by (time, id); one row past the page tells whether there is more.
    const page = (t: string) => `(${t}.created_at < ?2 OR (${t}.created_at = ?2 AND ${t}.id < ?4)) ORDER BY ${t}.created_at DESC, ${t}.id DESC LIMIT ?3`;
    const marks = actions.map((_, i) => `?${i + 5}`).join(', ');
    const stmts = [
      DB.prepare(
        `SELECT a.id, a.action, a.detail, a.created_at AS createdAt, a.actor_id AS actorId, u.nickname AS actorNickname
           FROM admin_audit_log a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.target_type = 'user' AND a.target_id = ?1 AND a.action IN (${marks}) AND ${page('a')}`,
      ).bind(id, before, limit + 1, beforeId || '￿', ...actions),
    ];
    // How reports about the member were handled: part of the reports feature.
    if ((kind === 'all' || kind === 'sanction') && (await hasGrant(c, 'reports'))) {
      stmts.push(
        DB.prepare(
          `SELECT a.id, a.action, a.detail, a.created_at AS createdAt, a.actor_id AS actorId, u.nickname AS actorNickname
             FROM admin_audit_log a LEFT JOIN users u ON u.id = a.actor_id
            WHERE a.target_type = 'report' AND a.target_id IN (SELECT id FROM reports WHERE target_user_id = ?1)
              AND a.action IN ('report.resolved', 'report.dismissed') AND ${page('a')}`,
        ).bind(id, before, limit + 1, beforeId || '￿'),
      );
    }
    if (kind === 'all' || kind === 'note') {
      stmts.push(
        DB.prepare(
          `SELECT n.id, 'note' AS action, n.body, n.created_at AS createdAt, n.author_id AS actorId, u.nickname AS actorNickname
             FROM admin_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.user_id = ?1 AND ${page('n')}`,
        ).bind(id, before, limit + 1, beforeId || '￿'),
      );
    }
    type Row = { id: string; action: string; detail?: string | null; body?: string; createdAt: number; actorId: string; actorNickname: string | null };
    const rows = (await DB.batch(stmts)).flatMap((r) => r.results as Row[]);
    rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id,
      action: r.action,
      createdAt: r.createdAt,
      actor: { id: r.actorId, nickname: r.actorNickname },
      detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
      body: r.body ?? null,
    }));
    const last = rows.length > limit ? items[items.length - 1]! : null;
    return c.json({ items, nextBefore: last?.createdAt ?? null, nextBeforeId: last?.id ?? null });
  })
  /** An internal handover note on a member (admins only, never shown to the member; no personal data). */
  .post('/users/:id/notes', async (c) => {
    const id = c.req.param('id');
    const { body } = await parseBody(c, z.object({ body: z.string().trim().min(2).max(500) }));
    if (looksPersonal(body)) fail(400, 'note_pii', 'notes must not hold e-mail addresses, phone, card or ID numbers');
    const u = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { id: true, status: true } });
    if (!u || u.status === 'deleted') fail(404, 'not_found', 'user not found');
    const noteId = crypto.randomUUID();
    const createdAt = Date.now();
    await c.var.db.insert(schema.adminNotes).values({ id: noteId, userId: id, authorId: c.var.user!.id, body, createdAt });
    // The note itself is the record; the audit row says who wrote one and when, not what it says.
    await audit(c, 'note.create', { type: 'user', id }, { noteId, length: body.length });
    return c.json({ id: noteId, createdAt });
  })
  /** Deleted by its author or a super admin. The text is gone; the audit row keeps who removed whose note. */
  .delete('/users/:id/notes/:noteId', async (c) => {
    const id = c.req.param('id');
    const noteId = c.req.param('noteId');
    const n = await c.var.db.query.adminNotes.findFirst({ where: and(eq(schema.adminNotes.id, noteId), eq(schema.adminNotes.userId, id)) });
    if (!n) fail(404, 'not_found', 'note not found');
    if (n.authorId !== c.var.user!.id && !can(c.var.user!.role, 'notes.delete_any')) fail(403, 'forbidden', 'only the author or a super admin can delete a note');
    await c.var.db.delete(schema.adminNotes).where(eq(schema.adminNotes.id, noteId));
    await audit(c, 'note.delete', { type: 'user', id }, { noteId, authorId: n.authorId, createdAt: n.createdAt });
    return c.json({ ok: true });
  })
  /**
   * `reportId`: the report this suspension is given for (it must be about this member); it is kept on both sides.
   * `preview`: what it would end (sign-ins, seats), before the reason is typed.
   */
  .post('/users/:id/suspend', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? SuspendSchema.partial({ reason: true }) : SuspendSchema);
    if (id === c.var.user!.id) fail(400, 'bad_request', 'cannot suspend yourself');
    const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id) });
    // A withdrawn account is gone (its notices went with it); it is not suspended back into existence.
    if (!target || target.status === 'deleted') fail(404, 'not_found', 'user not found');
    refuseBot(target);
    if (target.role !== 'user' && !can(c.var.user!.role, 'admins.manage')) fail(403, 'forbidden', 'only a super admin can suspend administrators');
    if (body.reportId) {
      const rep = await c.var.db.query.reports.findFirst({ where: eq(schema.reports.id, body.reportId), columns: { targetUserId: true } });
      if (rep?.targetUserId !== id) fail(400, 'bad_request', 'the report is not about this member');
    }
    if (target.status !== 'active') {
      // Asked again for a member already suspended (after a request that failed half way, or by a second administrator):
      // the tables are asked once more, since only they end the connections and seats a suspension leaves open. The
      // rest (status, notice, record) is not repeated.
      if (preview) fail(409, 'already_suspended', 'this member is already suspended');
      await alreadySuspended(c, id);
    }
    if (preview) {
      return c.json({ preview: true, member: { nickname: target.nickname, role: target.role, status: target.status }, ...(await sanctionPreview(c.env.DB, id)) });
    }
    const { reason } = SuspendSchema.parse(body);
    const at = Date.now();
    // Only an active account changes, so of two administrators suspending at once one does it (one reason, one notice,
    // one record) and the other is told it was already done.
    const [changed] = await c.var.db.batch([
      c.var.db
        .update(schema.users)
        .set({ status: 'suspended', suspendedReason: reason, updatedAt: at })
        .where(and(eq(schema.users.id, id), eq(schema.users.status, 'active')))
        .returning({ id: schema.users.id }),
      c.var.db.delete(schema.sessions).where(eq(schema.sessions.userId, id)),
    ]);
    if (!changed[0]) await alreadySuspended(c, id);
    // Deleting the sessions does not reach table connections already open: each room ends them and the member leaves
    // their seats (in a hand: folded on their turn, cashed out when it settles). The wallet itself refuses new buy-ins.
    // First of what follows the commit, so a later step that fails cannot leave the member playing.
    const kick = await kickEverywhere(c.env, id, 'suspended', true);
    signedOut(c, { user: id });
    if (body.reportId) {
      await c.var.db.insert(schema.reportEvents).values({ id: crypto.randomUUID(), reportId: body.reportId, actorId: c.var.user!.id, kind: 'sanction', toValue: 'user.suspend', body: reason, createdAt: at });
    }
    await sendMessages(c.var.db, { userIds: [id], category: 'sanction', ...notices(target.locale).suspended(reason), senderId: c.var.user!.id });
    await audit(c, 'user.suspend', { type: 'user', id }, { ...body, from: target.status, to: 'suspended', previousReason: target.suspendedReason, kick });
    return c.json({ ok: true, kick });
  })
  /**
   * Ends a member's sign-ins and table connections without suspending them (they can sign in again). With
   * `removeFromTable` they also leave their seats and waitlists the way a suspension does.
   */
  .post('/users/:id/disconnect', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? DisconnectSchema.partial({ reason: true }) : DisconnectSchema);
    if (id === c.var.user!.id) fail(400, 'bad_request', 'cannot disconnect yourself');
    const found = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { role: true, nickname: true, status: true, isBot: true } });
    if (!found) fail(404, 'not_found', 'user not found');
    refuseBot(found);
    const { isBot: _bot, ...target } = found;
    if (target.role !== 'user' && !can(c.var.user!.role, 'admins.manage')) fail(403, 'forbidden', 'only a super admin can disconnect administrators');
    if (preview) return c.json({ preview: true, member: target, removeFromTable: body.removeFromTable, ...(await sanctionPreview(c.env.DB, id)) });
    const ended = await c.var.db.delete(schema.sessions).where(eq(schema.sessions.userId, id)).returning({ kind: schema.sessions.kind });
    const kick = await kickEverywhere(c.env, id, 'disconnected', body.removeFromTable);
    signedOut(c, { user: id });
    await audit(c, 'user.disconnect', { type: 'user', id }, { ...body, sessions: ended.length, kick });
    return c.json({ ok: true, sessions: ended.length, kick });
  })
  .post('/users/:id/unsuspend', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, z.object({ reason: preview ? ReasonSchema.optional() : ReasonSchema }));
    const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { role: true, locale: true, status: true, suspendedReason: true, nickname: true, isBot: true } });
    if (!target) fail(404, 'not_found', 'user not found');
    refuseBot(target);
    if (target.role !== 'user' && !can(c.var.user!.role, 'admins.manage')) fail(403, 'forbidden', 'only a super admin can unsuspend administrators');
    if (preview) {
      return c.json({ preview: true, member: { nickname: target.nickname, role: target.role }, from: target.status, to: target.status === 'suspended' ? 'active' : target.status, suspendedReason: target.suspendedReason });
    }
    const lifted = await c.var.db
      .update(schema.users)
      .set({ status: 'active', suspendedReason: null, updatedAt: Date.now() })
      .where(and(eq(schema.users.id, id), eq(schema.users.status, 'suspended')))
      .returning({ id: schema.users.id });
    if (lifted[0]) await sendMessages(c.var.db, { userIds: [id], category: 'sanction', ...notices(target.locale).unsuspended(), senderId: c.var.user!.id });
    // The suspension's own reason is cleared from the account, so the record keeps it next to the reason for lifting it.
    await audit(c, 'user.unsuspend', { type: 'user', id }, { reason: body.reason, from: target.status, to: lifted[0] ? 'active' : target.status, suspendedReason: target.suspendedReason });
    return c.json({ ok: true });
  })
  /** Super admins (the rule). `preview`: the change, the console sessions it ends and the abilities gained or lost. */
  .post('/users/:id/role', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? RoleSchema.partial({ reason: true }) : RoleSchema);
    if (id === c.var.user!.id) fail(400, 'bad_request', 'cannot change your own role');
    const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id) });
    if (!target || target.status !== 'active') fail(404, 'not_found', 'active user not found');
    refuseBot(target);
    // A plain administrator's feature switches belong to that role: any role change clears them, so a new (or returning)
    // administrator starts with every feature off until a super admin turns some on.
    const switches = await c.var.db.query.adminPermissions.findFirst({ where: eq(schema.adminPermissions.userId, id), columns: { grants: true } });
    const cleared = parseGrants(switches?.grants);
    if (preview) {
      const sessions = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1 AND kind = 'admin' AND expires_at > ?2`).bind(id, Date.now()).first<{ n: number }>();
      const before = capabilitiesOf(target.role);
      const after = capabilitiesOf(body.role);
      return c.json({
        preview: true,
        member: { nickname: target.nickname, status: target.status },
        from: target.role,
        to: body.role,
        console: { from: target.role !== 'user', to: body.role !== 'user' },
        // Saving ends the member's console sessions; the new role applies from their next sign-in.
        adminSessions: sessions?.n ?? 0,
        capabilities: { gained: after.filter((k) => !before.includes(k)), lost: before.filter((k) => !after.includes(k)) },
        // The feature switches turned off by the change ([] when none were on); a new plain administrator has none.
        grantsCleared: cleared,
        // A VIP member made staff stops being VIP (staff never are): the color it ends, else null.
        vipCleared: body.role !== 'user' ? (target.vipColor ?? null) : null,
      });
    }
    // Role changes take effect immediately: drop existing admin sessions of the target, and the switches with the role.
    // Staff are never VIP, so a VIP member made staff loses it (and does not get it back with the role). The VIP state is
    // read and ended in the same transaction as the role, so a grant saved after `target` was read is ended too, and the
    // record names the color that was actually there.
    const now = Date.now();
    const staff = body.role !== 'user';
    const vipNow = c.var.db.select({ color: schema.users.vipColor, version: schema.users.vipVersion }).from(schema.users).where(eq(schema.users.id, id));
    const setRole = c.var.db.update(schema.users).set({ role: body.role, updatedAt: now }).where(eq(schema.users.id, id));
    const endVip = c.var.db
      .update(schema.users)
      .set({ vipColor: null, vipVersion: sql`${schema.users.vipVersion} + 1`, vipChangedAt: now, vipChangedBy: c.var.user!.id })
      .where(and(eq(schema.users.id, id), isNotNull(schema.users.vipColor)));
    const dropSessions = c.var.db.delete(schema.sessions).where(and(eq(schema.sessions.userId, id), eq(schema.sessions.kind, 'admin')));
    const dropSwitches = c.var.db.delete(schema.adminPermissions).where(eq(schema.adminPermissions.userId, id));
    const [vipBefore] = staff
      ? await c.var.db.batch([vipNow, endVip, setRole, dropSessions, dropSwitches])
      : await c.var.db.batch([vipNow, setRole, dropSessions, dropSwitches]);
    const vipEnded = staff && vipBefore[0]?.color ? vipBefore[0] : null;
    await audit(c, 'user.role', { type: 'user', id }, { from: target.role, to: body.role, reason: body.reason });
    if (switches) await audit(c, 'admin.grants.reset', { type: 'user', id }, { before: cleared, after: [], reason: body.reason, cause: 'role', from: target.role, to: body.role });
    if (vipEnded) await audit(c, 'user.vip', { type: 'user', id }, { from: vipEnded.color, to: null, reason: body.reason, cause: 'role', role: body.role, version: vipEnded.version + 1 });
    // The staff badge other players see at the tables where the member sits.
    const tables = await refreshRoleEverywhere(c.env, id, body.role);
    return c.json({ ok: true, tables });
  })
  /**
   * `preview` (the same body, idempotency key included): the balance before and after, whether it is a large
   * adjustment and whether this key was already applied. Refused the same way, but a refused preview is not listed with
   * the refused adjustments (the attempt is on the audit log as `user.chips.failed`).
   *
   * `refLedgerId`: the member's own transaction this adjustment corrects (a free refill paid in error): kept as the
   * adjustment's `ref_id` and in the audit row, so the original is never edited and the two stay linked.
   */
  .post('/users/:id/chips', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, ChipAdjustSchema);
    const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { role: true, locale: true, nickname: true, status: true, balance: true, isBot: true } });
    const role = c.var.user!.role;
    // A refused adjustment is audited too: the economy page lists them.
    const refuse = async (reason: string, status: 403 | 409, code: string, message: string): Promise<never> => {
      if (!preview) await audit(c, 'user.chips_refused', { type: 'user', id }, { reason, amount: body.amount, memo: body.memo }, 'failed');
      fail(status, code, message);
    };
    // A bot's chips come only from the bot fund and its play (the fund's total must stay its issuance).
    if (target?.isBot) await refuse('bot_account', 409, 'bot_account', 'table bot accounts are managed from the bots page');
    if (target && target.role !== 'user' && !can(role, 'admins.manage')) await refuse('forbidden', 403, 'forbidden', 'only a super admin can adjust chips of administrators');
    if (Math.abs(body.amount) >= LARGE_ADJUSTMENT && !can(role, 'chips.large')) await refuse('large_adjustment', 403, 'large_adjustment', `only a super admin can adjust ${LARGE_ADJUSTMENT} chips or more at once`);
    const ref = body.refLedgerId
      ? await c.env.DB.prepare(`SELECT id, type, amount, created_at AS createdAt FROM chip_ledger WHERE id = ?1 AND user_id = ?2`)
          .bind(body.refLedgerId, id)
          .first<{ id: string; type: string; amount: number; createdAt: number }>()
      : null;
    if (body.refLedgerId && !ref) fail(400, 'ref_not_found', 'the linked transaction is not one of this member\'s');
    if (preview) {
      const done = await c.env.DB.prepare(`SELECT 1 AS x FROM chip_ledger WHERE idempotency_key = ?1`).bind(`admin:${body.idempotencyKey}`).first();
      if (!target || (!done && target.balance + body.amount < 0)) await refuse('insufficient_balance', 409, 'insufficient_balance', 'adjustment would make the balance negative (or user not found)');
      return c.json({
        preview: true,
        member: { nickname: target!.nickname, role: target!.role, status: target!.status },
        amount: body.amount,
        balanceBefore: target!.balance,
        balanceAfter: done ? target!.balance : target!.balance + body.amount,
        large: Math.abs(body.amount) >= LARGE_ADJUSTMENT,
        duplicate: !!done,
        ref,
      });
    }
    const r = await applyLedger(c.env.DB, {
      userId: id,
      type: 'admin_adjust',
      amount: body.amount,
      idempotencyKey: `admin:${body.idempotencyKey}`,
      actorId: c.var.user!.id,
      memo: body.memo,
      refId: ref?.id ?? null,
    });
    if (r.status === 'insufficient') return refuse('insufficient_balance', 409, 'insufficient_balance', 'adjustment would make the balance negative (or user not found)');
    // The same request again (a retry, a double click): nothing changed, and that is on record.
    if (r.status === 'duplicate') await audit(c, 'user.chips_duplicate', { type: 'user', id }, { amount: body.amount, memo: body.memo, ledgerId: r.ledgerId, ...(ref ? { refLedgerId: ref.id } : {}) });
    if (r.status === 'applied') {
      await sendMessages(c.var.db, {
        userIds: [id],
        category: body.amount > 0 ? 'event' : 'admin',
        ...notices(target?.locale).chips(body.amount, body.memo, r.balanceAfter),
        senderId: c.var.user!.id,
      });
      await audit(c, 'user.chips', { type: 'user', id }, { amount: body.amount, memo: body.memo, ledgerId: r.ledgerId, ...(ref ? { refLedgerId: ref.id, refType: ref.type } : {}) });
    }
    return c.json({ ok: true, duplicate: r.status === 'duplicate', balanceAfter: r.balanceAfter });
  })
  /**
   * Issues a one-time password reset link. With mail configured it is also mailed to the
   * member; either way the response carries the link and a copy-ready message in the member's language.
   */
  .post('/users/:id/reset-link', async (c) => {
    const id = c.req.param('id');
    if (id === c.var.user!.id) fail(400, 'bad_request', 'use the change-password flow for your own account');
    const u = await c.var.db.query.users.findFirst({ where: and(eq(schema.users.id, id), eq(schema.users.status, 'active')) });
    if (!u) fail(404, 'not_found', 'user not found');
    refuseBot(u);
    // A reset link is an account takeover token: plain admins may only issue them for members.
    if (u.role !== 'user' && !can(c.var.user!.role, 'admins.manage')) fail(403, 'forbidden', 'only a super admin can issue reset links for administrators');
    const token = randomToken();
    await c.var.db.insert(schema.passwordResets).values({ tokenHash: await sha256(token), userId: id, expiresAt: Date.now() + 30 * 60 * 1000 });
    const path = `/reset?token=${encodeURIComponent(token)}`;
    const origin = c.env.APP_ORIGIN ?? '';
    const message = passwordResetMail({ locale: u.locale, nickname: u.nickname, link: `${origin}${path}`, origin, minutes: 30 });
    const mailed = mailEnabled(c.env);
    if (mailed) c.executionCtx.waitUntil(sendMail(c.env, { to: u.email, ...message }).catch((e) => console.error('admin reset mail failed', e)));
    await audit(c, 'user.reset_link', { type: 'user', id }, { mailed });
    return c.json({ path, url: `${origin}${path}`, expiresInMinutes: 30, locale: u.locale, mailed, message: { subject: message.subject, text: message.text } });
  })
  // ---------------------------------------------------------------- tables
  /**
   * Tables, newest first. Without `paged=1` every table as a plain array, as before. With it: `q` (part of the name, or
   * the exact id), `status` (open | closing | closed, or active = not closed), `roomType` (official | member | tournament), `issue=1`
   * (a last issue recorded), `limit` / `offset`, and the number of matching tables.
   */
  .get('/tables', async (c) => {
    const T = schema.tables;
    const paged = c.req.query('paged') === '1';
    const q = paged ? (c.req.query('q') ?? '').trim().slice(0, 64) : '';
    const status = c.req.query('status');
    const roomType = c.req.query('roomType');
    const where = paged
      ? and(
          q ? or(like(T.name, `%${q}%`), eq(T.id, q)) : undefined,
          status === 'open' || status === 'closing' || status === 'closed' ? eq(T.status, status) : status === 'active' ? ne(T.status, 'closed') : undefined,
          roomType === 'official' || roomType === 'member' || roomType === 'tournament' ? eq(T.roomType, roomType) : undefined,
          c.req.query('issue') === '1' ? isNotNull(T.lastIssue) : undefined,
        )
      : undefined;
    const { limit, offset } = page(c);
    const base = c.var.db
      .select({ t: T, host: schema.users.nickname })
      .from(T)
      .leftJoin(schema.users, eq(schema.users.id, T.createdBy))
      .where(where)
      .orderBy(desc(T.createdAt), T.id);
    const rows = paged ? await base.limit(limit).offset(offset) : await base;
    const items = rows.map(({ t: { joinCodeHash, ...t }, host }) => ({ ...t, hasJoinCode: !!joinCodeHash, hostNickname: t.roomType === 'member' ? host : null }));
    if (!paged) return c.json(items);
    const [count] = await c.var.db.select({ n: sql<number>`COUNT(*)` }).from(T).where(where);
    return c.json({ items, total: count?.n ?? 0, limit, offset });
  })
  .post('/tables', async (c) => {
    const body = await parseBody(c, TableInputSchema);
    const id = crypto.randomUUID().slice(0, 12);
    await c.var.db.insert(schema.tables).values({
      id,
      name: body.name,
      maxSeats: body.maxSeats,
      smallBlind: body.smallBlind,
      bigBlind: body.bigBlind,
      minBuyIn: body.minBuyIn,
      maxBuyIn: body.maxBuyIn,
      turnSeconds: body.turnSeconds,
      isPrivate: body.isPrivate,
      joinCodeHash: body.isPrivate && body.joinCode ? await sha256(`${id}:${body.joinCode}`) : null,
      allowSpectators: body.allowSpectators,
      beginner: body.beginner,
      botsEnabled: body.botsEnabled,
      botLevel: body.botLevel,
      botMinHumans: body.botMinHumans,
      botMax: body.botMax,
      botFillTo: body.botFillTo,
      botYield: body.botYield,
      createdBy: c.var.user!.id,
    });
    await audit(c, 'table.create', { type: 'table', id }, { ...body, joinCode: body.joinCode ? '***' : undefined });
    return c.json({ id }, 201);
  })
  .get('/tables/:id', async (c) => {
    const id = c.req.param('id');
    const t = await c.var.db.query.tables.findFirst({ where: eq(schema.tables.id, id) });
    if (!t) fail(404, 'not_found', 'table not found');
    const live = t.status === 'closed' ? null : await roomCall(c, id, 'status');
    const { joinCodeHash, ...rest } = t;
    const tournament =
      t.roomType === 'tournament' ? await c.env.DB.prepare('SELECT id, name, status FROM tournaments WHERE table_id = ?1').bind(id).first<{ id: string; name: string; status: string }>() : null;
    // The live status never includes hole cards or deck information.
    return c.json({ table: { ...rest, hasJoinCode: !!joinCodeHash }, live, diagnosis: live ? await diagnose(c.env.DB, t, live) : null, tournament });
  })
  /**
   * Emergency controls, each confirmed by the room before the admin is told it took effect: `pause` deals no new hand
   * (the running one finishes normally), `block` takes no new players (seated players stay). To close the table and pay
   * everyone out, use /close.
   */
  .post('/tables/:id/control', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, TableControlSchema);
    const t = await c.var.db.query.tables.findFirst({ where: eq(schema.tables.id, id) });
    if (!t || t.status === 'closed') fail(404, 'not_found', 'table not found');
    // A tournament's table is run by its tournament (routes/admin-tournaments.ts: pause, resume, stop), not as a cash table.
    if (t.roomType === 'tournament') fail(409, 'tournament_table', 'a tournament table is controlled from its tournament');
    const set =
      body.action === 'pause' || body.action === 'resume' ? { handsPaused: body.action === 'pause' } : { entryBlocked: body.action === 'block' };
    await c.var.db.update(schema.tables).set({ ...set, updatedAt: Date.now() }).where(eq(schema.tables.id, id));
    const live = (await roomCall(c, id, 'reload')) ?? (await roomCall(c, id, 'reload'));
    await audit(c, 'table.control', { type: 'table', id }, { ...body, roomConfirmed: !!live, handInProgress: live?.handInProgress ?? null });
    // The row is saved either way: a room that did not answer takes it on when it next loads, and sending it again is safe.
    if (!live) fail(503, 'room_unavailable', 'saved, but the table did not confirm; try again', { saved: true });
    return c.json({ ok: true, paused: !!live.paused, handInProgress: !!live.handInProgress });
  })
  .patch('/tables/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, TablePatchSchema);
    // Blocking entry is a table control (POST /tables/:id/control asks for the password again); this route does not
    // become a way around that, nor around its switch (tableControl). Other settings need neither.
    if (body.entryBlocked !== undefined) {
      if (!(await hasGrant(c, 'tableControl'))) fail(403, 'permission_off', 'this feature is turned off for your account');
      assertRecentReauth(c);
    }
    const T = schema.tables;
    const botFields = (['botsEnabled', 'botLevel', 'botMinHumans', 'botMax', 'botFillTo', 'botYield'] as const).filter((k) => body[k] !== undefined);
    const joinCodeHash = body.joinCode ? await sha256(`${id}:${body.joinCode}`) : null;
    const conflict = (now: { updatedAt: number } | undefined): never => fail(409, 'table_conflict', 'the table changed meanwhile', { updatedAt: now?.updatedAt ?? null });
    // The row is written only if every column this sets still holds what was read, and the status too: a change another
    // administrator made in between (a block from /control, another edit, a close) is never overwritten with what this
    // request read. The body names only what it changes, so it is merged onto a fresh read and tried again. With
    // `ifUpdatedAt` (the console sends what it was showing) any change since then is a conflict instead.
    const save = async () => {
      for (let attempt = 0; ; attempt++) {
        if (attempt === 3) conflict(await c.var.db.query.tables.findFirst({ where: eq(T.id, id) }));
        const r = await c.var.db.query.tables.findFirst({ where: eq(T.id, id) });
        if (!r || r.status === 'closed') fail(404, 'not_found', 'table not found');
        // A tournament's table is run by its tournament (routes/admin-tournaments.ts: pause, resume, stop), not as a cash table.
        if (r.roomType === 'tournament') fail(409, 'tournament_table', 'a tournament table is controlled from its tournament');
        if (body.ifUpdatedAt !== undefined && body.ifUpdatedAt !== r.updatedAt) conflict(r);
        const merged = { sb: body.smallBlind ?? r.smallBlind, bb: body.bigBlind ?? r.bigBlind, min: body.minBuyIn ?? r.minBuyIn, max: body.maxBuyIn ?? r.maxBuyIn };
        if (merged.bb < merged.sb || merged.min < merged.bb * 10 || merged.max < merged.min) fail(400, 'bad_request', 'invalid blind / buy-in combination');
        const isPrivate = body.isPrivate ?? r.isPrivate;
        const code = body.joinCode !== undefined ? joinCodeHash : r.joinCodeHash;
        if (isPrivate && !code) fail(400, 'bad_request', 'private tables need a join code');
        const bots = {
          botsEnabled: body.botsEnabled ?? r.botsEnabled,
          botLevel: body.botLevel ?? r.botLevel,
          botMinHumans: body.botMinHumans ?? r.botMinHumans,
          botMax: body.botMax ?? r.botMax,
          botFillTo: body.botFillTo ?? r.botFillTo,
          botYield: body.botYield ?? r.botYield,
        };
        // Table bots sit only at official tables; a member's room is theirs and other members'.
        if (botFields.length && r.roomType !== 'official') fail(400, 'bad_request', 'member rooms have no table bots');
        const botIssue = botFields.length ? botSettingsIssues(bots, r.maxSeats)[0] : undefined;
        if (botIssue) fail(400, 'bad_request', botIssue.message);
        const saved = await c.var.db
          .update(T)
          .set({
            name: body.name ?? r.name,
            smallBlind: merged.sb,
            bigBlind: merged.bb,
            minBuyIn: merged.min,
            maxBuyIn: merged.max,
            isPrivate,
            joinCodeHash: isPrivate ? code : null,
            allowSpectators: body.allowSpectators ?? r.allowSpectators,
            beginner: body.beginner ?? r.beginner,
            entryBlocked: body.entryBlocked ?? r.entryBlocked,
            ...bots,
            // Always later than what was read, so a form loaded before this change sees it as one.
            updatedAt: Math.max(Date.now(), r.updatedAt + 1),
          })
          .where(
            and(
              eq(T.id, id),
              eq(T.status, r.status),
              eq(T.updatedAt, r.updatedAt),
              eq(T.name, r.name),
              eq(T.smallBlind, r.smallBlind),
              eq(T.bigBlind, r.bigBlind),
              eq(T.minBuyIn, r.minBuyIn),
              eq(T.maxBuyIn, r.maxBuyIn),
              eq(T.isPrivate, r.isPrivate),
              r.joinCodeHash === null ? isNull(T.joinCodeHash) : eq(T.joinCodeHash, r.joinCodeHash),
              eq(T.allowSpectators, r.allowSpectators),
              eq(T.beginner, r.beginner),
              eq(T.entryBlocked, r.entryBlocked),
              eq(T.botsEnabled, r.botsEnabled),
              eq(T.botLevel, r.botLevel),
              eq(T.botMinHumans, r.botMinHumans),
              eq(T.botMax, r.botMax),
              eq(T.botFillTo, r.botFillTo),
              eq(T.botYield, r.botYield),
            ),
          )
          .returning({ id: T.id });
        if (saved.length) return r;
      }
    };
    const t = await save();
    // Blind changes apply from the next hand; the running hand keeps its config. Bot settings apply at once without
    // touching the running hand: a bot over the new limits stands up after it, and a bot that sits down meanwhile is dealt
    // in from the next one. A room that does not confirm keeps its old settings (entry blocking included) until it
    // reloads, so the admin is told to send the change again.
    const live = (await roomCall(c, id, 'reload')) ?? (await roomCall(c, id, 'reload'));
    await audit(
      c,
      'table.update',
      { type: 'table', id },
      {
        ...body,
        joinCode: body.joinCode ? '***' : body.joinCode,
        ...(botFields.length ? { botsBefore: Object.fromEntries(botFields.map((k) => [k, t[k]])) } : {}),
        roomConfirmed: !!live,
      },
    );
    if (!live) fail(503, 'room_unavailable', 'saved, but the table did not confirm; try again', { saved: true });
    return c.json({ ok: true, appliesFrom: live.appliesFrom ?? 'next hand' });
  })
  /** `preview`: who is seated with how many chips, and whether a hand is running (it finishes before the close). */
  .post('/tables/:id/close', async (c) => {
    const id = c.req.param('id');
    const t = await c.var.db.query.tables.findFirst({ where: eq(schema.tables.id, id) });
    if (!t || t.status === 'closed') fail(404, 'not_found', 'table not found');
    // A tournament's table is run by its tournament (routes/admin-tournaments.ts: pause, resume, stop), not as a cash table.
    if (t.roomType === 'tournament') fail(409, 'tournament_table', 'a tournament table is controlled from its tournament');
    if (await isPreview(c)) {
      const live = await roomCall(c, id, 'status');
      const { results: open } = await c.env.DB.prepare(
        `SELECT s.user_id AS userId, u.nickname, s.seat_index AS seatIndex, s.buy_in AS buyIn FROM table_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.table_id = ?1 AND s.status = 'seated' ORDER BY s.seat_index`,
      )
        .bind(id)
        .all<{ userId: string; nickname: string | null; seatIndex: number; buyIn: number }>();
      const stacks = new Map(((live?.seats as ({ userId: string; stack: number; inHand: boolean } | null)[] | undefined) ?? []).filter((s) => !!s).map((s) => [s!.userId, s!]));
      return c.json({
        preview: true,
        table: { id, name: t.name, status: t.status, roomType: t.roomType },
        // A stack is the room's (null when it did not answer); the buy-in is what the seat's session holds in D1.
        seats: open.map((s) => ({ ...s, stack: stacks.get(s.userId)?.stack ?? null, inHand: stacks.get(s.userId)?.inHand ?? null })),
        chipsOnTable: typeof live?.chipsOnTable === 'number' ? live.chipsOnTable : null,
        handInProgress: live ? !!live.handInProgress : null,
        waitlist: typeof live?.waitlist === 'number' ? live.waitlist : null,
        roomAnswered: !!live,
      });
    }
    // Stop new hands; the room finishes the current hand, cashes everyone out, then marks the table closed.
    await c.var.db.update(schema.tables).set({ status: 'closing', entryBlocked: true, updatedAt: Date.now() }).where(eq(schema.tables.id, id));
    // If the room cannot be reached the table stays 'closing' (no one can join) and the room finishes the close when it
    // next loads; the admin is told to retry, which is safe.
    const live = (await roomCall(c, id, 'close')) ?? (await roomCall(c, id, 'close'));
    await audit(c, 'table.close', { type: 'table', id }, live ?? { roomConfirmed: false });
    if (!live) fail(503, 'room_unavailable', 'the table did not confirm the close; try again');
    return c.json({ ok: true, live });
  })
  // ---------------------------------------------------------------- audit: hands, ledger, actions
  .get('/hands', async (c) => {
    if (c.req.query('paged') === '1') return handsPage(c);
    const { limit, offset } = page(c);
    const tableId = c.req.query('tableId');
    const userId = c.req.query('userId');
    let handIds: string[] | null = null;
    if (userId) {
      const r = await c.var.db.select({ id: schema.handPlayers.handId }).from(schema.handPlayers).where(eq(schema.handPlayers.userId, userId)).orderBy(desc(schema.handPlayers.endedAt)).limit(limit).offset(offset);
      handIds = r.map((x) => x.id);
      if (handIds.length === 0) return c.json([]);
    }
    const rows = await c.var.db
      .select({ id: schema.hands.id, tableId: schema.hands.tableId, handNumber: schema.hands.handNumber, startedAt: schema.hands.startedAt, endedAt: schema.hands.endedAt, board: schema.hands.board, potTotal: schema.hands.potTotal })
      .from(schema.hands)
      .where(and(tableId ? eq(schema.hands.tableId, tableId) : undefined, handIds ? inArray(schema.hands.id, handIds) : undefined))
      .orderBy(desc(schema.hands.endedAt))
      .limit(limit)
      .offset(handIds ? 0 : offset);
    return c.json(rows.map((r) => ({ ...r, board: JSON.parse(r.board) as string[] })));
  })
  /**
   * Full record of a FINISHED hand incl. every player's hole cards and the
   * engine log. Hands are only written once settled, so live hidden state can
   * never be read here. Requires re-auth and is audited.
   */
  .get('/hands/:id', async (c) => {
    const id = c.req.param('id');
    const h = await c.var.db.query.hands.findFirst({ where: eq(schema.hands.id, id) });
    if (!h) fail(404, 'not_found', 'hand not found');
    const players = await c.var.db
      .select({ hp: schema.handPlayers, nickname: schema.users.nickname })
      .from(schema.handPlayers)
      .innerJoin(schema.users, eq(schema.users.id, schema.handPlayers.userId))
      .where(eq(schema.handPlayers.handId, id));
    const log = JSON.parse(h.eventLog) as { actions: unknown[]; engine: string };
    await audit(c, 'hand.view_sensitive', { type: 'hand', id });
    return c.json({
      hand: { id: h.id, tableId: h.tableId, handNumber: h.handNumber, startedAt: h.startedAt, endedAt: h.endedAt, board: JSON.parse(h.board), potTotal: h.potTotal, engineVersion: h.engineVersion },
      actions: log.actions,
      engineLogGzipBase64: log.engine,
      players: players.map(({ hp, nickname }) => ({
        userId: hp.userId,
        nickname,
        seatIndex: hp.seatIndex,
        holeCards: JSON.parse(hp.holeCards),
        stackStart: hp.stackStart,
        stackEnd: hp.stackEnd,
        net: hp.net,
        won: hp.won,
        rankClass: hp.rankClass,
        bestFive: hp.bestFive ? JSON.parse(hp.bestFive) : null,
        wentToShowdown: hp.wentToShowdown,
      })),
      settlementBalanced: players.reduce((a, p) => a + p.hp.net, 0) === 0,
    });
  })
  .get('/ledger', async (c) => {
    if (c.req.query('paged') === '1') return ledgerPage(c);
    const { limit, offset } = page(c);
    const userId = c.req.query('userId');
    const type = c.req.query('type');
    const rows = await c.var.db
      .select({ l: schema.chipLedger, nickname: schema.users.nickname })
      .from(schema.chipLedger)
      .innerJoin(schema.users, eq(schema.users.id, schema.chipLedger.userId))
      .where(and(userId ? eq(schema.chipLedger.userId, userId) : undefined, type ? eq(schema.chipLedger.type, type as 'buy_in') : undefined))
      .orderBy(desc(schema.chipLedger.createdAt))
      .limit(limit)
      .offset(offset);
    await audit(c, 'ledger.view', userId ? { type: 'user', id: userId } : undefined, { q: userId ?? null, type: type ?? null, offset, count: rows.length });
    return c.json(rows.map((r) => ({ ...r.l, nickname: r.nickname })));
  })
  /**
   * The audit log, newest first. Super admins read every administrator's entries; others read their own (`scope`).
   * Without `paged=1`: the plain array of before (`limit`, `offset`). With it: filters `actor`, `action` (exact, or
   * `user.*` for a family), `outcome` (ok | failed), `targetType` and `targetId`, `from` / `to` (ms), `q` (2–50
   * characters in the detail, or a target id); pages go back from the last entry shown (`before`, `beforeId`), and the
   * first page counts the matches up to AUDIT_COUNT_CAP.
   */
  .get('/audit', async (c) => {
    const self = c.var.user!;
    const all = can(self.role, 'audit.all');
    if (c.req.query('paged') !== '1') {
      const { limit, offset } = page(c);
      const rows = await c.var.db
        .select({ a: schema.adminAuditLog, nickname: schema.users.nickname })
        .from(schema.adminAuditLog)
        .leftJoin(schema.users, eq(schema.users.id, schema.adminAuditLog.actorId))
        .where(all ? undefined : eq(schema.adminAuditLog.actorId, self.id))
        .orderBy(desc(schema.adminAuditLog.createdAt))
        .limit(limit)
        .offset(offset);
      return c.json(rows.map((r) => ({ ...r.a, actor: r.nickname, detail: r.a.detail ? JSON.parse(r.a.detail) : null })));
    }
    const q = (k: string, max = 64) => (c.req.query(k) ?? '').trim().slice(0, max) || undefined;
    const ms = (k: string) => (Number.isFinite(Number(c.req.query(k))) && Number(c.req.query(k)) > 0 ? Number(c.req.query(k)) : undefined);
    const outcome = c.req.query('outcome');
    const before = ms('before');
    const text = q('q', 50);
    const result = await searchAudit(c.env.DB, {
      actor: all ? q('actor') : self.id,
      action: q('action'),
      outcome: outcome === 'ok' || outcome === 'failed' ? outcome : undefined,
      targetType: q('targetType', 32),
      targetId: q('targetId'),
      from: ms('from'),
      to: ms('to'),
      q: text && text.length >= 2 ? text : undefined,
      before,
      beforeId: q('beforeId'),
      limit: Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100),
      count: before === undefined,
    });
    return c.json({ ...result, scope: all ? 'all' : 'own', countCap: AUDIT_COUNT_CAP });
  })
  // ---------------------------------------------------------------- chip economy
  /**
   * The chip economy over the last 7, 30 or 90 days, cut at the viewer's midnight (`tz` as on member activity): wallet
   * and table totals, issuance, movement per day, failures and transactions worth a look. Read when the page is opened
   * (the console does not poll it); nothing here changes a wallet.
   */
  .get('/economy', async (c) => {
    const days = [7, 30, 90].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 7;
    const tz = Math.min(Math.max(Math.trunc(Number(c.req.query('tz') ?? 0)) || 0, -840), 840);
    const at = Date.now();
    const out = await economy(c.env.DB, days, tz, at);
    return c.json({ ...out, at, d1Ms: Date.now() - at });
  })
  // ---------------------------------------------------------------- reconciliation
  /**
   * Detects wallets whose balance differs from the sum of their ledger, and tables whose open sessions differ from the
   * seats their room holds, and records an event for each new mismatch. A mismatch is its difference (wallet − ledger,
   * room seats − sessions): while that stays the same it is the same mismatch, even as the member keeps playing (balance
   * and ledger move together), so it gets no second event while one is open, nor after an administrator acknowledged it
   * with a note (`acknowledged` counts those). Balances are never "fixed" silently: an admin resolves each event.
   */
  .post('/reconcile/run', async (c) => {
    const ev = schema.reconciliationEvents;
    const mismatches = await findLedgerMismatches(c.env.DB);
    // Open events, and wallet events acknowledged with a note (NULL: resolved before resolutions were kept, by a note).
    const known = await c.var.db
      .select({ scope: ev.scope, subjectId: ev.subjectId, expected: ev.expected, actual: ev.actual, resolvedAt: ev.resolvedAt })
      .from(ev)
      .where(or(isNull(ev.resolvedAt), and(eq(ev.scope, 'user_ledger'), or(isNull(ev.resolution), eq(ev.resolution, 'note')))));
    const key = (scope: string, subject: string, difference: number) => `${scope}:${subject}:${difference}`;
    const open = new Set(known.filter((e) => !e.resolvedAt).map((e) => key(e.scope, e.subjectId, e.actual - e.expected)));
    const acked = new Set(known.filter((e) => e.resolvedAt).map((e) => key(e.scope, e.subjectId, e.actual - e.expected)));
    let created = 0;
    let acknowledged = 0;
    for (const m of mismatches) {
      const k = key('user_ledger', m.userId, m.balance - m.ledgerSum);
      if (open.has(k)) continue;
      if (acked.has(k)) {
        acknowledged++;
        continue;
      }
      await c.var.db.insert(ev).values({ id: crypto.randomUUID(), scope: 'user_ledger', subjectId: m.userId, expected: m.ledgerSum, actual: m.balance, detail: 'wallet balance != sum(chip_ledger)' });
      created++;
    }
    // Table-level: chips held at open seats vs. what the rooms report.
    const seated = await c.env.DB.prepare(`SELECT table_id AS tableId, SUM(buy_in) AS buyIns, COUNT(*) AS n FROM table_sessions WHERE status = 'seated' GROUP BY table_id`).all<{ tableId: string; buyIns: number; n: number }>();
    const tableReports: unknown[] = [];
    for (const row of seated.results) {
      const live = await roomCall(c, row.tableId, 'status');
      const liveSeats = ((live?.seats as ({ userId: string } | null)[] | undefined) ?? []).filter(Boolean).length;
      if (live && liveSeats !== row.n && !open.has(key('table', row.tableId, liveSeats - row.n))) {
        await c.var.db.insert(ev).values({ id: crypto.randomUUID(), scope: 'table', subjectId: row.tableId, expected: row.n, actual: liveSeats, detail: 'open table_sessions != seats held by the room' });
        created++;
      }
      tableReports.push({ tableId: row.tableId, openSessions: row.n, roomSeats: liveSeats, chipsOnTable: live?.chipsOnTable ?? null });
    }
    await audit(c, 'reconcile.run', undefined, { mismatches: mismatches.length, created, acknowledged });
    return c.json({ mismatches, created, acknowledged, tables: tableReports });
  })
  .get('/reconcile', async (c) => {
    const rows = await c.var.db.select().from(schema.reconciliationEvents).orderBy(desc(schema.reconciliationEvents.createdAt)).limit(200);
    return c.json(rows);
  })
  /**
   * One event with what an administrator needs to decide on it: for a wallet, the member, the ledger against the balance
   * and the rows where they part; for a table, the room against its open sessions (as on the table page).
   */
  .get('/reconcile/:id', async (c) => {
    const e = await c.var.db.query.reconciliationEvents.findFirst({ where: eq(schema.reconciliationEvents.id, c.req.param('id')) });
    if (!e) fail(404, 'not_found', 'event not found');
    if (e.scope === 'table') {
      const t = await c.var.db.query.tables.findFirst({ where: eq(schema.tables.id, e.subjectId) });
      const live = t && t.status !== 'closed' ? await roomCall(c, t.id, 'status') : null;
      return c.json({
        event: e,
        table: t ? { id: t.id, name: t.name, status: t.status, entryBlocked: t.entryBlocked, handsPaused: t.handsPaused, lastIssue: t.lastIssue } : null,
        diagnosis: t && live ? await diagnose(c.env.DB, t, live) : null,
      });
    }
    return c.json({ event: e, ...(await walletEvidence(c.env.DB, e)) });
  })
  /**
   * Resolves an event. `note` (any administrator): acknowledged with a note; nothing changes, and the same difference is
   * not raised again. A wallet mismatch can instead be corrected by a super admin, in one transaction that holds only
   * while the difference is still the event's (409 reconcile_stale once it moved):
   * - `record`: a 'reconcile' ledger row for the difference; the wallet keeps its chips, which are now on record;
   * - `revert`: that row and a second one taking the difference back out (or in), so the wallet returns to what its
   *   ledger says; refused if the wallet would go below zero. The member is told their balance was corrected (the
   *   note stays internal).
   * A correction applies to an open event or one acknowledged with a note, once per event.
   */
  .post('/reconcile/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, z.object({ note: z.string().trim().min(2).max(300), action: z.enum(['note', 'record', 'revert']).default('note') }));
    const ev = schema.reconciliationEvents;
    if (body.action === 'note') {
      const r = await c.var.db
        .update(ev)
        .set({ resolvedBy: c.var.user!.id, resolvedAt: Date.now(), resolution: 'note', detail: sql`COALESCE(${ev.detail}, '') || ' | resolved: ' || ${body.note}` })
        .where(and(eq(ev.id, id), isNull(ev.resolvedAt)))
        .returning();
      if (!r[0]) fail(404, 'not_found', 'open event not found');
      await audit(c, 'reconcile.resolve', { type: 'reconciliation', id }, body);
      return c.json({ ok: true, action: body.action });
    }
    if (!can(c.var.user!.role, 'ledger.correct')) fail(403, 'forbidden', 'only a super admin can correct a wallet or the ledger');
    const e = await c.var.db.query.reconciliationEvents.findFirst({ where: eq(ev.id, id) });
    if (!e) fail(404, 'not_found', 'event not found');
    if (e.scope !== 'user_ledger') fail(400, 'bad_request', 'only a wallet mismatch can be corrected');
    if (e.resolvedAt && e.resolution && e.resolution !== 'note') fail(409, 'already_resolved', 'this event was already corrected');
    const difference = e.actual - e.expected;
    const DB = c.env.DB;
    const before = await DB.prepare(`SELECT balance, status, locale, (SELECT COALESCE(SUM(amount), 0) FROM chip_ledger WHERE user_id = ?1) AS ledgerSum FROM users WHERE id = ?1`)
      .bind(e.subjectId)
      .first<{ balance: number; status: string; locale: 'ko' | 'en'; ledgerSum: number }>();
    if (!before) fail(404, 'not_found', 'member not found');
    if (before.balance - before.ledgerSum !== difference) fail(409, 'reconcile_stale', 'the difference changed since this event was recorded; run reconciliation again');
    const revert = body.action === 'revert';
    if (revert && before.balance - difference < 0) fail(409, 'insufficient_balance', 'reverting would make the balance negative');
    const actor = c.var.user!.id;
    const recordId = crypto.randomUUID();
    const revertId = crypto.randomUUID();
    const keys = [`reconcile:${id}:record`, `reconcile:${id}:revert`] as const;
    // Every write holds only if the one before it happened: the record row only while the wallet is still off its ledger
    // by exactly this difference (and, to revert, the wallet can give it back), the revert row only after the record row,
    // the wallet only with the revert row, the event only with our last row. The keys make a second correction a no-op.
    const results = await DB.batch([
      DB.prepare(
        `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, ref_id, idempotency_key, actor_id, memo)
         SELECT ?1, id, 'reconcile', ?2, balance, ?3, ?4, ?5, 'recorded difference' FROM users
          WHERE id = ?6 AND balance - (SELECT COALESCE(SUM(amount), 0) FROM chip_ledger WHERE user_id = ?6) = ?2${revert ? ' AND balance - ?2 >= 0' : ''}
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).bind(recordId, difference, id, keys[0], actor, e.subjectId),
      ...(revert
        ? [
            DB.prepare(
              `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, ref_id, idempotency_key, actor_id, memo)
               SELECT ?1, id, 'reconcile', ?2, balance + ?2, ?3, ?4, ?5, 'balance corrected' FROM users
                WHERE id = ?6 AND EXISTS (SELECT 1 FROM chip_ledger WHERE id = ?7)
               ON CONFLICT(idempotency_key) DO NOTHING`,
            ).bind(revertId, -difference, id, keys[1], actor, e.subjectId, recordId),
            DB.prepare(`UPDATE users SET balance = balance + ?1, updated_at = (unixepoch('subsec') * 1000) WHERE id = ?2 AND EXISTS (SELECT 1 FROM chip_ledger WHERE id = ?3)`).bind(-difference, e.subjectId, revertId),
          ]
        : []),
      DB.prepare(
        `UPDATE reconciliation_events SET resolved_by = ?1, resolved_at = ?2, resolution = ?3, detail = COALESCE(detail, '') || ?4
          WHERE id = ?5 AND (resolution IS NULL OR resolution = 'note') AND EXISTS (SELECT 1 FROM chip_ledger WHERE id = ?6)`,
      ).bind(actor, Date.now(), body.action, ` | ${body.action}: ${body.note}`, id, revert ? revertId : recordId),
      DB.prepare(`SELECT id, idempotency_key AS idempotencyKey, amount, balance_after AS balanceAfter FROM chip_ledger WHERE idempotency_key IN (?1, ?2)`).bind(...keys),
      DB.prepare(`SELECT balance FROM users WHERE id = ?1`).bind(e.subjectId),
    ]);
    const rows = (results[results.length - 2]?.results ?? []) as { id: string; idempotencyKey: string; amount: number; balanceAfter: number }[];
    const balanceAfter = (results[results.length - 1]?.results[0] as { balance: number } | undefined)?.balance ?? null;
    const ledgerIds = rows.filter((r) => r.id === recordId || r.id === revertId).map((r) => r.id);
    if (!ledgerIds.length) {
      if (rows.length) fail(409, 'already_resolved', 'this event was already corrected');
      fail(409, 'reconcile_stale', 'the wallet changed while it was being corrected; open the event again');
    }
    if (revert && before.status !== 'deleted' && balanceAfter !== null) {
      await sendMessages(c.var.db, { userIds: [e.subjectId], category: 'admin', ...notices(before.locale).reconcileReverted(-difference, balanceAfter), senderId: actor });
    }
    await audit(c, 'user.reconcile', { type: 'user', id: e.subjectId }, { eventId: id, action: body.action, difference, note: body.note, ledgerIds, balanceBefore: before.balance, balanceAfter });
    return c.json({ ok: true, action: body.action, ledgerIds, balanceAfter });
  })
  // ---------------------------------------------------------------- academy (anonymous aggregates)
  .get('/academy/stats', async (c) => {
    const rows = await c.var.db.select().from(schema.academyStats);
    const out: AcademyStatRow[] = rows.map(({ kind, itemId, starts, completes, correct, wrong }) => ({ kind, itemId, starts, completes, correct, wrong }));
    return c.json(out);
  });

export const adminRoutes = new Hono<AppEnv>().route('/auth', adminAuthRoutes).route('/', admin.route('/', adminCommunityRoutes).route('/', adminReportRoutes).route('/', adminServiceRoutes).route('/', adminSecurityRoutes).route('/', adminStatsRoutes).route('/', adminRefillRoutes).route('/', adminBotRoutes).route('/', adminTimeBankRoutes).route('/', adminTournamentRoutes).route('/', adminReferralRoutes).route('/', adminSettingsRoutes).route('/', adminSocialRoutes).route('/', adminBrandRoutes).route('/', adminVipRoutes));
