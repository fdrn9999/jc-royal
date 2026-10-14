import { beforeAll, describe, expect, it } from 'vitest';
import { Client, newUser, sharedAdmin } from '../support/client';

let admin: Client;

beforeAll(async () => {
  admin = sharedAdmin();
  expect((await admin.get('/api/admin/auth/me')).status).toBe(200);
});

const put = (c: Client, body: unknown) => c.req('PUT', '/api/academy/progress', body);
const done = (at: number) => ({ startedAt: at, completedAt: at, step: 3 });

describe('academy progress sync', () => {
  it('stores per user, last write wins by updatedAt, other accounts never see it', async () => {
    const a = await newUser();
    const b = await newUser();
    expect((await a.client.get('/api/academy/progress')).body).toMatchObject({ data: null, badges: [] });

    const v1 = { v: 2, lessons: { cards: done(100) }, practice: {}, updatedAt: 200 };
    expect((await put(a.client, { version: 2, updatedAt: 200, data: v1 })).status).toBe(200);
    // An older snapshot (e.g. a stale second device) does not overwrite the newer one.
    expect((await put(a.client, { version: 2, updatedAt: 150, data: { v: 2, lessons: {} } })).status).toBe(200);
    const got = (await a.client.get('/api/academy/progress')).body;
    expect(got.data).toEqual(v1);
    expect(got.updatedAt).toBe(200);
    expect((await b.client.get('/api/academy/progress')).body.data).toBeNull();
  });

  it('rejects oversized or malformed payloads and anonymous callers', async () => {
    const a = await newUser();
    expect((await put(a.client, { version: 2, updatedAt: 1, data: { blob: 'x'.repeat(40_000) } })).status).toBe(400);
    expect((await put(a.client, { version: 'x', updatedAt: 1, data: {} })).status).toBe(400);
    expect((await new Client().get('/api/academy/progress')).status).toBe(401);
  });
});

const ALL_BADGES = ['academy-graduate', 'card-reader', 'first-step', 'hand-expert', 'practice-graduate', 'rule-keeper', 'sharp-eye'];
const DAY = 24 * 60 * 60_000;
const badgeIds = (body: { badges: { badge: string }[] }) => body.badges.map((x) => x.badge).sort();
/** Progress shaped like the real app's after finishing everything at `t`: every lesson up to its last step, all 8 scenarios, 3 review sets of 8 solved questions. */
function studied(t: number) {
  const last = { cards: 3, hands: 4, holdem: 4, actions: 3, practice: 0 };
  const lessons = Object.fromEntries(Object.entries(last).map(([id, step], i) => [id, { startedAt: t + i * 1000, completedAt: t + i * 1000 + 500, step }]));
  const practice = Object.fromEntries([...'ABCDEFGH'].map((s, i) => [s, t + 4000 + i]));
  return { v: 2, updatedAt: t + 5000, lessons, practice, quiz: { correct: 30, wrong: 4 }, review: { sessions: 3, best: 8 } };
}

