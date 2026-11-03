/**
 * Players as other members see them (docs/SOCIAL.md "프로필 카드", "시즌 리더보드"): a member's card and the season
 * leaderboard. Only what a member chose to show leaves here: name, picture and badge as everywhere, the month they
 * joined, achievements unless hidden, statistics only when shown (off by default), never chips, email or a hand's cards.
 */
import {
  ACHIEVEMENT_PREFIX,
  ACHIEVEMENTS,
  LEADERBOARD,
  leaderboardScore,
  SeasonSchema,
  seasonOf,
  seasonRange,
  type AchievementCode,
  type LeaderboardDto,
  type LeaderboardRowDto,
  type PlayerCardDto,
  type PlayerCardStatsDto,
  HUD_DAYS,
  HUD_HANDS,
  HUD_SCOPES,
  type HudScope,
  type PlayerHudDto,
} from '@jc/types';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';
import { badgesFor } from '../lib/badges';
import { fail } from '../lib/http';
import { PLAY_STATS_COLUMNS, playRatios, type PlayStatsRow } from '../lib/play-stats';
import { rateLimit } from '../lib/rate-limit';
import { notBlocked, toPublic } from './social';

const notFound = (): never => fail(404, 'player_not_found', 'player not found');

interface CardRow {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  role: string;
  status: string;
  isBot: number;
  vipColor: string | null;
  joinedMonth: string;
  showAchievements: number;
  showStats: number;
  shareTable: number;
  showRanking: number;
  open: number;
}

/**
 * The player a card or a HUD is about. Not found, the same way, for no such player and, unless it is my own, a
 * withdrawn or suspended member and a member either side blocked (a block against staff is not in force, as
 * everywhere): the answer never tells which. A table bot is returned for the HUD to mark; the card refuses it.
 */
async function cardSubject(c: Context<AppEnv>, me: string, id: string): Promise<CardRow> {
  await rateLimit(c, 'player_card', 120, 60_000);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  const u = await c.env.DB.prepare(
    `SELECT id, nickname, avatar_url AS avatarUrl, role, status, is_bot AS isBot, vip_color AS vipColor,
            strftime('%Y-%m', (created_at + 32400000) / 1000, 'unixepoch') AS joinedMonth,
            show_achievements AS showAchievements, show_stats AS showStats, share_table AS shareTable, show_ranking AS showRanking,
            ${notBlocked('?1', '?2')} AS open
       FROM users WHERE id = ?2`,
  )
    .bind(me, id)
    .first<CardRow>();
  if (!u || (!u.isBot && id !== me && (u.status !== 'active' || !u.open))) notFound();
  return u!;
}

export const playerRoutes = new Hono<AppEnv>()
  .use('*', requireUser)
  /** A member's card (a table bot has none: not found, as cardSubject's other cases). */
  .get('/:id/card', async (c) => {
    const me = c.var.user!.id;
    const id = c.req.param('id');
    const u = await cardSubject(c, me, id);
    const self = id === me;
    if (u.isBot) notFound();
    const showAchievements = self || u.showAchievements === 1;
    const showStats = self || u.showStats === 1;
    const [badgesR, statsR] = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT badge, awarded_at AS at FROM user_badges WHERE user_id = ?1 AND badge LIKE '${ACHIEVEMENT_PREFIX}%' AND ?2 ORDER BY awarded_at`).bind(id, showAchievements ? 1 : 0),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS hands, ${PLAY_STATS_COLUMNS},
                (SELECT COUNT(*) FROM tournament_entries te JOIN tournaments tt ON tt.id = te.tournament_id
                  WHERE te.user_id = ?1 AND te.status = 'won' AND tt.is_private = 0) AS wins
           FROM hand_players WHERE user_id = ?1 AND ?2`,
      ).bind(id, showStats ? 1 : 0),
    ]);
    const codes = new Set<string>(ACHIEVEMENTS);
    const achievements = ((badgesR!.results ?? []) as { badge: string; at: number }[])
      .map((b) => ({ code: b.badge.slice(ACHIEVEMENT_PREFIX.length) as AchievementCode, at: b.at }))
      .filter((b) => codes.has(b.code));
    const s = (statsR!.results as (PlayStatsRow & Record<'hands' | 'wins', number>)[])[0];
    const r = s && playRatios(s);
    const stats: PlayerCardStatsDto | null = showStats && s && r ? { hands: s.hands, vpip: r.vpip, pfr: r.pfr, wtsd: r.wtsd, wsd: r.wsd, tournamentWins: s.wins } : null;
    const card: PlayerCardDto = {
      user: toPublic(u, await badgesFor(c, [u.role])),
      joinedMonth: u.joinedMonth,
      self,
      achievements: showAchievements ? achievements : null,
      stats,
      ...(self
        ? { privacy: { showAchievements: u.showAchievements === 1, showStats: u.showStats === 1, shareTable: u.shareTable === 1, showRanking: u.showRanking === 1 } }
        : {}),
    };
    return c.json(card);
  })
  /**
   * A seat's HUD (`?scope=cash|tournament`, the kind of table it is opened at): the player's latest hands of that kind
   * (HUD_HANDS from the last HUD_DAYS days) counted the way /api/me/stats counts, behind the card's gate. A member's
   * figures only when their card shows statistics (or they are mine); a table bot's always, marked as a bot's. Nothing
   * an administrator alone sees, and never chips, results or a hand's cards.
   */
  .get('/:id/hud', async (c) => {
    const me = c.var.user!.id;
    const id = c.req.param('id');
    const scope = c.req.query('scope') ?? 'cash';
    if (!(HUD_SCOPES as readonly string[]).includes(scope)) fail(400, 'bad_request', `scope must be one of ${HUD_SCOPES.join(', ')}`);
    const u = await cardSubject(c, me, id);
    const bot = u.isBot === 1;
    const shown = bot || id === me || u.showStats === 1;
    // The latest hands first, so the window is the player's most recent play at this kind of table.
    const s = await c.env.DB.prepare(
      `SELECT COUNT(*) AS hands, ${PLAY_STATS_COLUMNS}
         FROM (SELECT hp.* FROM hand_players hp JOIN hands h ON h.id = hp.hand_id LEFT JOIN tables t ON t.id = h.table_id
                WHERE hp.user_id = ?1 AND ?2 AND hp.ended_at >= ?3 AND (COALESCE(t.room_type, '') = 'tournament') = ?4
                ORDER BY hp.ended_at DESC LIMIT ${HUD_HANDS})`,
    )
      .bind(id, shown ? 1 : 0, Date.now() - HUD_DAYS * 86_400_000, scope === 'tournament' ? 1 : 0)
      .first<PlayStatsRow & { hands: number }>();
    const hud: PlayerHudDto = { bot, scope: scope as HudScope, stats: shown && s ? { hands: s.hands, ...playRatios(s) } : null };
    return c.json(hud);
  });

