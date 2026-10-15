import type { MaintenanceDto, ServiceNoticeDto, ServiceStatusDto } from '@jc/types';
import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { fail } from './http';
import { roomCallEnv } from './room';

/** The unfinished maintenance window (planned or under way); the game worker reads the same row (settlement.ts). */
const MAINTENANCE_SQL = `SELECT id, starts_at AS startsAt, ends_at AS endsAt, block_login AS blockLogin, message_ko AS messageKo, message_en AS messageEn
  FROM maintenance_windows WHERE ended_at IS NULL AND cancelled_at IS NULL AND ends_at > ?1 ORDER BY starts_at LIMIT 1`;

/** Most notices a page is sent. */
const NOTICE_LIMIT = 20;

/**
 * Notices still to be shown: those showing now first (urgent, then maintenance, then general; the newest first within
 * each), then those yet to start, soonest first. One more than the limit is read to tell whether the list was cut;
 * `edge` (the same on every row) is the next time any of them starts or ends.
 */
const NOTICES_SQL = `SELECT id, kind, title_ko AS titleKo, title_en AS titleEn, body_ko AS bodyKo, body_en AS bodyEn,
         starts_at AS startsAt, ends_at AS endsAt, post_id AS postId,
         MIN(CASE WHEN starts_at > ?1 THEN starts_at ELSE ends_at END) OVER () AS edge
  FROM service_notices WHERE deleted_at IS NULL AND (ends_at IS NULL OR ends_at > ?1)
  ORDER BY starts_at > ?1, CASE kind WHEN 'urgent' THEN 0 WHEN 'maintenance' THEN 1 ELSE 2 END,
    CASE WHEN starts_at > ?1 THEN starts_at ELSE -starts_at END, created_at DESC
  LIMIT ${NOTICE_LIMIT + 1}`;

/** A scalar that changes with every admin edit of a notice or a window (both write updated_at). */
export const SERVICE_REV_SQL = `(SELECT COALESCE(MAX(r), 0) FROM (SELECT MAX(updated_at) AS r FROM service_notices UNION ALL SELECT MAX(updated_at) FROM maintenance_windows))`;

interface MaintenanceRow {
  id: string;
  startsAt: number;
  endsAt: number;
  blockLogin: number;
  messageKo: string | null;
  messageEn: string | null;
}

function toMaintenance(r: MaintenanceRow | null | undefined, now: number): MaintenanceDto | null {
  if (!r) return null;
  return { id: r.id, startsAt: r.startsAt, endsAt: r.endsAt, blockLogin: !!r.blockLogin, messageKo: r.messageKo, messageEn: r.messageEn, active: r.startsAt <= now };
}

export async function currentMaintenance(d1: D1Database, now = Date.now()): Promise<MaintenanceDto | null> {
  return toMaintenance(await d1.prepare(MAINTENANCE_SQL).bind(now).first<MaintenanceRow>(), now);
}

/** What every page shows: notices and maintenance, read in one round trip. */
export async function serviceStatus(d1: D1Database, now = Date.now()): Promise<ServiceStatusDto> {
  const [notices, maintenance, rev] = await d1.batch<Record<string, unknown>>([
    d1.prepare(NOTICES_SQL).bind(now),
    d1.prepare(MAINTENANCE_SQL).bind(now),
    d1.prepare(`SELECT ${SERVICE_REV_SQL} AS rev`),
  ]);
  const rows = (notices?.results ?? []) as unknown as (ServiceNoticeDto & { edge?: number | null })[];
  // A page holding the whole list starts and ends notices itself; one holding a cut list asks again at the next edge,
  // when a notice may come into it.
  const cut = rows.length > NOTICE_LIMIT;
  const refreshAt = cut ? (rows[0]!.edge ?? null) : null;
  for (const r of rows) delete r.edge;
  return {
    now,
    rev: Number(rev?.results[0]?.rev ?? 0),
    notices: rows.slice(0, NOTICE_LIMIT),
    refreshAt,
    maintenance: toMaintenance(maintenance?.results[0] as MaintenanceRow | undefined, now),
  };
}

/** New games (quick play, a member room) wait while maintenance is under way. Tables refuse seats on their own as well. */
export async function refuseNewGamesInMaintenance(c: Context<AppEnv>) {
  const m = await currentMaintenance(c.env.DB);
  if (m?.active) fail(503, 'maintenance', 'service maintenance: no new games until it ends', { endsAt: m.endsAt });
}

/**
 * Sign-in and sign-up wait during maintenance that blocks them, except for staff (an admin signs in to the game to
 * check it before it reopens). Sessions already open stay; the admin console has its own sign-in and is never blocked.
 */
export async function refuseSignInInMaintenance(c: Context<AppEnv>, role?: 'user' | 'admin' | 'super_admin') {
  if (role === 'admin' || role === 'super_admin') return;
  const m = await currentMaintenance(c.env.DB);
  if (m?.active && m.blockLogin) fail(503, 'maintenance', 'service maintenance: sign-in reopens when it ends', { endsAt: m.endsAt });
}

/** Most rooms one maintenance change asks right away; the others learn of it at their next D1 write or alarm. */
export const MAINTENANCE_MAX_ROOMS = 60;

export interface RoomFanOut {
  tables: number;
  reached: number;
  /** Rooms that did not answer; they take the change on with their next occupancy write or at the window's edges. */
  unreached: string[];
  /** More tables were in use than were asked. */
  truncated: boolean;
}

/**
 * Tells tables in use (someone connected or seated) that maintenance was planned, moved or ended, so their players see
 * it now and a room stops or resumes dealing on time. Asked in parallel, each twice at most. A room asked to reload
 * changes nothing else: settings, seats and chips stay as they are.
 */
export async function tellRoomsAboutMaintenance(env: Env): Promise<RoomFanOut> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM tables WHERE status IN ('open', 'closing') AND (live_connections > 0 OR live_seated > 0) ORDER BY live_connections DESC LIMIT ?1`,
  )
    .bind(MAINTENANCE_MAX_ROOMS + 1)
    .all<{ id: string }>();
  const asked = results.slice(0, MAINTENANCE_MAX_ROOMS);
  const answers = await Promise.all(asked.map(async ({ id }) => ({ id, r: (await roomCallEnv(env, id, 'reload')) ?? (await roomCallEnv(env, id, 'reload')) })));
  return {
    tables: asked.length,
    reached: answers.filter((a) => a.r).length,
    unreached: answers.filter((a) => !a.r).map((a) => a.id),
    truncated: results.length > asked.length,
  };
}
