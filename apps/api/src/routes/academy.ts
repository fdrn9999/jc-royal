/**
 * Academy API: per-user progress sync, cosmetic badges and anonymous content
 * statistics. Nothing here touches wallets, the chip ledger or game history.
 */
import { schema, statsDay, statsIncrements, type AcademyMetric } from '@jc/db';
import {
  AcademyEventsSchema,
  AcademyProgressPutSchema,
  BADGES,
  GtoProgressPutSchema,
  plausibleBadges,
  type AcademyProgressDto,
  type BadgeDto,
  type BadgeId,
  type GtoProgressDto,
} from '@jc/types';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { fail, parseBody } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';

const DAY_METRIC = {
  lesson: { start: 'ac_lesson_start', complete: 'ac_lesson_done' },
  scenario: { start: 'ac_scenario_start', complete: 'ac_scenario_done' },
} as const;

async function badgesOf(c: Context<AppEnv>, userId: string): Promise<BadgeDto[]> {
  const rows = await c.var.db.select().from(schema.userBadges).where(eq(schema.userBadges.userId, userId));
  return rows
    .filter((r) => (BADGES as readonly string[]).includes(r.badge))
    .map((r) => ({ badge: r.badge as BadgeId, awardedAt: r.awardedAt }))
    .sort((a, b) => a.awardedAt - b.awardedAt);
}

export const academyRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  .get('/progress', async (c) => {
    const uid = c.var.user!.id;
    const row = await c.var.db.query.academyProgress.findFirst({ where: eq(schema.academyProgress.userId, uid) });
    const out: AcademyProgressDto = {
      data: row ? (JSON.parse(row.data) as Record<string, unknown>) : null,
      version: row?.version ?? null,
      updatedAt: row?.updatedAt ?? null,
      badges: await badgesOf(c, uid),
    };
    return c.json(out);
  })
  /**
   * Stores the client's merged progress. Last write wins by `updatedAt`
   * (the client merges server + local before pushing). Badges are awarded only
   * for claims that pass `plausibleBadges` (server clock, account age, lesson
   * steps, recorded answers), once each (INSERT OR IGNORE): idempotent,
   * chip-free and never taken back.
   */
  .put('/progress', async (c) => {
    const user = c.var.user!;
    const uid = user.id;
    await rateLimit(c, `academy-put:${uid}`, 60, 60_000);
    const body = await parseBody(c, AcademyProgressPutSchema);
    const data = JSON.stringify(body.data);
    await c.env.DB.prepare(
      `INSERT INTO academy_progress (user_id, data, version, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= academy_progress.updated_at`,
    )
      .bind(uid, data, body.version, body.updatedAt)
      .run();
    const now = Date.now();
    const earned = plausibleBadges(body.data, { now, since: user.createdAt });
    if (earned.length) {
      await c.env.DB.batch(earned.map((b) => c.env.DB.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge, awarded_at) VALUES (?1, ?2, ?3)').bind(uid, b, now)));
    }
    return c.json({ ok: true, badges: await badgesOf(c, uid) });
  })
  .get('/badges', async (c) => c.json(await badgesOf(c, c.var.user!.id)))
  /** The Advanced GTO Academy's progress: its own row (academy_gto_progress), no badges. */
  .get('/gto/progress', async (c) => {
    const row = await c.var.db.query.academyGtoProgress.findFirst({ where: eq(schema.academyGtoProgress.userId, c.var.user!.id) });
    const out: GtoProgressDto = {
      data: row ? (JSON.parse(row.data) as Record<string, unknown>) : null,
      version: row?.version ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
    return c.json(out);
  })
  /**
   * With `base` the write is compare-and-set: it lands only over the copy the client merged with (none there, for
   * null) and only with a later updatedAt, so two devices writing from the same copy cannot drop each other's records:
   * the second gets 409, merges the newer copy and writes again. Without `base` the newer updatedAt wins.
   */
  .put('/gto/progress', async (c) => {
    const uid = c.var.user!.id;
    await rateLimit(c, `academy-gto-put:${uid}`, 60, 60_000);
    const body = await parseBody(c, GtoProgressPutSchema);
    const insert = 'INSERT INTO academy_gto_progress (user_id, data, version, updated_at) VALUES (?1, ?2, ?3, ?4)';
    const sql =
      body.base === undefined
        ? `${insert} ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at
           WHERE excluded.updated_at >= academy_gto_progress.updated_at`
        : body.base === null
          ? `${insert} ON CONFLICT(user_id) DO NOTHING`
          : 'UPDATE academy_gto_progress SET data = ?2, version = ?3, updated_at = ?4 WHERE user_id = ?1 AND updated_at = ?5 AND ?4 > ?5';
    const args = [uid, JSON.stringify(body.data), body.version, body.updatedAt, ...(typeof body.base === 'number' ? [body.base] : [])];
    const r = await c.env.DB.prepare(sql)
      .bind(...args)
      .run();
    if (body.base !== undefined && !r.meta.changes) fail(409, 'conflict', 'the progress changed on another device');
    return c.json({ ok: true });
  })
  /**
   * Anonymous counters: academy_stats never holds a user id. The id appears only in this request's rate-limit key,
   * a rate_limits row that the daily housekeeping deletes once its window is long over. The same events are added to
   * the day's totals of the operations statistics (daily_stats, per day and kind, also without a user id).
   */
  .post('/events', async (c) => {
    await rateLimit(c, `academy-events:${c.var.user!.id}`, 30, 60_000);
    const { events } = await parseBody(c, AcademyEventsSchema);
    const stmt = c.env.DB.prepare(
      `INSERT INTO academy_stats (kind, item_id, starts, completes, correct, wrong, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(kind, item_id) DO UPDATE SET starts = starts + excluded.starts, completes = completes + excluded.completes,
         correct = correct + excluded.correct, wrong = wrong + excluded.wrong, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    const day: Partial<Record<AcademyMetric, number>> = {};
    const add = (k: AcademyMetric) => (day[k] = (day[k] ?? 0) + 1);
    for (const e of events) {
      if (e.kind === 'question') {
        add('ac_answer');
        if (e.correct) add('ac_correct');
      } else add(DAY_METRIC[e.kind][e.phase]);
    }
    await c.env.DB.batch([
      ...events.map((e) =>
        e.kind === 'question'
          ? stmt.bind('question', e.id, 0, 0, e.correct ? 1 : 0, e.correct ? 0 : 1, now)
          : stmt.bind(e.kind, e.id, e.phase === 'start' ? 1 : 0, e.phase === 'complete' ? 1 : 0, 0, 0, now),
      ),
      ...statsIncrements(c.env.DB, statsDay(now), day),
    ]);
    return c.json({ ok: true, recorded: events.length });
  });