describe('badges (cosmetic, chip-free)', () => {
  it('are awarded once from progress and never touch the wallet or ledger', async () => {
    const a = await newUser();
    const before = (await a.client.get('/api/auth/me')).body.balance;
    const ledger = (await a.client.get('/api/me/ledger')).body.length;
    const data = studied(Date.now());
    const r1 = await put(a.client, { version: 2, updatedAt: 10, data });
    expect(badgeIds(r1.body)).toEqual(ALL_BADGES);
    const r2 = await put(a.client, { version: 2, updatedAt: 11, data });
    expect(r2.body.badges).toEqual(r1.body.badges); // idempotent: same rows, same timestamps
    expect((await a.client.get('/api/auth/me')).body.balance).toBe(before);
    expect((await a.client.get('/api/me/ledger')).body.length).toBe(ledger);
  });

  it('forged or impossible progress is still stored but earns nothing', async () => {
    const now = Date.now();
    const forged: Record<string, unknown>[] = [
      // The pre-check fixture: 1970 timestamps, finished on step 3 of 5, review sets without a single answer.
      { v: 2, lessons: { cards: done(1), hands: done(2), holdem: done(3), actions: done(4), practice: done(5) }, practice: { A: 1, B: 1, C: 1, D: 1, E: 1, F: 1, G: 1, H: 1 }, review: { sessions: 3 } },
      // Dated three days ahead of the server's clock, review claimed without answers.
      { ...studied(now + 3 * DAY), quiz: { correct: 0, wrong: 0 } },
      // Before the account existed.
      { ...studied(now - 3 * DAY), quiz: { correct: 2, wrong: 0 } },
      // Wrong types: string / fractional times, finished on the first step, counters as strings.
      {
        v: 2,
        lessons: { cards: { startedAt: String(now), completedAt: String(now), step: 3 }, hands: { startedAt: now, completedAt: now + 0.5, step: 4 }, holdem: { startedAt: now, completedAt: now, step: 0 }, actions: { completedAt: now, step: 3 } },
        practice: { A: String(now) },
        quiz: { correct: '99', wrong: 0 },
        review: { sessions: 3 },
      },
    ];
    for (const data of forged) {
      const a = await newUser();
      const r = await put(a.client, { version: 2, updatedAt: now, data });
      expect(r.status).toBe(200);
      expect(r.body.badges).toEqual([]);
      const got = (await a.client.get('/api/academy/progress')).body;
      expect(got.data).toEqual(data); // progress sync is unaffected; only badges are withheld
      expect(got.badges).toEqual([]);
    }
  });

  it('concurrent syncs award each badge once with a stable time, and a later reset keeps them', async () => {
    const a = await newUser();
    const before = (await a.client.get('/api/auth/me')).body.balance;
    const ledger = (await a.client.get('/api/me/ledger')).body.length;
    const t = Date.now();
    const rs = await Promise.all([0, 1, 2, 3, 4].map((i) => put(a.client, { version: 2, updatedAt: t + i, data: studied(t) })));
    for (const r of rs) expect(r.status).toBe(200);
    const first = (await a.client.get('/api/academy/badges')).body as { badge: string; awardedAt: number }[];
    expect(first.map((b) => b.badge).sort()).toEqual(ALL_BADGES); // one row per badge
    expect((await put(a.client, { version: 2, updatedAt: t + 10, data: studied(t) })).body.badges).toEqual(first);

    // Restarting the academy replaces the progress but never takes a badge back.
    const reset = { v: 2, updatedAt: t + 20, resetAt: t + 20, lessons: {}, practice: {}, quiz: { correct: 0, wrong: 0 }, review: { sessions: 0, best: 0 } };
    expect((await put(a.client, { version: 2, updatedAt: t + 20, data: reset })).body.badges).toEqual(first);
    const got = (await a.client.get('/api/academy/progress')).body;
    expect(got.data).toEqual(reset);
    expect(got.badges).toEqual(first);
    expect((await a.client.get('/api/auth/me')).body.balance).toBe(before);
    expect((await a.client.get('/api/me/ledger')).body.length).toBe(ledger);
  });
});

describe('anonymous academy statistics', () => {
  it('aggregates counters without user ids; admin-only read', async () => {
    const a = await newUser();
    const id = `itest-${Date.now().toString(36)}`;
    const events = [
      { kind: 'question', id, correct: false },
      { kind: 'question', id, correct: true },
      { kind: 'lesson', id, phase: 'start' },
      { kind: 'lesson', id, phase: 'complete' },
    ];
    expect((await a.client.post('/api/academy/events', { events })).status).toBe(200);
    expect((await a.client.post('/api/academy/events', { events: [{ kind: 'question', id: 'bad id!', correct: true }] })).status).toBe(400);
    expect((await a.client.get('/api/admin/academy/stats')).status).toBeGreaterThanOrEqual(401);
    const rows = (await admin.get('/api/admin/academy/stats')).body as Record<string, unknown>[];
    expect(rows.find((r) => r.kind === 'question' && r.itemId === id)).toEqual({ kind: 'question', itemId: id, starts: 0, completes: 0, correct: 1, wrong: 1 });
    expect(rows.find((r) => r.kind === 'lesson' && r.itemId === id)).toMatchObject({ starts: 1, completes: 1 });
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['completes', 'correct', 'itemId', 'kind', 'starts', 'wrong']);
  });
});

describe('beginner tables', () => {
  it('admin marks a table as beginner and the lobby shows the flag', async () => {
    const created = await admin.post('/api/admin/tables', { name: `입문 ${Date.now() % 1000}`, maxSeats: 6, smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 200, beginner: true });
    expect(created.status).toBe(201);
    const u = await newUser();
    const lobby = (await u.client.get('/api/tables')).body as { id: string; beginner: boolean }[];
    expect(lobby.find((t) => t.id === created.body.id)?.beginner).toBe(true);
    expect((await admin.patch(`/api/admin/tables/${created.body.id}`, { beginner: false })).status).toBe(200);
    expect(((await u.client.get(`/api/tables/${created.body.id}`)).body as { beginner: boolean }).beginner).toBe(false);
  });
});
