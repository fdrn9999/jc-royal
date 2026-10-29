import { writeOps } from '@jc/db';
import type { Context } from 'hono';
import { ADMIN_MONITOR_HUB, type AdminMonitorEvent, type AdminMonitorEventInput, type MonitorTable, type MonitorTableFlag, type MonitorTotals } from '@jc/types';
import type { AppEnv, Env } from '../env';
import { INTERNAL_HEADER } from '../routes/tables';
import type { SignOutScope } from './presence';
import { SWEEP_CLOSING_AFTER_MS } from './room';

/**
 * The control center (docs/CONTROL_CENTER.md): a table's row as its grid shows it, and publishing to its hub (the game
 * worker's AdminMonitorHub, administrators' console sockets only). As with the member hubs (lib/realtime.ts): only after
 * the D1 write it reports has committed, in the background, never failing or repeating what the request did; a hub that
 * cannot be reached loses the event and the console catches up on its next read or reconnect.
 */

export interface MonitorRow {
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

/** The columns the grid shows, by name (from `tables t LEFT JOIN users u ON u.id = t.created_by`): never join_code_hash or live_waitlist_users. */
export const MONITOR_COLUMNS = `t.id, t.name, t.room_type, t.status, t.max_seats, t.small_blind, t.big_blind, t.is_private, t.allow_spectators,
  t.beginner, t.entry_blocked, t.hands_paused, t.bots_enabled, t.live_seated, t.live_bots, t.live_playing, t.live_waitlist,
  t.live_spectators, t.live_connections, t.hands_played, t.last_issue, t.live_updated_at, t.created_at, t.updated_at,
  CASE WHEN t.room_type = 'member' THEN u.nickname END AS host`;

export function monitorTable(r: MonitorRow, now: number, seatedOnClosed: ReadonlySet<string>): MonitorTable {
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

const hubPost = async (env: Env, op: 'publish' | 'revoke', body: unknown): Promise<void> => {
  const stub = env.ADMIN_MONITOR.get(env.ADMIN_MONITOR.idFromName(ADMIN_MONITOR_HUB));
  const res = await stub.fetch(`https://admin-monitor/${op}`, {
    method: 'POST',
    headers: { [INTERNAL_HEADER]: env.INTERNAL_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`admin monitor ${op}: ${res.status}`);
};

/** Sends an event to the console pages (a followed room's summary only to those following it). A miss is counted (rt_undelivered), then thrown. */
export async function sendToAdmins(env: Env, e: AdminMonitorEventInput): Promise<void> {
  if (!env.ADMIN_MONITOR) return;
  try {
    await hubPost(env, 'publish', { event: { ...e, eventId: crypto.randomUUID(), occurredAt: Date.now() } as AdminMonitorEvent });
  } catch (err) {
    await writeOps(env.DB, 'rt_undelivered');
    throw err;
  }
}

/** In the background of a request, after its write: never throws, never delays the response. */
export function adminMonitorPublish(c: Context<AppEnv>, e: AdminMonitorEventInput) {
  c.executionCtx.waitUntil(sendToAdmins(c.env, e).catch((err) => console.warn('admin monitor publish failed', e.type, String(err))));
}

/**
 * After a table's settings, switches or status changed in D1: its row, as the grid lists it, to the console pages.
 * Read again here (one query) so the event carries what D1 has, not what the request meant to write.
 */
export function adminMonitorTableChanged(c: Context<AppEnv>, id: string) {
  const env = c.env;
  if (!env.ADMIN_MONITOR) return;
  c.executionCtx.waitUntil(
    (async () => {
      const r = await env.DB.prepare(
        `SELECT ${MONITOR_COLUMNS},
           CASE WHEN t.status = 'closed' AND EXISTS (SELECT 1 FROM table_sessions s WHERE s.table_id = t.id AND s.status = 'seated') THEN 1 ELSE 0 END AS stuck
         FROM tables t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?1`,
      )
        .bind(id)
        .first<MonitorRow & { stuck: number }>();
      if (!r) return;
      const table = monitorTable(r, Date.now(), new Set(r.stuck ? [r.id] : []));
      await sendToAdmins(env, { type: 'admin.monitor.table', resourceId: id, revision: table.updatedAt, table });
    })().catch((err) => console.warn('admin monitor table publish failed', String(err))),
  );
}

/**
 * After a tournament changed in D1 (lib/tournament.ts tournamentChanged): its version, to the console pages of
 * administrators with the tournaments permission, which read it again. Read here so the version is D1's.
 */
export async function adminTournamentChanged(env: Env, id: string): Promise<void> {
  if (!env.ADMIN_MONITOR) return;
  const r = await env.DB.prepare('SELECT version FROM tournaments WHERE id = ?1').bind(id).first<{ version: number }>();
  if (r) await sendToAdmins(env, { type: 'admin.monitor.changed', kind: 'tournament', resourceId: id, revision: r.version });
}

/**
 * Closes the console sockets of ended console sign-ins (logout, a session ended from the security page, a suspension, a
 * role taken away), or with `reauth` those of an administrator whose duties changed (the page reconnects and the api
 * checks again). Tried twice, as realtimeSignOut; a revoke the hub never hears of leaves the socket open until the hub's
 * sweep finds the sign-in or the duty gone (MONITOR_SWEEP_MS).
 */
export function adminMonitorRevoke(c: Context<AppEnv>, scope: SignOutScope, opts: { reauth?: boolean } = {}) {
  if (!c.env.ADMIN_MONITOR) return;
  const body = { ...scope, at: Date.now(), ...(opts.reauth ? { reauth: true } : {}) };
  c.executionCtx.waitUntil(
    hubPost(c.env, 'revoke', body)
      .catch(() => hubPost(c.env, 'revoke', body))
      .catch((err) => {
        console.warn('admin monitor revoke not delivered', String(err));
        return writeOps(c.env.DB, 'rt_revoke_fail');
      }),
  );
}
