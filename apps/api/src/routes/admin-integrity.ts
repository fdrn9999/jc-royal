/**
 * Integrity signs (lib/integrity.ts): pairs of members whose hands together look like chips passed on purpose, for an
 * operator to look into. Nothing here sanctions anyone: a review opens a report with the evidence in the existing
 * report queue, where it is worked, decided and (if it comes to that) followed by a suspension like any other report.
 */
import { schema } from '@jc/db';
import { INTEGRITY_DAYS, type ReportContext } from '@jc/types';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { fail, parseBody } from '../lib/http';
import { integrity, integrityPair } from '../lib/integrity';
import { looksPersonal } from '../lib/pii';
import { isUniqueViolation } from './auth';

const days = (v: unknown) => ((INTEGRITY_DAYS as readonly number[]).includes(Number(v)) ? Number(v) : INTEGRITY_DAYS[0]);

const ReviewSchema = z.object({
  /** The member whose chips went over, and the member who received them, as the list gave them. */
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  days: z.number().int().optional(),
  /** Why the operator opens it; kept as the report's detail and in the audit row. */
  reason: z.string().trim().min(2).max(300),
});

/** Mounted inside the admin router (requireAdmin and the permission rules already applied). */
export const adminIntegrityRoutes = new Hono<AppEnv>()
  /** The last 7 or 30 days' pairs, highest band first. Read when the page is opened (the console does not poll it). */
  .get('/integrity', async (c) => {
    const span = days(c.req.query('days'));
    const at = Date.now();
    const out = await integrity(c.env.DB, span, at);
    const d1Ms = Date.now() - at;
    // The list says which members played as pairs and shared a network, so every look is recorded.
    await audit(c, 'integrity.view', undefined, { days: span, pairs: out.pairs.length, found: out.found });
    return c.json({ ...out, at, d1Ms });
  })
  /**
   * Opens a review of one pair: a 'cheating' report on the member who received the chips, filed by the operator, with
   * the signs and hands worked out again here (not taken from the page) as its evidence and the other member named in
   * it. Refused when the pair no longer meets the signs, for a table bot, and when one is already open for the pair.
   */
  .post('/integrity/review', async (c) => {
    const body = await parseBody(c, ReviewSchema);
    if (looksPersonal(body.reason)) fail(400, 'note_pii', 'a reason must not hold e-mail addresses, phone, card or ID numbers');
    if (body.from === body.to) fail(400, 'invalid_input', 'a pair is two members');
    const span = days(body.days);
    const DB = c.env.DB;
    const people = (await DB.prepare(`SELECT id, nickname, is_bot AS bot FROM users WHERE id IN (?1, ?2)`).bind(body.from, body.to).all<{ id: string; nickname: string; bot: number }>()).results;
    if (people.length < 2) fail(404, 'not_found', 'member not found');
    if (people.some((p) => p.bot)) fail(409, 'bot_account', 'table bots are not reviewed');
    const at = Date.now();
    const read = await integrityPair(DB, body.from, body.to, span, at);
    if (!read || read.pair.from !== body.from || read.pair.to !== body.to) fail(409, 'not_flagged', 'the pair no longer meets the signs');
    const open = await DB.prepare(
      `SELECT id FROM reports WHERE status = 'open' AND target_user_id = ?1 AND target_type = 'player'
          AND json_extract(context, '$.kind') = 'signal' AND json_extract(context, '$.partnerId') = ?2 LIMIT 1`,
    )
      .bind(body.to, body.from)
      .first<{ id: string }>();
    if (open) fail(409, 'already_reported', 'a review of this pair is already open', { reportId: open.id });
    const { pair } = read;
    const partner = people.find((p) => p.id === body.from)!;
    const context: ReportContext = {
      kind: 'signal',
      partnerId: pair.from,
      partnerNickname: partner.nickname,
      days: span,
      since: read.since,
      signals: pair.signals,
      risk: pair.risk,
      shared: pair.shared,
      flowBb: pair.flowBb,
      oneWay: pair.oneWay,
      dumps: pair.dumps,
      hands: pair.hands.map((h) => ({ id: h.id, number: h.handNumber, tableId: h.tableId, bb: h.bb, dump: h.dump })),
    };
    const id = crypto.randomUUID();
    const me = c.var.user!.id;
    try {
      await c.var.db.insert(schema.reports).values({
        id,
        reporterId: me,
        targetType: 'player',
        targetId: pair.to,
        targetUserId: pair.to,
        reason: 'cheating',
        detail: body.reason,
        context: JSON.stringify(context),
        createdAt: at,
      });
    } catch (e) {
      // One open report per reporter and member: this operator already has one open on the receiver (another pair).
      if (!isUniqueViolation(e, 'reports.reporter_id')) throw e;
      const mine = await DB.prepare(`SELECT id FROM reports WHERE reporter_id = ?1 AND target_type = 'player' AND target_id = ?2 AND status = 'open'`)
        .bind(me, pair.to)
        .first<{ id: string }>();
      fail(409, 'already_reported', 'you already have a report open on this member', { reportId: mine?.id ?? null });
    }
    await audit(c, 'integrity.review', { type: 'user', id: pair.to }, { reportId: id, partnerId: pair.from, days: span, signals: pair.signals, risk: pair.risk, reason: body.reason });
    return c.json({ id }, 201);
  });
