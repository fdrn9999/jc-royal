/**
 * Console sessions and who may do what. Every administrator sees and ends their own console sessions (a sign-in left
 * open elsewhere); a super admin sees everyone's and can end them. Ending a session only protects an account, so it
 * needs no password; the session is gone from the next request on. Member sessions are ended from the member's page
 * (disconnect).
 *
 * A super admin also turns each feature on or off for each plain administrator (lib/permissions.ts GRANTS): never for
 * themselves, another super admin or a member, after the password, with a reason, and against the version they saw
 * (two super admins saving at once: the second is told). It applies from the administrator's next request.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { adminMonitorRevoke } from '../lib/admin-monitor';
import { audit, searchAudit } from '../lib/audit';
import { fail, isPreview, parseBody } from '../lib/http';
import { CAPABILITIES, FEATURES, GRANT_OF, GRANTS, ROUTE_RULES, can, capabilitiesOf, effectiveFeatures, grantsOf, parseGrants, type Grant } from '../lib/permissions';
import { ADMIN_ABSOLUTE_TTL, ADMIN_REAUTH_WINDOW } from '../lib/session';

type SessionRow = {
  id: string;
  userId: string;
  nickname: string;
  role: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  reauthAt: number | null;
};

const GrantsSchema = z.object({
  grants: z.array(z.enum(GRANTS)).max(GRANTS.length * 2),
  baseVersion: z.number().int().min(0),
  reason: z.string().trim().min(2).max(200),
  preview: z.boolean().optional(),
});
const GrantsPreviewSchema = GrantsSchema.partial({ reason: true });

type StaffRow = {
  id: string;
  nickname: string;
  role: 'user' | 'admin' | 'super_admin';
  status: 'active' | 'suspended' | 'deleted';
  lastLoginAt: number | null;
  grants: string | null;
  version: number | null;
  updatedAt: number | null;
  updatedBy: string | null;
  updatedByNickname: string | null;
};

/** An administrator and their switches. No e-mail address: the page needs none. */
const STAFF = `SELECT u.id, u.nickname, u.role, u.status, u.last_login_at AS lastLoginAt, p.grants, p.version, p.updated_at AS updatedAt,
                      p.updated_by AS updatedBy, ub.nickname AS updatedByNickname
                 FROM users u LEFT JOIN admin_permissions p ON p.user_id = u.id LEFT JOIN users ub ON ub.id = p.updated_by`;

const staffOf = (r: StaffRow) => ({
  id: r.id,
  nickname: r.nickname,
  role: r.role,
  status: r.status,
  lastLoginAt: r.lastLoginAt,
  // A super admin holds every feature and has no switches.
  grants: r.role === 'super_admin' ? null : parseGrants(r.grants),
  version: r.version ?? 0,
  updatedAt: r.updatedAt,
  updatedBy: r.updatedBy ? { id: r.updatedBy, nickname: r.updatedByNickname } : null,
});

const canonical = (list: readonly string[]): Grant[] => GRANTS.filter((g) => list.includes(g));

