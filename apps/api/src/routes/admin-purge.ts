/**
 * Permanent removal (lib/purge.ts, docs/ADMIN_SECURITY.md "영구 삭제"): `preview: true` answers the plan (what goes,
 * what stays, what blocks it, the fingerprint and the text to type) and writes nothing; the removal sends the reason,
 * the typed text and the preview's fingerprint. Mounted inside the admin router: an admin session, the admin origin and
 * the permission rule (super admin `data.purge`, the password confirmed for the removal, not for the preview) are
 * applied already. The ordinary delete (status / deleted_at) stays where it was and is never turned into this.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { fail, isPreview, parseBody } from '../lib/http';
import { planPurge, runPurge, type PurgeBlocker, type PurgeKind } from '../lib/purge';
import { clientIp } from '../lib/rate-limit';
import { roomCall } from '../lib/room';

const PurgeSchema = z.object({
  reason: z.string().trim().min(2).max(200),
  confirm: z.string().trim().max(40),
  fingerprint: z.string().min(1).max(128),
});

/**
 * What a closed table's room says D1 cannot: someone still connected or seated, a hand in it. A room that does not
 * answer blocks too (no one can say it is empty).
 */
async function roomBlockers(c: Context<AppEnv>, id: string): Promise<PurgeBlocker[]> {
  const live = await roomCall(c, id, 'status');
  if (!live) return [{ code: 'room_unreachable', count: 1 }];
  const seated = Array.isArray(live.seats) ? live.seats.filter((s) => s !== null).length : 0;
  const connections = typeof live.connections === 'number' ? live.connections : 0;
  return [
    ...(seated > 0 ? [{ code: 'room_seated', count: seated }] : []),
    ...(connections > 0 ? [{ code: 'room_connections', count: connections }] : []),
    ...(live.handInProgress ? [{ code: 'room_hand', count: 1 }] : []),
  ];
}

async function purge(c: Context<AppEnv>, kind: PurgeKind, action: string) {
  const id = c.req.param('id')!;
  const planned = await planPurge(c.env.DB, kind, id, kind === 'table' ? () => roomBlockers(c, id) : undefined);
  if (!planned) fail(404, 'not_found', `${kind} not found`);
  const { plan, read } = planned;
  if (await isPreview(c)) return c.json({ preview: true, ...plan });
  const body = await parseBody(c, PurgeSchema);
  // Decided on what the administrator saw: anything since (a comment, an edit, a restored template) is shown again.
  if (body.fingerprint !== plan.fingerprint) fail(409, 'purge_changed', 'the target changed since the preview', { plan });
  if (!plan.deletable) fail(409, 'purge_blocked', 'this cannot be removed permanently', { blockers: plan.blockers });
  if (body.confirm !== plan.confirmText) fail(400, 'purge_confirm', 'the typed confirmation does not match');
  const auditId = crypto.randomUUID();
  const detail = {
    reason: body.reason,
    class: 'B',
    removed: plan.removes,
    kept: plan.keeps,
    fingerprint: plan.fingerprint,
    // One super admin with the password confirmed; a second approver is not asked for (docs/ADMIN_SECURITY.md).
    approval: { mode: 'single', role: 'super_admin', reauth: true },
    ...read.facts,
  };
  let done: boolean;
  try {
    done = await runPurge(c.env.DB, read, { id: auditId, actorId: c.var.user!.id, action, targetType: kind, targetId: id, detail, ip: clientIp(c), at: Date.now() });
  } catch (e) {
    console.error('purge failed', kind, e instanceof Error ? e.message : String(e));
    fail(500, 'purge_failed', 'nothing was removed; try again');
  }
  // Changed or blocked between the read and the batch (another administrator, a new comment): nothing was written.
  if (!done) fail(409, 'purge_changed', 'the target changed during the removal; nothing was removed');
  c.set('audited', true);
  return c.json({ ok: true, auditId, removed: plan.removes });
}

export const adminPurgeRoutes = new Hono<AppEnv>()
  .post('/board/posts/:id/purge', (c) => purge(c, 'post', 'board.post.purge'))
  .post('/tables/:id/purge', (c) => purge(c, 'table', 'table.purge'))
  .post('/tournament-templates/:id/purge', (c) => purge(c, 'tournament_template', 'tournament_template.purge'));
