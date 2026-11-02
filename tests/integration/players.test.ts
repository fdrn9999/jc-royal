// Players as other members see them (docs/SOCIAL.md "프로필 카드", "친구 테이블 알림", "업적", "시즌 리더보드"): a
// member's card shows only what they chose, never to someone either side blocked; friends are told of a seat at a
// public table and never of a private one, nor by a member away, invisible or who turned it off; the first achievements
// come from a hand the server recorded; and the season board ranks finished tournaments, leaving out members who asked.
import { LEADERBOARD, leaderboardScore, seasonOf, seasonRange, type InboxItemDto, type InboxPageDto, type LeaderboardDto, type PlayerCardDto, type SocialSettingsDto } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, newUser } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

type User = Awaited<ReturnType<typeof newUser>>;

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; ; await sleep(250)) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(v).slice(0, 400)}`);
  }
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
