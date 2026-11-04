// Multi-table tournaments (docs/TOURNAMENT_MTT.md) behind MTT_ENABLED. Off (the shared worker, as in production):
// no multi-table template is made and none is listed. On (a worker of its own): 13 players over three 6-seat tables
// played to one winner, with the tables balanced and merged between hands down to a final table. Throughout, the
// tournament's chips stay the same in D1, nobody sits at two tables at once, a watcher never sees a card still in
// play; at the end every player has a place (shared only by those out in one hand with one stack) and the winner holds
// every chip.
import type { TableView, TournamentDetailDto, TournamentStructure } from '@jc/types';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, sharedAdmin, signupBody, uniq, WEB_ORIGIN } from '../support/client';
import { d1 } from '../support/d1';
import { prepareState, root, startWorker, TABLES, type RunningWorker } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errCode = (r: { body: any }) => r.body?.error?.code as string | undefined;
const ADMIN_ORIGIN = 'http://localhost:5174';

/** 13 players at 200 chips, 6-seat tables (5, 4 and 4 at the start), starting by itself once full. */
const MTT: TournamentStructure = {
  name: 'mtt',
  capacity: 13,
  minPlayers: 13,
  startStack: 200,
  levels: [
    { sb: 10, bb: 20 },
    { sb: 20, bb: 40 },
    { sb: 40, bb: 80 },
  ],
  levelMinutes: 1,
  turnSeconds: 10,
  timeBank: { enabled: false, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: true,
  format: 'mtt',
  tableSeats: 6,
};

async function reauth(c: Client) {
  const valid = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (valid && valid - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe('multi-table tournaments switched off', () => {
  const admin = sharedAdmin();
  it('makes no multi-table template and lists none', async () => {
    await reauth(admin);
    const made = await admin.post('/api/admin/tournament-templates', { ...MTT, name: uniq('mtt'), reason: 'mtt off test' });
    expect([made.status, errCode(made)]).toEqual([409, 'mtt_disabled']);
    const list = await admin.get('/api/admin/tournament-templates');
    expect(list.status).toBe(200);
    expect(list.body.mttEnabled).toBe(false);
    expect((list.body.templates as { format?: string }[]).some((t) => t.format === 'mtt')).toBe(false);
  });
});

describe('a multi-table tournament (MTT_ENABLED on)', () => {
  const state = resolve(root, 'tests/.state/mtt');
  const port = 8823;
  let worker: RunningWorker | undefined;
  const sockets: TableSocket[] = [];
  afterAll(async () => {
    for (const s of sockets.splice(0)) s.close();
    await worker?.stop();
  });

  it('plays 13 players over three tables down to one winner, chips and seats kept', async () => {
    await prepareState(state, TABLES);
    worker = await startWorker(port, state, { MTT_ENABLED: '1' });
    const base = worker.url;
    const n = Date.now();
    const member = async (tag: string) => {
      const c = new Client(WEB_ORIGIN, base);
      const nickname = `m${tag}${n % 100000}`.slice(0, 14);
      const r = await c.post('/api/auth/register', await signupBody(c, { email: `mtt-${tag}-${n}@mtt.dev`, nickname }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return { c, id: r.body.id as string, nickname };
    };

    // An operator on this worker (bootstrapped as global-setup does for the shared one).
    const boss = await member('boss');
    const boot = await fetch(`${base}/api/admin/auth/bootstrap`, {
      method: 'POST',
      headers: { Origin: ADMIN_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-bootstrap-token-0123456789', email: `mtt-boss-${n}@mtt.dev` }),
    });
    expect(boot.status, await boot.text()).toBe(200);
    const admin = new Client(ADMIN_ORIGIN, base);
    expect((await admin.post('/api/admin/auth/login', { email: `mtt-boss-${n}@mtt.dev`, password: PASSWORD })).status).toBe(200);
    expect(boss.id).toBeTruthy();
    await reauth(admin);
    const tpl = await admin.post('/api/admin/tournament-templates', { ...MTT, name: uniq('mtt'), reason: 'mtt test' });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    expect(tpl.body.template).toMatchObject({ format: 'mtt', tableSeats: 6 });
    expect((await admin.get('/api/admin/tournament-templates')).body.mttEnabled).toBe(true);
    // Values that do not make several tables are refused.
    const one = await admin.post('/api/admin/tournament-templates', { ...MTT, capacity: 6, minPlayers: 6, name: uniq('mtt'), reason: 'mtt test' });
    expect(one.status).toBe(400);
    const opened = await admin.post('/api/admin/tournaments', { templateId: tpl.body.template.id, templateVersion: tpl.body.template.version, name: uniq('MTT') });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const id = opened.body.tournament.id as string;

    const players = [];
    for (let i = 0; i < 13; i++) players.push(await member(`p${i}`));
    const watcher = await member('w');
    for (const p of players) {
      const r = await p.c.post(`/api/tournaments/${id}/register`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const tableIds = [1, 2, 3].map((k) => `mtt-${id}-${k}`);
    let d: TournamentDetailDto | undefined;
    for (let i = 0; i < 80; i++) {
      d = (await players[0]!.c.get(`/api/tournaments/${id}`)).body;
      if (d?.status === 'running' && d.tables?.length === 3) break;
      await sleep(250);
    }
    expect(d).toMatchObject({ status: 'running', mtt: { tableSeats: 6 } });
    expect(d!.tables!.map((t) => t.id)).toEqual(tableIds);
    expect(d!.tables!.map((t) => t.players).sort()).toEqual([4, 4, 5]);
    // The operator's view hears the coordinator.
    const ad = await admin.get(`/api/admin/tournaments/${id}`);
    expect(ad.body.coordinator).toMatchObject({ answered: true, status: 'running', playersLeft: 13 });
    expect(ad.body.coordinator.tables).toHaveLength(3);

    // Each player at their own table, as their page has it.
    type Seat = { p: (typeof players)[number]; table: string; ws: TableSocket; busy: boolean; done: boolean };
    const seats: Seat[] = [];
    for (const p of players) {
      const mine = (await p.c.get(`/api/tournaments/${id}`)).body as TournamentDetailDto;
      expect(tableIds).toContain(mine.me?.tableId);
      const ws = await TableSocket.open(p.c, mine.me!.tableId!, { base });
      sockets.push(ws);
      seats.push({ p, table: mine.me!.tableId!, ws, busy: false, done: false });
    }
    expect(seats.some((s) => s.ws.state!.seats[s.ws.state!.you.seatIndex ?? -1]?.userId === s.p.id)).toBe(true);

    // A watcher at every table: what it sees of the seats, and any card of a hand still in play.
    const watching = new Map<string, TableSocket>();
    const leaks: string[] = [];
    let finalSeen = false;
    for (const t of tableIds) {
      const ws = await TableSocket.open(watcher.c, t, { base });
      sockets.push(ws);
      watching.set(t, ws);
      ws.ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.t !== 'state') return;
        const s = m.state as TableView;
        if (s.you.seatIndex !== null) leaks.push(`${t}: the watcher is seated`);
        // No card while someone is to act; after that, only one the settled hand's showdown turned over, at that seat.
        if (s.hand && s.hand.actorSeat !== null && s.seats.some((x) => x.holeCards?.length)) leaks.push(`${t}: hole cards seen while hand ${s.hand.id} is in play`);
        const turned = new Map((s.hand?.result?.showdown ?? []).map((x) => [x.seatIndex, x.cards.join()]));
        for (const x of s.seats) if (x.holeCards?.length && turned.get(x.seatIndex) !== x.holeCards.join()) leaks.push(`${t}: seat ${x.seatIndex}'s cards seen outside the showdown of hand ${s.hand?.id ?? '-'}`);
        if (s.tournament?.mtt?.finalTable) finalSeen = true;
      });
    }

    // Two tables never hold the same player: a seat seen at two tables for more than a moment (a socket's lag) counts.
    const twice = new Map<string, number>();
    const doubled: string[] = [];
    const seatCheck = setInterval(() => {
      const at = new Map<string, string[]>();
      for (const [t, ws] of watching) for (const x of ws.state?.seats ?? []) if (x.userId) at.set(x.userId, [...(at.get(x.userId) ?? []), t]);
      for (const [u, ts] of at) {
        if (ts.length < 2) twice.delete(u);
        else if ((twice.get(u) ?? 0) + 1 >= 5) doubled.push(`${u} at ${ts.join(', ')}`);
        else twice.set(u, (twice.get(u) ?? 0) + 1);
      }
      for (const u of [...twice.keys()]) if (!at.has(u) || at.get(u)!.length < 2) twice.delete(u);
    }, 300);

    // Everyone goes all in on their turn, and follows the tournament to a new table when moved.
    let on = true;
    const moves: string[] = [];
    // A move followed as the page follows it (Table.tsx): to the table named. That table may have broken and closed
    // before the player got there, and its socket is then refused; the page then goes where the tournament has them
    // (`me.tableId`), which says where next if they are still on the way. Each refusal is kept with what the table's
    // own route answered; a player who gets to no table is stuck.
    const refused: string[] = [];
    const stuck: string[] = [];
    const following: Promise<void>[] = [];
    const follow = async (s: Seat, first: string) => {
      let to = first;
      try {
        for (let i = 0; i < 20; i++) {
          try {
            const ws = await TableSocket.open(s.p.c, to, { base });
            sockets.push(ws);
            s.ws = ws;
            s.table = to;
            return;
          } catch {
            const t = await s.p.c.get(`/api/tables/${to}`);
            refused.push(`${s.p.nickname}: ${to} (${t.status} ${(t.body as { status?: string } | null)?.status ?? '-'})`);
          }
          // An answer without the player's entry is no answer: not "out of the tournament".
          const r = await s.p.c.get(`/api/tournaments/${id}`);
          const me = r.status === 200 ? (r.body as TournamentDetailDto).me : undefined;
          if (!me) {
            stuck.push(`${s.p.nickname} at ${to}: the tournament answered ${r.status} without the entry`);
            s.done = true;
            return;
          }
          if (me.status !== 'playing') {
            s.done = true;
            return;
          }
          if (me.tableId && me.tableId !== to) to = me.tableId;
          else await sleep(1000);
        }
        stuck.push(`${s.p.nickname} at ${to}`);
      } catch (e) {
        stuck.push(`${s.p.nickname} at ${to}: ${e instanceof Error ? e.message : String(e)}`);
      }
      s.done = true;
    };
    const loop = (async () => {
      while (on) {
        for (const s of seats) {
          const st = s.ws.state;
          if (s.busy || s.done || !st) continue;
          const to = st.tournament?.mtt?.movedTo;
          if (to && to !== s.table) {
            s.busy = true;
            moves.push(`${s.p.nickname}: ${s.table} -> ${to}`);
            s.ws.close();
            following.push(follow(s, to).finally(() => (s.busy = false)));
            continue;
          }
          if (st.tournament && st.tournament.you.status !== 'playing') {
            s.done = true;
            continue;
          }
          if (!isMyTurn(st)) continue;
          s.busy = true;
          const legal = (t: string) => st.you.legal.some((o) => o.type === t);
          void s.ws
            .act(legal('allin') ? 'allin' : legal('call') ? 'call' : 'check')
            .catch(() => undefined)
            .finally(() => (s.busy = false));
        }
        await sleep(100);
      }
    })();

    // The chips in D1: every report a table makes is one hand's end, so the total never changes.
    const totals = new Set<number>();
    let end: { status: string; winner: string | null; left: number } | undefined;
    try {
      const deadline = Date.now() + 540_000;
      for (;;) {
        const [row] = await d1<{ status: string; winner: string | null; left: number; chips: number }>(
          `SELECT t.status, t.winner_id AS winner, t.players_left AS left,
                  (SELECT COALESCE(SUM(e.stack), 0) FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status IN ('playing', 'won')) AS chips
             FROM tournaments t WHERE t.id = '${id}'`,
          state,
        );
        totals.add(row!.chips);
        if (row!.status !== 'running') {
          end = row;
          break;
        }
        if (Date.now() > deadline) throw new Error(`the tournament did not finish; ${row!.left} left; moves: ${moves.length}`);
        await sleep(1500);
      }
    } finally {
      on = false;
      await loop;
      // A follow still under way when the tournament ended is waited for: its outcome counts below.
      await Promise.all(following);
      clearInterval(seatCheck);
    }

    expect(end).toMatchObject({ status: 'finished', left: 1 });
    expect([...totals]).toEqual([13 * 200]);
    expect(leaks).toEqual([]);
    expect(doubled).toEqual([]);
    // Every move got the player to a table (a refusal on the way is the page's case above, not a failure).
    expect(stuck, `refused: ${refused.join('; ') || 'none'}`).toEqual([]);
    console.info(`mtt: ${moves.length} moves, ${refused.length} refused${refused.length ? `: ${refused.join('; ')}` : ''}`);
    // Players went out, so tables were balanced or broken: some moved, and the last of them was the final table.
    expect(moves.length).toBeGreaterThan(0);
    expect(finalSeen).toBe(true);

    const entries = await d1<{ userId: string; status: string; place: number; stack: number; hand: number | null }>(
      `SELECT user_id AS userId, status, place, stack, eliminated_hand AS hand FROM tournament_entries WHERE tournament_id = '${id}' ORDER BY place`,
      state,
    );
    expect(entries).toHaveLength(13);
    expect(entries[0]).toMatchObject({ status: 'won', place: 1, stack: 13 * 200, userId: end!.winner, hand: null });
    const out = entries.slice(1);
    expect(out.every((e) => e.status === 'eliminated' && e.stack === 0 && e.hand !== null)).toBe(true);
    // Placed as a Sit & Go places (docs/TOURNAMENT.md): out in a later hand is higher; out in the same hand (one table's
    // report, whatever the other tables do meanwhile) with the same stack at its start, the same place. So the places
    // run as a competition ranking (1, 2, 3, 3, 5, ...), and a shared place is only ever of one hand.
    for (const e of entries) expect([e.userId, e.place]).toEqual([e.userId, 1 + entries.filter((x) => x.place < e.place).length]);
    for (const x of out)
      for (const y of out) {
        if (x.place === y.place) expect(x.hand).toBe(y.hand);
        else if (x.hand !== y.hand) expect([x.place, y.place, x.place < y.place]).toEqual([x.place, y.place, x.hand! > y.hand!]);
      }
    // The tables broken up closed as they broke; the last one lingers a minute for the result (as a Sit & Go's does),
    // then closes too, and the page lists none to watch.
    const open = async () => (await d1<{ id: string }>(`SELECT id FROM tables WHERE id LIKE 'mtt-${id}-%' AND status <> 'closed'`, state)).map((t) => t.id);
    expect(await open()).toHaveLength(1);
    for (let i = 0; i < 60 && (await open()).length; i++) await sleep(1500);
    expect(await open()).toEqual([]);
    const after = (await watcher.c.get(`/api/tournaments/${id}`)).body as TournamentDetailDto;
    expect(after).toMatchObject({ status: 'finished' });
    expect(after.tables ?? []).toEqual([]);
  }, 600_000);
});
