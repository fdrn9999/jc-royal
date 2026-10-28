import type { LobbyTableDto } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { type Client, newUser } from '../support/client';
import { TableSocket } from '../support/ws';

const room = (over: Record<string, unknown> = {}) => ({ name: '참여 확인 방', maxSeats: 2, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000, ...over });

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});
async function sock(client: Client, tableId: string, opts: Parameters<typeof TableSocket.open>[2] = {}) {
  const s = await TableSocket.open(client, tableId, opts);
  open.push(s);
  return s;
}

const list = async (c: Client) => (await c.get('/api/tables')).body as LobbyTableDto[];
const one = async (c: Client, id: string) => (await c.get(`/api/tables/${id}`)).body as LobbyTableDto;
const balance = async (c: Client) => (await c.get('/api/auth/me')).body.balance as number;

describe('lobby participation', () => {
  it('tells only the caller that they hold a seat, the same in the list and the table, until they cash out', async () => {
    const host = await newUser();
    const { id } = (await host.client.post('/api/rooms', room())).body;
    const player = await newUser();
    const other = await newUser();

    expect((await one(player.client, id)).myParticipation).toEqual({ status: 'none' });
    const ws = await sock(player.client, id);
    expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });

    // The seat is the player's own business: the host and anyone else read none for the same table.
    expect((await one(player.client, id)).myParticipation).toEqual({ status: 'seated' });
    expect((await list(player.client)).find((t) => t.id === id)?.myParticipation).toEqual({ status: 'seated' });
    expect((await one(host.client, id)).myParticipation).toEqual({ status: 'none' });
    expect((await one(other.client, id)).myParticipation).toEqual({ status: 'none' });
    const others = await list(other.client);
    expect(others.find((t) => t.id === id)?.myParticipation).toEqual({ status: 'none' });
    expect(others.every((t) => t.myParticipation?.status === 'none')).toBe(true);
    // Nothing about the seat itself is in the reply.
    expect(Object.keys((await one(player.client, id)).myParticipation!)).toEqual(['status']);

    // Leaving the table page keeps the seat (nothing folds or cashes out); standing up ends it.
    ws.close();
    expect((await one(player.client, id)).myParticipation).toEqual({ status: 'seated' });
    const back = await sock(player.client, id);
    expect(back.state!.you.seatIndex).toBe(0);
    expect(await back.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await expect.poll(async () => (await one(player.client, id)).myParticipation?.status, { timeout: 10_000 }).toBe('none');
    expect((await list(player.client)).find((t) => t.id === id)?.myParticipation).toEqual({ status: 'none' });
  });

  it('a seated player returns to a full private table without spectators, with no code and no second buy-in; nobody borrows their way in', async () => {
    const host = await newUser();
    const { id } = (await host.client.post('/api/rooms', room({ isPrivate: true, joinCode: 'seat-code', allowSpectators: false }))).body;
    const wh = await sock(host.client, id);
    expect(await wh.request({ t: 'sit', seatIndex: 0, buyIn: 400 })).toMatchObject({ t: 'ack' });
    const player = await newUser();
    const wp = await sock(player.client, id, { code: 'seat-code' });
    expect(await wp.request({ t: 'sit', seatIndex: 1, buyIn: 500 })).toMatchObject({ t: 'ack' });
    const paid = await balance(player.client);
    // The two of them are dealt in: the player leaves in the middle of a hand, holding cards.
    const dealt = await wp.waitState((s) => !!s.hand && (s.seats[1]?.holeCards?.length ?? 0) === 2, 15_000, 'dealt in');
    const mine = dealt.seats[1]!;

    // Back in the lobby: the table is full and closed to viewers, but it is theirs to continue.
    wp.close();
    const seen = await one(player.client, id);
    expect(seen).toMatchObject({ isPrivate: true, allowSpectators: false, myParticipation: { status: 'seated' } });

    // Plain /table/{id}: no ticket, no code, no new buy-in. The same seat, hand, cards and stack come back, and the
    // turn clock was not touched by the trip.
    player.client.cookies.delete(`jc_room_${id}`);
    const back = await sock(player.client, id);
    expect(back.closed).toBeNull();
    expect(back.state!.you).toMatchObject({ seatIndex: 1, needsCode: false });
    expect(back.state!.hand?.id).toBe(dealt.hand!.id);
    expect(back.state!.hand?.deadline).toBe(dealt.hand!.deadline);
    expect(back.state!.seats[1]).toMatchObject({ userId: player.me.id, stack: mine.stack, streetBet: mine.streetBet, holeCards: mine.holeCards });
    expect(await balance(player.client)).toBe(paid);
    const ledger = (await player.client.get('/api/me/ledger')).body as { type: string; tableId: string }[];
    expect(ledger.filter((l) => l.type === 'buy_in' && l.tableId === id)).toHaveLength(1);

    // Another member gets nothing from the seat: refused without the code, and their lobby says none.
    const stranger = await newUser();
    expect((await one(stranger.client, id)).myParticipation).toEqual({ status: 'none' });
    const refused = await sock(stranger.client, id, { noState: true });
    expect(await refused.waitClose()).toBe(4003);
  });
});
