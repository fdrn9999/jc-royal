// Players as other members see them (docs/SOCIAL.md "프로필 카드", "친구 테이블 알림", "업적", "시즌 리더보드"): a
// member's card shows only what they chose, never to someone either side blocked; friends are told of a seat at a
// public table and never of a private one, nor by a member away, invisible or who turned it off; the first achievements
// come from a hand the server recorded; and the season board ranks finished tournaments, leaving out members who asked.
import { LEADERBOARD, leaderboardScore, seasonOf, seasonRange, type InboxItemDto, type InboxPageDto, type LeaderboardDto, type PlayerCardDto, type PlayerHudDto, type SocialSettingsDto } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, newUser } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

type User = Awaited<ReturnType<typeof newUser>>;

const open: TableSocket[] = [];
// Members a test marked as bots, members again after it: no later test finds a bot holding a member's welcome chips.
const posing: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  for (const id of posing.splice(0)) await d1(`UPDATE users SET is_bot = 0 WHERE id = '${id}'`);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; ; await sleep(250)) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(v).slice(0, 400)}`);
  }
}

/** Fills `key`'s rate-limit window, away from the window's end so the next request falls in it. */
async function fillWindow(key: string, limit: number) {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5_000) await sleep(left + 100);
  const start = Date.now() - (Date.now() % 60_000);
  await d1(`INSERT INTO rate_limits (key, window_start, count) VALUES ('${key}', ${start}, ${limit}) ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`);
}

const card = (c: Client, id: string) => c.get<PlayerCardDto>(`/api/players/${id}/card`);
const settings = async (u: User, body: Partial<SocialSettingsDto>) => {
  const r = await u.client.patch<SocialSettingsDto>('/api/friends/settings', body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const friendTable = async (u: User) => ((await u.client.get<InboxPageDto>('/api/notifications?filter=social')).body.items ?? []).filter((i) => i.kind === 'friend_table');

async function befriend(a: User, b: User) {
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
}

async function sit(u: User, tableId: string, seatIndex: number, code?: string) {
  const ws = await TableSocket.open(u.client, tableId, code ? { code } : {});
  open.push(ws);
  expect(await ws.request({ t: 'sit', seatIndex, buyIn: 300 })).toMatchObject({ t: 'ack' });
  await ws.waitState((s) => s.you.seatIndex === seatIndex);
  return ws;
}

describe('profile card', () => {
  it('needs a member; shows the month joined and what the member chose, never their e-mail or chips', async () => {
    expect((await new Client().get('/api/players/anyone/card')).status).toBe(401);
    const a = await newUser();
    const b = await newUser();

    const mine = await card(a.client, a.me.id);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ self: true, user: { id: a.me.id, nickname: a.me.nickname }, achievements: [], privacy: { showAchievements: true, showStats: false, shareTable: true, showRanking: true } });
    expect(mine.body.joinedMonth).toBe(seasonOf(Date.now()));
    // My own card always has my statistics, with what they were counted from.
    expect(mine.body.stats).toMatchObject({ hands: 0, vpip: { n: 0, of: 0 }, tournamentWins: 0 });

    const seen = await card(b.client, a.me.id);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ self: false, achievements: [], stats: null });
    // Not mine: no privacy settings, and nothing private rides along.
    expect(seen.body.privacy).toBeUndefined();
    const text = JSON.stringify(seen.body);
    for (const leak of [a.email, 'balance', 'email', 'birth']) expect(text).not.toContain(leak);

    // Statistics are off by default; turned on, others see them too.
    expect(await settings(a, { showStats: true })).toMatchObject({ showStats: true, showAchievements: true, shareTable: true, showRanking: true });
    expect((await card(b.client, a.me.id)).body.stats).toMatchObject({ hands: 0, wtsd: { n: 0, of: 0 }, wsd: { n: 0, of: 0 } });
    // Achievements hidden: others read null, I still see mine (and that they are hidden).
    await settings(a, { showAchievements: false });
    expect((await card(b.client, a.me.id)).body.achievements).toBeNull();
    expect((await card(a.client, a.me.id)).body).toMatchObject({ achievements: [], privacy: { showAchievements: false, showStats: true } });

    // The settings take only booleans, and something to change.
    expect((await a.client.patch('/api/friends/settings', {})).status).toBe(400);
    expect((await a.client.patch('/api/friends/settings', { showStats: 'yes' })).status).toBe(400);
    expect((await a.client.get<SocialSettingsDto>('/api/friends/settings')).body).toMatchObject({ showAchievements: false, showStats: true, shareTable: true, showRanking: true });
  });

  it('reads as not found, the same way, for no such member, a block either way, a suspended member and a bot', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const notFound = async (viewer: User, id: string) => {
      const r = await card(viewer.client, id);
      expect(r.status, id).toBe(404);
      expect(r.body).toMatchObject({ error: { code: 'player_not_found' } });
    };
    await notFound(a, 'no-such-member');
    await notFound(a, 'bad id!');

    // a blocks b: neither sees the other's card; c still sees both.
    expect((await a.client.req('PUT', `/api/blocks/${b.me.id}`)).status).toBe(200);
    await notFound(b, a.me.id);
    await notFound(a, b.me.id);
    expect((await card(c.client, a.me.id)).status).toBe(200);
    // Unblocked: seen again.
    expect((await a.client.req('DELETE', `/api/blocks/${b.me.id}`)).status).toBe(200);
    expect((await card(b.client, a.me.id)).status).toBe(200);

    await d1(`UPDATE users SET status = 'suspended' WHERE id = '${c.me.id}'`);
    await notFound(a, c.me.id);
    const [bot] = await d1<{ id: string }>(`SELECT id FROM users WHERE is_bot = 1 LIMIT 1`);
    if (bot) await notFound(a, bot.id);
  });

  it('a hand the server recorded gives the first achievements, and the card counts it', async () => {
    const a = await newUser();
    const b = await newUser();
    const wa = await sit(a, 'it-player-hu', 0);
    const wb = await sit(b, 'it-player-hu', 1);
    const s = await wa.waitState((v) => v.status === 'playing' && !!v.hand && v.hand.actorSeat !== null, 20_000, 'hand dealt');
    const handId = s.hand!.id;
    await wb.waitState((v) => v.hand?.id === handId && v.hand.seq === s.hand!.seq, 15_000, 'same hand on both');
    // Whoever acts first folds: the other wins the blinds.
    const [actorWs, actor, winner] = isMyTurn(wa.state!) ? [wa, a, b] : [wb, b, a];
    expect(isMyTurn(actorWs.state!)).toBe(true);
    expect((await actorWs.act('fold')).result.t).toBe('state');
    await wa.waitState((v) => v.hand?.id !== handId || v.hand.stage === 'settled', 20_000, 'settled');

    const codes = (r: { body: PlayerCardDto }) => (r.body.achievements ?? []).map((x) => x.code).sort();
    const won = await until(() => card(winner.client, winner.me.id), (r) => codes(r).includes('first_win'), 'first win');
    expect(codes(won)).toEqual(['first_hand', 'first_win']);
    const lost = await until(() => card(actor.client, actor.me.id), (r) => codes(r).includes('first_hand'), 'first hand');
    expect(codes(lost)).toEqual(['first_hand']);
    expect(lost.body.stats!.hands).toBe(1);
    // Others see the achievements (on by default) but not the statistics (off by default).
    const other = await card(winner.client, actor.me.id);
    expect(codes(other)).toEqual(['first_hand']);
    expect(other.body.stats).toBeNull();
  });
});

describe('table HUD', () => {
  const hud = (c: Client, id: string, scope?: string) => c.get<PlayerHudDto>(`/api/players/${id}/hud${scope ? `?scope=${scope}` : ''}`);
  const DAY = 86_400_000;
  let n = 0;
  /** A recorded hand of `user` at `table`, with the statistics columns as the server fills them (NULL: no chance). */
  const row = (table: string, user: string, at: number, cols: Partial<Record<'vpip' | 'pfr' | 'saw_flop' | 'went_to_showdown' | 'pot_won' | 'three_bet' | 'fold_3bet' | 'cbet' | 'fold_cbet' | 'post_bets' | 'post_calls' | 'big_blind', number | null>>) => {
    const id = `${table}-h${++n}`;
    const v = { vpip: 0, pfr: 0, saw_flop: 0, went_to_showdown: 0, pot_won: 0, three_bet: null, fold_3bet: null, cbet: null, fold_cbet: null, post_bets: 0, post_calls: 0, big_blind: 10, ...cols };
    const ks = Object.keys(v) as (keyof typeof v)[];
    return [
      `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ('${id}', '${table}', ${n}, ${at - 1000}, ${at}, '[]', 20, 'it', '{}')`,
      `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, ended_at, position, ${ks.join(', ')}) VALUES ('${id}', '${user}', 0, '["As","Kd"]', 1000, 1000, 0, 0, ${at}, 'BTN', ${ks.map((k) => v[k] ?? 'NULL').join(', ')})`,
    ];
  };

  it('counts the latest hands of the table kind as the statistics do, each ratio over its chances, behind the card setting', async () => {
    const a = await newUser();
    const b = await newUser();
    const tag = Math.random().toString(36).slice(2, 8);
    const [cash, tn] = [`it-hud-${tag}-c`, `it-hud-${tag}-t`];
    const now = Date.now();
    await d1(
      [
        `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, room_type) VALUES ('${cash}', '${cash}', 6, 5, 10, 200, 2000, 'closed', 'official'), ('${tn}', '${tn}', 6, 5, 10, 200, 2000, 'closed', 'tournament')`,
        // A raise and a 3-bet, a c-bet, bets and a call after the flop; shown down and won.
        ...row(cash, a.me.id, now - 4000, { vpip: 1, pfr: 1, saw_flop: 1, went_to_showdown: 1, pot_won: 30, three_bet: 1, cbet: 1, post_bets: 2, post_calls: 1 }),
        // A call, a 3-bet chance not taken, a c-bet folded to.
        ...row(cash, a.me.id, now - 3000, { vpip: 1, saw_flop: 1, three_bet: 0, fold_cbet: 1, post_calls: 1 }),
        // A fold before the flop: in the sample, no chance at anything.
        ...row(cash, a.me.id, now - 2000, {}),
        // Recorded before the later figures existed: in the hands, VPIP and PFR, in none of the rest.
        ...row(cash, a.me.id, now - 1000, { vpip: 1, pfr: 1, post_bets: null, post_calls: null, big_blind: null }),
        // Older than the HUD's days: left out.
        ...row(cash, a.me.id, now - 100 * DAY, { vpip: 1, pfr: 1, three_bet: 1 }),
        // A tournament table's hand: only in the tournament HUD.
        ...row(tn, a.me.id, now - 500, { vpip: 1, pfr: 1, three_bet: 1 }),
      ].join('; '),
    );

    const mine = await hud(a.client, a.me.id);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({
      bot: false,
      scope: 'cash',
      stats: {
        hands: 4,
        vpip: { n: 3, of: 4 },
        pfr: { n: 2, of: 4 },
        wtsd: { n: 1, of: 2 },
        wsd: { n: 1, of: 1 },
        counted: 3,
        threeBet: { n: 1, of: 2 },
        // No 3-bet against an open of theirs: no chance, not 0 of something.
        foldTo3Bet: { n: 0, of: 0 },
        cbet: { n: 1, of: 1 },
        foldToCbet: { n: 1, of: 1 },
        aggression: { bets: 2, calls: 2 },
      },
    });
    expect((await hud(a.client, a.me.id, 'cash')).body).toEqual(mine.body);
    expect((await hud(a.client, a.me.id, 'tournament')).body.stats).toMatchObject({ hands: 1, vpip: { n: 1, of: 1 }, threeBet: { n: 1, of: 1 }, counted: 1 });
    expect((await hud(a.client, a.me.id, 'mtt')).status).toBe(400);

    // Another member: nothing while a keeps statistics private (the default), then the same figures as a's own.
    const hidden = await hud(b.client, a.me.id);
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual({ bot: false, scope: 'cash', stats: null });
    await settings(a, { showStats: true });
    const shown = await hud(b.client, a.me.id);
    expect(shown.body).toEqual(mine.body);
    // Never the hand's cards, chips or anything private.
    const text = JSON.stringify(shown.body);
    for (const leak of ['As', 'Kd', a.email, 'balance', 'net', 'won']) expect(text).not.toContain(leak);
  });

  it('reads as not found the way the card does, and a bot’s is shown and marked as a bot’s', async () => {
    expect((await new Client().get('/api/players/anyone/hud')).status).toBe(401);
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const bot = await newUser();
    for (const u of [a, b, c]) await settings(u, { showStats: true });
    const notFound = async (viewer: User, id: string) => {
      const r = await hud(viewer.client, id);
      expect(r.status, id).toBe(404);
      expect(r.body).toMatchObject({ error: { code: 'player_not_found' } });
    };
    await notFound(a, 'no-such-member');
    await notFound(a, 'bad id!');
    expect((await a.client.req('PUT', `/api/blocks/${b.me.id}`)).status).toBe(200);
    await notFound(b, a.me.id);
    await notFound(a, b.me.id);
    expect((await hud(c.client, a.me.id)).status).toBe(200);
    await d1(`UPDATE users SET status = 'suspended' WHERE id = '${c.me.id}'`);
    await notFound(a, c.me.id);

    // A bot (suspended as well, so no bot table running meanwhile seats it): its figures with the mark, its card still none.
    posing.push(bot.me.id);
    await d1(`UPDATE users SET is_bot = 1, status = 'suspended' WHERE id = '${bot.me.id}'`);
    const r = await hud(a.client, bot.me.id, 'cash');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bot: true, scope: 'cash', stats: { hands: 0, vpip: { n: 0, of: 0 } } });
    expect((await card(a.client, bot.me.id)).status).toBe(404);
  });

  it('counts each member against their own budget: one who used it up holds up no one else', async () => {
    const a = await newUser();
    const b = await newUser();
    // A table opens a HUD for each seat: a member at a busy one may use up their budget, and only theirs.
    await fillWindow(`player_card:${a.me.id}`, 120);
    expect((await hud(a.client, b.me.id)).status).toBe(429);
    expect((await card(a.client, b.me.id)).status).toBe(429);
    expect((await hud(b.client, a.me.id)).status).toBe(200);
    expect((await card(b.client, a.me.id)).status).toBe(200);
    await fillWindow(`leaderboard:${a.me.id}`, 60);
    expect((await a.client.get('/api/leaderboard')).status).toBe(429);
    expect((await b.client.get('/api/leaderboard')).status).toBe(200);
  });
});

describe('friend table alerts', () => {
  it('tells accepted friends of a seat at a public table once, shows whether it is still taken, and never strangers', async () => {
    const a = await newUser();
    const b = await newUser();
    const stranger = await newUser();
    await befriend(a, b);
    const ws = await sit(a, 'it-player-0', 0);
    const [item] = await until(() => friendTable(b), (xs) => xs.length > 0, 'friend table item');
    expect(item).toMatchObject({ actor: { id: a.me.id }, params: { name: 'it-player-0' }, state: 'open', href: '/table/it-player-0', count: 1, readAt: null });
    expect(await friendTable(stranger)).toEqual([]);
    expect(await friendTable(a)).toEqual([]);

    // Standing up: the item says the seat is gone.
    expect(await ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await until(() => friendTable(b), (xs) => xs[0]?.state === 'expired', 'expired after leaving');
    // Sitting down again soon after: not told again (the same item, still one).
    await sit(a, 'it-player-0', 0);
    await sleep(1500);
    const again = await friendTable(b);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ count: 1, at: item!.at, state: 'open' });
  });

  it('says nothing for a member who turned it off, is invisible or away, nor of a private table', async () => {
    const friend = await newUser();
    const off = await newUser();
    const hidden = await newUser();
    const away = await newUser();
    const priv = await newUser();
    const control = await newUser();
    for (const u of [off, hidden, away, priv, control]) await befriend(u, friend);
    await settings(off, { shareTable: false });
    expect((await hidden.client.req('PUT', '/api/me/presence', { mode: 'invisible' })).status).toBe(200);
    expect((await away.client.req('PUT', '/api/me/presence', { mode: 'away' })).status).toBe(200);

    await sit(off, 'it-player-1', 0);
    await sit(hidden, 'it-player-1', 1);
    await sit(away, 'it-player-1', 2);
    await sit(priv, 'it-player-priv', 0, 'player-77');
    // The member at the private table then sits at a public one: had the private seat been told, this one would have
    // come within the quiet time and been held back, so the item naming the public table shows it was not.
    await sit(priv, 'it-player-2', 0);
    await sit(control, 'it-player-2', 1);
    const items = await until(() => friendTable(friend), (xs) => xs.length >= 2, 'items from the public seats');
    await sleep(1000);
    const final = await friendTable(friend);
    expect(final.map((i: InboxItemDto) => i.actor?.id).sort()).toEqual([priv.me.id, control.me.id].sort());
    expect(items.every((i) => i.href === '/table/it-player-2' && i.params.name === 'it-player-2')).toBe(true);
    expect(JSON.stringify(final)).not.toContain('it-player-priv');
  });
});

describe('season leaderboard', () => {
  const TN_COLS = 'id, name, status, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms, tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start, finished_at, winner_id';
  /** A finished tournament, its finishers in order (first place first). */
  async function finished(id: string, at: number, order: User[], status = 'finished') {
    await d1(`INSERT INTO tournaments (${TN_COLS}) VALUES ('${id}', '${id}', '${status}', 6, 2, 1500, '[]', 60000, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ${at}, '${order[0]!.me.id}')`);
    await d1(
      `INSERT INTO tournament_entries (tournament_id, user_id, status, place, registered_at) VALUES ${order
        .map((u, i) => `('${id}', '${u.me.id}', '${i === 0 ? 'won' : 'eliminated'}', ${i + 1}, ${at - 60_000})`)
        .join(', ')}`,
    );
  }

  it('checks the season, and is empty for a member who finished nothing', async () => {
    expect((await new Client().get('/api/leaderboard')).status).toBe(401);
    const u = await newUser();
    for (const bad of ['2026-13', '26-01', 'now']) expect((await u.client.get(`/api/leaderboard?season=${bad}`)).status, bad).toBe(400);
    const now = (await u.client.get<LeaderboardDto>('/api/leaderboard')).body;
    expect(now).toMatchObject({ season: seasonOf(Date.now()), me: null, hidden: false });
    expect(now.to - now.from).toBeGreaterThan(27 * 86_400_000);
  });

  it('ranks finished tournaments with enough members by places, leaving out the hidden, suspended and bots', async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    // A season of the past no other test writes to.
    const season = `20${String(10 + Math.floor(Math.random() * 10))}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}`;
    const { from, to } = seasonRange(season);
    const [p1, p2, p3, p4, quiet, bot] = [await newUser(), await newUser(), await newUser(), await newUser(), await newUser(), await newUser()];
    // Suspended too, so no bot table running meanwhile picks it to sit down.
    posing.push(bot.me.id);
    await d1(`UPDATE users SET is_bot = 1, status = 'suspended' WHERE id = '${bot.me.id}'`);
    const at = (h: number) => from + h * 3_600_000;
    await finished(`lb-${tag}-1`, at(1), [p1, p2, p3, p4]);
    await finished(`lb-${tag}-2`, at(2), [p1, p3, p2, quiet]);
    await finished(`lb-${tag}-3`, at(3), [p2, p1, p4, p3]);
    // Not counted: two members and a bot, cancelled (not a finish: no table cron reads it, unlike a running one), and
    // the last moment of the season before.
    await finished(`lb-${tag}-4`, at(4), [p4, bot, p1]);
    await finished(`lb-${tag}-5`, at(5), [p4, p3, p2, p1], 'cancelled');
    await finished(`lb-${tag}-6`, from - 1, [p4, p3, p2, p1]);
    expect(LEADERBOARD.minTournaments).toBe(3);

    const board = (u: User) => u.client.get<LeaderboardDto>(`/api/leaderboard?season=${season}`).then((r) => r.body);
    const b1 = await board(p1);
    expect(b1).toMatchObject({ season, from, to, ranked: 3, hidden: false });
    expect(b1.rows.map((r) => [r.rank, r.user.id, r.tournaments, r.wins, r.score])).toEqual([
      [1, p1.me.id, 3, 2, leaderboardScore(8, 9)],
      [2, p2.me.id, 3, 1, leaderboardScore(6, 9)],
      [3, p3.me.id, 3, 0, leaderboardScore(3, 9)],
    ]);
    expect(b1.me).toMatchObject({ rank: 1, user: { id: p1.me.id } });
    // Two counted tournaments: my own row, not ranked yet.
    expect((await board(p4)).me).toMatchObject({ rank: null, tournaments: 2, wins: 0, score: leaderboardScore(1, 6) });
    expect(JSON.stringify(b1)).not.toContain(p1.email);

    // Asking not to appear: off the board for everyone, my row gone too, and the others move up.
    await settings(p2, { showRanking: false });
    const b2 = await board(p2);
    expect(b2).toMatchObject({ hidden: true, me: null, ranked: 2 });
    expect(b2.rows.map((r) => r.user.id)).toEqual([p1.me.id, p3.me.id]);
    expect(b2.rows.map((r) => r.rank)).toEqual([1, 2]);
    // A suspended member is left out as well.
    await d1(`UPDATE users SET status = 'suspended' WHERE id = '${p3.me.id}'`);
    expect((await board(p1)).rows.map((r) => r.user.id)).toEqual([p1.me.id]);
  });
});
