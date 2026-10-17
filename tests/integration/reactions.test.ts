import { REACTION_BURST, REACTION_COOLDOWN_MS, type ServerMessage } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { newUser } from '../support/client';
import { TableSocket } from '../support/ws';

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function connect(client: Awaited<ReturnType<typeof newUser>>['client'], tableId: string) {
  const ws = await TableSocket.open(client, tableId);
  open.push(ws);
  return ws;
}
async function player(tableId: string) {
  const u = await newUser();
  return { ...u, ws: await connect(u.client, tableId) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type React = Extract<ServerMessage, { t: 'react' }>;
const reacts = (ws: TableSocket) => ws.messages.filter((m): m is React => m.t === 'react');

describe('quick reactions', () => {
  it('a seated player\'s reaction reaches everyone at the table with their seat; a spectator cannot send one', async () => {
    const [a, b, spec] = [await player('it-react-0'), await player('it-react-0'), await player('it-react-0')];
    expect(await a.ws.request({ t: 'sit', seatIndex: 2, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await b.ws.request({ t: 'sit', seatIndex: 4, buyIn: 500 })).toMatchObject({ t: 'ack' });
    await a.ws.waitState((s) => s.seats[4]?.userId === b.me.id);

    const seen = [b.ws, spec.ws, a.ws].map((ws) => ws.waitNext((m) => m.t === 'react', 10_000, 'react'));
    expect(await a.ws.request({ t: 'react', reaction: 'fire' })).toMatchObject({ t: 'ack' });
    for (const m of await Promise.all(seen)) expect(m).toMatchObject({ t: 'react', seatIndex: 2, userId: a.me.id, reaction: 'fire' });

    // Not seated, or not a reaction the table offers.
    expect(await spec.ws.request({ t: 'react', reaction: 'clap' })).toMatchObject({ t: 'error', code: 'forbidden' });
    // (A message the schema refuses is answered without its reqId.)
    const refused = b.ws.waitNext((m) => m.t === 'error', 10_000, 'bad_request');
    b.ws.send({ t: 'react', reaction: 'poop', reqId: 'r-poop-0001' });
    expect(await refused).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(reacts(a.ws)).toHaveLength(1);

    // Nothing of it is kept: a new connection is not sent it.
    const later = await connect(spec.client, 'it-react-0');
    await later.waitState(() => true);
    await sleep(500);
    expect(reacts(later)).toHaveLength(0);
  });

  it('keeps one player to the cooldown and the burst limit, also across a new connection', async () => {
    const a = await player('it-react-1');
    const watcher = await player('it-react-1');
    expect(await a.ws.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });

    expect(await a.ws.request({ t: 'react', reaction: 'clap' })).toMatchObject({ t: 'ack' });
    expect(await a.ws.request({ t: 'react', reaction: 'clap' })).toMatchObject({ t: 'error', code: 'rate_limited' });
    // A new tab (it replaces the old connection) does not start the count again.
    const again = await connect(a.client, 'it-react-1');
    await again.waitState((s) => s.you.seatIndex === 0);
    expect(await again.request({ t: 'react', reaction: 'wow' })).toMatchObject({ t: 'error', code: 'rate_limited' });

    // Spaced out, up to the burst limit; the next one waits for the window.
    for (let n = 1; n < REACTION_BURST.max; n++) {
      await sleep(REACTION_COOLDOWN_MS + 50);
      expect(await again.request({ t: 'react', reaction: 'heart' })).toMatchObject({ t: 'ack' });
    }
    await sleep(REACTION_COOLDOWN_MS + 50);
    expect(await again.request({ t: 'react', reaction: 'gg' })).toMatchObject({ t: 'error', code: 'rate_limited' });
    await sleep(300);
    expect(reacts(watcher.ws)).toHaveLength(REACTION_BURST.max);
  }, 30_000);

  it('changes nothing at the table, and a player who left the seat can no longer send one', async () => {
    const a = await player('it-react-2');
    expect(await a.ws.request({ t: 'sit', seatIndex: 1, buyIn: 500 })).toMatchObject({ t: 'ack' });
    // Alone at the table, so no hand is dealt: the table's version moves only for a real change.
    const version = (await a.ws.waitState((s) => s.you.seatIndex === 1)).version;
    const states = a.ws.messages.filter((m) => m.t === 'state').length;
    expect(await a.ws.request({ t: 'react', reaction: 'cool' })).toMatchObject({ t: 'ack' });
    await sleep(300);
    expect(a.ws.state!.version).toBe(version);
    expect(a.ws.messages.filter((m) => m.t === 'state')).toHaveLength(states);
    expect(await a.ws.request({ t: 'leave' })).toMatchObject({ t: 'ack' });
    await a.ws.waitState((s) => s.you.seatIndex === null);
    await sleep(REACTION_COOLDOWN_MS + 50);
    expect(await a.ws.request({ t: 'react', reaction: 'cool' })).toMatchObject({ t: 'error', code: 'forbidden' });
  });
});