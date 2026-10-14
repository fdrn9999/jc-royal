/**
 * Academy API: per-user progress sync, cosmetic badges and anonymous content
 * statistics. Nothing here touches wallets, the chip ledger or game history.
 */
import { schema } from '@jc/db';
import { AcademyEventsSchema, AcademyProgressPutSchema, BADGES, plausibleBadges, type AcademyProgressDto, type BadgeDto, type BadgeId } from '@jc/types';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { parseBody } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';

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
  /** Anonymous counters: the user id is only used for rate limiting, never stored. */
  .post('/events', async (c) => {
    await rateLimit(c, `academy-events:${c.var.user!.id}`, 30, 60_000);
    const { events } = await parseBody(c, AcademyEventsSchema);
    const stmt = c.env.DB.prepare(
      `INSERT INTO academy_stats (kind, item_id, starts, completes, correct, wrong, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(kind, item_id) DO UPDATE SET starts = starts + excluded.starts, completes = completes + excluded.completes,
         correct = correct + excluded.correct, wrong = wrong + excluded.wrong, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    await c.env.DB.batch(
      events.map((e) =>
        e.kind === 'question'
          ? stmt.bind('question', e.id, 0, 0, e.correct ? 1 : 0, e.correct ? 0 : 1, now)
          : stmt.bind(e.kind, e.id, e.phase === 'start' ? 1 : 0, e.phase === 'complete' ? 1 : 0, 0, 0, now),
      ),
    );
    return c.json({ ok: true, recorded: events.length });
  });
