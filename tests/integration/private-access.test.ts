import { afterEach, describe, expect, it } from 'vitest';
import { BASE, type Client, newUser, WEB_ORIGIN } from '../support/client';
import { TableSocket } from '../support/ws';

const room = (over: Record<string, unknown> = {}) => ({ name: '비공개 방', maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000, isPrivate: true, ...over });

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});
async function sock(client: Client, tableId: string, opts: Parameters<typeof TableSocket.open>[2] = {}) {
  const s = await TableSocket.open(client, tableId, opts);
  open.push(s);
  return s;
}

/** The raw Set-Cookie of an /access call (the test client keeps only name=value). */
async function accessRaw(client: Client, tableId: string, code: string) {
  const res = await fetch(`${BASE()}/api/tables/${tableId}/access`, {
    method: 'POST',
    headers: { Origin: WEB_ORIGIN, Cookie: client.cookieHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return { status: res.status, cookies: res.headers.getSetCookie(), body: (await res.json()) as { ok?: boolean; error?: { code: string } } };
}

describe('private table join tickets', () => {
  it('trades the code for an HttpOnly ticket scoped to the table socket; the code itself is never accepted in a URL', async () => {
    const host = await newUser();
    const { id } = (await host.client.post('/api/rooms', room({ joinCode: 'pass-1234' }))).body;
    const guest = await newUser();

    const ok = await accessRaw(guest.client, id, 'pass-1234');
    expect(ok.status).toBe(200);
    expect(ok.cookies).toHaveLength(1);
    const ticket = ok.cookies[0]!;
    expect(ticket).toMatch(new RegExp(`^jc_room_${id}=`));
    expect(ticket).toMatch(/HttpOnly/i);
    expect(ticket).toMatch(/SameSite=Strict/i);
    expect(ticket).toContain(`Path=/ws/tables/${id}`);
    expect(ticket).not.toContain('pass-1234');

    // The old way, the code in the socket address, no longer lets anyone sit.
    const legacy = await sock(guest.client, id, { query: '?code=pass-1234' });
    expect(legacy.state!.you).toMatchObject({ canSit: false, needsCode: true });
    legacy.close();

    // With the ticket: sit, then stand up again.
    const withTicket = await sock(guest.client, id, { code: 'pass-1234' });
    expect(withTicket.access).toBe(200);
    expect(withTicket.state!.you).toMatchObject({ canSit: true, needsCode: false });
    expect(await withTicket.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    expect(await withTicket.request({ t: 'leave' })).toMatchObject({ t: 'ack' });

    // A ticket belongs to the member it was issued to.
    const thief = await newUser();
    thief.client.cookies.set(`jc_room_${id}`, ticket.split(';')[0]!.split('=').slice(1).join('='));
    const stolen = await sock(thief.client, id);
    expect(stolen.state!.you).toMatchObject({ canSit: false, needsCode: true });

    // The host needs no code for their own room, and public tables need none: no cookie in either case.
    expect(await accessRaw(host.client, id, 'anything')).toMatchObject({ status: 200, cookies: [] });
    expect(await accessRaw(guest.client, 'it-six-5', 'anything')).toMatchObject({ status: 200, cookies: [] });
    expect((await accessRaw(guest.client, 'no-such-table', 'anything')).status).toBe(404);
  });

  it('wrong codes are refused and limited per member', async () => {
    const host = await newUser();
    const { id } = (await host.client.post('/api/rooms', room({ joinCode: 'right-code' }))).body;
    const guesser = await newUser();
    const statuses: number[] = [];
    // 10 tries per 10 minutes; the window is fixed, so allow for it turning over once during the loop.
    for (let i = 0; i < 21 && !statuses.includes(429); i++) {
      const r = await guesser.client.post(`/api/tables/${id}/access`, { code: `guess-${i}` });
      statuses.push(r.status);
      if (r.status === 403) expect(r.body.error.code).toBe('bad_join_code');
      if (r.status === 429) expect(r.body.error.code).toBe('rate_limited');
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((s) => s === 403)).toBe(true);
    expect(statuses.length).toBeGreaterThanOrEqual(11);
    // Even the right code waits for the limit to pass.
    expect((await guesser.client.post(`/api/tables/${id}/access`, { code: 'right-code' })).status).toBe(429);
  });

  it('without spectators, a socket without the code is closed with 4003; a code change revokes old tickets but never a seat', async () => {
    const host = await newUser();
    const { id } = (await host.client.post('/api/rooms', room({ joinCode: 'first-code', allowSpectators: false }))).body;

    const stranger = await newUser();
    const refused = await sock(stranger.client, id, { noState: true });
    expect(await refused.waitClose()).toBe(4003);
    expect(refused.messages).toEqual([expect.objectContaining({ t: 'error', code: 'join_code_required' })]);

    // The host gets in without a ticket; a guest with one sits; a third member with one waits.
    const wh = await sock(host.client, id);
    expect(wh.state!.you).toMatchObject({ needsCode: false, canSit: true });
    expect(await wh.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const guest = await newUser();
    const wg = await sock(guest.client, id, { code: 'first-code' });
    expect(await wg.request({ t: 'sit', seatIndex: 1, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const waiter = await newUser();
    const ww = await sock(waiter.client, id, { code: 'first-code' });
    ww.send({ t: 'waitlist', join: true });
    await ww.waitState((s) => s.you.inWaitlist, 10_000, 'in waitlist');
    const viewer = await newUser();
    const wv = await sock(viewer.client, id, { code: 'first-code' });
    expect(wv.state!.you.needsCode).toBe(false);

    // The host changes the code: those holding only the old one are let go, the seated stay.
    expect((await host.client.patch(`/api/rooms/${id}`, { joinCode: 'second-code' })).status).toBe(200);
    expect(await ww.waitClose()).toBe(4003);
    expect(await wv.waitClose()).toBe(4003);
    const hs = await wh.waitState((s) => s.waitlist.length === 0, 10_000, 'waitlist dropped');
    expect(hs.seats.filter((x) => x.state !== 'empty').map((x) => x.userId)).toEqual([host.me.id, guest.me.id]);
    expect(wg.closed).toBeNull();

    // A seated player comes back without any valid ticket; the old ticket lets nobody else in.
    wg.close();
    const back = await sock(guest.client, id);
    expect(back.state!.you.seatIndex).toBe(1);
    const again = await sock(viewer.client, id, { noState: true });
    expect(await again.waitClose()).toBe(4003);
    const fresh = await sock(viewer.client, id, { code: 'second-code' });
    expect(fresh.state!.you).toMatchObject({ needsCode: false });
  });

  it('with spectators, a code change keeps viewers watching but asks them for the new code to sit', async () => {
    const host = await newUser();
    const { id } = (await host.client.post('/api/rooms', room({ joinCode: 'watch-one' }))).body;
    const viewer = await newUser();
    const wv = await sock(viewer.client, id, { code: 'watch-one' });
    expect(wv.state!.you).toMatchObject({ canSit: true, needsCode: false });
    expect((await host.client.patch(`/api/rooms/${id}`, { joinCode: 'watch-two' })).status).toBe(200);
    await wv.waitState((s) => s.you.needsCode, 10_000, 'needs the new code');
    expect(wv.state!.you.canSit).toBe(false);
    expect(wv.closed).toBeNull();
    expect(await wv.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'error', code: 'join_code_required' });
  });
});
