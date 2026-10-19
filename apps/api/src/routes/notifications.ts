import { NotificationSettingsSaveSchema, PUSH_MAX_DEVICES, PushSubscribeSchema, PushUnsubscribeSchema, type PushDeviceDto } from '@jc/types';
import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { requireUser, requireUserQuiet } from '../lib/auth';
import { sha256 } from '../lib/crypto';
import { fail, parseBody } from '../lib/http';
import { pushConfigured, readSettings, saveSettings } from '../lib/notification-settings';
import { rateLimit } from '../lib/rate-limit';
import { allowedEndpoint, deviceLabel, onCurve, validKeys } from '../lib/webpush';

type DeviceRow = {
  id: string;
  session_id: string;
  label: string | null;
  created_at: number;
  last_success_at: number | null;
  last_failure_at: number | null;
};

const toDevice = (r: DeviceRow, sessionId: string): PushDeviceDto => ({
  id: r.id,
  label: r.label,
  createdAt: r.created_at,
  lastSuccessAt: r.last_success_at,
  lastFailureAt: r.last_failure_at,
  current: r.session_id === sessionId,
});

const DEVICE_COLUMNS = 'id, session_id, label, created_at, last_success_at, last_failure_at';

async function devices(env: Env, uid: string): Promise<DeviceRow[]> {
  const r = await env.DB.prepare(
    `SELECT ${DEVICE_COLUMNS} FROM push_subscriptions WHERE user_id = ?1 AND disabled_at IS NULL ORDER BY updated_at DESC`,
  )
    .bind(uid)
    .all<DeviceRow>();
  return r.results;
}

/**
 * Push notifications, mounted at /api/me before meRoutes (each route checks the sign-in itself). The settings are the
 * account's: what this browser allows and whether it is registered are the device's, and only it can tell.
 */
