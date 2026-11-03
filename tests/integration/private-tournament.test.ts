// Private tournaments (docs/TOURNAMENT.md "비공개 대회"): a Sit & Go a member opens from an active template, as its
// host. Hidden from everyone else (not listed, its page and every action 404) until the host invites them or they bring
// its code; the code is answered once and only its hash is kept; a new code retires the old one. Only the host invites,
// starts and cancels; one open per host. Its table admits its players only. Played to the end it stays out of the
// official records (leaderboard, profile wins, the tournament-win achievement).
import type { InboxItemDto, InboxPageDto, TableView, TournamentDetailDto, TournamentStructure, TournamentSummaryDto, TournamentTemplateDto } from '@jc/types';
import { afterAll, describe, expect, it } from 'vitest';
import { newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { isMyTurn, TableSocket } from '../support/ws';

const admin = sharedAdmin();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type User = Awaited<ReturnType<typeof newUser>>;
const errCode = (r: { body: any }) => r.body?.error?.code as string | undefined;

async function reauth() {
  const valid = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (valid && valid - Date.now() > 60_000) return;
  const r = await admin.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Three seats at 200 chips, started by the host: the test fills them by hand. */
const THREE: TournamentStructure = {
  name: 'private',
  capacity: 3,
  minPlayers: 2,
  startStack: 200,
  levels: [
    { sb: 10, bb: 20 },
    { sb: 20, bb: 40 },
  ],
  levelMinutes: 1,
  turnSeconds: 10,
  timeBank: { enabled: false, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: false,
};

let tpl: TournamentTemplateDto | null = null;
async function template(): Promise<TournamentTemplateDto> {
  if (tpl) return tpl;
  await reauth();
  const r = await admin.post('/api/admin/tournament-templates', { ...THREE, name: uniq('ptpl'), reason: 'private tournament test' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  tpl = r.body.template as TournamentTemplateDto;
  return tpl;
}

const opened: string[] = [];
const sockets: TableSocket[] = [];
afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const id of opened) {
    const cur = (await admin.get(`/api/admin/tournaments/${id}`)).body?.tournament as { status: string; version: number; name: string } | undefined;
    if (!cur) continue;
    await reauth();
    if (cur.status === 'running') await admin.post(`/api/admin/tournaments/${id}/abort`, { baseVersion: cur.version, reason: 'private test done', confirmName: cur.name });
    else if (cur.status === 'registering' || cur.status === 'closed') await admin.post(`/api/admin/tournaments/${id}/cancel`, { baseVersion: cur.version, reason: 'private test done' });
  }
});

async function host(u: User, name?: string): Promise<{ id: string; code: string }> {
  const t = await template();
  const r = await u.client.post('/api/tournaments/private', { templateId: t.id, ...(name ? { name } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  opened.push(r.body.id);
  return { id: r.body.id, code: r.body.code };
}
async function befriend(a: User, b: User) {
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
}
const listed = async (u: User, id: string) => ((await u.client.get('/api/tournaments')).body.tournaments as TournamentSummaryDto[]).find((x) => x.id === id);
const detail = (u: User, id: string) => u.client.get<TournamentDetailDto>(`/api/tournaments/${id}`);
async function invites(u: User): Promise<InboxItemDto[]> {
  const r = await u.client.get<InboxPageDto>('/api/notifications?filter=game');
  expect(r.status).toBe(200);
  return r.body.items.filter((i) => i.kind === 'tournament_invite');
}

describe('private tournaments', () => {
  it('stays hidden but from its host, those they invite and those with its code; the host alone runs it', async () => {
    const [a, f, g, s, late] = await Promise.all([newUser(), newUser(), newUser(), newUser(), newUser()]);
    await befriend(a, f);
    await befriend(f, g);

    // Only a member, only an active Sit & Go template, a well-formed body.
    expect((await a.client.post('/api/tournaments/private', {})).status).toBe(400);
    expect((await a.client.post('/api/tournaments/private', { templateId: (await template()).id, extra: 1 })).status).toBe(400);
    expect(errCode(await a.client.post('/api/tournaments/private', { templateId: 'no-such-template' }))).toBe('tournament_template_not_found');
    const templates = await a.client.get('/api/tournaments/private/templates');
    expect(templates.status).toBe(200);
    expect(templates.body.openPerHost).toBe(1);
    expect(templates.body.templates.some((x: { id: string }) => x.id === tpl!.id)).toBe(true);

    const { id, code } = await host(a, 'Friends night');
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
    // Only the code's hash is kept.
    const [row] = await d1<{ hash: string | null; host: string; isPrivate: number }>(`SELECT join_code_hash AS hash, host_id AS host, is_private AS isPrivate FROM tournaments WHERE id = '${id}'`);
    expect(row).toMatchObject({ host: a.me.id, isPrivate: 1 });
    expect(row!.hash).not.toContain(code);
    // The host is registered, sees it (theirs) and is never told the code again.
    const mine = await detail(a, id);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ private: { host: a.me.nickname, mine: true }, me: { status: 'registered' }, registered: 1 });
    expect(JSON.stringify(mine.body)).not.toContain(code);
    expect((await listed(a, id))?.private).toEqual({ host: a.me.nickname, mine: true });
    // One open private tournament a host.
    const second = await a.client.post('/api/tournaments/private', { templateId: tpl!.id });
    expect([second.status, errCode(second)]).toEqual([409, 'tournament_private_limit']);

    // A stranger: not listed, and the page and every action read as no such tournament.
    expect(await listed(s, id)).toBeUndefined();
    expect((await detail(s, id)).status).toBe(404);
    for (const path of ['register', 'start', 'cancel', 'code', 'invite']) {
      const r = await s.client.post(`/api/tournaments/${id}/${path}`, path === 'invite' ? { userId: f.me.id } : undefined);
      expect([path, r.status]).toEqual([path, 404]);
    }

    // The host invites a friend: the friend now sees it, and may decline (it goes from their bell and their view).
    expect((await f.client.get(`/api/tournaments/${id}`)).status).toBe(404);
    expect((await f.client.post(`/api/tournaments/${id}/invite`, { userId: a.me.id })).status).toBe(404);
    expect((await a.client.post(`/api/tournaments/${id}/invite`, { userId: f.me.id })).status).toBe(201);
    expect((await invites(f))[0]).toMatchObject({ state: 'open', href: `/tournaments/${id}` });
    const seen = await detail(f, id);
    expect(seen.status).toBe(200);
    expect(seen.body.private).toEqual({ host: a.me.nickname, mine: false });
    expect((await listed(f, id))?.private).toEqual({ host: a.me.nickname, mine: false });
    // Only the host invites to it, and only the host starts, cancels or changes its code.
    const relay = await f.client.post(`/api/tournaments/${id}/invite`, { userId: g.me.id });
    expect([relay.status, errCode(relay)]).toEqual([403, 'tournament_invite_host_only']);
    expect(await invites(g)).toEqual([]);
    for (const path of ['start', 'cancel', 'code']) {
      const r = await f.client.post(`/api/tournaments/${id}/${path}`);
      expect([path, r.status, errCode(r)]).toEqual([path, 403, 'tournament_host_only']);
    }
    expect((await f.client.post(`/api/tournaments/${id}/decline`)).status).toBe(200);
    expect(await invites(f)).toEqual([]);
    expect((await detail(f, id)).status).toBe(404);

    // The code: a wrong one and a well-formed one of nothing answer alike; the right one registers (as typed by hand).
    const wrong = await s.client.post('/api/tournaments/join', { code: 'ABCDEFGHJK' });
    expect([wrong.status, errCode(wrong)]).toEqual([404, 'tournament_code_invalid']);
    expect((await s.client.post('/api/tournaments/join', { code: 'x' })).status).toBe(400);
    const typed = `${code.slice(0, 5).toLowerCase()} ${code.slice(5)}`;
    const joined = await s.client.post('/api/tournaments/join', { code: typed });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body).toMatchObject({ ok: true, id, started: false });
    expect((await detail(s, id)).body).toMatchObject({ me: { status: 'registered' }, private: { mine: false } });

    // A new code retires the old one.
    const renewed = await a.client.post(`/api/tournaments/${id}/code`);
    expect(renewed.status).toBe(200);
    expect(renewed.body.code).not.toBe(code);
    expect(errCode(await late.client.post('/api/tournaments/join', { code }))).toBe('tournament_code_invalid');
    expect((await late.client.post('/api/tournaments/join', { code: renewed.body.code })).status).toBe(200);
    expect((await detail(a, id)).body.registered).toBe(3);

    // The host cancels: everyone registered is told; it can be cancelled once.
    expect((await a.client.post(`/api/tournaments/${id}/cancel`)).status).toBe(200);
    expect((await detail(a, id)).body.status).toBe('cancelled');
    const told = await d1<{ userId: string }>(`SELECT user_id AS userId FROM messages WHERE id LIKE 'tn:${id}:cancelled:%'`);
    expect(told.map((m) => m.userId).sort()).toEqual([a.me.id, s.me.id, late.me.id].sort());
    expect(errCode(await a.client.post(`/api/tournaments/${id}/cancel`))).toBe('tournament_state');
    // A code of a cancelled tournament opens nothing.
    expect(errCode(await g.client.post('/api/tournaments/join', { code: renewed.body.code }))).toBe('tournament_code_invalid');
  }, 120_000);

  it('plays on a table its players alone may enter, and stays out of the official records', async () => {
    const [a, b, c, outsider] = await Promise.all([newUser(), newUser(), newUser(), newUser()]);
    const { id, code } = await host(a);
    for (const u of [b, c]) expect((await u.client.post('/api/tournaments/join', { code })).status).toBe(200);
    const started = await a.client.post(`/api/tournaments/${id}/start`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ started: true, tableId: `sng-${id}` });
    const T = `sng-${id}`;

    // Someone not in it may not watch (the room refuses them as a private table without the code would).
    const refused = await TableSocket.open(outsider.client, T, { noState: true });
    sockets.push(refused);
    expect(await refused.waitClose()).toBe(4003);

    const ws = await Promise.all([a, b, c].map((u) => TableSocket.open(u.client, T)));
    sockets.push(...ws);
    let on = true;
    const busy = new Set<TableSocket>();
    const loop = (async () => {
      while (on) {
        for (const x of ws) {
          const st = x.state;
          if (busy.has(x) || x.closed || !st || !isMyTurn(st)) continue;
          busy.add(x);
          const legal = (t: string) => st.you.legal.some((o) => o.type === t);
          void x
            .act(legal('allin') ? 'allin' : legal('call') ? 'call' : 'check')
            .catch(() => undefined)
            .finally(() => busy.delete(x));
        }
        await sleep(100);
      }
    })();
    let end: TableView;
    try {
      end = await ws[0]!.waitState((x) => x.tournament?.status === 'finished', 180_000, 'the private tournament to finish');
    } finally {
      on = false;
      await loop;
    }
    const winner = end.tournament!.places.find((p) => p.place === 1)!;
    const won = [a, b, c].find((u) => u.me.nickname === winner.nickname)!;
    expect(won).toBeTruthy();

    // A result like any other in its own page...
    let d: TournamentDetailDto | undefined;
    for (let i = 0; i < 60; i++) {
      d = (await detail(a, id)).body;
      if (d.status === 'finished') break;
      await sleep(250);
    }
    expect(d).toMatchObject({ status: 'finished', winner: winner.nickname });
    // ...but no official record: no win on the profile, no leaderboard row, no tournament-win achievement.
    const card = await won.client.get(`/api/players/${won.me.id}/card`);
    expect(card.status).toBe(200);
    expect(card.body.stats?.tournamentWins).toBe(0);
    expect((card.body.achievements as { code: string }[]).some((x) => x.code === 'play:tournament_win' || x.code === 'tournament_win')).toBe(false);
    const board = await won.client.get('/api/leaderboard');
    expect(board.status).toBe(200);
    expect(board.body.me).toBeNull();
    const badges = await d1<{ badge: string }>(`SELECT badge FROM user_badges WHERE user_id = '${won.me.id}' AND badge LIKE '%tournament_win%'`);
    expect(badges).toEqual([]);
  }, 300_000);
});