/** The season leaderboard (see LEADERBOARD in @jc/types): `?season=YYYY-MM`, this month by default. */
export const leaderboardRoutes = new Hono<AppEnv>().use('*', requireUser).get('/', async (c) => {
  const me = c.var.user!.id;
  await rateLimit(c, 'leaderboard', 60, 60_000);
  const q = c.req.query('season');
  const season = q === undefined ? seasonOf(Date.now()) : SeasonSchema.safeParse(q).success ? q : fail(400, 'invalid_season', 'season is YYYY-MM');
  const { from, to } = seasonRange(season);
  const { results } = await c.env.DB.prepare(
    `WITH t AS (
       SELECT tn.id, COUNT(*) AS n
         FROM tournaments tn JOIN tournament_entries e ON e.tournament_id = tn.id JOIN users u ON u.id = e.user_id
        WHERE tn.status = 'finished' AND tn.is_private = 0 AND tn.finished_at >= ?1 AND tn.finished_at < ?2 AND e.status IN ('eliminated', 'won') AND e.place IS NOT NULL
        GROUP BY tn.id HAVING SUM(u.is_bot = 0) >= ?3
     ), r AS (
       SELECT e.user_id, COUNT(*) AS played, SUM(e.status = 'won') AS wins, SUM(t.n - e.place) AS beaten, SUM(t.n - 1) AS possible
         FROM t JOIN tournament_entries e ON e.tournament_id = t.id
        WHERE e.status IN ('eliminated', 'won') AND e.place IS NOT NULL
        GROUP BY e.user_id
     )
     SELECT r.user_id AS id, r.played, r.wins, r.beaten, r.possible, u.nickname, u.avatar_url AS avatarUrl, u.role, u.vip_color AS vipColor,
            u.show_ranking AS showRanking
       FROM r JOIN users u ON u.id = r.user_id
      WHERE u.is_bot = 0 AND u.status = 'active'`,
  )
    .bind(from, to, LEADERBOARD.minHumans)
    .all<{ id: string; played: number; wins: number; beaten: number; possible: number; nickname: string; avatarUrl: string | null; role: string; vipColor: string | null; showRanking: number }>();
  const badge = await badgesFor(c, results.map((r) => r.role));
  const scored = results
    .filter((r) => r.showRanking === 1)
    .map((r) => ({ r, score: leaderboardScore(r.beaten, r.possible) }))
    .sort((a, b) => b.score - a.score || b.r.played - a.r.played || b.r.wins - a.r.wins || (a.r.id < b.r.id ? -1 : 1));
  const row = (x: { r: (typeof results)[number]; score: number }, rank: number | null): LeaderboardRowDto => ({
    rank,
    user: toPublic(x.r, badge),
    tournaments: x.r.played,
    wins: x.r.wins,
    score: x.score,
  });
  const ranked: LeaderboardRowDto[] = [];
  for (const x of scored) {
    if (x.r.played < LEADERBOARD.minTournaments) continue;
    // Equal scores, equal tournaments and wins share a rank.
    const prev = ranked[ranked.length - 1];
    const same = prev && prev.score === x.score && prev.tournaments === x.r.played && prev.wins === x.r.wins;
    ranked.push(row(x, same ? prev.rank : ranked.length + 1));
  }
  const mine = await c.env.DB.prepare('SELECT show_ranking AS showRanking FROM users WHERE id = ?1').bind(me).first<{ showRanking: number }>();
  const hidden = mine?.showRanking === 0;
  const myRanked = ranked.find((r) => r.user.id === me);
  const myScored = scored.find((x) => x.r.id === me);
  const dto: LeaderboardDto = {
    season,
    from,
    to,
    rows: ranked.slice(0, LEADERBOARD.top),
    ranked: ranked.length,
    me: myRanked ?? (myScored ? row(myScored, null) : null),
    hidden,
  };
  return c.json(dto);
});
