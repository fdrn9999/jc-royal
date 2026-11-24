// A tournament's hands in hand history and the tournament statistics (docs/TOURNAMENT.md "대회 핸드 기록"). A tournament
// opened without hand recording leaves no hand behind, so the HUD's tournament scope has nothing to count (how every
// tournament was before, and still is unless TOURNAMENT_HANDS_ENABLED is set). One opened with it records each hand
// once — through D1 being away and a server restart with a hand still unrecorded — under its tournament, with the level
// it was dealt at, and apart from cash play: wallets, the chip ledger, a member's own statistics, achievements and
// challenges stay as they were.
import type { HandSummaryDto, PlayerHudDto, StatsDto, TableView } from '@jc/types';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, signupBody, WEB_ORIGIN } from '../support/client';
import { d1 as d1At, holdD1WriteLock } from '../support/d1';
import { prepareState, root, startWorker, TABLES, type RunningWorker } from '../support/worker';
import { isMyTurn, TableSocket } from '../support/ws';

const state = resolve(root, 'tests/.state/tournament-hands');
const port = 8820;
// The service-wide switch is on here; what a tournament does is what it was opened with (`record_hands`).
const VARS = { TOURNAMENT_HANDS_ENABLED: '1' };
const d1 = <T = Record<string, unknown>>(sql: string) => d1At<T>(sql, state);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}; last: ${JSON.stringify(v).slice(-300)}`);
    await sleep(250);
  }
}

type Choice = { type: string; amount?: number };
const option = (s: TableView, type: string) => s.you.legal.find((o) => o.type === type);
const shove = (s: TableView): Choice => (option(s, 'allin') ? { type: 'allin' } : option(s, 'call') ? { type: 'call' } : { type: 'check' });
const giveUp = (s: TableView): Choice => (option(s, 'fold') ? { type: 'fold' } : { type: 'check' });

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

let worker: RunningWorker | undefined;
let serial = 0;
const tag = Date.now().toString(36);

/** A two-player tournament put straight into D1 (as tournaments.test.ts does for its restart), with or without hand recording. */
async function tournament(record: boolean) {
  const id = `th${serial++}${tag}`.padEnd(12, '0').slice(0, 12);
  await d1(
    `INSERT INTO tournaments (id, name, status, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms, tb_unit_ms, tb_refill_hands, tb_refill_ms, min_hands, require_verified, auto_start, record_hands)
     VALUES ('${id}', 'hands ${record ? 'on' : 'off'}', 'registering', 2, 2, 200, '[{"sb":10,"bb":20},{"sb":20,"bb":40}]', 600000, 60, 1, 30000, 60000, 10000, 10, 5000, 0, 0, 1, ${record ? 1 : 0})`,
  );
  return id;
}

async function member(i: number) {
  const client = new Client(WEB_ORIGIN, worker!.url);
  const n = `${tag}${serial++}`;
  const r = await client.post('/api/auth/register', await signupBody(client, { email: `th-${n}-${i}@hands.dev`, nickname: `th${i}${n}`.slice(0, 14) }));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { client, id: r.body.id as string };
}

async function entered(id: string) {
  const members = [await member(0), await member(1)];
  expect((await members[0]!.client.post(`/api/tournaments/${id}/register`)).body).toMatchObject({ started: false });
  expect((await members[1]!.client.post(`/api/tournaments/${id}/register`)).body).toMatchObject({ started: true, tableId: `sng-${id}` });
  return members;
}

const open = (members: { client: Client }[], table: string) => Promise.all(members.map((m) => TableSocket.open(m.client, table, { base: worker!.url })));
const ids = (xs: string[]) => xs.map((x) => `'${x}'`).join(', ');
async function books(users: string[]) {
  const rows = await d1<{ id: string; balance: number; n: number; badges: number; challenges: number }>(
    `SELECT u.id, u.balance, (SELECT COUNT(*) FROM chip_ledger l WHERE l.user_id = u.id) AS n,
            (SELECT COUNT(*) FROM user_badges b WHERE b.user_id = u.id AND b.badge != 'play:tournament_win') AS badges,
            (SELECT COUNT(*) FROM challenge_completions c WHERE c.user_id = u.id) AS challenges
       FROM users u WHERE u.id IN (${ids(users)}) ORDER BY u.id`,
  );
  return rows.map((r) => ({ ...r }));
}
const hud = (c: Client, id: string, scope: string) => c.get<PlayerHudDto>(`/api/players/${id}/hud?scope=${scope}`);
const finished = (id: string) =>
  until(
    () => d1<{ status: string; hands: number }>(`SELECT status, hands FROM tournaments WHERE id = '${id}'`),
    (r) => r[0]?.status === 'finished',
    'D1 to have the result',
  );

async function playOut(ws: TableSocket[]) {
  const stop = autoplay(ws, shove);
  try {
    await ws[0]!.waitState((x) => x.tournament?.status === 'finished', 180_000, 'the tournament to finish');
  } finally {
    await stop();
  }
  for (const s of ws) s.close();
}

describe("a tournament's hands", () => {
  beforeAll(async () => {
    await prepareState(state, TABLES);
    worker = await startWorker(port, state, VARS);
  }, 240_000);
  afterAll(async () => {
    await worker?.stop();
  });

  it('are not kept by a tournament opened without hand recording: nothing for the tournament statistics to count', async () => {
    const id = await tournament(false);
    const members = await entered(id);
    await playOut(await open(members, `sng-${id}`));
    const [tn] = await finished(id);
    expect(tn!.hands).toBeGreaterThan(0);
    expect(await d1(`SELECT id FROM hands WHERE table_id = 'sng-${id}'`)).toEqual([]);
    expect(await d1(`SELECT hand_id FROM hand_players WHERE user_id IN (${ids(members.map((m) => m.id))})`)).toEqual([]);
    for (const m of members) expect((await hud(m.client, m.id, 'tournament')).body.stats!.hands).toBe(0);
  }, 360_000);

  it('are recorded once each by a tournament opened with it, through a D1 outage and a restart, apart from cash play', async () => {
    const id = await tournament(true);
    const T = `sng-${id}`;
    const members = await entered(id);
    const users = members.map((m) => m.id);
    const before = await books(users);

    // The first hand ends while D1 is away, and the server stops before D1 is back: the hand waits in the room.
    let ws = await open(members, T);
    const first = await ws[0]!.waitState((x) => !!x.hand && x.hand.actorSeat !== null, 30_000, 'a turn');
    const release = holdD1WriteLock(state);
    try {
      const stop = autoplay(ws, giveUp);
      try {
        await ws[0]!.waitState((x) => x.hand?.id !== first.hand!.id || x.hand.stage === 'settled', 60_000, 'the first hand to end');
      } finally {
        await stop();
      }
      for (const s of ws) s.close();
      await worker!.stop();
    } finally {
      release();
    }
    expect(await d1(`SELECT id FROM hands WHERE table_id = '${T}'`)).toEqual([]);
    worker = await startWorker(port, state, VARS);

    ws = await open(members, T);
    await until(() => d1<{ id: string }>(`SELECT id FROM hands WHERE table_id = '${T}'`), (r) => r.some((h) => h.id === first.hand!.id), 'the first hand in D1 after the restart', 60_000);
    await playOut(ws);
    const [tn] = await finished(id);

    const hands = await until(
      () =>
        d1<{ id: string; n: number; tid: string | null; meta: string; players: number; tagged: number }>(
          `SELECT h.id, h.hand_number AS n, h.tournament_id AS tid, h.tournament AS meta,
                  (SELECT COUNT(*) FROM hand_players p WHERE p.hand_id = h.id) AS players,
                  (SELECT COUNT(*) FROM hand_players p WHERE p.hand_id = h.id AND p.tournament_id = '${id}') AS tagged
             FROM hands h WHERE h.table_id = '${T}' ORDER BY h.hand_number`,
        ),
      (r) => r.length >= tn!.hands,
      'every hand in D1',
      60_000,
    );
    // Each hand the tournament counted, once, in order.
    expect(hands.map((h) => h.n)).toEqual(Array.from({ length: tn!.hands }, (_, i) => i + 1));
    expect(new Set(hands.map((h) => h.id)).size).toBe(hands.length);
    for (const h of hands) {
      expect(h.tid).toBe(id);
      expect([h.players, h.tagged]).toEqual([2, 2]);
      const meta = JSON.parse(h.meta) as Record<string, unknown>;
      expect(meta).toMatchObject({ format: 'sng', startStack: 200, hand: h.n, left: 2 });
      expect([[0, 10, 20], [1, 20, 40]]).toContainEqual([meta.level, meta.sb, meta.bb]);
    }
    expect(JSON.parse(hands[0]!.meta)).toMatchObject({ level: 0, sb: 10, bb: 20 });
    // Tournament chips: every hand's results sum to nothing, and the last leaves one player with all of them.
    const nets = await d1<{ handId: string; net: number; top: number }>(`SELECT hand_id AS handId, SUM(net) AS net, MAX(stack_end) AS top FROM hand_players WHERE tournament_id = '${id}' GROUP BY hand_id`);
    expect(nets.every((r) => Number(r.net) === 0)).toBe(true);
    expect(Number(nets.find((r) => r.handId === hands.at(-1)!.id)!.top)).toBe(400);

    // Nothing of it in a wallet, the ledger, the badges (the winner's, which is the tournament's own, aside) or the challenges.
    expect(await books(users)).toEqual(before);

    for (const m of members) {
      // The tournament scope counts them; the cash scope and the member's own statistics do not.
      const t = (await hud(m.client, m.id, 'tournament')).body.stats!;
      expect(t.hands).toBe(hands.length);
      expect(t.vpip.of).toBeGreaterThan(0);
      expect((await hud(m.client, m.id, 'cash')).body.stats!.hands).toBe(0);
      const stats = (await m.client.get<StatsDto>('/api/me/stats')).body;
      expect(stats).toMatchObject({ handsPlayed: 0, netChips: 0, totalWon: 0, bestHand: null, largestPot: 0 });
      // Hand history lists them as the tournament's, at the level's big blind, and the replay opens.
      const list = (await m.client.get<HandSummaryDto[]>('/api/me/hands?limit=100')).body;
      expect(list.map((h) => h.id).sort()).toEqual(hands.map((h) => h.id).sort());
      for (const h of list) {
        const meta = JSON.parse(hands.find((x) => x.id === h.id)!.meta) as { level: number; bb: number };
        expect(h.tournament).toEqual({ id, format: 'sng', level: meta.level });
        expect(h.bigBlind).toBe(meta.bb);
      }
      expect((await m.client.get(`/api/me/hands/${hands[0]!.id}`)).status).toBe(200);
    }
  }, 480_000);

  it('are recorded from where a room kept by a server from before hand recording takes it up, and no earlier hand is made up', async () => {
    // A room's stored tournament from a game-worker older than hand recording has no such field, like one opened without
    // it: the api was deployed first and opened this tournament with recording, the older room dealt its first hand.
    const id = await tournament(false);
    const T = `sng-${id}`;
    const members = await entered(id);
    let ws = await open(members, T);
    const first = await ws[0]!.waitState((x) => !!x.hand && x.hand.actorSeat !== null, 30_000, 'a turn');
    const stop = autoplay(ws, giveUp);
    try {
      await ws[0]!.waitState((x) => x.hand?.id !== first.hand!.id || x.hand.stage === 'settled', 60_000, 'the first hand to end');
    } finally {
      await stop();
    }
    for (const s of ws) s.close();
    await worker!.stop();
    await d1(`UPDATE tournaments SET record_hands = 1 WHERE id = '${id}'`);
    worker = await startWorker(port, state, VARS);

    ws = await open(members, T);
    await playOut(ws);
    const [tn] = await finished(id);
    const rows = await until(
      () => d1<{ id: string; n: number; tid: string | null; meta: string }>(`SELECT id, hand_number AS n, tournament_id AS tid, tournament AS meta FROM hands WHERE table_id = '${T}' ORDER BY hand_number`),
      (r) => r.at(-1)?.n === tn!.hands,
      'the last hand in D1',
      60_000,
    );
    // The hands dealt after the restart, each once; the one before it stays unrecorded.
    expect(rows.some((h) => h.id === first.hand!.id)).toBe(false);
    expect(rows.length).toBeGreaterThan(0);
    const from = rows[0]!.n;
    expect(from).toBeGreaterThan(1);
    expect(rows.map((h) => h.n)).toEqual(Array.from({ length: tn!.hands - from + 1 }, (_, i) => from + i));
    for (const h of rows) {
      expect(h.tid).toBe(id);
      expect(JSON.parse(h.meta)).toMatchObject({ format: 'sng', hand: h.n });
    }
  }, 480_000);

  it('opens a tournament with hand recording where TOURNAMENT_HANDS_ENABLED is set', async () => {
    // (Without it — the main worker of tournaments.test.ts — a tournament is opened without, and leaves no hand.)
    const tpl = `th-tpl-${tag}`;
    await d1(
      `INSERT INTO tournament_templates (id, name, capacity, min_players, start_stack, levels, level_ms, turn_seconds, tb_enabled, tb_initial_ms, tb_max_ms, tb_unit_ms, tb_refill_hands, tb_refill_ms)
       VALUES ('${tpl}', 'hands', 2, 2, 200, '[{"sb":10,"bb":20},{"sb":20,"bb":40}]', 600000, 60, 1, 30000, 60000, 10000, 10, 5000)`,
    );
    const host = await member(0);
    const r = await host.client.post('/api/tournaments/private', { templateId: tpl });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const rows = await d1<{ record: number }>(`SELECT record_hands AS record FROM tournaments WHERE host_id = '${host.id}'`);
    expect(rows.map((x) => Number(x.record))).toEqual([1]);
  });
});