export const notificationRoutes = new Hono<AppEnv>()
  .get('/notifications/settings', requireUser, async (c) => c.json(await readSettings(c.env, c.var.user!.id)))
  /** Only what is sent changes, from the version the device showed; another version: 409 with the current settings. */
  .put('/notifications/settings', requireUser, async (c) => {
    const body = await parseBody(c, NotificationSettingsSaveSchema);
    const uid = c.var.user!.id;
    await rateLimit(c, `notify-settings:${uid}`, 30, 10 * 60_000);
    const r = await saveSettings(c.env, uid, body, Date.now());
    if (!r.ok) fail(409, 'stale_settings', 'the settings were changed elsewhere; review them and save again', r.settings);
    return c.json(r.settings);
  })
  /**
   * Who this browser is signed in as, for the service worker before it shows a push (public/sw.js): only the member's
   * id, and the sign-in is not extended (an unanswered push never keeps a session alive).
   */
  .get('/notifications/recipient', requireUserQuiet, (c) => c.json({ id: c.var.user!.id }))
  /** The public half of the VAPID key pair, which browsers subscribe with. */
  .get('/notifications/push-key', requireUser, (c) => {
    if (!pushConfigured(c.env)) fail(503, 'push_unavailable', 'push notifications are not available');
    return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY! });
  })
  .get('/notifications/devices', requireUser, async (c) => {
    const sid = c.var.session!.id;
    return c.json({ devices: (await devices(c.env, c.var.user!.id)).map((r) => toDevice(r, sid)) });
  })
  /**
   * This browser's subscription, for the member and this sign-in (it goes with the sign-in: sign-out, sign-out
   * everywhere, a password reset or withdrawal remove it). Only a known push service is accepted, only with service
   * consent given. A browser registered by another account before is this member's from now on: one subscription, one
   * member. The same registration again writes nothing.
   */
  .post('/notifications/subscriptions', requireUser, async (c) => {
    const body = await parseBody(c, PushSubscribeSchema);
    const uid = c.var.user!.id;
    const sid = c.var.session!.id;
    if (!pushConfigured(c.env)) fail(503, 'push_unavailable', 'push notifications are not available');
    if (!allowedEndpoint(body.endpoint) || (body.oldEndpoint !== undefined && !allowedEndpoint(body.oldEndpoint)))
      fail(400, 'push_endpoint_refused', 'this push service is not supported');
    if (!validKeys(body.keys.p256dh, body.keys.auth) || !(await onCurve(body.keys.p256dh))) fail(400, 'invalid_push_keys', 'the subscription keys are not valid');
    if (!(await readSettings(c.env, uid)).service) fail(409, 'push_consent_required', 'push notifications are not agreed to');
    const hash = await sha256(body.endpoint);
    const label = deviceLabel(c.req.header('user-agent'));
    const now = Date.now();
    const db = c.env.DB;
    const same = await db
      .prepare(
        `SELECT ${DEVICE_COLUMNS} FROM push_subscriptions
          WHERE endpoint_hash = ?1 AND user_id = ?2 AND session_id = ?3 AND p256dh = ?4 AND auth = ?5 AND disabled_at IS NULL`,
      )
      .bind(hash, uid, sid, body.keys.p256dh, body.keys.auth)
      .first<DeviceRow>();
    // A page checks its registration once when it opens: the same again costs a read, no write.
    if (same && !body.oldEndpoint) return c.json({ device: toDevice(same, sid), publicKey: c.env.VAPID_PUBLIC_KEY! });
    await rateLimit(c, `push-subscribe:${uid}`, 20, 10 * 60_000);
    const statements = [];
    // The subscription the browser replaced: gone, if it was this member's.
    if (body.oldEndpoint) statements.push(db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash = ?1 AND user_id = ?2').bind(await sha256(body.oldEndpoint), uid));
    statements.push(
      db
        .prepare(
          `INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, endpoint_hash, p256dh, auth, label, created_at, updated_at, failures)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 0)
           ON CONFLICT(endpoint_hash) DO UPDATE SET
             id = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.id ELSE excluded.id END,
             created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.created_at ELSE excluded.created_at END,
             last_success_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.last_success_at ELSE NULL END,
             user_id = excluded.user_id, session_id = excluded.session_id, endpoint = excluded.endpoint,
             p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, updated_at = excluded.updated_at,
             failures = 0, last_failure_at = NULL, disabled_at = NULL`,
        )
        .bind(crypto.randomUUID(), uid, sid, body.endpoint, hash, body.keys.p256dh, body.keys.auth, label, now),
      // The oldest beyond the most a member may have go.
      db
        .prepare(
          `DELETE FROM push_subscriptions WHERE id IN
             (SELECT id FROM push_subscriptions WHERE user_id = ?1 ORDER BY updated_at DESC, created_at DESC LIMIT -1 OFFSET ?2)`,
        )
        .bind(uid, PUSH_MAX_DEVICES),
    );
    await db.batch(statements);
    const row = await db.prepare(`SELECT ${DEVICE_COLUMNS} FROM push_subscriptions WHERE endpoint_hash = ?1 AND user_id = ?2`).bind(hash, uid).first<DeviceRow>();
    if (!row) fail(409, 'push_device_not_found', 'the device was removed meanwhile');
    return c.json({ device: toDevice(row, sid), publicKey: c.env.VAPID_PUBLIC_KEY! }, same ? 200 : 201);
  })
  /** This browser stops: by its endpoint, which only the browser holding the subscription knows. */
  .post('/notifications/subscriptions/remove', requireUser, async (c) => {
    const body = await parseBody(c, PushUnsubscribeSchema);
    await rateLimit(c, `push-subscribe:${c.var.user!.id}`, 20, 10 * 60_000);
    await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash = ?1').bind(await sha256(body.endpoint)).run();
    return c.json({ ok: true });
  })
  /** One of the member's own devices, from the list (another member's is not found). */
  .delete('/notifications/subscriptions/:id', requireUser, async (c) => {
    const id = c.req.param('id');
    if (id.length > 64) fail(404, 'push_device_not_found', 'no such device');
    const r = await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?1 AND user_id = ?2').bind(id, c.var.user!.id).run();
    if (!r.meta.changes) fail(404, 'push_device_not_found', 'no such device');
    return c.json({ ok: true });
  });
