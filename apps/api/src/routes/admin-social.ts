/**
 * Social administration (packages/types/src/social.ts SocialSettings): quick reactions at the tables and which staff
 * roles carry their badge where other players see them. Mounted inside the admin router: an admin session, the admin
 * origin and the permission table's rule are already applied.
 *
 * - The policy is a super admin's, with the password, a reason and a preview of the old and new values. A change is a
 *   new version row; two administrators editing from the same version: the second is told it changed (409) and shown the
 *   current one.
 * - Where it applies: the api reads it for every reply with a staff member in it (lobby host, board, friends, replays),
 *   so from the next request. The rooms hold it: open tables with someone connected are told to reload (reactions and
 *   seats with the next view, the chat on screen sent again); one not asked or not answering takes it with its next hand
 *   record. Nothing stored changes: a hidden badge comes back when it is shown again.
 * - Nothing here is about one member: no route sets anyone's badge, and a member's role is still changed only by
 *   POST /users/:id/role.
 */
import { SOCIAL_DEFAULTS, SOCIAL_LIMITS, type SocialSettings } from '@jc/types';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { fail, isPreview, parseBody } from '../lib/http';
import { pick } from '../lib/pick';
import { roomCall } from '../lib/room';

const ReasonSchema = z.string().trim().min(2).max(200);
const L = SOCIAL_LIMITS;
const PolicyFields = {
  /** The version the administrator was looking at: a newer one meanwhile is a conflict. */
  baseVersion: z.number().int().min(0),
  reactionsEnabled: z.boolean(),
  cooldownMs: z.number().int().min(L.cooldownMs.min).max(L.cooldownMs.max),
  burstMax: z.number().int().min(L.burstMax.min).max(L.burstMax.max),
  burstWindowMs: z.number().int().min(L.burstWindowMs.min).max(L.burstWindowMs.max),
  showSuperAdmin: z.boolean(),
  showAdmin: z.boolean(),
};
const PolicySchema = z.object({ ...PolicyFields, reason: ReasonSchema });
const PolicyPreviewSchema = z.object({ ...PolicyFields, reason: ReasonSchema.optional() });

/** Where a new version takes effect: api replies from the next request, rooms when they reload (or record a hand). */
export const SOCIAL_APPLIES_FROM = 'next_request';
/** Most tables one change asks to reload; the rest take it with their next hand record. */
const RELOAD_MAX = 100;

export interface SocialPolicyRow extends SocialSettings {
  version: number;
  change: string;
  actorId: string | null;
  actorNickname: string | null;
  reason: string | null;
  createdAt: number;
}

const POLICY_COLUMNS = `p.version, p.reactions_enabled AS reactionsEnabled, p.reaction_cooldown_ms AS cooldownMs, p.reaction_burst_max AS burstMax,
  p.reaction_burst_window_ms AS burstWindowMs, p.show_super_admin AS showSuperAdmin, p.show_admin AS showAdmin, p.change, p.actor_id AS actorId,
  p.reason, p.created_at AS createdAt, u.nickname AS actorNickname`;