/** Mounted inside the admin router (requireAdmin and the permission rules already applied). */
export const adminSecurityRoutes = new Hono<AppEnv>()
  /** Open console sessions, most recently used first: your own, or with `sessions.all` every administrator's. */
  .get('/security/sessions', async (c) => {
    const me = c.var.user!;
    const all = can(me.role, 'sessions.all');
    const now = Date.now();
    // From the staff (users_staff_idx) to their sessions, so member sessions are never read.
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.user_id AS userId, u.nickname, u.role, s.created_at AS createdAt, s.last_seen_at AS lastSeenAt, s.expires_at AS expiresAt,
              s.ip, s.user_agent AS userAgent, s.reauth_at AS reauthAt
         FROM users u JOIN sessions s ON s.user_id = u.id
        WHERE u.role != 'user' AND s.kind = 'admin' AND s.expires_at > ?1 AND s.created_at > ?2 ${all ? '' : 'AND u.id = ?3'}
        ORDER BY s.last_seen_at DESC LIMIT 200`,
    )
      .bind(now, now - ADMIN_ABSOLUTE_TTL, ...(all ? [] : [me.id]))
      .all<SessionRow>();
    const current = c.var.session!.id;
    return c.json({
      scope: all ? 'all' : 'own',
      items: results.map((s) => ({
        id: s.id,
        user: { id: s.userId, nickname: s.nickname, role: s.role },
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        // Idle limit (slides while used) and the fixed limit from sign-in; the session ends at the earlier.
        idleExpiresAt: s.expiresAt,
        absoluteExpiresAt: s.createdAt + ADMIN_ABSOLUTE_TTL,
        ip: s.ip,
        userAgent: s.userAgent,
        reauthValidUntil: s.reauthAt && s.reauthAt + ADMIN_REAUTH_WINDOW > now ? s.reauthAt + ADMIN_REAUTH_WINDOW : null,
        current: s.id === current,
      })),
    });
  })
  /** Ends one console session: your own (this one too, which signs you out), or with `sessions.all` anyone's. */
  .delete('/security/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const me = c.var.user!;
    const s = await c.env.DB.prepare(`SELECT user_id AS userId FROM sessions WHERE id = ?1 AND kind = 'admin'`).bind(id).first<{ userId: string }>();
    if (!s) fail(404, 'not_found', 'session not found');
    const own = s.userId === me.id;
    if (!own && !can(me.role, 'sessions.all')) fail(403, 'forbidden', "only a super admin can end other administrators' sessions");
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(id).run();
    adminMonitorRevoke(c, { user: s.userId, session: id });
    await audit(c, 'admin.session.end', { type: 'user', id: s.userId }, { sessionId: id, own, current: id === c.var.session!.id });
    return c.json({ ok: true, current: id === c.var.session!.id });
  })
  /** Ends your other console sessions (this one stays). */
  .post('/security/sessions/end-others', async (c) => {
    const me = c.var.user!;
    const r = await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND kind = 'admin' AND id != ?2`).bind(me.id, c.var.session!.id).run();
    const ended = r.meta.changes ?? 0;
    adminMonitorRevoke(c, { user: me.id, except: c.var.session!.id });
    await audit(c, 'admin.session.end_others', { type: 'user', id: me.id }, { ended });
    return c.json({ ok: true, ended });
  })
  /**
   * The permission table, read-only: per feature, who may use it, whether the password is asked again and the switch it
   * stands behind; and what you may use yourself (your switches, and per feature how many of its actions).
   */
  .get('/security/permissions', async (c) => {
    const me = c.var.user!;
    const rules = Object.entries(ROUTE_RULES);
    const features = FEATURES.map((feature) => {
      const mine = rules.filter(([, r]) => r.feature === feature);
      const level = (n: number) => (n === 0 ? 'none' : n === mine.length ? 'all' : 'some');
      return {
        feature,
        // 'some': some of the feature's actions are for super admins only (or ask for the password).
        admin: level(mine.filter(([, r]) => r.role === 'admin').length),
        reauth: level(mine.filter(([, r]) => r.reauth).length),
        // The switch: a GRANTS key, 'always' (every administrator) or 'super' (super admins only, no switch).
        grant: GRANT_OF[feature],
        actions: mine.map(([key, r]) => ({ route: key, action: r.action, role: r.role, reauth: !!r.reauth })),
      };
    });
    const grants = await grantsOf(c);
    return c.json({
      role: me.role,
      capabilities: capabilitiesOf(me.role),
      capabilityRoles: CAPABILITIES,
      features,
      grantKeys: GRANTS,
      grants,
      effective: effectiveFeatures(me.role, grants),
    });
  })
  /** Administrators and their switches (super admins only): `q` a nickname or id, `role`, server pages. */
  .get('/security/admins', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100);
    const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
    const q = (c.req.query('q') ?? '').trim().slice(0, 64);
    const role = c.req.query('role');
    const where = [`u.role != 'user'`, `u.status != 'deleted'`, `u.is_bot = 0`];
    const binds: unknown[] = [];
    if (q) {
      where.push(`(u.nickname LIKE ? ESCAPE '\\' OR u.id = ?)`);
      binds.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, q);
    }
    if (role === 'admin' || role === 'super_admin') {
      where.push('u.role = ?');
      binds.push(role);
    }
    const W = `WHERE ${where.join(' AND ')}`;
    const DB = c.env.DB;
    // Staff only (users_staff_idx): a handful of rows, never the members.
    const [list, count] = await DB.batch([
      DB.prepare(`${STAFF} ${W} ORDER BY u.role = 'super_admin' DESC, lower(u.nickname), u.id LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
      DB.prepare(`SELECT COUNT(*) AS n FROM users u ${W}`).bind(...binds),
    ]);
    return c.json({
      items: ((list?.results ?? []) as StaffRow[]).map(staffOf),
      total: Number((count?.results[0] as { n?: number } | undefined)?.n ?? 0),
      limit,
      offset,
      grantKeys: GRANTS,
    });
  })
  /**
   * One administrator: their switches and version, what they may actually use per feature, and the history of their
   * switches (`before`, `beforeId`: the page after the last entry shown).
   */
  .get('/security/admins/:id', async (c) => {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(`${STAFF} WHERE u.id = ?1 AND u.role != 'user' AND u.status != 'deleted'`).bind(id).first<StaffRow>();
    if (!row) fail(404, 'not_found', 'administrator not found');
    const admin = staffOf(row);
    const before = Number(c.req.query('before')) || undefined;
    const history = await searchAudit(c.env.DB, {
      targetType: 'user',
      targetId: id,
      action: 'admin.grants.*',
      before,
      beforeId: before ? (c.req.query('beforeId') ?? '').slice(0, 64) : undefined,
      limit: 20,
      count: false,
    });
    return c.json({
      admin,
      grantKeys: GRANTS,
      effective: effectiveFeatures(admin.role, admin.grants ?? [...GRANTS]),
      // Who changed what and why. The IP stays on the audit page.
      history: { ...history, items: history.items.map(({ ip: _ip, ...h }) => h) },
    });
  })
  /**
   * Sets a plain administrator's switches. `preview`: what turns on and off and the actions it opens or closes; nothing
   * is written. Refused: yourself, a super admin or a member (409 not_plain_admin), a version other than the current
   * one (409 admin_grants_conflict, with the current switches), no change. Applies from the administrator's next
   * request; their sessions stay.
   */
  .put('/security/admins/:id/grants', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? GrantsPreviewSchema : GrantsSchema);
    const me = c.var.user!;
    if (id === me.id) fail(400, 'bad_request', 'cannot change your own permissions');
    const DB = c.env.DB;
    const row = await DB.prepare(`${STAFF} WHERE u.id = ?1 AND u.status != 'deleted' AND u.is_bot = 0`).bind(id).first<StaffRow>();
    if (!row) fail(404, 'not_found', 'user not found');
    if (row.role !== 'admin') fail(409, 'not_plain_admin', 'only a plain administrator has feature switches');
    const current = staffOf(row);
    const conflict = (now: ReturnType<typeof staffOf>): never =>
      fail(409, 'admin_grants_conflict', 'the permissions changed meanwhile', { version: now.version, grants: now.grants });
    if (current.version !== body.baseVersion) conflict(current);
    const from = current.grants ?? [];
    const to = canonical(body.grants);
    const gained = to.filter((g) => !from.includes(g));
    const lost = from.filter((g) => !to.includes(g));
    if (!gained.length && !lost.length) fail(400, 'admin_grants_no_change', 'the permissions are the same as now');
    if (preview) {
      const was = effectiveFeatures('admin', from);
      const will = effectiveFeatures('admin', to);
      return c.json({
        preview: true,
        admin: { id, nickname: row.nickname, status: row.status },
        from,
        to,
        gained,
        lost,
        version: body.baseVersion + 1,
        appliesFrom: 'next_request',
        actions: { from: was.reduce((n, f) => n + f.allowed, 0), to: will.reduce((n, f) => n + f.allowed, 0) },
      });
    }
    const now = Date.now();
    const json = JSON.stringify(to);
    // One statement, only while the account is still a plain administrator and the version is the one the editor saw.
    const stillAdmin = `EXISTS (SELECT 1 FROM users WHERE id = ?1 AND role = 'admin' AND status != 'deleted')`;
    const r =
      body.baseVersion === 0
        ? await DB.prepare(
            `INSERT INTO admin_permissions (user_id, grants, version, updated_by, updated_at) SELECT ?1, ?2, 1, ?3, ?4 WHERE ${stillAdmin}
               ON CONFLICT(user_id) DO NOTHING`,
          )
            .bind(id, json, me.id, now)
            .run()
        : await DB.prepare(`UPDATE admin_permissions SET grants = ?2, version = version + 1, updated_by = ?3, updated_at = ?4 WHERE user_id = ?1 AND version = ?5 AND ${stillAdmin}`)
            .bind(id, json, me.id, now, body.baseVersion)
            .run();
    if (!r.meta.changes) {
      const again = await DB.prepare(`${STAFF} WHERE u.id = ?1`).bind(id).first<StaffRow>();
      if (!again || again.role !== 'admin' || again.status === 'deleted') fail(409, 'not_plain_admin', 'only a plain administrator has feature switches');
      conflict(staffOf(again));
    }
    const version = body.baseVersion + 1;
    // Their open control center pages reconnect, and the handshake reads the new switches (it refuses without table duty).
    adminMonitorRevoke(c, { user: id }, { reauth: true });
    await audit(c, 'admin.grants.update', { type: 'user', id }, { before: from, after: to, gained, lost, reason: body.reason, version });
    return c.json({ ok: true, grants: to, version });
  });
