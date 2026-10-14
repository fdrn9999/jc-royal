/**
 * Admin console API. Every route requires an admin session (requireAdmin);
 * sensitive mutations additionally require the password to have been
 * re-confirmed within the last minutes (requireRecentReauth). All changes are
 * written to admin_audit_log.
 */
import { applyLedger, findLedgerMismatches, schema } from '@jc/db';
import { ChipAdjustSchema, TableInputSchema, TablePatchSchema, type AcademyStatRow } from '@jc/types';
import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireAdmin, requireRecentReauth, requireSuperAdmin } from '../lib/auth';
import { randomToken, sha256 } from '../lib/crypto';
import { toCsv } from '../lib/csv';
import { fail, parseBody } from '../lib/http';
import { adminAuthRoutes, audit, requireAdminOrigin } from './admin-auth';
import { adminCommunityRoutes } from './admin-community';
import { adminReportRoutes } from './reports';
import { sendMessages } from '../lib/community';
import { mailEnabled, passwordResetMail, sendMail } from '../lib/mail';
import { notices } from '../lib/notices';
import { INTERNAL_HEADER } from './tables';

async function roomCall(c: Context<AppEnv>, tableId: string, action: 'status' | 'reload' | 'close'): Promise<Record<string, unknown> | null> {
  try {
    const stub = c.env.TABLES.get(c.env.TABLES.idFromName(tableId));
    const res = await stub.fetch(`https://room/internal/${tableId}/${action}`, { method: 'POST', headers: { [INTERNAL_HEADER]: c.env.INTERNAL_SECRET } });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const page = (c: Context<AppEnv>) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200),
  offset: Math.max(Number(c.req.query('offset') ?? 0) || 0, 0),
});

