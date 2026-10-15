/**
 * Members' own rooms. A member opens a room with stakes from fixed presets; it then plays like any table: the room
 * deals and checks seats and join codes, and buy-ins and cash-outs go through the wallet ledger. The host can
 * rename it, change spectating and the join code, and close it (everyone seated is cashed out). The host never
 * gets chips, cards, other players' hands or results. A room nobody sits in closes by itself (MEMBER_IDLE_CLOSE_MS).
 */
import { schema } from '@jc/db';
import { MAX_ACTIVE_ROOMS, RoomCreateSchema, RoomPatchSchema } from '@jc/types';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { sha256 } from '../lib/crypto';
import { fail, parseBody } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import { roomCallEnv, roomCallOrFail } from '../lib/room';

const TURN_SECONDS = 20;

/** The caller's own open room; official tables and other members' rooms are not theirs to change. */
async function hostedRoom(c: Context<AppEnv>, id: string) {
  const t = await c.var.db.query.tables.findFirst({ where: eq(schema.tables.id, id) });
  if (!t || t.roomType !== 'member' || t.status === 'closed') fail(404, 'not_found', 'room not found');
  if (t.createdBy !== c.var.user!.id) fail(403, 'forbidden', 'only the host can change this room');
  return t;
}

export const roomRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .post('/', async (c) => {
    const body = await parseBody(c, RoomCreateSchema);
    const me = c.var.user!.id;
    await rateLimit(c, `room-create:${me}`, 5, 60 * 60_000);
    const id = crypto.randomUUID().slice(0, 12);
    const now = Date.now();
    const joinCodeHash = body.isPrivate && body.joinCode ? await sha256(`${id}:${body.joinCode}`) : null;
    // The per-member limit is checked in the same statement as the insert, so two creates at once cannot both pass.
    const r = await c.env.DB.prepare(
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, is_private, join_code_hash,
                           allow_spectators, room_type, created_by, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'member', ?12, ?13, ?13
        WHERE (SELECT COUNT(*) FROM tables WHERE created_by = ?12 AND room_type = 'member' AND status != 'closed') < ?14`,
    )
      .bind(id, body.name, body.maxSeats, body.bigBlind / 2, body.bigBlind, body.minBuyIn, body.maxBuyIn, TURN_SECONDS, body.isPrivate ? 1 : 0, joinCodeHash, body.allowSpectators ? 1 : 0, me, now, MAX_ACTIVE_ROOMS)
      .run();
    if (!r.meta.changes) fail(409, 'room_limit', `at most ${MAX_ACTIVE_ROOMS} open rooms per member`);
    // Wake the room so its empty-room timer runs even if nobody comes. A room that cannot be woken would stay listed
    // and count toward the limit with no timer to close it, so the new (still empty) row is closed and the member retries.
    if (!(await roomCallEnv(c.env, id, 'reload')) && !(await roomCallEnv(c.env, id, 'reload'))) {
      await c.env.DB.prepare(`UPDATE tables SET status = 'closed', updated_at = ?2 WHERE id = ?1 AND status = 'open'`).bind(id, Date.now()).run();
      fail(503, 'room_unavailable', 'the room could not be opened; try again');
    }
    return c.json({ id }, 201);
  })
  .patch('/:id', async (c) => {
    const body = await parseBody(c, RoomPatchSchema);
    const t = await hostedRoom(c, c.req.param('id'));
    const isPrivate = body.isPrivate ?? t.isPrivate;
    let joinCodeHash = t.joinCodeHash;
    if (body.joinCode !== undefined) joinCodeHash = body.joinCode ? await sha256(`${t.id}:${body.joinCode}`) : null;
    if (isPrivate && !joinCodeHash) fail(400, 'bad_request', 'private rooms need a join code');
    await c.var.db
      .update(schema.tables)
      .set({ name: body.name ?? t.name, isPrivate, joinCodeHash: isPrivate ? joinCodeHash : null, allowSpectators: body.allowSpectators ?? t.allowSpectators, updatedAt: Date.now() })
      .where(eq(schema.tables.id, t.id));
    // Seated players keep their seats; a new join code applies to people arriving from now on. The change is saved
    // either way; if the room does not confirm it, the host is told to send it again.
    await roomCallOrFail(c, t.id, 'reload', { saved: true });
    return c.json({ ok: true });
  })
  .post('/:id/close', async (c) => {
    const t = await hostedRoom(c, c.req.param('id'));
    // As for an admin close: no new hands, the current hand finishes, everyone is cashed out, then it closes.
    await c.var.db.update(schema.tables).set({ status: 'closing', entryBlocked: true, updatedAt: Date.now() }).where(eq(schema.tables.id, t.id));
    // The room must take the close on; if it cannot be reached now the table stays 'closing' (no one can join) and
    // the host retries. The room also finishes a close it finds in D1 when it next loads.
    const live = await roomCallOrFail(c, t.id, 'close');
    return c.json({ ok: true, closed: live.closed === true });
  });
