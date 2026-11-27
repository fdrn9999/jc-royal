// A table's background music (packages/types bgm.ts): chosen when the room is opened, one of the catalogue's ids and
// nothing else, kept with the room and told to everyone at it in the table's snapshot: its host, another player, a
// spectator, after a reconnect and after the game server comes back from its storage. A table without one (made
// before the choice existed) plays the default. A tournament's choice goes to its table.
import type { TableView, TournamentStructure, TournamentTemplateDto } from '@jc/types';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, signupBody, uniq, WEB_ORIGIN } from '../support/client';
import { d1 } from '../support/d1';
import { prepareState, root, startWorker, type RunningWorker } from '../support/worker';
import { TableSocket } from '../support/ws';

const room = (over: Record<string, unknown> = {}) => ({ name: '음악 방', maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000, ...over });
const bgmAt = async (c: Client, tableId: string, base?: string) => {
  const ws = await TableSocket.open(c, tableId, base ? { base } : {});
  const table = (ws.state as TableView).table;
  ws.close();
  return table.bgmId;
};
const admin = sharedAdmin();
async function reauth() {
  const valid = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (valid && valid - Date.now() > 60_000) return;
  const r = await admin.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe('a room’s background music', () => {
  it('is one of the catalogue’s ids: a URL, a path or any other text is refused, and nothing is stored for it', async () => {
    const u = await newUser();
    for (const bad of ['https://example.com/a.mp3', '/assets/tournament.mp3', '../music/tournament.mp3', 'Tournament', '', 'constructor', 7, null, ['tournament']]) {
      const r = await u.client.post('/api/rooms', room({ bgmId: bad }));
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const rows = await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM tables WHERE created_by = '${u.me.id}'`);
    expect(Number(rows[0]!.n)).toBe(0);
    // A field of another name is no way around it: the room is opened with the default, the URL kept nowhere.
    const r = await u.client.post('/api/rooms', room({ bgmUrl: 'https://example.com/a.mp3', bgm: 'https://example.com/a.mp3' }));
    expect(r.status).toBe(201);
    const stored = await d1<Record<string, unknown>>(`SELECT * FROM tables WHERE id = '${r.body.id}'`);
    expect(stored[0]!.bgm_id).toBe('black-table-rhythm');
    expect(JSON.stringify(stored)).not.toContain('example.com');
  });

  it('the one chosen is kept with the room and told to its host, another player, a spectator, and again after a reconnect', async () => {
    const host = await newUser();
    const guest = await newUser();
    const watcher = await newUser();
    const made = await host.client.post('/api/rooms', room({ bgmId: 'tournament' }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id as string;
    expect((await d1<{ bgm: string }>(`SELECT bgm_id AS bgm FROM tables WHERE id = '${id}'`))[0]!.bgm).toBe('tournament');

    const wh = await TableSocket.open(host.client, id);
    const wg = await TableSocket.open(guest.client, id);
    const ww = await TableSocket.open(watcher.client, id);
    expect(await wh.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    expect(await wg.request({ t: 'sit', seatIndex: 1, buyIn: 400 })).toMatchObject({ t: 'ack' });
    // Seated or watching, in a hand or between two: every snapshot says the same.
    const dealt = await ww.waitState((s) => !!s.hand, 20_000, 'a hand');
    expect(dealt.you.seatIndex).toBeNull();
    for (const w of [wh, wg, ww]) expect((await w.waitState((s) => !!s.hand, 20_000, 'a hand')).table.bgmId).toBe('tournament');
    // A reload, a dropped connection: the room says it again.
    wg.close();
    ww.close();
    expect(await bgmAt(guest.client, id)).toBe('tournament');
    expect(await bgmAt(watcher.client, id)).toBe('tournament');
    // The host's own changes to the room do not touch it (it is chosen once, when the room is opened).
    expect((await host.client.patch(`/api/rooms/${id}`, { name: '이름만 바꾼 방', bgmId: 'none' })).status).toBe(200);
    expect(await bgmAt(guest.client, id)).toBe('tournament');
    const wg2 = await TableSocket.open(guest.client, id);
    for (const w of [wh, wg2]) if (w.state?.you.seatIndex != null) await w.request({ t: 'leave' });
    wh.close();
    wg2.close();
  }, 90_000);

  it('a room without music says so; one opened without a choice, and an official table, play the default', async () => {
    const u = await newUser();
    const quiet = await u.client.post('/api/rooms', room({ bgmId: 'none' }));
    const plain = await u.client.post('/api/rooms', room({ name: '고르지 않은 방' }));
    expect([quiet.status, plain.status]).toEqual([201, 201]);
    expect(await bgmAt(u.client, quiet.body.id)).toBe('none');
    expect(await bgmAt(u.client, plain.body.id)).toBe('black-table-rhythm');
    // Seeded without the column's value, as every table made before the migration is after it.
    expect(await bgmAt(u.client, 'it-six-5')).toBe('black-table-rhythm');
  });

  it('an official table takes the same ids from the console', async () => {
    await reauth();
    const base = { maxSeats: 6, smallBlind: 10, bigBlind: 20, minBuyIn: 400, maxBuyIn: 4000 };
    const bad = await admin.post('/api/admin/tables', { ...base, name: uniq('bgm-bad'), bgmId: 'https://example.com/a.mp3' });
    expect(bad.status).toBe(400);
    const ok = await admin.post('/api/admin/tables', { ...base, name: uniq('bgm-ok'), bgmId: 'tournament' });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    const dflt = await admin.post('/api/admin/tables', { ...base, name: uniq('bgm-df') });
    expect(dflt.status, JSON.stringify(dflt.body)).toBeLessThan(300);
    const u = await newUser();
    expect(await bgmAt(u.client, ok.body.id)).toBe('tournament');
    expect(await bgmAt(u.client, dflt.body.id)).toBe('black-table-rhythm');
  });
});

describe('a tournament’s background music', () => {
  const TWO: TournamentStructure = {
    name: 'bgm',
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
  const opened: string[] = [];
  afterAll(async () => {
    for (const id of opened) {
      const cur = (await admin.get(`/api/admin/tournaments/${id}`)).body?.tournament as { status: string; version: number; name: string } | undefined;
      if (!cur) continue;
      await reauth();
      if (cur.status === 'running') await admin.post(`/api/admin/tournaments/${id}/abort`, { baseVersion: cur.version, reason: 'bgm test done', confirmName: cur.name });
      else if (cur.status === 'registering' || cur.status === 'closed') await admin.post(`/api/admin/tournaments/${id}/cancel`, { baseVersion: cur.version, reason: 'bgm test done' });
    }
  });

  it('chosen by its host from the same ids, and played at its table for every player', async () => {
    await reauth();
    const made = await admin.post('/api/admin/tournament-templates', { ...TWO, name: uniq('bgmtpl'), reason: 'bgm test' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const tpl = made.body.template as TournamentTemplateDto;
    const a = await newUser();
    const b = await newUser();
    for (const bad of ['https://example.com/a.mp3', 'Tournament', '']) {
      expect((await a.client.post('/api/tournaments/private', { templateId: tpl.id, bgmId: bad })).status, bad).toBe(400);
    }
    const r = await a.client.post('/api/tournaments/private', { templateId: tpl.id, bgmId: 'tournament' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    opened.push(id);
    expect((await d1<{ bgm: string }>(`SELECT bgm_id AS bgm FROM tournaments WHERE id = '${id}'`))[0]!.bgm).toBe('tournament');
    expect((await b.client.post('/api/tournaments/join', { code: r.body.code })).status).toBe(200);
    const started = await a.client.post(`/api/tournaments/${id}/start`);
    expect(started.body, JSON.stringify(started.body)).toMatchObject({ started: true });
    const T = started.body.tableId as string;
    expect((await d1<{ bgm: string }>(`SELECT bgm_id AS bgm FROM tables WHERE id = '${T}'`))[0]!.bgm).toBe('tournament');
    expect(await bgmAt(a.client, T)).toBe('tournament');
    expect(await bgmAt(b.client, T)).toBe('tournament');
  }, 90_000);

  it('one opened without a choice plays the default', async () => {
    await reauth();
    const made = await admin.post('/api/admin/tournament-templates', { ...TWO, name: uniq('bgmtpl'), reason: 'bgm test' });
    const tpl = made.body.template as TournamentTemplateDto;
    const a = await newUser();
    const r = await a.client.post('/api/tournaments/private', { templateId: tpl.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    opened.push(r.body.id);
    expect((await d1<{ bgm: string }>(`SELECT bgm_id AS bgm FROM tournaments WHERE id = '${r.body.id}'`))[0]!.bgm).toBe('black-table-rhythm');
  });
});

describe('a room’s background music across a game server restart', () => {
  const state = resolve(root, 'tests/.state/bgm');
  const port = 8824;
  let worker: RunningWorker | undefined;
  afterAll(async () => {
    await worker?.stop();
  });

  it('comes back from the room’s storage; an id no longer in the catalogue plays the default', async () => {
    await prepareState(state, [{ id: 'it-bgm-old', maxSeats: 6 as const, sb: 5, bb: 10, min: 100, max: 1000, turnSeconds: 60 }]);
    // A row holding an id a later version dropped from the catalogue.
    await d1(`UPDATE tables SET bgm_id = 'a-track-long-gone' WHERE id = 'it-bgm-old'`, state);
    worker = await startWorker(port, state);
    const base = worker.url;
    const user = async (n: string) => {
      const c = new Client(WEB_ORIGIN, base);
      const r = await c.post('/api/auth/register', await signupBody(c, { email: `${n}-${Date.now()}@bgm.dev`, nickname: `${n}${Date.now() % 100000}` }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return c;
    };
    const host = await user('bh');
    const guest = await user('bg');
    const made = await host.post('/api/rooms', room({ bgmId: 'tournament' }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id as string;
    const quiet = await host.post('/api/rooms', room({ name: '조용한 방', bgmId: 'none' }));
    expect(quiet.status).toBe(201);
    // Seated, so the room has something to restore.
    const wh = await TableSocket.open(host, id, { base });
    expect(await wh.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    expect(wh.state!.table.bgmId).toBe('tournament');
    expect(await bgmAt(guest, 'it-bgm-old', base)).toBe('black-table-rhythm');

    await worker.stop();
    worker = await startWorker(port, state);

    const back = await TableSocket.open(host, id, { base });
    expect(back.state!.table.bgmId).toBe('tournament');
    expect(back.state!.you.seatIndex).toBe(0);
    expect(await bgmAt(guest, id, base)).toBe('tournament');
    expect(await bgmAt(guest, quiet.body.id, base)).toBe('none');
    expect(await bgmAt(guest, 'it-bgm-old', base)).toBe('black-table-rhythm');
    expect(await back.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    back.close();
    wh.close();
  }, 240_000);
});
