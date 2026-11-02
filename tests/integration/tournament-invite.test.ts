// Inviting a friend to a tournament (docs/TOURNAMENT.md "친구 초대", POST /api/tournaments/:id/invite): only an
// accepted friend neither side blocked, only while registration is open with a seat left and the friend is not in it
// yet; one inbox item per friend who invites, telling the invited member's pages at once, and showing what became of it
// (open, done once they are in, expired when the seats or the registration are gone). It grants nothing.
import type { AdminTournamentRow, InboxItemDto, InboxPageDto, TournamentStructure } from '@jc/types';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { RealtimeSocket } from '../support/realtime';

const admin = sharedAdmin();
type User = Awaited<ReturnType<typeof newUser>>;

async function reauth() {
  const valid = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (valid && valid - Date.now() > 60_000) return;
  const r = await admin.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Three seats, started by an operator: the test fills them by hand. */
const THREE: TournamentStructure = {
  name: 'invite',
  capacity: 3,
  minPlayers: 2,
  startStack: 200,
  levels: [{ sb: 10, bb: 20 }],
  levelMinutes: 5,
  turnSeconds: 10,
  timeBank: { enabled: false, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: false,
};

const opened: AdminTournamentRow[] = [];
afterAll(async () => {
  for (const t of opened) {
    const cur = (await admin.get(`/api/admin/tournaments/${t.id}`)).body?.tournament as AdminTournamentRow | undefined;
    if (cur?.status !== 'registering' && cur?.status !== 'closed') continue;
    await reauth();
    await admin.post(`/api/admin/tournaments/${t.id}/cancel`, { baseVersion: cur.version, reason: 'invite test done' });
  }
});

async function openTournament(): Promise<AdminTournamentRow> {
  await reauth();
  const tpl = await admin.post('/api/admin/tournament-templates', { ...THREE, name: uniq('tpl'), reason: 'invite test' });
  expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
  const r = await admin.post('/api/admin/tournaments', { templateId: tpl.body.template.id, templateVersion: tpl.body.template.version, name: uniq('Inv') });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  opened.push(r.body.tournament);
  return r.body.tournament;
}

async function befriend(a: User, b: User) {
  expect((await a.client.post('/api/friends/requests', { userId: b.me.id })).status).toBe(201);
  expect((await b.client.post(`/api/friends/${a.me.id}/accept`)).status).toBe(200);
}

const invite = (from: User, id: string, to: string) => from.client.post(`/api/tournaments/${id}/invite`, { userId: to });
const errCode = (r: { body: any }) => r.body?.error?.code as string | undefined;
async function invites(u: User): Promise<InboxItemDto[]> {
  const r = await u.client.get<InboxPageDto>('/api/notifications?filter=game');
  expect(r.status).toBe(200);
  return r.body.items.filter((i) => i.kind === 'tournament_invite');
}

describe('tournament invites', () => {
  it('reaches an accepted friend while a seat is left, once per friend who invites, and shows what became of it', async () => {
    const t = await openTournament();
    const [a, b, f, stranger] = await Promise.all([newUser(), newUser(), newUser(), newUser()]);
    await befriend(a, b);
    await befriend(a, f);

    // Only members, a well-formed body, someone else, and a friend.
    expect((await new Client().post(`/api/tournaments/${t.id}/invite`, { userId: b.me.id })).status).toBe(401);
    expect((await a.client.post(`/api/tournaments/${t.id}/invite`, {})).status).toBe(400);
    expect((await a.client.post(`/api/tournaments/${t.id}/invite`, { userId: b.me.id, extra: 1 })).status).toBe(400);
    expect(errCode(await invite(a, t.id, a.me.id))).toBe('invite_self');
    expect((await invite(a, 'nosuchtourn1', b.me.id)).status).toBe(404);
    const refused = await invite(stranger, t.id, b.me.id);
    expect([refused.status, errCode(refused)]).toEqual([403, 'not_friends']);
    expect(await invites(b)).toEqual([]);

    // The invited member's pages hear of it at once; the item names the friend and the tournament, nothing more.
    const ws = await RealtimeSocket.open(b.client);
    try {
      const heard = ws.event('notification.changed');
      const sent = await invite(a, t.id, b.me.id);
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      await heard;
    } finally {
      ws.close();
    }
    const [item] = await invites(b);
    expect(item).toMatchObject({ actor: { id: a.me.id, nickname: a.me.nickname }, params: { name: t.name }, state: 'open', readAt: null, href: `/tournaments/${t.id}` });
    expect(JSON.stringify(item)).not.toContain(a.email);
    // Again from the same friend: the same item, counted while unread.
    expect((await invite(a, t.id, b.me.id)).status).toBe(201);
    expect(await invites(b)).toMatchObject([{ id: item!.id, count: 2 }]);

    // Once the friend is in, the item says so and a new invite is refused as pointless.
    expect((await b.client.post(`/api/tournaments/${t.id}/register`)).status).toBe(200);
    expect((await invites(b))[0]!.state).toBe('done');
    const again = await invite(a, t.id, b.me.id);
    expect([again.status, errCode(again)]).toEqual([409, 'tournament_invite_joined']);

    // Every seat taken: the open invite of another friend expires, and no new one goes out.
    expect((await invite(a, t.id, f.me.id)).status).toBe(201);
    expect((await invites(f))[0]!.state).toBe('open');
    const others = await Promise.all([newUser(), newUser()]);
    for (const o of others) expect((await o.client.post(`/api/tournaments/${t.id}/register`)).status).toBe(200);
    expect((await invites(f))[0]!.state).toBe('expired');
    const full = await invite(a, t.id, f.me.id);
    expect([full.status, errCode(full)]).toEqual([409, 'tournament_full']);
    expect((await invites(f))[0]!.count).toBe(1);

    // Registration over (cancelled): refused as not open.
    await reauth();
    const cur = (await admin.get(`/api/admin/tournaments/${t.id}`)).body.tournament as AdminTournamentRow;
    expect((await admin.post(`/api/admin/tournaments/${t.id}/cancel`, { baseVersion: cur.version, reason: 'invite test' })).status).toBe(200);
    const closed = await invite(a, t.id, f.me.id);
    expect([closed.status, errCode(closed)]).toEqual([409, 'tournament_not_open']);
  });

  it('is refused, the same as to a stranger, when either side blocked the other', async () => {
    const t = await openTournament();
    const [a, b, c] = await Promise.all([newUser(), newUser(), newUser()]);
    await befriend(a, b);
    await befriend(a, c);
    // Blocking ends the friendship; an invite then reads as to a stranger, and nothing reaches the blocked side.
    expect((await b.client.req('PUT', `/api/blocks/${a.me.id}`)).status).toBe(200);
    const r = await invite(a, t.id, b.me.id);
    expect([r.status, errCode(r)]).toEqual([403, 'not_friends']);
    expect(await invites(b)).toEqual([]);
    // An invite already in the bell of someone who then blocks the inviter leaves their list.
    expect((await invite(a, t.id, c.me.id)).status).toBe(201);
    expect(await invites(c)).toHaveLength(1);
    expect((await c.client.req('PUT', `/api/blocks/${a.me.id}`)).status).toBe(200);
    expect(await invites(c)).toEqual([]);
  });
});
