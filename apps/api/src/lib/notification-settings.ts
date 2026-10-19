import {
  NOTIFICATION_CONSENT_VERSION,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_TYPE_DB,
  NOTIFICATION_TYPES,
  type NotificationDbType,
  type NotificationSettingsDto,
  type NotificationSettingsSave,
  type NotificationType,
} from '@jc/types';
import type { Env } from '../env';
import { fail } from './http';

/**
 * A member's push choices (notification_settings) and the record of every consent change (notification_consents),
 * the account's and never a device's. A change names the version it was made from: the check and the write are one D1
 * batch, so of two devices saving at once one wins and the other is told to look again (409 stale_settings), and a
 * device that has not seen a withdrawal made elsewhere cannot give the consent back by saving what it shows.
 */

type Row = Record<NotificationDbType, number> & {
  service: number;
  night: number;
  version: number;
  service_at: number | null;
  night_at: number | null;
  updated_at: number;
};

/** Whether this server can send pushes at all: the VAPID key pair and subject are configured. */
export function pushConfigured(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

function toDto(env: Env, r: Row | null): NotificationSettingsDto {
  const pushAvailable = pushConfigured(env);
  if (!r) return { ...NOTIFICATION_DEFAULTS, types: { ...NOTIFICATION_DEFAULTS.types }, pushAvailable };
  return {
    service: !!r.service,
    night: !!r.service && !!r.night,
    types: Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, !!r[NOTIFICATION_TYPE_DB[t]]])) as Record<NotificationType, boolean>,
    version: r.version,
    serviceAt: r.service_at,
    nightAt: r.night_at,
    updatedAt: r.updated_at,
    pushAvailable,
  };
}

async function readRow(env: Env, uid: string): Promise<Row | null> {
  return env.DB.prepare('SELECT * FROM notification_settings WHERE user_id = ?1').bind(uid).first<Row>();
}

export async function readSettings(env: Env, uid: string): Promise<NotificationSettingsDto> {
  return toDto(env, await readRow(env, uid));
}

type Consent = { kind: 'service' | 'night'; agreed: boolean };

function consentRow(env: Env, uid: string, c: Consent, source: 'signup' | 'settings', now: number, guard: string, version: number) {
  return env.DB.prepare(
    `INSERT INTO notification_consents (id, user_id, kind, agreed, policy_version, source, created_at)
     SELECT ?3, ?1, ?4, ?5, ?6, ?7, ?8 WHERE ${guard}`,
  ).bind(uid, version, crypto.randomUUID(), c.kind, c.agreed ? 1 : 0, NOTIFICATION_CONSENT_VERSION, source, now);
}

const TYPE_COLUMNS = NOTIFICATION_TYPES.map((t) => NOTIFICATION_TYPE_DB[t]);

/** Signup's two optional consents: a row only when service consent is given (no row is the same as none). */
export async function saveSignupConsent(env: Env, uid: string, consent: { service: boolean; night: boolean } | undefined, now: number): Promise<void> {
  if (!consent?.service) return;
  const night = consent.night;
  const guard = 'NOT EXISTS (SELECT 1 FROM notification_settings WHERE user_id = ?1)';
  await env.DB.batch([
    consentRow(env, uid, { kind: 'service', agreed: true }, 'signup', now, guard, 0),
    ...(night ? [consentRow(env, uid, { kind: 'night', agreed: true }, 'signup', now, guard, 0)] : []),
    env.DB.prepare(
      `INSERT INTO notification_settings (user_id, service, night, ${TYPE_COLUMNS.join(', ')}, version, service_at, night_at, updated_at)
       VALUES (?1, 1, ?2, ${TYPE_COLUMNS.map(() => '1').join(', ')}, 1, ?3, ?4, ?3) ON CONFLICT(user_id) DO NOTHING`,
    ).bind(uid, night ? 1 : 0, now, night ? now : null),
  ]);
}

export type SaveOutcome = { ok: true; settings: NotificationSettingsDto } | { ok: false; settings: NotificationSettingsDto };

/**
 * Applies a change made from `expectedVersion`. Withdrawing service consent withdraws night consent as well (it is
 * given again, if wanted, after service is); night consent without service is refused. Nothing changed: no new version
 * and no record.
 */
export async function saveSettings(env: Env, uid: string, body: NotificationSettingsSave, now: number): Promise<SaveOutcome> {
  const row = await readRow(env, uid);
  const cur = toDto(env, row);
  if (body.expectedVersion !== cur.version) return { ok: false, settings: cur };
  const service = body.service ?? cur.service;
  if (body.night === true && !service) fail(400, 'night_needs_service', 'night pushes need service pushes on');
  const night = service && (body.night ?? cur.night);
  const types = { ...cur.types };
  for (const t of NOTIFICATION_TYPES) {
    const v = body.types?.[t];
    if (v !== undefined) types[t] = v;
  }
  const consents: Consent[] = [];
  if (service !== cur.service) consents.push({ kind: 'service', agreed: service });
  if (night !== cur.night) consents.push({ kind: 'night', agreed: night });
  if (!consents.length && NOTIFICATION_TYPES.every((t) => types[t] === cur.types[t])) return { ok: true, settings: cur };
  const serviceAt = service !== cur.service ? now : cur.serviceAt;
  const nightAt = night !== cur.night ? now : cur.nightAt;
  // Every statement holds only while the row is still what this change was made from.
  const guard = row
    ? 'EXISTS (SELECT 1 FROM notification_settings WHERE user_id = ?1 AND version = ?2)'
    : 'NOT EXISTS (SELECT 1 FROM notification_settings WHERE user_id = ?1)';
  const typeValues = TYPE_COLUMNS.map((_, i) => (types[NOTIFICATION_TYPES[i]!] ? 1 : 0));
  const write = row
    ? env.DB.prepare(
        `UPDATE notification_settings SET service = ?3, night = ?4, ${TYPE_COLUMNS.map((c, i) => `${c} = ?${7 + i}`).join(', ')},
                version = version + 1, service_at = ?5, night_at = ?6, updated_at = ?${7 + TYPE_COLUMNS.length}
          WHERE user_id = ?1 AND version = ?2`,
      ).bind(uid, cur.version, service ? 1 : 0, night ? 1 : 0, serviceAt, nightAt, ...typeValues, now)
    : env.DB.prepare(
        `INSERT INTO notification_settings (user_id, service, night, ${TYPE_COLUMNS.join(', ')}, version, service_at, night_at, updated_at)
         VALUES (?1, ?3, ?4, ${TYPE_COLUMNS.map((_, i) => `?${7 + i}`).join(', ')}, 1, ?5, ?6, ?${7 + TYPE_COLUMNS.length})
         ON CONFLICT(user_id) DO NOTHING`,
      ).bind(uid, cur.version, service ? 1 : 0, night ? 1 : 0, serviceAt, nightAt, ...typeValues, now);
  const results = await env.DB.batch([...consents.map((c) => consentRow(env, uid, c, 'settings', now, guard, cur.version)), write]);
  if ((results.at(-1)?.meta.changes ?? 0) !== 1) return { ok: false, settings: await readSettings(env, uid) };
  // Withdrawn: the browsers registered go too (a push needs the consent at sending anyway), and pushes not sent yet.
  if (cur.service && !service)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ?1').bind(uid),
      env.DB.prepare(`DELETE FROM notification_events WHERE user_id = ?1 AND status = 'pending'`).bind(uid),
    ]);
  return { ok: true, settings: await readSettings(env, uid) };
}
