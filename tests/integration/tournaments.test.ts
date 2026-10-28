// Sit & Go tournaments (docs/TOURNAMENT.md): templates a super admin keeps (checked, versioned, archived), tournaments
// opened from them, registration (again, full, elsewhere, not enough hands, many at once for the last seats, closed and
// reopened, cancelled with one notice each in the member's language), the start (by itself when full, never twice), the
// table (tournament chips only: no sitting down, topping up or leaving; not in the lobby; no cash-table control), play to
// a winner with places, nothing in wallets, the ledger or hand history, an operator's pause from the next hand and resume
// with the level time kept, everyone away (no deal, the clock stopped, back on return), the stop (not a finish), recovery,
// and a server restart in the middle of a hand.
import type { AdminTournamentRow, TableView, TournamentStructure, TournamentTemplateDto } from '@jc/types';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, signupBody, uniq, WEB_ORIGIN } from '../support/client';
import { d1 } from '../support/d1';
import { RealtimeSocket } from '../support/realtime';
import { prepareState, root, startWorker, TABLES, type RunningWorker } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';

const admin = sharedAdmin();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(v).slice(-300)}`);
    await sleep(250);
  }
}

async function reauth(c: Client = admin) {
  const valid = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (valid && valid - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Two players, 200 chips at 10/20 then 20/40: an all-in ends most hands, so a tournament takes a few of them. */
const FAST: TournamentStructure = {
  name: 'fast',
  capacity: 2,
  minPlayers: 2,
  startStack: 200,
  levels: [
    { sb: 10, bb: 20 },
    { sb: 20, bb: 40 },
  ],
  levelMinutes: 1,
  turnSeconds: 10,
  timeBank: { enabled: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: true,
};

const opened: string[] = [];
const sockets: TableSocket[] = [];
afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  // Nothing this file opened keeps playing or stays open for the next run of the suite.
  for (const id of opened) {
    const t = await row(id);
    if (!t) continue;
    await reauth();
    if (t.status === 'running') await admin.post(`/api/admin/tournaments/${id}/abort`, { baseVersion: t.version, reason: 'tournament test done', confirmName: t.name });
    else if (t.status === 'registering' || t.status === 'closed') await admin.post(`/api/admin/tournaments/${id}/cancel`, { baseVersion: t.version, reason: 'tournament test done' });
  }
});

async function template(over: Partial<TournamentStructure> = {}): Promise<TournamentTemplateDto> {
  await reauth();
  const r = await admin.post('/api/admin/tournament-templates', { ...FAST, name: uniq('tpl'), ...over, reason: 'tournament test' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.template;
}
async function open(tpl: TournamentTemplateDto): Promise<AdminTournamentRow> {
  const r = await admin.post('/api/admin/tournaments', { templateId: tpl.id, templateVersion: tpl.version, name: uniq('T') });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  opened.push(r.body.tournament.id);
  return r.body.tournament;
}
async function row(id: string): Promise<AdminTournamentRow | null> {
  const r = await admin.get(`/api/admin/tournaments/${id}`);
  return r.status === 200 ? r.body.tournament : null;
}
const ids = (xs: string[]) => xs.map((x) => `'${x}'`).join(', ');
const notices = (id: string, kind: string) => d1<{ userId: string; title: string }>(`SELECT user_id AS userId, title FROM messages WHERE id LIKE 'tn:${id}:${kind}:%'`);
const errCode = (r: { body: any }) => r.body?.error?.code as string | undefined;

type Member = Awaited<ReturnType<typeof newUser>>;
const register = (m: Member, id: string) => m.client.post(`/api/tournaments/${id}/register`);

type Choice = { type: string; amount?: number };
const option = (s: TableView, type: string) => s.you.legal.find((o) => o.type === type);
const shove = (s: TableView): Choice => (option(s, 'allin') ? { type: 'allin' } : option(s, 'call') ? { type: 'call' } : { type: 'check' });

/** Acts for each of `players` on its turn until stopped. */
function autoplay(players: TableSocket[], choose: (s: TableView) => Choice) {
  let on = true;
  const busy = new Set<TableSocket>();
  const loop = (async () => {
    while (on) {
      for (const ws of players) {
        const s = ws.state;
        if (busy.has(ws) || ws.closed || !s || !isMyTurn(s)) continue;
        busy.add(ws);
        const c = choose(s);
        void ws
          .act(c.type, c.amount)
          .catch(() => undefined)
          .finally(() => busy.delete(ws));
      }
      await sleep(100);
    }
  })();
  return async () => {
    on = false;
    await loop;
    await until(async () => busy.size, (n) => n === 0, 'autoplay to stop', 20_000);
  };
}

/** Members, their wallet balances and ledger rows: tournament play changes neither. */
async function books(userIds: string[]) {
  const rows = await d1<{ id: string; balance: number; n: number }>(
    `SELECT u.id, u.balance, (SELECT COUNT(*) FROM chip_ledger l WHERE l.user_id = u.id) AS n FROM users u WHERE u.id IN (${ids(userIds)}) ORDER BY u.id`,
  );
  return rows.map((r) => ({ id: r.id, balance: Number(r.balance), n: Number(r.n) }));
}

/** A heads-up tournament (two registrations start it) and both players' sockets. */
async function headsUp(over: Partial<TournamentStructure> = {}) {
  const tpl = await template(over);
  const t = await open(tpl);
  const [a, b] = await Promise.all([newUser(), newUser()]);
  expect((await register(a, t.id)).body).toMatchObject({ ok: true, started: false });
  const second = await register(b, t.id);
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  expect(second.body).toMatchObject({ ok: true, started: true, tableId: `sng-${t.id}` });
  const tableId = second.body.tableId as string;
  const wa = await TableSocket.open(a.client, tableId);
  const wb = await TableSocket.open(b.client, tableId);
  sockets.push(wa, wb);
  return { tpl, t, a, b, tableId, wa, wb };
}

describe('tournament templates', () => {
  it('are checked, previewed without a write, versioned against concurrent edits, and archived', async () => {
    await reauth();
    const name = uniq('tpl');
    const bad = await admin.post('/api/admin/tournament-templates', { ...FAST, name, startStack: 100, reason: 'tournament test' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'tournament_structure_invalid', details: { problem: 'start_stack_too_small' } });
    const preview = await admin.post('/api/admin/tournament-templates', { ...FAST, name, preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ preview: true, to: { name, capacity: 2, startStack: 200 } });
    expect(await d1(`SELECT id FROM tournament_templates WHERE name = '${name}'`)).toEqual([]);

    const tpl = await template({ name });
    expect(tpl).toMatchObject({ name, version: 1, status: 'active', levelMinutes: 1 });
    const same = await admin.req('PUT', `/api/admin/tournament-templates/${tpl.id}`, { ...FAST, name, baseVersion: 1, reason: 'tournament test' });
    expect(same.status).toBe(400);
    expect(errCode(same)).toBe('tournament_template_no_change');
    const v2 = await admin.req('PUT', `/api/admin/tournament-templates/${tpl.id}`, { ...FAST, name, levelMinutes: 2, baseVersion: 1, reason: 'tournament test' });
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    expect(v2.body.template).toMatchObject({ version: 2, levelMinutes: 2 });
    const stale = await admin.req('PUT', `/api/admin/tournament-templates/${tpl.id}`, { ...FAST, name, levelMinutes: 3, baseVersion: 1, reason: 'tournament test' });
    expect(stale.status).toBe(409);
    expect(errCode(stale)).toBe('tournament_template_conflict');

    // A tournament is opened from the version the summary showed.
    const old = await admin.post('/api/admin/tournaments', { templateId: tpl.id, templateVersion: 1 });
    expect(old.status).toBe(409);
    expect(errCode(old)).toBe('tournament_template_conflict');
    const summary = await admin.post('/api/admin/tournaments', { templateId: tpl.id, templateVersion: 2, preview: true });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body).toMatchObject({ preview: true, summary: { name, levelMinutes: 2, capacity: 2 }, openMax: 20 });
    const t = await open(v2.body.template);
    expect(t).toMatchObject({ status: 'registering', templateId: tpl.id, capacity: 2, startStack: 200, registered: 0, version: 1, recovery: [] });
    const created = await d1<{ action: string; outcome: string }>(`SELECT action, outcome FROM admin_audit_log WHERE target_type = 'tournament' AND target_id = '${t.id}'`);
    expect(created).toEqual([{ action: 'tournament.create', outcome: 'ok' }]);

    // Archived: no new tournament from it; the one opened keeps its copy.
    const archived = await admin.post(`/api/admin/tournament-templates/${tpl.id}/status`, { status: 'archived', baseVersion: 2, reason: 'tournament test' });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body.template).toMatchObject({ status: 'archived', version: 3 });
    const again = await admin.post(`/api/admin/tournament-templates/${tpl.id}/status`, { status: 'archived', baseVersion: 3, reason: 'tournament test' });
    expect(again.status).toBe(409);
    expect(errCode(again)).toBe('tournament_template_state');
    const fromArchived = await admin.post('/api/admin/tournaments', { templateId: tpl.id, templateVersion: 3 });
    expect(fromArchived.status).toBe(409);
    expect(errCode(fromArchived)).toBe('tournament_template_archived');
    expect((await row(t.id))!.status).toBe('registering');
  }, 60_000);
});

describe('registration', () => {
  it('registers once, refuses a member in another tournament or short of hands, and gives up a seat before the start', async () => {
    const tpl = await template({ capacity: 3, autoStart: false });
    const t = await open(tpl);
    const a = await newUser();
    const b = await newUser();
    expect((await register(a, t.id)).body).toEqual({ ok: true, already: false, started: false, tableId: null });
    expect((await register(a, t.id)).body).toEqual({ ok: true, already: true, started: false, tableId: null });

    // The member's view: players by nickname (no ids), the viewer's own entry marked, and whether the viewer may register.
    const mine = (await a.client.get(`/api/tournaments/${t.id}`)).body;
    expect(mine).toMatchObject({ id: t.id, status: 'registering', registered: 1, me: { status: 'registered' }, eligibility: null });
    expect(mine.entries).toEqual([{ nickname: a.me.nickname, status: 'registered', place: null, stack: null, me: true }]);
    expect(JSON.stringify(mine)).not.toContain(a.me.id);
    expect((await b.client.get(`/api/tournaments/${t.id}`)).body).toMatchObject({ me: null, eligibility: { ok: true } });
    const list = (await a.client.get('/api/tournaments')).body;
    expect(list.current).toMatchObject({ id: t.id, me: { status: 'registered' } });
    expect(list.tournaments.some((x: { id: string }) => x.id === t.id)).toBe(true);

    // One tournament at a time.
    const other = await open(tpl);
    const elsewhere = await register(a, other.id);
    expect(elsewhere.status).toBe(409);
    expect(errCode(elsewhere)).toBe('tournament_already_active');

    // Hands played at cash tables first.
    const picky = await open(await template({ minHands: 5, autoStart: false }));
    const short = await register(b, picky.id);
    expect(short.status).toBe(403);
    expect(short.body.error).toMatchObject({ code: 'tournament_ineligible', details: { reason: 'min_hands', handsLeft: 5 } });
    expect((await b.client.get(`/api/tournaments/${picky.id}`)).body.eligibility).toEqual({ ok: false, reason: 'min_hands', handsLeft: 5 });

    // Unregistering frees the member for another tournament; registering again comes back as a new registration.
    expect((await a.client.post(`/api/tournaments/${t.id}/unregister`)).body).toEqual({ ok: true });
    expect((await a.client.post(`/api/tournaments/${t.id}/unregister`)).body).toEqual({ ok: true });
    expect((await register(a, other.id)).body).toMatchObject({ ok: true, already: false });
    expect((await a.client.post(`/api/tournaments/${other.id}/unregister`)).status).toBe(200);
    expect((await register(a, t.id)).body).toMatchObject({ ok: true, already: false });
    const entries = (await admin.get(`/api/admin/tournaments/${t.id}`)).body.entries as { userId: string; status: string }[];
    expect(entries.filter((e) => e.userId === a.me.id).map((e) => e.status)).toEqual(['registered']);
    expect((await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM tournament_entries WHERE user_id = '${a.me.id}'`))[0]!.n).toBe(2);
    expect((await a.client.get('/api/tournaments/zzz')).status).toBe(404);
  }, 60_000);

  it('never takes more registrations than seats when many arrive at once', async () => {
    const t = await open(await template({ capacity: 3, autoStart: false }));
    const members = await Promise.all(Array.from({ length: 6 }, () => newUser()));
    const results = await Promise.all(members.map((m) => register(m, t.id)));
    const ok = results.filter((r) => r.status === 200 && r.body.already === false);
    expect(ok.length, JSON.stringify(results.map((r) => [r.status, errCode(r)]))).toBe(3);
    expect(results.filter((r) => r.status === 409).map(errCode)).toEqual(['tournament_full', 'tournament_full', 'tournament_full']);
    const count = await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id = '${t.id}' AND status = 'registered'`);
    expect(Number(count[0]!.n)).toBe(3);
    const after = (await row(t.id))!;
    expect(after.registered).toBe(3);
    expect(after.roster).toBe(3);
  }, 60_000);

  it('closes and reopens registration, refuses a stale console, and a cancel tells each registrant once in their language', async () => {
    const t = await open(await template({ capacity: 3, autoStart: false }));
    const ko = await newUser();
    const en = await newUser(undefined, { locale: 'en' });
    const late = await newUser();
    expect((await register(ko, t.id)).status).toBe(200);
    expect((await register(en, t.id)).status).toBe(200);
    const v = (await row(t.id))!.version;

    const closed = await admin.post(`/api/admin/tournaments/${t.id}/registration`, { action: 'close', baseVersion: v });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.tournament).toMatchObject({ status: 'closed', version: v + 1 });
    const refused = await register(late, t.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'tournament_not_open', details: { status: 'closed' } });
    const stale = await admin.post(`/api/admin/tournaments/${t.id}/registration`, { action: 'open', baseVersion: v });
    expect(stale.status).toBe(409);
    expect(errCode(stale)).toBe('tournament_conflict');
    const twice = await admin.post(`/api/admin/tournaments/${t.id}/registration`, { action: 'close', baseVersion: v + 1 });
    expect(twice.status).toBe(409);
    expect(errCode(twice)).toBe('tournament_state');
    const reopened = await admin.post(`/api/admin/tournaments/${t.id}/registration`, { action: 'open', baseVersion: v + 1 });
    expect(reopened.body.tournament).toMatchObject({ status: 'registering', version: v + 2 });

    // Start with fewer than the minimum? Here two of three seats are taken and the minimum is two: an operator may start.
    // Instead it is cancelled: a password and a reason, no result, one notice per registrant.
    await reauth();
    const noReason = await admin.post(`/api/admin/tournaments/${t.id}/cancel`, { baseVersion: v + 2 });
    expect(noReason.status).toBe(400);
    const cancelled = await admin.post(`/api/admin/tournaments/${t.id}/cancel`, { baseVersion: v + 2, reason: 'tournament test cancel' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ ok: true, notified: 2, tournament: { status: 'cancelled', endReason: 'cancelled', winner: null } });
    const sent = await notices(t.id, 'cancelled');
    expect(sent.map((n) => n.userId).sort()).toEqual([ko.me.id, en.me.id].sort());
    expect(sent.find((n) => n.userId === en.me.id)!.title).toBe('Tournament cancelled');
    expect(sent.find((n) => n.userId === ko.me.id)!.title).toBe('토너먼트 취소 안내');
    const again = await admin.post(`/api/admin/tournaments/${t.id}/cancel`, { baseVersion: v + 3, reason: 'tournament test cancel' });
    expect(again.status).toBe(409);
    expect(errCode(again)).toBe('tournament_state');
    expect(await notices(t.id, 'cancelled')).toHaveLength(2);
    const leave = await ko.client.post(`/api/tournaments/${t.id}/unregister`);
    expect(leave.status).toBe(409);
    expect(errCode(leave)).toBe('tournament_state');
    // Free again for another tournament.
    const next = await open(await template({ capacity: 3, autoStart: false }));
    expect((await register(ko, next.id)).status).toBe(200);
  }, 60_000);

  it('an operator starts with the minimum, re-reading each registration, and never twice', async () => {
    const t = await open(await template({ capacity: 3, autoStart: false, turnSeconds: 60 }));
    const [a, b] = await Promise.all([newUser(), newUser()]);
    expect((await register(a, t.id)).status).toBe(200);
    const one = await admin.post(`/api/admin/tournaments/${t.id}/start`, { baseVersion: (await row(t.id))!.version });
    expect(one.status).toBe(409);
    expect(errCode(one)).toBe('tournament_not_ready');
    expect((await register(b, t.id)).status).toBe(200);
    const v = (await row(t.id))!.version;
    const [x, y] = await Promise.all([
      admin.post(`/api/admin/tournaments/${t.id}/start`, { baseVersion: v, reason: 'enough players' }),
      admin.post(`/api/admin/tournaments/${t.id}/start`, { baseVersion: v, reason: 'enough players' }),
    ]);
    const statuses = [x.status, y.status].sort();
    expect(statuses, JSON.stringify([x.body, y.body])).toEqual([200, 409]);
    const won = x.status === 200 ? x : y;
    expect(won.body).toMatchObject({ ok: true, started: true, players: 2, tableId: `sng-${t.id}`, tournament: { status: 'running', playersLeft: 2 } });
    const lost = x.status === 200 ? y : x;
    expect(['tournament_started', 'tournament_conflict']).toContain(errCode(lost));
    expect(await notices(t.id, 'started')).toHaveLength(2);
    const starts = await d1<{ detail: string }>(`SELECT detail FROM admin_audit_log WHERE target_id = '${t.id}' AND action = 'tournament.start' AND outcome = 'ok'`);
    expect(starts).toHaveLength(1);
    expect(JSON.parse(starts[0]!.detail)).toMatchObject({ reason: 'enough players', players: 2, tableId: `sng-${t.id}` });
  }, 60_000);
});

describe('a heads-up tournament', () => {
  it('starts by itself when full, keeps cash out of it, and ends with a winner and places', async () => {
    const { t, a, b, tableId, wa, wb } = await headsUp();
    const ledgerBefore = await books([a.me.id, b.me.id]);

    // Started once: nobody else gets in, nobody leaves, an operator cannot start it again.
    const late = await newUser();
    const full = await register(late, t.id);
    expect(full.status).toBe(409);
    expect(full.body.error).toMatchObject({ code: 'tournament_not_open', details: { status: 'running' } });
    const quit = await a.client.post(`/api/tournaments/${t.id}/unregister`);
    expect(quit.status).toBe(409);
    expect(errCode(quit)).toBe('tournament_started');
    const restart = await admin.post(`/api/admin/tournaments/${t.id}/start`, { baseVersion: (await row(t.id))!.version });
    expect(restart.status).toBe(409);
    expect(errCode(restart)).toBe('tournament_started');
    const started = await notices(t.id, 'started');
    expect(started.map((n) => n.userId).sort()).toEqual([a.me.id, b.me.id].sort());

    // The table: both seated with the tournament's chips at its first level.
    const s = await wa.waitState((x) => !!x.hand, 20_000, 'the first deal');
    expect(s.tournament).toMatchObject({ id: t.id, status: 'running', level: 0, levelCount: 2, smallBlind: 10, bigBlind: 20, playersLeft: 2, entrants: 2, startStack: 200, you: { status: 'playing' } });
    expect(s.tournament!.levelEndsAt).toBeGreaterThan(Date.now());
    expect(s.seats.filter((x) => x.userId).map((x) => x.stack + x.streetBet).sort()).toEqual([200, 200]);
    for (const [msg, ws] of [
      [{ t: 'sit', seatIndex: 1, buyIn: 200 }, wa],
      [{ t: 'topUp', amount: 100 }, wb],
      [{ t: 'leave' }, wa],
      [{ t: 'autoRebuy', on: false }, wb],
      [{ t: 'autoBuy', policy: { mode: 'off' } }, wa],
      [{ t: 'waitlist', join: true }, wa],
    ] as const) {
      const r = await ws.request(msg as unknown as { t: string });
      expect(r, JSON.stringify(msg)).toMatchObject({ t: 'error', code: 'tournament_table' });
    }
    // Not a cash table: not in the lobby, and the cash-table controls refuse it.
    const lobby = (await late.client.get('/api/tables')).body as { id: string }[];
    expect(lobby.some((x) => x.id === tableId)).toBe(false);
    await reauth();
    const control = await admin.post(`/api/admin/tables/${tableId}/control`, { action: 'pause', reason: 'tournament test' });
    expect(control.status).toBe(409);
    expect(errCode(control)).toBe('tournament_table');
    const close = await admin.post(`/api/admin/tables/${tableId}/close`, { reason: 'tournament test' });
    expect(close.status).toBe(409);
    expect(errCode(close)).toBe('tournament_table');
    // The table page points at its tournament, and its seats (tournament chips, no wallet sessions) are not flagged.
    const tableDetail = await admin.get(`/api/admin/tables/${tableId}`);
    expect(tableDetail.status).toBe(200);
    expect(tableDetail.body.tournament).toEqual({ id: t.id, name: t.name, status: 'running' });
    expect(tableDetail.body.diagnosis).toMatchObject({ sessionsOnlyInD1: [], seatsOnlyInRoom: [] });
    expect(tableDetail.body.diagnosis.issues).not.toContain('seat_without_session');
    // A spectator sees the tournament but is not in it.
    const watcher = await TableSocket.open(late.client, tableId);
    sockets.push(watcher);
    expect(watcher.state!.tournament).toMatchObject({ id: t.id, you: { status: 'watching', place: null } });
    // A tournament page, from here on: the room's writes it hears of are the bust and the finish, not each hand's stacks.
    const pages = await RealtimeSocket.open(late.client, { topics: ['tournaments'] });
    const told = () => pages.events.filter((e) => e.type === 'tournament.changed' && e.resourceId === t.id).length;

    const stop = autoplay([wa, wb], shove);
    let end: TableView;
    try {
      end = await wa.waitState((x) => x.tournament?.status === 'finished', 180_000, 'the tournament to finish');
    } finally {
      await stop();
    }
    const winnerSeat = end.seats.find((x) => x.userId && x.stack > 0)!;
    const winner = winnerSeat.userId === a.me.id ? a : b;
    const loser = winner === a ? b : a;
    const loserWs = winner === a ? wb : wa;
    expect(end.tournament).toMatchObject({
      playersLeft: 1,
      places: [
        { nickname: winner.me.nickname, place: 1 },
        { nickname: loser.me.nickname, place: 2 },
      ],
    });
    expect((await (winner === a ? wa : wb).waitState((x) => x.tournament?.status === 'finished')).tournament!.you).toEqual({ status: 'won', place: 1 });
    expect((await loserWs.waitState((x) => x.tournament?.status === 'finished')).tournament!.you).toEqual({ status: 'eliminated', place: 2 });

    const r = (await until(() => row(t.id), (x) => x?.status === 'finished', 'D1 to have the result'))!;
    expect(r).toMatchObject({ status: 'finished', endReason: 'completed', winner: winner.me.nickname, playersLeft: 1, recovery: [] });
    await pages.until(() => told() > 0, 15_000, 'the result to the tournament pages');
    // (the bust and the finish, in one write or two)
    expect(told()).toBeLessThanOrEqual(2);
    pages.close();
    const entries = await d1<{ userId: string; status: string; place: number; stack: number }>(
      `SELECT user_id AS userId, status, place, stack FROM tournament_entries WHERE tournament_id = '${t.id}' ORDER BY place`,
    );
    expect(entries).toEqual([
      { userId: winner.me.id, status: 'won', place: 1, stack: 400 },
      { userId: loser.me.id, status: 'eliminated', place: 2, stack: 0 },
    ]);
    const tn = await d1<{ winner: string; finished: number; aborted: number | null }>(`SELECT winner_id AS winner, finished_at AS finished, aborted_at AS aborted FROM tournaments WHERE id = '${t.id}'`);
    expect(tn[0]).toMatchObject({ winner: winner.me.id, aborted: null });
    expect(tn[0]!.finished).toBeGreaterThan(0);
    // Tournament chips are not money: no hand history, no wallet or ledger change.
    expect(await d1(`SELECT id FROM hands WHERE table_id = '${tableId}'`)).toEqual([]);
    expect(await books([a.me.id, b.me.id])).toEqual(ledgerBefore);
    // The table lingers a minute for the result, then closes.
    const detail = (await admin.get(`/api/admin/tournaments/${t.id}`)).body;
    expect(detail.live?.tournament).toMatchObject({ status: 'finished', playersLeft: 1, unsynced: false });
    expect(detail.live.tournament.closeAt).toBeGreaterThan(Date.now());
    // Nothing to stop or pause once it is over.
    await reauth();
    const abort = await admin.post(`/api/admin/tournaments/${t.id}/abort`, { baseVersion: r.version, reason: 'tournament test', confirmName: r.name });
    expect(abort.status).toBe(409);
    expect(errCode(abort)).toBe('tournament_state');
    const member = (await loser.client.get(`/api/tournaments/${t.id}`)).body;
    expect(member).toMatchObject({ status: 'finished', winner: winner.me.nickname, me: { status: 'eliminated', place: 2 } });
  }, 300_000);
});

describe('three players', () => {
  it('places every player once, sharing a place only between players out in the same hand with the same stack', async () => {
    const t = await open(await template({ capacity: 3 }));
    const ms = await Promise.all([newUser(), newUser(), newUser()]);
    const res = [] as { status: number; body: any }[];
    for (const m of ms) res.push(await register(m, t.id));
    expect(res[2]!.body).toMatchObject({ started: true, tableId: `sng-${t.id}` });
    const ws = await Promise.all(ms.map((m) => TableSocket.open(m.client, `sng-${t.id}`)));
    sockets.push(...ws);
    const stop = autoplay(ws, shove);
    try {
      await ws[0]!.waitState((x) => x.tournament?.status === 'finished', 240_000, 'the tournament to finish');
    } finally {
      await stop();
    }
    const r = (await until(() => row(t.id), (x) => x?.status === 'finished', 'D1 to have the result'))!;
    const entries = await d1<{ status: string; place: number; stack: number; hand: number | null }>(
      `SELECT status, place, stack, eliminated_hand AS hand FROM tournament_entries WHERE tournament_id = '${t.id}' ORDER BY place`,
    );
    expect(entries.map((e) => e.status)).toEqual(['won', 'eliminated', 'eliminated']);
    expect(entries[0]).toMatchObject({ place: 1, stack: 600, hand: null });
    const [second, third] = [entries[1]!, entries[2]!];
    expect(second.place).toBe(2);
    // Out in different hands: 2nd and 3rd. Out in the same hand: the larger stack placed higher, or both 2nd.
    if (second.hand !== third.hand) expect([third.place, third.hand! < second.hand!]).toEqual([3, true]);
    else expect([2, 3]).toContain(third.place);
    expect(r.playersLeft).toBe(1);
  }, 360_000);
});

describe('operators during a tournament', () => {
  it('pause from the next hand, keep the level time while paused, resume, then stop it (not a finish)', async () => {
    const { t, a, b, tableId, wa, wb } = await headsUp({ turnSeconds: 60 });
    const first = await wa.waitState((x) => !!x.hand && x.hand.actorSeat !== null, 20_000, 'a turn');
    const handId = first.hand!.id;
    const v = (await row(t.id))!.version;

    const pause = await admin.post(`/api/admin/tournaments/${t.id}/pause`, { baseVersion: v, reason: 'tournament test pause' });
    expect(pause.status, JSON.stringify(pause.body)).toBe(200);
    expect(pause.body).toMatchObject({ ok: true, appliesFrom: 'next_hand', roomConfirmed: true, tournament: { pauseRequested: true, version: v + 1 } });
    const twice = await admin.post(`/api/admin/tournaments/${t.id}/pause`, { baseVersion: v + 1 });
    expect(errCode(twice)).toBe('tournament_state');
    const stale = await admin.post(`/api/admin/tournaments/${t.id}/resume`, { baseVersion: v });
    expect(errCode(stale)).toBe('tournament_conflict');
    // The hand being played goes on: its player folds and it ends; no next hand comes.
    const actor = [wa, wb].find((x) => x.state && isMyTurn(x.state))!;
    expect(actor.state!.tournament!.paused).toBe(true);
    await actor.act('fold');
    await sleep(7_000);
    const held = wa.state!;
    expect(held.hand?.id ?? handId).toBe(handId);
    expect(held.tournament).toMatchObject({ paused: true, levelEndsAt: null });
    const left = held.tournament!.levelLeftMs!;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(60_000);
    const stopped = (await until(() => row(t.id), (x) => !!x && x.clockStoppedAt !== null && x.levelEndsAt === null, 'D1 to have the stopped clock'))!;
    expect(stopped.levelLeftMs).toBe(left);
    // Still stopped a few seconds later: the level time does not run while paused.
    await sleep(2_000);
    expect(wa.state!.tournament!.levelLeftMs).toBe(left);

    const resume = await admin.post(`/api/admin/tournaments/${t.id}/resume`, { baseVersion: v + 1, reason: 'tournament test resume' });
    expect(resume.status, JSON.stringify(resume.body)).toBe(200);
    expect(resume.body).toMatchObject({ ok: true, appliesFrom: 'now', tournament: { pauseRequested: false } });
    const dealt = await wa.waitState((x) => !!x.hand && x.hand.id !== handId, 15_000, 'the next deal');
    const at = Date.now();
    expect(dealt.tournament!.paused).toBe(false);
    expect(Math.abs(dealt.tournament!.levelEndsAt! - (at + left))).toBeLessThan(3_000);

    // Stop: the name typed again, the password, a reason; places so far stay, those playing are stopped, nobody wins.
    await reauth();
    const cur = (await row(t.id))!;
    const wrongName = await admin.post(`/api/admin/tournaments/${t.id}/abort`, { baseVersion: cur.version, reason: 'tournament test stop', confirmName: 'nope' });
    expect(wrongName.status).toBe(400);
    expect(errCode(wrongName)).toBe('tournament_name_mismatch');
    const staleStop = await admin.post(`/api/admin/tournaments/${t.id}/abort`, { baseVersion: cur.version - 1, reason: 'tournament test stop', confirmName: cur.name });
    expect(staleStop.status).toBe(409);
    expect(errCode(staleStop)).toBe('tournament_conflict');
    const stop = await admin.post(`/api/admin/tournaments/${t.id}/abort`, { baseVersion: cur.version, reason: 'tournament test stop', confirmName: cur.name });
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(stop.body).toMatchObject({ ok: true, roomConfirmed: true, notified: 2, tournament: { status: 'aborted', endReason: 'aborted', winner: null } });
    const shown = await wa.waitState((x) => x.tournament?.status === 'aborted', 15_000, 'the stop at the table');
    expect(shown.tournament!.you.status).toBe('stopped');
    // The hand being played ends (its players act or time out), then the table closes.
    const stopPlay = autoplay([wa, wb], () => ({ type: 'fold' }));
    try {
      await until(async () => (await d1<{ status: string }>(`SELECT status FROM tables WHERE id = '${tableId}'`))[0]?.status, (s) => s === 'closed', 'the table to close', 90_000);
    } finally {
      await stopPlay();
    }
    const entries = await d1<{ status: string; place: number | null }>(`SELECT status, place FROM tournament_entries WHERE tournament_id = '${t.id}'`);
    expect(entries).toEqual([
      { status: 'stopped', place: null },
      { status: 'stopped', place: null },
    ]);
    const tn = await d1<{ status: string; finished: number | null; winner: string | null; note: string }>(
      `SELECT status, finished_at AS finished, winner_id AS winner, end_note AS note FROM tournaments WHERE id = '${t.id}'`,
    );
    expect(tn[0]).toEqual({ status: 'aborted', finished: null, winner: null, note: 'tournament test stop' });
    const told = await notices(t.id, 'aborted');
    expect(told.map((n) => n.userId).sort()).toEqual([a.me.id, b.me.id].sort());
    const again = await admin.post(`/api/admin/tournaments/${t.id}/abort`, { baseVersion: cur.version + 1, reason: 'tournament test stop', confirmName: cur.name });
    expect(errCode(again)).toBe('tournament_state');
    const history = (await admin.get(`/api/admin/tournaments/${t.id}`)).body.history as { action: string }[];
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(['tournament.create', 'tournament.pause', 'tournament.resume', 'tournament.abort']));
    expect(await d1(`SELECT id FROM hands WHERE table_id = '${tableId}'`)).toEqual([]);
  }, 300_000);

  it('deals no hand while everyone still in is away (the clock stopped), and deals again when one is back', async () => {
    const { t, wa, wb } = await headsUp({ turnSeconds: 60 });
    await wa.waitState((x) => !!x.hand, 20_000, 'the first deal');
    for (const ws of [wa, wb]) expect(await ws.request({ t: 'sitOut' })).toMatchObject({ t: 'ack' });
    // Away from the next turn on: the player whose turn it is now folds (or the turn would time out); after this hand
    // no deal comes and the level clock stops.
    const actor = [wa, wb].find((x) => x.state && isMyTurn(x.state));
    if (actor) await actor.act('fold');
    const quiet = await wa.waitState((x) => x.tournament!.levelEndsAt === null && (!x.hand || x.hand.actorSeat === null), 30_000, 'the clock to stop');
    const handId = quiet.hand?.id ?? null;
    const left = quiet.tournament!.levelLeftMs!;
    expect(left).toBeGreaterThan(0);
    await sleep(7_000);
    expect(wa.state!.hand?.id ?? null).toBe(handId);
    expect(wa.state!.tournament).toMatchObject({ status: 'running', paused: false, levelEndsAt: null, levelLeftMs: left });
    const stopped = (await until(() => row(t.id), (x) => !!x && x.clockStoppedAt !== null, 'D1 to have the stopped clock'))!;
    expect(stopped.pauseRequested).toBe(false);

    expect(await wb.request({ t: 'sitIn' })).toMatchObject({ t: 'ack' });
    const dealt = await wa.waitState((x) => !!x.hand && x.hand.id !== handId, 15_000, 'a deal after the return');
    expect(dealt.tournament!.levelEndsAt).toBeGreaterThan(Date.now());
  }, 120_000);

  it('recovery asks the room to read the tournament again and is recorded', async () => {
    const { t } = await headsUp({ turnSeconds: 60 });
    const r = await admin.post(`/api/admin/tournaments/${t.id}/recover`, { reason: 'tournament test recover' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, tournament: { status: 'running' } });
    const audited = await d1<{ outcome: string }>(`SELECT outcome FROM admin_audit_log WHERE target_id = '${t.id}' AND action = 'tournament.recover'`);
    expect(audited).toEqual([{ outcome: 'ok' }]);
    const none = await open(await template({ autoStart: false }));
    const noTable = await admin.post(`/api/admin/tournaments/${none.id}/recover`, {});
    expect(noTable.status).toBe(409);
    expect(errCode(noTable)).toBe('tournament_state');
    // The list: filters and the counts operators work from.
    const list = (await admin.get(`/api/admin/tournaments?status=running&q=${encodeURIComponent(t.name)}`)).body;
    expect(list.tournaments.map((x: AdminTournamentRow) => x.id)).toEqual([t.id]);
    expect(list.counts.running).toBeGreaterThanOrEqual(1);
    expect((await admin.get('/api/admin/tournaments?status=nope')).status).toBe(400);
    expect((await admin.get('/api/admin/tournaments?recovery=1')).status).toBe(200);
  }, 120_000);
});

describe('a tournament across a server restart', () => {
  const state = resolve(root, 'tests/.state/tournament-restart');
  const port = 8814;
  let worker: RunningWorker | undefined;
  afterAll(async () => {
    await worker?.stop();
  });

  it('comes back with the same hand, stacks and level, and plays on to one result', async () => {
    await prepareState(state, TABLES);
    const id = `rs${Date.now().toString(36)}`.padEnd(12, '0').slice(0, 12);
    await d1(
      `INSERT INTO tournaments (id, name, status, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms, tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start)
       VALUES ('${id}', 'restart', 'registering', 2, 2, 200, '[{"sb":10,"bb":20},{"sb":20,"bb":40}]', 60000, 60, 1, 30000, 60000, 10000, 10, 5000, 0, 0, 1)`,
      state,
    );
    worker = await startWorker(port, state);
    const base = worker.url;
    const n = Date.now();
    const members: Client[] = [];
    for (const i of [0, 1]) {
      const c = new Client(WEB_ORIGIN, base);
      expect((await c.post('/api/auth/register', await signupBody(c, { email: `tn-rs-${n}-${i}@restart.dev`, nickname: `trs${i}${n % 100000}` }))).status).toBe(201);
      members.push(c);
    }
    expect((await members[0]!.post(`/api/tournaments/${id}/register`)).body).toMatchObject({ started: false });
    expect((await members[1]!.post(`/api/tournaments/${id}/register`)).body).toMatchObject({ started: true, tableId: `sng-${id}` });
    const T = `sng-${id}`;

    let ws = await Promise.all(members.map((c) => TableSocket.open(c, T, { base })));
    const before = await ws[0]!.waitState((x) => !!x.hand && x.hand.actorSeat !== null, 30_000, 'a turn');
    for (const s of ws) s.close();
    await worker.stop();
    worker = await startWorker(port, state);

    ws = await Promise.all(members.map((c) => TableSocket.open(c, T, { base })));
    const after = ws[0]!.state!;
    expect(after.hand!.id).toBe(before.hand!.id);
    expect(after.hand!.seq).toBe(before.hand!.seq);
    const seat = (v: TableView) => v.seats.map((x) => ({ userId: x.userId, stack: x.stack, bet: x.streetBet }));
    expect(seat(after)).toEqual(seat(before));
    const mine = (v: TableView) => v.seats[v.you.seatIndex!]!.holeCards;
    expect(mine(after)).toHaveLength(2);
    expect(mine(after)).toEqual(mine(before));
    expect(after.tournament).toMatchObject({ id, status: 'running', level: before.tournament!.level, playersLeft: 2, entrants: 2 });

    const stop = autoplay(ws, shove);
    try {
      await ws[0]!.waitState((x) => x.tournament?.status === 'finished', 180_000, 'the tournament to finish');
    } finally {
      await stop();
    }
    for (const s of ws) s.close();
    const tn = await until(
      () => d1<{ status: string; reason: string; winner: string | null; left: number }>(`SELECT status, end_reason AS reason, winner_id AS winner, players_left AS left FROM tournaments WHERE id = '${id}'`, state),
      (r) => r[0]?.status === 'finished',
      'D1 to have the result',
      30_000,
    );
    expect(tn[0]).toMatchObject({ status: 'finished', reason: 'completed', left: 1 });
    const entries = await d1<{ userId: string; status: string; place: number; stack: number }>(
      `SELECT user_id AS userId, status, place, stack FROM tournament_entries WHERE tournament_id = '${id}' ORDER BY place`,
      state,
    );
    expect(entries.map((e) => [e.status, e.place, e.stack])).toEqual([
      ['won', 1, 400],
      ['eliminated', 2, 0],
    ]);
    expect(entries[0]!.userId).toBe(tn[0]!.winner);
  }, 360_000);
});
