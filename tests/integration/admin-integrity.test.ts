// Integrity signs (apps/api/src/lib/integrity.ts): the pairs of members whose cash-table hands show chips going one
// way, read by an administrator with the reports switch on, and a review of one pair filed as a report in the existing
// queue with the evidence worked out again on the server. Nothing here suspends anyone.
import { afterAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { ALL_GRANTS, promoteSql } from '../support/grants';

const ADMIN_ORIGIN = 'http://localhost:5174';
const admin = sharedAdmin();
const tag = uniq('integ');
const table = `${tag}-cash`;
const tour = `${tag}-tour`;
const BB = 10;

type User = Awaited<ReturnType<typeof newUser>>;

/**
 * `hands` hands at `at` on `t`: `giver` gives up 30 big blinds without a showdown and `taker` alone wins them, with
 * `others` dealt in for nothing.
 */
async function dumped(t: string, giver: User, taker: User, hands: number, at: number, others: User[] = []) {
  const ids = Array.from({ length: hands }, (_, i) => `${tag}-${t.slice(-4)}-h${i}`);
  const hand = (id: string, i: number) => `('${id}', '${t}', ${i + 1}, ${at - 60_000 + i}, ${at + i}, '[]', ${30 * BB}, 'test', '[]')`;
  const seat = (id: string, u: User, seat: number, net: number, i: number) =>
    `('${id}', '${u.me.id}', ${seat}, '[]', 1000, ${1000 + net}, ${net}, ${Math.max(0, net + 30 * BB)}, 0, ${at + i})`;
  await d1(
    `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ${ids.map(hand).join(', ')};` +
      `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) VALUES ${ids
        .flatMap((id, i) => [seat(id, giver, 0, -30 * BB, i), seat(id, taker, 1, 30 * BB, i), ...others.map((o, k) => seat(id, o, k + 2, 0, i))])
        .join(', ')};`,
  );
  return ids;
}

async function staffWith(grants: readonly string[]) {
  const u = await newUser();
  await d1(promoteSql(`id = '${u.me.id}'`, grants));
  const c = new Client(ADMIN_ORIGIN);
  expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
  return { c, id: u.me.id };
}

const pairOf = (body: any, from: string, to: string) => (body.pairs as any[]).find((p) => p.from === from && p.to === to);
const audits = (action: string, actor: string) =>
  d1<{ target: string | null; detail: string | null }>(
    `SELECT target_id AS target, detail FROM admin_audit_log WHERE action = '${action}' AND actor_id = '${actor}' AND outcome = 'ok' ORDER BY created_at, rowid`,
  );

afterAll(async () => {
  await d1(
    `DELETE FROM hand_players WHERE hand_id LIKE '${tag}-%'; DELETE FROM hands WHERE id LIKE '${tag}-%'; DELETE FROM tables WHERE id LIKE '${tag}-%';` +
      `DELETE FROM report_events WHERE report_id IN (SELECT id FROM reports WHERE json_extract(context, '$.kind') = 'signal' AND detail LIKE '${tag}%');` +
      `DELETE FROM reports WHERE json_extract(context, '$.kind') = 'signal' AND detail LIKE '${tag}%';`,
  );
});

describe('integrity signs', () => {
  it('lists a pair whose chips went one way, opens one review of it in the report queue, and records every look', async () => {
    const [giver, taker, bystander] = await Promise.all([newUser(), newUser(), newUser()]);
    const now = Date.now();
    await d1(
      `INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, status, room_type) VALUES
         ('${table}', '${table}', 6, 5, ${BB}, 200, 2000, 'closed', 'official'), ('${tour}', '${tour}', 6, 5, ${BB}, 200, 2000, 'closed', 'tournament')`,
    );
    // 12 hands at a cash table inside the week, 1 older than the week and 12 at a tournament table: only the 12 count.
    await dumped(table, giver, taker, 12, now - 3_600_000, [bystander]);
    await d1(
      `INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log) VALUES ('${tag}-old', '${table}', 99, ${now - 9 * 86_400_000}, ${now - 9 * 86_400_000}, '[]', 0, 'test', '[]');` +
        `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at) VALUES
           ('${tag}-old', '${giver.me.id}', 0, '[]', 1000, 0, -1000, 0, 0, ${now - 9 * 86_400_000}), ('${tag}-old', '${taker.me.id}', 1, '[]', 1000, 2000, 1000, 2000, 0, ${now - 9 * 86_400_000})`,
    );
    await dumped(tour, taker, giver, 12, now - 3_600_000);

    const me = (await admin.get('/api/admin/auth/me')).body.user.id as string;
    const list = await admin.get('/api/admin/integrity?days=7');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toMatchObject({ days: 7, capped: false, thresholds: { minShared: 10, minFlowBb: 50, dumpBb: 20, minDumps: 3 } });
    const pair = pairOf(list.body, giver.me.id, taker.me.id);
    expect(pair).toMatchObject({ shared: 12, flowBb: 360, oneWay: 1, dumps: 12, review: null });
    expect(pair.signals).toEqual(expect.arrayContaining(['flow', 'dumps']));
    expect(pair.risk).not.toBe('low');
    expect(pair.fromUser).toMatchObject({ id: giver.me.id, nickname: giver.me.nickname, status: 'active', openReports: 0 });
    expect(pair.toUser).toMatchObject({ id: taker.me.id, nickname: taker.me.nickname, openReports: 0 });
    // The evidence: the ten newest of the cash table's dumps, nothing from the tournament or before the week.
    expect(pair.hands).toHaveLength(10);
    expect(pair.hands.every((h: any) => h.tableId === table && h.dump && h.bb === 30)).toBe(true);
    // The tournament's chips went the other way; they are not a pair, and the bystander is in no pair.
    expect(pairOf(list.body, taker.me.id, giver.me.id)).toBeUndefined();
    expect((list.body.pairs as any[]).some((p) => p.from === bystander.me.id || p.to === bystander.me.id)).toBe(false);
    // No address is sent, only whether the two shared one.
    expect(JSON.stringify(list.body)).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|::1/);
    // Every look is recorded with the period and how many pairs it showed.
    const views = await audits('integrity.view', me);
    expect(JSON.parse(views.at(-1)!.detail!)).toEqual({ days: 7, pairs: list.body.pairs.length });

    // A review: a reason without personal data, two different members, neither a table bot, the pair as listed.
    const review = (body: Record<string, unknown>) => admin.post('/api/admin/integrity/review', { from: giver.me.id, to: taker.me.id, days: 7, reason: `${tag} chips one way`, ...body });
    expect((await review({ reason: 'x' })).body.error.code).toBe('bad_request');
    expect((await review({ reason: `${tag} 연락처 010-1234-5678` })).body.error.code).toBe('note_pii');
    expect((await review({ to: giver.me.id })).body.error.code).toBe('invalid_input');
    expect((await review({ to: `${tag}-nobody` })).status).toBe(404);
    const bot = (await d1<{ id: string }>(`SELECT id FROM users WHERE is_bot = 1 LIMIT 1`))[0];
    if (bot) expect((await review({ from: bot.id })).body.error.code).toBe('bot_account');
    // The other way round is not what the hands show; a pair that meets nothing either.
    expect((await review({ from: taker.me.id, to: giver.me.id })).body.error.code).toBe('not_flagged');
    expect((await review({ to: bystander.me.id })).body.error.code).toBe('not_flagged');

    const opened = await review({});
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const id = opened.body.id as string;
    const [row] = await d1<{ reporter: string; type: string; target: string; reason: string; status: string; detail: string; context: string }>(
      `SELECT reporter_id AS reporter, target_type AS type, target_user_id AS target, reason, status, detail, context FROM reports WHERE id = '${id}'`,
    );
    expect(row).toMatchObject({ reporter: me, type: 'player', target: taker.me.id, reason: 'cheating', status: 'open', detail: `${tag} chips one way` });
    const ctx = JSON.parse(row!.context);
    expect(ctx).toMatchObject({ kind: 'signal', partnerId: giver.me.id, partnerNickname: giver.me.nickname, days: 7, shared: 12, flowBb: 360, dumps: 12 });
    expect(ctx.hands).toHaveLength(10);
    expect(ctx.hands[0]).toEqual({ id: expect.any(String), number: expect.any(Number), tableId: table, bb: 30, dump: true });
    const reviewed = await audits('integrity.review', me);
    expect(reviewed.at(-1)!.target).toBe(taker.me.id);
    expect(JSON.parse(reviewed.at(-1)!.detail!)).toMatchObject({ reportId: id, partnerId: giver.me.id, days: 7, reason: `${tag} chips one way` });
    // Nobody was suspended or had chips touched by it.
    expect(await d1(`SELECT status FROM users WHERE id IN ('${giver.me.id}', '${taker.me.id}')`)).toEqual([{ status: 'active' }, { status: 'active' }]);

    // The list now points at the open review, and the queue shows it with its evidence.
    const again = pairOf((await admin.get('/api/admin/integrity?days=7')).body, giver.me.id, taker.me.id);
    expect(again).toMatchObject({ review: id, toUser: { openReports: 1 } });
    const queue = (await admin.get(`/api/admin/reports?status=open&userId=${taker.me.id}&limit=100`)).body.items as any[];
    expect(queue.find((r) => r.id === id)).toMatchObject({ reason: 'cheating', target: { id: taker.me.id }, context: { kind: 'signal', partnerId: giver.me.id } });

    // One open review per pair: asking again points at it.
    const twice = await review({});
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatchObject({ code: 'already_reported', details: { reportId: id } });
  });

  it('is open to administrators with the reports switch only; members get nothing', async () => {
    const member = await newUser();
    expect((await member.client.get('/api/admin/integrity')).status).toBe(403);
    const off = await staffWith(ALL_GRANTS.filter((g) => g !== 'reports'));
    const refused = await off.c.get('/api/admin/integrity');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('permission_off');
    expect((await off.c.post('/api/admin/integrity/review', { from: 'a', to: 'b', reason: 'look' })).body.error.code).toBe('permission_off');
    const on = await staffWith(['reports']);
    const seen = await on.c.get('/api/admin/integrity?days=30');
    expect(seen.status).toBe(200);
    expect(seen.body.days).toBe(30);
    // A period the page does not offer reads as the first one.
    expect((await on.c.get('/api/admin/integrity?days=365')).body.days).toBe(7);
  });
});
