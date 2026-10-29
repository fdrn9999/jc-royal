/**
 * VIP members (packages/types/src/vip.ts). Mounted inside the admin router: an admin session, the admin origin and the
 * permission table's rule (feature `vip`: a super admin, or an administrator whose `vip` switch is on; the password
 * confirmed for a change; preview) are already applied.
 *
 * - VIP is a name color and a mark, nothing more: no game, wallet, ledger, seat, tournament or console code reads it.
 * - Only an ordinary member can be made VIP: a table bot (409 bot_account), staff (409 vip_staff) or a deleted account
 *   (409 vip_deleted) is refused, and the refusal is on the audit log (auditFailures: `user.vip.failed`). A suspended
 *   member keeps it, hidden from other players until the suspension ends.
 * - `expectedVersion` is the version the page showed. Asking for the state the member already has changes nothing
 *   (200, changed: false), so a repeated request is safe; any other request on an older version is refused (409
 *   vip_conflict, with the state as it is now), and so is a change that lost a race to another administrator.
 * - Each change raises the version and records when and by whom; the audit row (`user.vip`) keeps the color before and
 *   after, and the reason. The tables where the member sits redraw the name: nobody is disconnected and no hand is
 *   touched. Other members' open pages that show the name (friends, conversations, board, lobby hosts) get the shown
 *   color alone (realtime `member.vip.changed`), never the reason or who changed it.
 */
import {
  AdminVipPreviewSchema,
  AdminVipSchema,
  VIP_DEFAULT_COLOR,
  isVipColor,
  shownVip,
  vipIneligible,
  type AdminVipDto,
  type AdminVipPreviewDto,
  type AdminVipResultDto,
  type VipColor,
} from '@jc/types';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { fail, isPreview, parseBody } from '../lib/http';
import { realtimeToAll, realtimeToUsers } from '../lib/realtime';
import { refreshVipEverywhere } from '../lib/room';

interface Row {
  id: string;
  nickname: string;
  role: string;
  status: string;
  is_bot: number;
  vip_color: string | null;
  vip_version: number;
  vip_changed_at: number | null;
  vip_changed_by: string | null;
  changed_by_nickname: string | null;
}

function toDto(r: Row): AdminVipDto {
  return {
    member: { id: r.id, nickname: r.nickname, role: r.role, status: r.status, isBot: !!r.is_bot },
    color: isVipColor(r.vip_color) ? r.vip_color : null,
    version: r.vip_version,
    changedAt: r.vip_changed_at,
    changedBy: r.vip_changed_by ? { id: r.vip_changed_by, nickname: r.changed_by_nickname } : null,
    ineligible: vipIneligible({ role: r.role, status: r.status, isBot: r.is_bot }),
  };
}

async function load(c: Context<AppEnv>, id: string): Promise<AdminVipDto> {
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.nickname, u.role, u.status, u.is_bot, u.vip_color, u.vip_version, u.vip_changed_at, u.vip_changed_by, b.nickname AS changed_by_nickname
       FROM users u LEFT JOIN users b ON b.id = u.vip_changed_by WHERE u.id = ?1`,
  )
    .bind(id)
    .first<Row>();
  if (!row) fail(404, 'not_found', 'user not found');
  return toDto(row);
}

/** An account that cannot be made VIP. Ending a color such an account still has is allowed (it only tidies up). */
function refuse(vip: AdminVipDto, to: VipColor | null) {
  if (!vip.ineligible || (to === null && vip.color !== null)) return;
  if (vip.ineligible === 'bot') fail(409, 'bot_account', 'table bot accounts are never VIP', { vip });
  if (vip.ineligible === 'deleted') fail(409, 'vip_deleted', 'a deleted account cannot be made VIP', { vip });
  fail(409, 'vip_staff', 'administrators are never VIP', { vip });
}

export const adminVipRoutes = new Hono<AppEnv>()
  .get('/users/:id/vip', async (c) => c.json(await load(c, c.req.param('id'))))
  /**
   * `{enabled: true, color?}` makes the member VIP (gold unless a color is given) or changes their color;
   * `{enabled: false}` ends it. `reason` and `expectedVersion` always; `preview: true` (no reason needed) answers with
   * the change as it would be made now and writes nothing.
   */
  .patch('/users/:id/vip', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? AdminVipPreviewSchema : AdminVipSchema);
    const vip = await load(c, id);
    const from = vip.color;
    const to: VipColor | null = body.enabled ? (body.color ?? from ?? VIP_DEFAULT_COLOR) : null;
    refuse(vip, to);
    const changed = from !== to;
    if (changed && body.expectedVersion !== vip.version) fail(409, 'vip_conflict', 'the VIP state changed since it was opened', { vip });
    const db = c.env.DB;
    if (preview) {
      const seated = await db
        .prepare(`SELECT COUNT(DISTINCT table_id) AS n FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`)
        .bind(id)
        .first<{ n: number }>();
      return c.json({ preview: true, from, to, version: vip.version, changed, tables: seated?.n ?? 0, vip } satisfies AdminVipPreviewDto);
    }
    const { reason } = AdminVipSchema.parse(body);
    const target = { type: 'user', id };
    if (!changed) {
      await audit(c, 'user.vip', target, { from, to, reason, changed: false, version: vip.version });
      return c.json({ changed: false, vip, tables: 0, reached: 0 } satisfies AdminVipResultDto);
    }
    const now = Date.now();
    // Only from the version the request named, and only onto an account that may carry it (ending one always).
    const done = await db
      .prepare(
        `UPDATE users SET vip_color = ?2, vip_version = vip_version + 1, vip_changed_at = ?3, vip_changed_by = ?4, updated_at = ?3
          WHERE id = ?1 AND vip_version = ?5 AND (?2 IS NULL OR (role = 'user' AND is_bot = 0 AND status != 'deleted'))
          RETURNING vip_version`,
      )
      .bind(id, to, now, c.var.user!.id, vip.version)
      .first<{ vip_version: number }>();
    if (!done) fail(409, 'vip_conflict', 'the VIP state changed while saving', { vip: await load(c, id) });
    await audit(c, 'user.vip', target, { from, to, reason, change: from === null ? 'assign' : to === null ? 'remove' : 'color', version: done.vip_version });
    // The member's own pages read their account again (the color shown on their name); nothing else in the event.
    realtimeToUsers(c, [id], { scope: 'user', type: 'account.changed' });
    const after = await load(c, id);
    // What other players see (nothing while the member is suspended); the room never reads more than this.
    const shown = shownVip({ role: after.member.role, status: after.member.status, isBot: after.member.isBot, vipColor: after.color }) ?? null;
    // Other members' open pages that show this name: the shown color only, and only when it changed (a suspended
    // member's stays hidden, so a change to theirs says nothing to anyone).
    const before = shownVip({ role: vip.member.role, status: vip.member.status, isBot: vip.member.isBot, vipColor: from }) ?? null;
    if (shown !== before) realtimeToAll(c, { scope: 'service', type: 'member.vip.changed', resourceId: id, revision: after.version, payload: { vip: shown } });
    const rooms = await refreshVipEverywhere(c.env, id, shown);
    return c.json({ changed: true, vip: after, tables: rooms.tables, reached: rooms.reached } satisfies AdminVipResultDto);
  });
