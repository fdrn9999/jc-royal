/**
 * Console sessions and who may do what. Every administrator sees and ends their own console sessions (a sign-in left
 * open elsewhere); a super admin sees everyone's and can end them. Ending a session only protects an account, so it
 * needs no password; the session is gone from the next request on. Member sessions are ended from the member's page
 * (disconnect).
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { fail } from '../lib/http';
import { CAPABILITIES, FEATURES, ROUTE_RULES, can, capabilitiesOf } from '../lib/permissions';
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
    await audit(c, 'admin.session.end', { type: 'user', id: s.userId }, { sessionId: id, own, current: id === c.var.session!.id });
    return c.json({ ok: true, current: id === c.var.session!.id });
  })
  /** Ends your other console sessions (this one stays). */
  .post('/security/sessions/end-others', async (c) => {
    const me = c.var.user!;
    const r = await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND kind = 'admin' AND id != ?2`).bind(me.id, c.var.session!.id).run();
    const ended = r.meta.changes ?? 0;
    await audit(c, 'admin.session.end_others', { type: 'user', id: me.id }, { ended });
    return c.json({ ok: true, ended });
  })
  /** The permission table, read-only: per feature, who may use it and whether the password is asked again. */
  .get('/security/permissions', (c) => {
    const rules = Object.entries(ROUTE_RULES);
    const features = FEATURES.map((feature) => {
      const mine = rules.filter(([, r]) => r.feature === feature);
      const level = (n: number) => (n === 0 ? 'none' : n === mine.length ? 'all' : 'some');
      return {
        feature,
        // 'some': some of the feature's actions are for super admins only (or ask for the password).
        admin: level(mine.filter(([, r]) => r.role === 'admin').length),
        reauth: level(mine.filter(([, r]) => r.reauth).length),
        actions: mine.map(([key, r]) => ({ route: key, action: r.action, role: r.role, reauth: !!r.reauth })),
      };
    });
    return c.json({ role: c.var.user!.role, capabilities: capabilitiesOf(c.var.user!.role), capabilityRoles: CAPABILITIES, features });
  });
