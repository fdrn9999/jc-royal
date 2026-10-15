import type { TableView } from '@jc/types';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { newUser } from '../support/client';
import { isMyTurn, TableSocket } from '../support/ws';

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function player(tableId: string, opts: { code?: string } = {}) {
  const u = await newUser();
  const ws = await TableSocket.open(u.client, tableId, opts);
  open.push(ws);
  return { ...u, ws };
}

async function sit(p: Awaited<ReturnType<typeof player>>, seatIndex: number, buyIn: number) {
  const r = await p.ws.request({ t: 'sit', seatIndex, buyIn });
  expect(r, JSON.stringify(r)).toMatchObject({ t: 'ack' });
  await p.ws.waitState((s) => s.you.seatIndex === seatIndex);
}

/** Status code of a raw WebSocket upgrade attempt (fetch() forbids the Upgrade header). */
function upgradeStatus(headers: Record<string, string>, table = 'it-hu-0'): Promise<number> {
  const u = new URL(`${process.env.TEST_BASE_URL}/ws/tables/${table}`);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

const handLive = (s: TableView) => !!s.hand && s.status === 'playing';

/** Drive the hand to completion with check/call from whichever socket is to act. */
async function playOutCheckCall(players: { ws: TableSocket }[]) {
  const handId = players[0]!.ws.state!.hand!.id;
  for (let guard = 0; guard < 400; guard++) {
    const s0 = players[0]!.ws.state!;
    if (!s0.hand || s0.hand.id !== handId || s0.hand.stage === 'settled') return;
    const actor = players.find((p) => p.ws.state && isMyTurn(p.ws.state) && p.ws.state.hand?.id === handId);
    if (!actor) {
      // The acting player's own state message may still be in flight.
      await new Promise((r) => setTimeout(r, 100));
      if (guard > 390) throw new Error(`no player sees its turn: ${JSON.stringify(players.map((p) => [p.ws.state?.hand?.seq, p.ws.state?.hand?.actorSeat, p.ws.state?.you.legal.length]))}`);
      continue;
    }
    const legal = actor.ws.state!.you.legal;
    const type = legal.some((o) => o.type === 'check') ? 'check' : 'call';
    const { result } = await actor.ws.act(type);
    expect(result.t, JSON.stringify(result)).toBe('state');
  }
  throw new Error('hand did not finish');
}

describe('table room over WebSocket (real workerd + Durable Objects)', () => {
  it('rejects unauthenticated sockets and cross-site origins', async () => {
    const url = `${process.env.TEST_BASE_URL!.replace('http', 'ws')}/ws/tables/it-hu-0`;
    const ws = new WebSocket(url);
    const err = await new Promise<string>((res) => {
      ws.addEventListener('error', () => res('error'));
      ws.addEventListener('open', () => res('open'));
    });
    expect(err).toBe('error');
    expect(await upgradeStatus({})).toBe(401);
    const u = await newUser();
    expect(await upgradeStatus({ Origin: 'https://evil.example', Cookie: u.client.cookieHeader() })).toBe(403);
    expect(await upgradeStatus({ Origin: 'http://localhost:5173', Cookie: u.client.cookieHeader() }, 'no-such-table')).toBe(404);
  });

  it('heads-up: buy-in debits the wallet, hand auto-starts, each player sees only own cards', async () => {
    const a = await player('it-hu-1');
    const b = await player('it-hu-1');
    await sit(a, 0, 500);
    expect((await a.client.get('/api/auth/me')).body.balance).toBe(9500);
    const ledger = (await a.client.get('/api/me/ledger')).body;
    expect(ledger[0]).toMatchObject({ type: 'buy_in', amount: -500, balanceAfter: 9500, tableId: 'it-hu-1' });
    await sit(b, 1, 1000);
    const sa = await a.ws.waitState(handLive, 15_000, 'hand start');
    const sb = await b.ws.waitState(handLive);
    expect(sa.seats[0]!.holeCards).toHaveLength(2);
    expect(sa.seats[1]!.holeCards ?? null).toBeNull();
    expect(sb.seats[1]!.holeCards).toHaveLength(2);
    expect(sb.seats[0]!.holeCards ?? null).toBeNull();
    // No raw engine internals leak.
    for (const m of [...a.ws.messages, ...b.ws.messages]) expect(JSON.stringify(m)).not.toMatch(/remainingDeck|deckSeed|burnPile/);
    // A spectator sees no hole cards at all.
    const spec = await player('it-hu-1');
    const ss = await spec.ws.waitState(handLive);
    expect(ss.seats.every((s) => !s.holeCards)).toBe(true);
    expect(ss.you.seatIndex).toBeNull();
    expect(ss.spectatorCount).toBeGreaterThanOrEqual(1);
  });

  it('validates sit requests: range, occupied seat, double seat, insufficient wallet', async () => {
    const a = await player('it-hu-2');
    const b = await player('it-hu-2');
    expect(await a.ws.request({ t: 'sit', seatIndex: 0, buyIn: 50 })).toMatchObject({ t: 'error', code: 'buyin_out_of_range' });
    await sit(a, 0, 1000);
    expect(await a.ws.request({ t: 'sit', seatIndex: 1, buyIn: 200 })).toMatchObject({ t: 'error', code: 'already_seated' });
    expect(await b.ws.request({ t: 'sit', seatIndex: 0, buyIn: 200 })).toMatchObject({ t: 'error', code: 'seat_taken' });
    // Drain b's wallet below the minimum via other tables, then try.
    for (let i = 0; i < 9; i++) {
      const t = `it-hu-${3 + i}`;
      const s = await TableSocket.open(b.client, t);
      open.push(s);
      expect(await s.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    }
    expect((await b.client.get('/api/auth/me')).body.balance).toBe(1000);
    const s2 = await TableSocket.open(b.client, 'it-six-5');
    open.push(s2);
    expect(await s2.request({ t: 'sit', seatIndex: 0, buyIn: 1500 })).toMatchObject({ t: 'error', code: 'insufficient_balance' });
    expect((await b.client.get('/api/auth/me')).body.balance).toBe(1000);
  });

  it('server validates actions: wrong turn, stale seq, duplicate intent', async () => {
    const a = await player('it-six-0');
    const b = await player('it-six-0');
    await sit(a, 0, 1000);
    await sit(b, 3, 1000);
    await a.ws.waitState(handLive);
    await b.ws.waitState(handLive);
    const [actor, other] = isMyTurn(a.ws.state!) ? [a, b] : [b, a];
    // other player tries to act
    const wrong = await other.ws.act('call');
    expect(wrong.result).toMatchObject({ t: 'error', code: 'not_your_turn' });
    // stale seq
    const h = actor.ws.state!.hand!;
    const staleId = 'stale-intent-1';
    const pStale = actor.ws.waitNext((m) => m.t === 'error' && m.reqId === staleId);
    actor.ws.send({ t: 'action', intentId: staleId, handId: h.id, seq: h.seq + 5, type: 'call' });
    expect(await pStale).toMatchObject({ code: 'stale_version' });
    // forged amount (raise beyond stack)
    const big = await actor.ws.act('raise', 999_999);
    expect(big.result).toMatchObject({ t: 'error', code: 'illegal_action' });
    // valid action, then replay the identical message
    const ok = await actor.ws.act('call');
    expect(ok.result.t).toBe('state');
    const pDup = actor.ws.waitNext((m) => m.t === 'error' && m.reqId === ok.intentId);
    actor.ws.send({ t: 'action', intentId: ok.intentId, handId: ok.handId, seq: ok.seq, type: 'call' });
    expect(await pDup).toMatchObject({ t: 'error' });
    // Malformed payloads are rejected by schema validation.
    const pBad = actor.ws.waitNext((m) => m.t === 'error' && m.code === 'bad_request');
    actor.ws.send({ t: 'action', type: 'call', amount: -5 });
    expect(await pBad).toBeTruthy();
  });

  it('6-handed: plays full hands, conserves table chips, records hands and stats', async () => {
    const ps = [];
    for (let i = 0; i < 6; i++) ps.push(await player('it-six-1'));
    for (let i = 0; i < 6; i++) await sit(ps[i]!, i, 1000);
    await ps[0]!.ws.waitState(handLive, 20_000);
    for (const p of ps) await p.ws.waitState(handLive);
    await playOutCheckCall(ps);
    const settled = await ps[0]!.ws.waitState((s) => s.hand?.stage === 'settled' || (s.hand?.number ?? 0) > 1, 20_000, 'settled');
    const total = settled.seats.reduce((a, s) => a + s.stack, 0);
    expect(total).toBe(6000);
    // Everyone saw exactly their own cards during the hand.
    for (const [i, p] of ps.entries()) {
      for (const m of p.ws.messages) {
        if (m.t !== 'state' || !m.state.hand || m.state.hand.stage === 'settled') continue;
        m.state.seats.forEach((s, si) => {
          if (si !== i) expect(s.holeCards ?? null).toBeNull();
        });
      }
    }
    // Hand history and stats are derived from the recorded hand.
    await new Promise((r) => setTimeout(r, 500));
    const hands = (await ps[0]!.client.get('/api/me/hands')).body;
    expect(hands.length).toBeGreaterThanOrEqual(1);
    expect(hands[0]).toMatchObject({ tableId: 'it-six-1' });
    const stats = (await ps[0]!.client.get('/api/me/stats')).body;
    expect(stats.handsPlayed).toBeGreaterThanOrEqual(1);
    const detail = (await ps[1]!.client.get(`/api/me/hands/${hands[0].id}`)).body;
    expect(detail.players).toHaveLength(6);
    for (const pl of detail.players) {
      if (!pl.isYou && pl.rankClass === null) expect(pl.holeCards).toBeNull();
    }
    const nets = detail.players.reduce((a: number, p: { net: number }) => a + p.net, 0);
    expect(nets).toBe(0);
  });

  it('reconnect restores the seat and own cards; a second tab replaces the first', async () => {
    const a = await player('it-six-2');
    const b = await player('it-six-2');
    await sit(a, 1, 800);
    await sit(b, 2, 800);
    const before = await a.ws.waitState(handLive);
    const myCards = before.seats[1]!.holeCards;
    a.ws.close();
    await b.ws.waitState((s) => s.seats[1]!.connected === false, 10_000, 'disconnect shown');
    const again = await TableSocket.open(a.client, 'it-six-2');
    open.push(again);
    const st = await again.waitState(handLive);
    expect(st.you.seatIndex).toBe(1);
    expect(st.seats[1]!.holeCards).toEqual(myCards);
    expect(st.hand!.id).toBe(before.hand!.id);
    // Second tab
    const tab2 = await TableSocket.open(a.client, 'it-six-2');
    open.push(tab2);
    await again.wait((m) => m.t === 'replaced', 5_000, 'replaced');
    // The server closes the old socket (close frame 4001). Under local `wrangler dev`
    // the proxy leaves the client in CLOSING without a close event, so assert the
    // observable contract: closing/closed and no further table traffic.
    for (let i = 0; i < 30 && again.ws.readyState < 2; i++) await new Promise((r) => setTimeout(r, 100));
    expect(again.ws.readyState).toBeGreaterThanOrEqual(2);
    const seen = again.messages.length;
    tab2.send({ t: 'chat', text: 'still here?' });
    await tab2.wait((m) => m.t === 'chat' && m.message.text === 'still here?');
    await new Promise((r) => setTimeout(r, 300));
    expect(again.messages.length).toBe(seen);
    expect(tab2.state!.you.seatIndex).toBe(1);
  });

  it('leaving cashes the stack out to the wallet exactly once', async () => {
    const a = await player('it-six-3');
    await sit(a, 0, 700);
    expect((await a.client.get('/api/auth/me')).body.balance).toBe(9300);
    const r1 = await a.ws.request({ t: 'leave' });
    expect(r1.t).toBe('ack');
    await a.ws.waitState((s) => s.you.seatIndex === null);
    expect((await a.client.get('/api/auth/me')).body.balance).toBe(10000);
    const r2 = await a.ws.request({ t: 'leave' });
    expect(r2.t).toBe('ack');
    expect((await a.client.get('/api/auth/me')).body.balance).toBe(10000);
    const ledger = (await a.client.get('/api/me/ledger')).body as { type: string; amount: number }[];
    expect(ledger.filter((l) => l.type === 'cash_out')).toEqual([expect.objectContaining({ amount: 700 })]);
    expect(ledger.reduce((s, l) => s + l.amount, 0)).toBe(10000);
  });

  it('turn timer: an idle player is checked/folded automatically by the server', async () => {
    const a = await player('it-fast-0');
    const b = await player('it-fast-0');
    await sit(a, 0, 500);
    await sit(b, 1, 500);
    const s = await a.ws.waitState(handLive);
    expect(s.hand!.deadline).toBeGreaterThan(Date.now() - 1000);
    const firstSeq = s.hand!.seq;
    // nobody acts: the server must advance the hand on its own
    const later = await a.ws.waitState((x) => !!x.hand && x.hand.id === s.hand!.id && x.hand.seq > firstSeq, 10_000, 'timeout action');
    const actor = s.hand!.actorSeat!;
    // Facing the big blind, the small blind's timeout is a fold.
    expect(later.seats[actor]!.lastAction?.type).toBe('fold');
    expect(later.hand!.stage).toBe('settled');
    expect(later.hand!.result!.winners).toEqual([expect.objectContaining({ seatIndex: actor === 0 ? 1 : 0, amount: 15 })]);
    // and play continues with a new hand after the pause
    await a.ws.waitState((x) => !!x.hand && x.hand.id !== s.hand!.id, 15_000, 'next hand');
  });

  it('private table: join code required to sit; spectating allowed', async () => {
    const noCode = await player('it-private');
    expect(noCode.ws.state!.you).toMatchObject({ canSit: false, needsCode: true });
    expect(await noCode.ws.request({ t: 'sit', seatIndex: 0, buyIn: 200 })).toMatchObject({ t: 'error', code: 'join_code_required' });
    const bad = await player('it-private', { code: 'wrong-code' });
    expect(bad.ws.access).toBe(403);
    expect(await bad.ws.request({ t: 'sit', seatIndex: 0, buyIn: 200 })).toMatchObject({ t: 'error', code: 'join_code_required' });
    const good = await player('it-private', { code: 'royal-777' });
    expect(good.ws.access).toBe(200);
    expect(good.ws.state!.you).toMatchObject({ canSit: true, needsCode: false });
    await sit(good, 0, 200);
  });

  it('spectators disabled: non-seated viewers get no hand details or chat', async () => {
    const a = await player('it-nospec');
    const b = await player('it-nospec');
    await sit(a, 0, 300);
    await sit(b, 1, 300);
    await a.ws.waitState(handLive);
    const watcher = await player('it-nospec');
    expect(watcher.ws.state!.hand).toBeNull();
    const err = watcher.ws.waitNext((m) => m.t === 'error');
    watcher.ws.send({ t: 'chat', text: 'hello' });
    expect(await err).toMatchObject({ code: 'forbidden' });
  });

  it('chat is broadcast to the table and length/rate limited', async () => {
    const a = await player('it-six-4');
    const b = await player('it-six-4');
    const got = b.ws.waitNext((m) => m.t === 'chat');
    a.ws.send({ t: 'chat', text: '안녕하세요 <script>x</script>' });
    const m = await got;
    expect(m).toMatchObject({ t: 'chat', message: { text: '안녕하세요 <script>x</script>', nickname: a.me.nickname } });
    const tooLong = a.ws.waitNext((x) => x.t === 'error');
    a.ws.send({ t: 'chat', text: 'x'.repeat(201) });
    expect(await tooLong).toMatchObject({ code: 'bad_request' });
    const fast = a.ws.waitNext((x) => x.t === 'error' && x.code === 'rate_limited');
    a.ws.send({ t: 'chat', text: 'one' });
    a.ws.send({ t: 'chat', text: 'two' });
    expect(await fast).toBeTruthy();
  });
});
