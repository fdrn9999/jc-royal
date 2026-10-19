import { schema } from '@jc/db';
import { PresenceBeatSchema, PresenceLeaveSchema, PresenceModeSchema, type MyPresenceDto, type PresenceMode } from '@jc/types';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser, requireUserQuiet } from '../lib/auth';
import { fail, parseBody } from '../lib/http';
import { applyMode, hubCall, type HubBeat, type HubQuery } from '../lib/presence';
import { rateLimit } from '../lib/rate-limit';

/** What friends see of me now, by my mode and my devices' beats. */
async function myState(c: Context<AppEnv>, mode: PresenceMode): Promise<MyPresenceDto> {
  const uid = c.var.user!.id;
  if (mode === 'invisible') return { mode, state: 'offline' };
  const r = await hubCall<HubQuery>(c.env, 'query', { asker: uid, ids: [uid] });
  return { mode, state: applyMode(mode, r?.presence?.[uid] ?? 'offline') };
}

/**
 * My status (docs/PRESENCE.md), mounted at /api/me before meRoutes: the beat and the leave come every half minute from
 * every open page, so they check the sign-in without sliding it (requireUserQuiet, no D1 write) and answer before
 * meRoutes' requireUser would run. Never rate limited in D1 (a write per call): the hub limits beats per member.
 */
export const presenceRoutes = new Hono<AppEnv>()
  /**
   * This device is here; `idleMs` since the member last did something on it. The answer carries the account's mode
   * and what friends see, so a mode changed on another device shows here within a beat.
   */
  .post('/presence/heartbeat', requireUserQuiet, async (c) => {
    const body = await parseBody(c, PresenceBeatSchema);
    const u = c.var.user!;
    const s = c.var.session!;
    // The sign-in's span goes along: the device shows no longer than the sign-in, and a beat still on its way when the
    // member signed out (here or of every device) is not recorded (the hub's PresenceBook).
    const r = await hubCall<HubBeat>(c.env, 'beat', {
      user: u.id,
      session: s.id,
      conn: body.conn,
      idleMs: body.idleMs,
      visible: body.visible,
      view: body.view ?? null,
      until: s.expiresAt,
      since: s.createdAt,
    });
    if (r?.limited) fail(429, 'rate_limited', 'too many status updates; slow down');
    if (!r?.state) fail(503, 'presence_unavailable', 'status is unavailable right now');
    return c.json({ mode: u.presenceMode, state: applyMode(u.presenceMode, r.state) } satisfies MyPresenceDto);
  })
  /** This device closed (pagehide, keepalive): friends see the change without waiting for it to expire. */
  .post('/presence/leave', requireUserQuiet, async (c) => {
    const body = await parseBody(c, PresenceLeaveSchema);
    await hubCall(c.env, 'leave', { user: c.var.user!.id, session: c.var.session!.id, conn: body.conn });
    return c.json({ ok: true });
  })
  .get('/presence', requireUser, async (c) => c.json(await myState(c, c.var.user!.presenceMode)))
  /** Auto, away or invisible, for the account (every device): saved in D1, applied by the api to every answer. */
  .put('/presence', requireUser, async (c) => {
    const body = await parseBody(c, PresenceModeSchema);
    const uid = c.var.user!.id;
    await rateLimit(c, `presence-mode:${uid}`, 30, 10 * 60_000);
    await c.var.db.update(schema.users).set({ presenceMode: body.mode, updatedAt: Date.now() }).where(eq(schema.users.id, uid));
    return c.json(await myState(c, body.mode));
  });