const policyOf = (r: Record<string, unknown>): SocialPolicyRow => ({
  version: Number(r.version),
  reactionsEnabled: Number(r.reactionsEnabled) === 1,
  cooldownMs: Number(r.cooldownMs),
  burstMax: Number(r.burstMax),
  burstWindowMs: Number(r.burstWindowMs),
  showSuperAdmin: Number(r.showSuperAdmin) === 1,
  showAdmin: Number(r.showAdmin) === 1,
  change: String(r.change),
  actorId: (r.actorId as string | null) ?? null,
  actorNickname: (r.actorNickname as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  createdAt: Number(r.createdAt),
});
const SETTINGS = ['reactionsEnabled', 'cooldownMs', 'burstMax', 'burstWindowMs', 'showSuperAdmin', 'showAdmin'] as const;
const settingsOf = (p: SocialSettings): SocialSettings => pick(p, SETTINGS);
const brief = (p: SocialPolicyRow | null) => (p ? { version: p.version, ...settingsOf(p) } : null);

async function currentPolicy(db: D1Database): Promise<SocialPolicyRow | null> {
  const r = await db.prepare(`SELECT ${POLICY_COLUMNS} FROM social_policies p LEFT JOIN users u ON u.id = p.actor_id ORDER BY p.version DESC LIMIT 1`).first<Record<string, unknown>>();
  return r ? policyOf(r) : null;
}

function conflict(current: SocialPolicyRow | null): never {
  fail(409, 'social_policy_conflict', 'the social policy changed meanwhile', { policy: brief(current) });
}

/** Tables a room holds the policy for and someone sees: open or closing, with a connection (seated, waiting or watching). */
const LIVE_TABLES = `status IN ('open', 'closing') AND live_connections > 0`;

/**
 * Tells the tables someone is connected to to read the policy again, most connections first, at most RELOAD_MAX. A table
 * not asked or not answering takes the new version with its next hand record; one nobody is at reads it when it next loads.
 */
async function reloadTables(c: Context<AppEnv>) {
  const { results } = await c.env.DB.prepare(`SELECT id FROM tables WHERE ${LIVE_TABLES} ORDER BY live_connections DESC LIMIT ?1`)
    .bind(RELOAD_MAX + 1)
    .all<{ id: string }>();
  const asked = results.slice(0, RELOAD_MAX);
  const answers = await Promise.all(asked.map(async ({ id }) => (await roomCall(c, id, 'reload')) ?? (await roomCall(c, id, 'reload'))));
  const unreached = asked.filter((_, i) => !answers[i]).map((t) => t.id);
  return { tables: asked.length, reached: asked.length - unreached.length, unreached, more: results.length > RELOAD_MAX };
}

/** Writes the next version from `from` (still the latest), or reports the conflict. */
async function writeVersion(c: Context<AppEnv>, from: SocialPolicyRow | null, next: SocialSettings, reason: string) {
  const r = await c.env.DB.prepare(
    `INSERT INTO social_policies (version, reactions_enabled, reaction_cooldown_ms, reaction_burst_max, reaction_burst_window_ms, show_super_admin, show_admin, change, actor_id, reason, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'policy', ?8, ?9, ?10
      WHERE COALESCE((SELECT MAX(version) FROM social_policies), 0) = ?11
     ON CONFLICT (version) DO NOTHING`,
  )
    .bind(
      (from?.version ?? 0) + 1,
      next.reactionsEnabled ? 1 : 0,
      next.cooldownMs,
      next.burstMax,
      next.burstWindowMs,
      next.showSuperAdmin ? 1 : 0,
      next.showAdmin ? 1 : 0,
      c.var.user!.id,
      reason,
      Date.now(),
      from?.version ?? 0,
    )
    .run();
  if (!r.meta.changes) conflict(await currentPolicy(c.env.DB));
  return { version: (from?.version ?? 0) + 1, ...next };
}

/** What changes for players, for the preview and the audit row (badge: which roles start or stop showing theirs). */
function effects(from: SocialSettings, to: SocialSettings) {
  return {
    reactions: from.reactionsEnabled === to.reactionsEnabled ? 'same' : to.reactionsEnabled ? 'on' : 'off',
    limits: SETTINGS.slice(1, 4).some((k) => from[k] !== to[k]),
    badgesShown: (['super_admin', 'admin'] as const).filter((r) => !shows(from, r) && shows(to, r)),
    badgesHidden: (['super_admin', 'admin'] as const).filter((r) => shows(from, r) && !shows(to, r)),
  };
}
const shows = (p: SocialSettings, role: 'admin' | 'super_admin') => (role === 'admin' ? p.showAdmin : p.showSuperAdmin);

export const adminSocialRoutes = new Hono<AppEnv>()
  /** The policy and its latest versions, the limits and defaults, and how many tables a change would reach now. */
  .get('/social', async (c) => {
    const db = c.env.DB;
    const [versions, live] = await db.batch([
      db.prepare(`SELECT ${POLICY_COLUMNS} FROM social_policies p LEFT JOIN users u ON u.id = p.actor_id ORDER BY p.version DESC LIMIT 20`),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(live_connections), 0) AS connections FROM tables WHERE ${LIVE_TABLES}`),
    ]);
    const list = ((versions?.results ?? []) as Record<string, unknown>[]).map(policyOf);
    const t = (live?.results?.[0] ?? {}) as { n?: number; connections?: number };
    return c.json({
      now: Date.now(),
      policy: list[0] ?? null,
      versions: list,
      limits: SOCIAL_LIMITS,
      defaults: SOCIAL_DEFAULTS,
      appliesFrom: SOCIAL_APPLIES_FROM,
      tables: { live: Number(t.n ?? 0), connections: Number(t.connections ?? 0), reloadMax: RELOAD_MAX },
    });
  })
  /** A new policy version. `preview`: the old and new values, what changes for players and the tables told to reload. */
  .put('/social/policy', async (c) => {
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? PolicyPreviewSchema : PolicySchema);
    const next = settingsOf(body);
    const current = await currentPolicy(c.env.DB);
    if ((current?.version ?? 0) !== body.baseVersion) conflict(current);
    const base = current ?? SOCIAL_DEFAULTS;
    if (SETTINGS.every((k) => base[k] === next[k])) fail(400, 'social_no_change', 'the policy is the same as now');
    const change = effects(base, next);
    if (preview) {
      const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM tables WHERE ${LIVE_TABLES}`).first<{ n: number }>();
      return c.json({ preview: true, from: brief(current), to: { version: body.baseVersion + 1, ...next }, appliesFrom: SOCIAL_APPLIES_FROM, effects: change, tables: Math.min(Number(r?.n ?? 0), RELOAD_MAX), more: Number(r?.n ?? 0) > RELOAD_MAX });
    }
    const to = await writeVersion(c, current, next, body.reason!);
    const rooms = await reloadTables(c);
    await audit(c, 'social.policy', undefined, {
      from: brief(current),
      to,
      reason: body.reason,
      effects: change,
      appliesFrom: SOCIAL_APPLIES_FROM,
      rooms: { tables: rooms.tables, reached: rooms.reached, more: rooms.more },
    });
    return c.json({ ok: true, policy: to, appliesFrom: SOCIAL_APPLIES_FROM, effects: change, rooms });
  });
