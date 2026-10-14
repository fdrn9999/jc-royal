import { NEWCOMER_HANDS, type QuickPlayDto } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { newUser, uniq } from '../support/client';
import { d1 } from '../support/d1';
import { TableSocket } from '../support/ws';

type Quick = { status: number; body: QuickPlayDto & { error?: { code: string; details?: Record<string, number> } } };

const quick = (u: Awaited<ReturnType<typeof newUser>>, body: Record<string, unknown>) => u.client.post('/api/tables/quick', body) as Promise<Quick>;
const balance = async (u: Awaited<ReturnType<typeof newUser>>) => (await u.client.get('/api/auth/me')).body.balance as number;

/** Gives a user NEWCOMER_HANDS finished hands so quick play no longer treats them as new. */
async function makeExperienced(userId: string) {
  const tag = uniq('qp');
  await d1(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${NEWCOMER_HANDS})
     INSERT INTO hands (id, table_id, hand_number, started_at, ended_at, board, pot_total, engine_version, event_log)
     SELECT '${tag}-' || i, 'it-qp-a-reg', i, 1, 2, '[]', 0, 'test', '{"actions":[]}' FROM n`,
  );
  await d1(
    `INSERT INTO hand_players (hand_id, user_id, seat_index, hole_cards, stack_start, stack_end, net, won, went_to_showdown, ended_at)
     SELECT id, '${userId}', 0, '[]', 100, 100, 0, 0, 0, 2 FROM hands WHERE id LIKE '${tag}-%'`,
  );
}

describe('quick play', () => {
  it('sends newcomers to beginner tables first and experienced players elsewhere first', async () => {
    const fresh = await newUser();
    const first = await quick(fresh, { bigBlind: 26 });
    expect(first.status).toBe(200);
    expect(first.body.table).toMatchObject({ id: 'it-qp-a-beg', beginner: true, isPrivate: false });
    expect(first.body.seatIndex).toBe(0);
    // "Find another table" after a failed try skips the tables already tried.
    expect((await quick(fresh, { bigBlind: 26, exclude: ['it-qp-a-beg'] })).body.table.id).toBe('it-qp-a-reg');

    const veteran = await newUser();
    await makeExperienced(veteran.me.id);
    expect((await veteran.client.get('/api/me/stats')).body.handsPlayed).toBe(NEWCOMER_HANDS);
    expect((await quick(veteran, { bigBlind: 26 })).body.table.id).toBe('it-qp-a-reg');
    // Beginner tables are last for them, not closed to them.
    expect((await quick(veteran, { bigBlind: 26, exclude: ['it-qp-a-reg'] })).body.table.id).toBe('it-qp-a-beg');
  });

  it('honours table size and blind filters, and the chosen seat goes through the normal paid buy-in', async () => {
    const u = await newUser();
    const hu = await quick(u, { bigBlind: 34, maxSeats: 2 });
    expect(hu.body.table).toMatchObject({ id: 'it-qp-b-hu', maxSeats: 2, bigBlind: 34 });
    expect((await quick(u, { bigBlind: 34, maxSeats: 6 })).body.table).toMatchObject({ id: 'it-qp-b-six', maxSeats: 6 });
    expect((await quick(u, { maxSeats: 4 })).status).toBe(400);
    // Picking a table pays nothing; the buy-in is the usual seat request against the wallet ledger.
    expect(await balance(u)).toBe(10000);
    const ws = await TableSocket.open(u.client, hu.body.table.id);
    expect(await ws.request({ t: 'sit', seatIndex: hu.body.seatIndex, buyIn: 400 })).toMatchObject({ t: 'ack' });
    expect(await balance(u)).toBe(9600);
    const ledger = (await u.client.get('/api/me/ledger')).body as { type: string; amount: number; tableId: string }[];
    expect(ledger.filter((l) => l.type === 'buy_in')).toEqual([expect.objectContaining({ amount: -400, tableId: 'it-qp-b-hu' })]);
    ws.close();
  });

  it('never picks private or entry-blocked tables', async () => {
    const u = await newUser();
    const r = await quick(u, { bigBlind: 42 });
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe('no_table');
    expect((await quick(u, { bigBlind: 74 })).body.error?.code).toBe('no_table');
  });

  it('asks the table room, not the lobby counts: a full table is never returned', async () => {
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    const wa = await TableSocket.open(a.client, 'it-qp-d-full');
    const wb = await TableSocket.open(b.client, 'it-qp-d-full');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 600 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 600 })).toMatchObject({ t: 'ack' });
    // Make the lobby mirror claim the table is empty; only the room knows better.
    await d1(`UPDATE tables SET live_seated = 0, live_waitlist = 0 WHERE id = 'it-qp-d-full'`);
    const r = await quick(c, { bigBlind: 58 });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('tables_full');
    // A player already seated there is not sent back to it.
    expect((await quick(a, { bigBlind: 58 })).body.error?.code).toBe('no_table');
    wa.close();
    wb.close();
  });

  it('says when the wallet cannot cover any matching table, with the cheapest minimum', async () => {
    const u = await newUser();
    const r = await quick(u, { bigBlind: 66 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'insufficient_balance', details: { minBuyIn: 20000, balance: 10000 } });
    expect(await balance(u)).toBe(10000);
  });

  it('prefers tables where players are already seated', async () => {
    const host = await newUser();
    const ws = await TableSocket.open(host.client, 'it-qp-f-b');
    expect(await ws.request({ t: 'sit', seatIndex: 3, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    await expect
      .poll(async () => ((await host.client.get('/api/tables/it-qp-f-b')).body as { seated: number }).seated, { timeout: 10_000 })
      .toBe(1);
    const u = await newUser();
    const r = await quick(u, { bigBlind: 82 });
    expect(r.body.table).toMatchObject({ id: 'it-qp-f-b', seated: 1 });
    expect(r.body.seatIndex).toBe(0);
    ws.close();
  });
});