const admin = new Hono<AppEnv>()
  .use('*', requireAdminOrigin)
  .use('*', requireAdmin)
  // ---------------------------------------------------------------- dashboard
  .get('/dashboard', async (c) => {
    const t0 = Date.now();
    const db = c.env.DB;
    const [users, online, tables, hands, today, seats, issues] = await db.batch([
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE status != 'deleted'`),
      db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE kind = 'user' AND last_seen_at > ?1`).bind(Date.now() - 5 * 60_000),
      db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status != 'closed' THEN 1 ELSE 0 END) AS active, SUM(live_playing) AS playing, SUM(live_connections) AS conns, SUM(live_seated) AS seated FROM tables`),
      db.prepare(`SELECT COUNT(*) AS n FROM hands`),
      db.prepare(`SELECT COUNT(*) AS n FROM hands WHERE ended_at > ?1`).bind(Date.now() - 24 * 60 * 60_000),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(buy_in), 0) AS chips FROM table_sessions WHERE status = 'seated'`),
      db.prepare(`SELECT id, name, last_issue AS issue FROM tables WHERE last_issue IS NOT NULL ORDER BY updated_at DESC LIMIT 10`),
    ]);
    const one = <T>(r: D1Result | undefined) => (r?.results[0] ?? {}) as T;
    const tb = one<{ total: number; active: number; playing: number; conns: number; seated: number }>(tables);
    return c.json({
      users: one<{ n: number }>(users).n,
      onlineUsers: one<{ n: number }>(online).n,
      tables: { total: tb.total ?? 0, active: tb.active ?? 0, playing: tb.playing ?? 0, seatedPlayers: tb.seated ?? 0 },
      websocketConnections: tb.conns ?? 0,
      handsCompleted: one<{ n: number }>(hands).n,
      handsLast24h: one<{ n: number }>(today).n,
      openTableSessions: one<{ n: number }>(seats).n,
      issues: issues?.results ?? [],
      server: { env: c.env.ENVIRONMENT, d1LatencyMs: Date.now() - t0, at: Date.now() },
    });
  })
  // ---------------------------------------------------------------- users
  .get('/users', async (c) => {
    const { limit, offset } = page(c);
    const q = (c.req.query('q') ?? '').trim();
    const status = c.req.query('status');
    const locale = c.req.query('locale');
    const where = and(
      q ? or(like(schema.users.email, `%${q}%`), like(schema.users.nickname, `%${q}%`), eq(schema.users.id, q)) : undefined,
      status === 'active' || status === 'suspended' || status === 'deleted' ? eq(schema.users.status, status) : undefined,
      locale === 'ko' || locale === 'en' ? eq(schema.users.locale, locale) : undefined,
    );
    const rows = await c.var.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        nickname: schema.users.nickname,
        locale: schema.users.locale,
        role: schema.users.role,
        status: schema.users.status,
        balance: schema.users.balance,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(where)
      .orderBy(desc(schema.users.createdAt))
      .limit(limit)
      .offset(offset);
    return c.json(rows);
  })
  /** Member data export for the selected members. The notice members accept at signup covers this use. */
  .post('/users/export', requireRecentReauth, async (c) => {
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
      return c.var.db.select(cols).from(u).where(inArray(u.id, chunk));
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
    const [ledger, seats, hands] = await Promise.all([
      c.var.db.select().from(schema.chipLedger).where(eq(schema.chipLedger.userId, id)).orderBy(desc(schema.chipLedger.createdAt)).limit(50),
      c.var.db.select().from(schema.tableSessions).where(and(eq(schema.tableSessions.userId, id), eq(schema.tableSessions.status, 'seated'))),
      c.env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(net), 0) AS net FROM hand_players WHERE user_id = ?1`).bind(id).first<{ n: number; net: number }>(),
    ]);
    const ledgerSum = await c.env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM chip_ledger WHERE user_id = ?1`).bind(id).first<{ s: number }>();
    const { passwordHash: _ph, ...safe } = u;
    return c.json({ user: safe, ledger, openSeats: seats, hands: hands ?? { n: 0, net: 0 }, ledgerConsistent: (ledgerSum?.s ?? 0) === u.balance });
  })
  .post('/users/:id/suspend', requireRecentReauth, async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, z.object({ reason: z.string().trim().min(2).max(200) }));
    if (id === c.var.user!.id) fail(400, 'bad_request', 'cannot suspend yourself');
    const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id) });
    if (!target) fail(404, 'not_found', 'user not found');
    if (target.role !== 'user' && c.var.user!.role !== 'super_admin') fail(403, 'forbidden', 'only a super admin can suspend administrators');
    await c.var.db.batch([
      c.var.db.update(schema.users).set({ status: 'suspended', suspendedReason: body.reason, updatedAt: Date.now() }).where(eq(schema.users.id, id)),
      c.var.db.delete(schema.sessions).where(eq(schema.sessions.userId, id)),
    ]);
    await sendMessages(c.var.db, { userIds: [id], category: 'sanction', ...notices(target.locale).suspended(body.reason), senderId: c.var.user!.id });
    await audit(c, 'user.suspend', { type: 'user', id }, body);
    return c.json({ ok: true });
  })
  .post('/users/:id/unsuspend', requireRecentReauth, async (c) => {
    const id = c.req.param('id');
    const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { role: true, locale: true } });
    if (!target) fail(404, 'not_found', 'user not found');
    if (target.role !== 'user' && c.var.user!.role !== 'super_admin') fail(403, 'forbidden', 'only a super admin can unsuspend administrators');
    const lifted = await c.var.db
      .update(schema.users)
      .set({ status: 'active', suspendedReason: null, updatedAt: Date.now() })
      .where(and(eq(schema.users.id, id), eq(schema.users.status, 'suspended')))
      .returning({ id: schema.users.id });
    if (lifted[0]) await sendMessages(c.var.db, { userIds: [id], category: 'sanction', ...notices(target.locale).unsuspended(), senderId: c.var.user!.id });
    await audit(c, 'user.unsuspend', { type: 'user', id });
    return c.json({ ok: true });
  })
  .post('/users/:id/role', requireSuperAdmin, requireRecentReauth, async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, z.object({ role: z.enum(['user', 'admin', 'super_admin']) }));
    if (id === c.var.user!.id) fail(400, 'bad_request', 'cannot change your own role');
    const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id) });
    if (!target || target.status !== 'active') fail(404, 'not_found', 'active user not found');
    await c.var.db.update(schema.users).set({ role: body.role, updatedAt: Date.now() }).where(eq(schema.users.id, id));
    // Role changes take effect immediately: drop existing admin sessions of the target.
    await c.var.db.delete(schema.sessions).where(and(eq(schema.sessions.userId, id), eq(schema.sessions.kind, 'admin')));
    await audit(c, 'user.role', { type: 'user', id }, { from: target.role, to: body.role });
    return c.json({ ok: true });
  })
  .post('/users/:id/chips', requireRecentReauth, async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, ChipAdjustSchema);
    const target = await c.var.db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { role: true, locale: true } });
    if (target && target.role !== 'user' && c.var.user!.role !== 'super_admin') fail(403, 'forbidden', 'only a super admin can adjust chips of administrators');
    const r = await applyLedger(c.env.DB, {
      userId: id,
      type: 'admin_adjust',
      amount: body.amount,
      idempotencyKey: `admin:${body.idempotencyKey}`,
      actorId: c.var.user!.id,
      memo: body.memo,
    });
    if (r.status === 'insufficient') fail(409, 'insufficient_balance', 'adjustment would make the balance negative (or user not found)');
    if (r.status === 'applied') {
      await sendMessages(c.var.db, {
        userIds: [id],
        category: body.amount > 0 ? 'event' : 'admin',
        ...notices(target?.locale).chips(body.amount, body.memo, r.balanceAfter),
        senderId: c.var.user!.id,
      });
      await audit(c, 'user.chips', { type: 'user', id }, { amount: body.amount, memo: body.memo, ledgerId: r.ledgerId });
    }
    return c.json({ ok: true, duplicate: r.status === 'duplicate', balanceAfter: r.balanceAfter });
  })
  /**
   * Issues a one-time password reset link. With mail configured it is also mailed to the
   * member; either way the response carries the link and a copy-ready message in the member's language.
   */
  .post('/users/:id/reset-link', requireRecentReauth, async (c) => {
    const id = c.req.param('id');
    if (id === c.var.user!.id) fail(400, 'bad_request', 'use the change-password flow for your own account');
    const u = await c.var.db.query.users.findFirst({ where: and(eq(schema.users.id, id), eq(schema.users.status, 'active')) });
    if (!u) fail(404, 'not_found', 'user not found');
    // A reset link is an account takeover token: plain admins may only issue them for members.
    if (u.role !== 'user' && c.var.user!.role !== 'super_admin') fail(403, 'forbidden', 'only a super admin can issue reset links for administrators');
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
  .get('/tables', async (c) => {
    const rows = await c.var.db.select().from(schema.tables).orderBy(desc(schema.tables.createdAt));
    return c.json(rows.map(({ joinCodeHash, ...t }) => ({ ...t, hasJoinCode: !!joinCodeHash })));
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
    // The live status never includes hole cards or deck information.
    return c.json({ table: { ...rest, hasJoinCode: !!joinCodeHash }, live });
  })
  .patch('/tables/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, TablePatchSchema);
    const t = await c.var.db.query.tables.findFirst({ where: eq(schema.tables.id, id) });
    if (!t || t.status === 'closed') fail(404, 'not_found', 'table not found');
    const merged = { sb: body.smallBlind ?? t.smallBlind, bb: body.bigBlind ?? t.bigBlind, min: body.minBuyIn ?? t.minBuyIn, max: body.maxBuyIn ?? t.maxBuyIn };
    if (merged.bb < merged.sb || merged.min < merged.bb * 10 || merged.max < merged.min) fail(400, 'bad_request', 'invalid blind / buy-in combination');
    const isPrivate = body.isPrivate ?? t.isPrivate;
    let joinCodeHash = t.joinCodeHash;
    if (body.joinCode !== undefined) joinCodeHash = body.joinCode ? await sha256(`${id}:${body.joinCode}`) : null;
    if (isPrivate && !joinCodeHash) fail(400, 'bad_request', 'private tables need a join code');
    await c.var.db
      .update(schema.tables)
      .set({
        name: body.name ?? t.name,
        smallBlind: merged.sb,
        bigBlind: merged.bb,
        minBuyIn: merged.min,
        maxBuyIn: merged.max,
        isPrivate,
        joinCodeHash: isPrivate ? joinCodeHash : null,
        allowSpectators: body.allowSpectators ?? t.allowSpectators,
        beginner: body.beginner ?? t.beginner,
        entryBlocked: body.entryBlocked ?? t.entryBlocked,
        updatedAt: Date.now(),
      })
      .where(eq(schema.tables.id, id));
    // Blind changes apply from the next hand; the running hand keeps its config.
    const live = await roomCall(c, id, 'reload');
    await audit(c, 'table.update', { type: 'table', id }, { ...body, joinCode: body.joinCode ? '***' : body.joinCode });
    return c.json({ ok: true, appliesFrom: live?.appliesFrom ?? 'next hand' });
  })
  .post('/tables/:id/close', requireRecentReauth, async (c) => {
    const id = c.req.param('id');
    const t = await c.var.db.query.tables.findFirst({ where: eq(schema.tables.id, id) });
    if (!t || t.status === 'closed') fail(404, 'not_found', 'table not found');
    // Stop new hands; the room finishes the current hand, cashes everyone out, then marks the table closed.
    await c.var.db.update(schema.tables).set({ status: 'closing', entryBlocked: true, updatedAt: Date.now() }).where(eq(schema.tables.id, id));
    const live = await roomCall(c, id, 'close');
    await audit(c, 'table.close', { type: 'table', id }, live);
    return c.json({ ok: true, live });
  })
  // ---------------------------------------------------------------- audit: hands, ledger, actions
  .get('/hands', async (c) => {
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
  .get('/hands/:id', requireRecentReauth, async (c) => {
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
    return c.json(rows.map((r) => ({ ...r.l, nickname: r.nickname })));
  })
  .get('/audit', async (c) => {
    const { limit, offset } = page(c);
    const rows = await c.var.db
      .select({ a: schema.adminAuditLog, nickname: schema.users.nickname })
      .from(schema.adminAuditLog)
      .leftJoin(schema.users, eq(schema.users.id, schema.adminAuditLog.actorId))
      .orderBy(desc(schema.adminAuditLog.createdAt))
      .limit(limit)
      .offset(offset);
    return c.json(rows.map((r) => ({ ...r.a, actor: r.nickname, detail: r.a.detail ? JSON.parse(r.a.detail) : null })));
  })
  // ---------------------------------------------------------------- reconciliation
  /**
   * Detects wallets whose balance differs from the sum of their ledger and
   * records an open reconciliation event for each new mismatch. Balances are
   * never "fixed" silently: an admin resolves each event explicitly.
   */
  .post('/reconcile/run', async (c) => {
    const mismatches = await findLedgerMismatches(c.env.DB);
    const open = await c.var.db.select().from(schema.reconciliationEvents).where(isNull(schema.reconciliationEvents.resolvedAt));
    const openKeys = new Set(open.map((e) => `${e.subjectId}:${e.expected}:${e.actual}`));
    let created = 0;
    for (const m of mismatches) {
      if (openKeys.has(`${m.userId}:${m.ledgerSum}:${m.balance}`)) continue;
      await c.var.db.insert(schema.reconciliationEvents).values({ id: crypto.randomUUID(), scope: 'user_ledger', subjectId: m.userId, expected: m.ledgerSum, actual: m.balance, detail: 'wallet balance != sum(chip_ledger)' });
      created++;
    }
    // Table-level: chips held at open seats vs. what the rooms report.
    const seated = await c.env.DB.prepare(`SELECT table_id AS tableId, SUM(buy_in) AS buyIns, COUNT(*) AS n FROM table_sessions WHERE status = 'seated' GROUP BY table_id`).all<{ tableId: string; buyIns: number; n: number }>();
    const tableReports: unknown[] = [];
    for (const row of seated.results) {
      const live = await roomCall(c, row.tableId, 'status');
      const liveSeats = ((live?.seats as ({ userId: string } | null)[] | undefined) ?? []).filter(Boolean).length;
      if (live && liveSeats !== row.n) {
        await c.var.db.insert(schema.reconciliationEvents).values({ id: crypto.randomUUID(), scope: 'table', subjectId: row.tableId, expected: row.n, actual: liveSeats, detail: 'open table_sessions != seats held by the room' });
        created++;
      }
      tableReports.push({ tableId: row.tableId, openSessions: row.n, roomSeats: liveSeats, chipsOnTable: live?.chipsOnTable ?? null });
    }
    await audit(c, 'reconcile.run', undefined, { mismatches: mismatches.length, created });
    return c.json({ mismatches, created, tables: tableReports });
  })
  .get('/reconcile', async (c) => {
    const rows = await c.var.db.select().from(schema.reconciliationEvents).orderBy(desc(schema.reconciliationEvents.createdAt)).limit(200);
    return c.json(rows);
  })
  .post('/reconcile/:id/resolve', requireRecentReauth, async (c) => {
    const id = c.req.param('id');
    const body = await parseBody(c, z.object({ note: z.string().trim().min(2).max(300) }));
    const r = await c.var.db
      .update(schema.reconciliationEvents)
      .set({ resolvedBy: c.var.user!.id, resolvedAt: Date.now(), detail: sql`COALESCE(${schema.reconciliationEvents.detail}, '') || ' | resolved: ' || ${body.note}` })
      .where(and(eq(schema.reconciliationEvents.id, id), isNull(schema.reconciliationEvents.resolvedAt)))
      .returning();
    if (!r[0]) fail(404, 'not_found', 'open event not found');
    await audit(c, 'reconcile.resolve', { type: 'reconciliation', id }, body);
    return c.json({ ok: true });
  })
  // ---------------------------------------------------------------- academy (anonymous aggregates)
  .get('/academy/stats', async (c) => {
    const rows = await c.var.db.select().from(schema.academyStats);
    const out: AcademyStatRow[] = rows.map(({ kind, itemId, starts, completes, correct, wrong }) => ({ kind, itemId, starts, completes, correct, wrong }));
    return c.json(out);
  });

export const adminRoutes = new Hono<AppEnv>().route('/auth', adminAuthRoutes).route('/', admin.route('/', adminCommunityRoutes).route('/', adminReportRoutes));
