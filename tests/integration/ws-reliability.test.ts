import type { ServerMessage, TableView } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { newUser, type Client } from '../support/client';
import { isMyTurn, TableSocket } from '../support/ws';

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function connect(client: Client, tableId: string) {
  const s = await TableSocket.open(client, tableId);
  open.push(s);
  return s;
}

/** The ack or error carrying this id (ignores answers already received). */
const answer = (s: TableSocket, reqId: string) => s.waitNext((m) => (m.t === 'ack' || m.t === 'error') && 'reqId' in m && m.reqId === reqId, 15_000, `answer to ${reqId}`);

/** A fresh state for this socket. */
async function synced(s: TableSocket): Promise<TableView> {
  const p = s.waitNext((m) => m.t === 'state');
  s.send({ t: 'sync' });
  return ((await p) as Extract<ServerMessage, { t: 'state' }>).state;
}

describe('command delivery over WebSocket', () => {
  it('answers a ping from the runtime, without the room', async () => {
    const u = await newUser();
    const s = await connect(u.client, 'it-link-0');
    const p = s.waitNext((m) => m.t === 'pong');
    s.ws.send('{"t":"ping"}');
    // The room's own handler would add `at`; the stored automatic answer is the bare text.
    expect(await p).toEqual({ t: 'pong' });
  });

  it('a sit sent again on a new connection after the first closed seats once and debits the wallet once', async () => {
    const u = await newUser();
    const first = await connect(u.client, 'it-link-1');
    const msg = { t: 'sit', seatIndex: 0, buyIn: 500, reqId: 'link-sit-0001' };
    first.send(msg);
    first.close(); // gone before its answer could arrive
    const second = await connect(u.client, 'it-link-1');
    const p = answer(second, msg.reqId);
    second.send(msg);
    expect(await p).toMatchObject({ t: 'ack' });
    await second.waitState((v) => v.you.seatIndex === 0);
    expect((await u.client.get('/api/auth/me')).body.balance).toBe(9500);
    const ledger = (await u.client.get('/api/me/ledger')).body as { type: string }[];
    expect(ledger.filter((e) => e.type === 'buy_in')).toHaveLength(1);
  });

  it('acknowledges an action, and one sent again after its connection closed counts once', async () => {
    const a = await newUser();
    const b = await newUser();
    const sockets = { a: await connect(a.client, 'it-link-2'), b: await connect(b.client, 'it-link-2') };
    expect(await sockets.a.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    expect(await sockets.b.request({ t: 'sit', seatIndex: 1, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    let who: 'a' | 'b' | null = null;
    for (let i = 0; i < 150 && !who; i++) {
      if (sockets.a.state && isMyTurn(sockets.a.state)) who = 'a';
      else if (sockets.b.state && isMyTurn(sockets.b.state)) who = 'b';
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(who, 'nobody sees their turn').not.toBeNull();
    const ws = sockets[who!];
    const client = who === 'a' ? a.client : b.client;
    const before = ws.state!;
    const h = before.hand!;
    const call = before.you.legal.find((o) => o.type === 'call');
    expect(call).toBeDefined();
    const stackBefore = before.seats[before.you.seatIndex!]!.stack;

    const msg = { t: 'action', intentId: 'link-act-0001', handId: h.id, seq: h.seq, type: 'call' };
    ws.send(msg);
    ws.close();
    const again = await connect(client, 'it-link-2');
    const p = answer(again, msg.intentId);
    again.send(msg);
    expect(await p).toMatchObject({ t: 'ack' });
    // And once more on the same connection: still only an answer.
    const p2 = answer(again, msg.intentId);
    again.send(msg);
    expect(await p2).toMatchObject({ t: 'ack' });

    const after = await synced(again);
    expect(after.hand!.id).toBe(h.id);
    expect(after.hand!.actorSeat).not.toBe(before.you.seatIndex);
    expect(stackBefore - after.seats[after.you.seatIndex!]!.stack).toBe((call as { amount: number }).amount);
    // Chips are conserved: stacks plus the pot (which includes this street's bets).
    expect(after.seats.reduce((n, s) => n + s.stack, 0) + after.hand!.potTotal).toBe(2000);
  });

  it('posts a chat line sent twice with the same id once and answers both', async () => {
    const u = await newUser();
    const watcher = await connect((await newUser()).client, 'it-link-3');
    const s = await connect(u.client, 'it-link-3');
    const msg = { t: 'chat', text: 'only once please', reqId: 'link-chat-0001' };
    const p1 = answer(s, msg.reqId);
    s.send(msg);
    expect(await p1).toMatchObject({ t: 'ack' });
    s.close();
    const s2 = await connect(u.client, 'it-link-3');
    const p2 = answer(s2, msg.reqId);
    s2.send(msg);
    expect(await p2).toMatchObject({ t: 'ack' });
    // A different id is a different line, even with the same text. It goes once the player's second between lines has
    // passed: a new connection does not start that wait again (multiplayer.test.ts).
    await new Promise((r) => setTimeout(r, 1_000));
    const p3 = answer(s2, 'link-chat-0002');
    s2.send({ ...msg, reqId: 'link-chat-0002' });
    expect(await p3).toMatchObject({ t: 'ack' });
    // Joining now: the history holds the text twice (two ids), not three times.
    const late = await connect((await newUser()).client, 'it-link-3');
    const history = (await late.wait((m) => m.t === 'chatHistory')) as Extract<ServerMessage, { t: 'chatHistory' }>;
    expect(history.messages.filter((l) => l.text === msg.text)).toHaveLength(2);
    // And the room broadcast it twice.
    expect(watcher.messages.filter((m) => m.t === 'chat' && m.message.text === msg.text)).toHaveLength(2);
  });

  it('acknowledges sit out, sit in, the waitlist and cancelling a top-up, and a late copy changes nothing', async () => {
    const a = await newUser();
    const b = await newUser();
    const sa = await connect(a.client, 'it-link-0');
    const sb = await connect(b.client, 'it-link-0');
    expect(await sa.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });

    const out = { t: 'sitOut', reqId: 'link-out-0001' };
    let p = answer(sa, out.reqId);
    sa.send(out);
    expect(await p).toMatchObject({ t: 'ack' });
    expect((await synced(sa)).you.sittingOut).toBe(true);
    p = answer(sa, 'link-in-0001');
    sa.send({ t: 'sitIn', reqId: 'link-in-0001' });
    expect(await p).toMatchObject({ t: 'ack' });
    // The first command arriving again after the second must not undo it.
    p = answer(sa, out.reqId);
    sa.send(out);
    expect(await p).toMatchObject({ t: 'ack' });
    expect((await synced(sa)).you.sittingOut).toBe(false);

    const join = { t: 'waitlist', join: true, reqId: 'link-wl-0001' };
    p = answer(sb, join.reqId);
    sb.send(join);
    expect(await p).toMatchObject({ t: 'ack' });
    expect((await synced(sb)).you.inWaitlist).toBe(true);
    p = answer(sb, 'link-wl-0002');
    sb.send({ t: 'waitlist', join: false, reqId: 'link-wl-0002' });
    expect(await p).toMatchObject({ t: 'ack' });
    p = answer(sb, join.reqId);
    sb.send(join);
    expect(await p).toMatchObject({ t: 'ack' });
    expect((await synced(sb)).you.inWaitlist).toBe(false);

    p = answer(sa, 'link-cancel-01');
    sa.send({ t: 'cancelTopUp', reqId: 'link-cancel-01' });
    expect(await p).toMatchObject({ t: 'ack' });

    // Older clients send these without an id: applied as before, no answer.
    sa.send({ t: 'sitOut' });
    expect((await sa.waitNext((m) => m.t === 'state' && m.state.you.sittingOut, 15_000, 'sat out')).t).toBe('state');
    expect(sa.messages.filter((m) => m.t === 'ack').length).toBe(5);
  });
});
