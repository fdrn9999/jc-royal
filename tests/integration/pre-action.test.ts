import type { PreActionKind, ServerMessage, TableView } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { newUser } from '../support/client';
import { isMyTurn, TableSocket } from '../support/ws';

const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function player(tableId: string) {
  const u = await newUser();
  const ws = await TableSocket.open(u.client, tableId);
  open.push(ws);
  return { ...u, ws };
}
type Player = Awaited<ReturnType<typeof player>>;

/** Three players dealt into the first hand, by position (the button acts first preflop three-handed). */
async function threeHanded(tableId: string) {
  const ps: Player[] = [];
  for (let i = 0; i < 3; i++) ps.push(await player(tableId));
  for (const [i, p] of ps.entries()) expect(await p.ws.request({ t: 'sit', seatIndex: i, buyIn: 1000 })).toMatchObject({ t: 'ack' });
  for (const p of ps) await p.ws.waitState((s) => s.status === 'playing' && s.hand?.stage === 'preflop' && s.hand.actorSeat !== null, 20_000, 'hand start');
  const h = ps[0]!.ws.state!.hand!;
  expect(ps[0]!.ws.state!.seats.filter((x) => x.hasCards)).toHaveLength(3);
  const at = (seat: number | null) => ps.find((p) => p.ws.state!.you.seatIndex === seat)!;
  return { ps, btn: at(h.buttonSeat), sb: at(h.sbSeat), bb: at(h.bbSeat) };
}

const seatOf = (p: Player) => p.ws.state!.you.seatIndex!;
const toCallOf = (s: TableView) => Math.max(...s.seats.map((x) => x.streetBet)) - s.seats[s.you.seatIndex!]!.streetBet;

/** Chooses a pre-action against what the player sees now, as the web client does; resolves with the answer. */
function pre(p: Player, kind: PreActionKind | null, over: Record<string, unknown> = {}) {
  const s = p.ws.state!;
  const toCall = s.you.seatIndex === null ? 0 : toCallOf(s);
  return p.ws.request({ t: 'preAction', handId: s.hand!.id, stage: s.hand!.stage, toCall, kind, ...over });
}

/** Waits for the player's turn, then acts. */
async function actOn(p: Player, type: string, amount?: number) {
  await p.ws.waitState(isMyTurn, 15_000, `turn for ${type}`);
  const { result } = await p.ws.act(type, amount);
  expect(result.t, JSON.stringify(result)).toBe('state');
}

/** Every view a player got kept the table's chips: stacks plus the pot while playing, stacks once settled. */
function conserved(ps: Player[], total: number) {
  for (const p of ps) {
    for (const m of p.ws.messages) {
      if (m.t !== 'state' || !m.state.hand) continue;
      const stacks = m.state.seats.reduce((a, x) => a + x.stack, 0);
      expect(stacks + (m.state.hand.stage === 'settled' ? 0 : m.state.hand.potTotal)).toBe(total);
    }
  }
}

/** A player never sees a pre-action other than their own. */
function onlyOwnerSees(ps: Player[], owner: Player) {
  for (const p of ps) {
    if (p === owner) continue;
    for (const m of p.ws.messages) if (m.t === 'state') expect(m.state.you.preAction ?? null).toBeNull();
  }
}

const notice = (p: Player) => p.ws.waitNext((m) => m.t === 'notice' && m.code === 'preaction_cancelled', 15_000, 'pre-action notice');

describe('pre-actions (check, check/fold, fold chosen while waiting)', () => {
  it('a check chosen in the big blind is made when the turn comes, without the player acting', async () => {
    const { ps, btn, sb, bb } = await threeHanded('it-pre-0');
    expect(await pre(bb, 'check')).toMatchObject({ t: 'ack' });
    await bb.ws.waitState((s) => s.you.preAction === 'check');
    await actOn(btn, 'call');
    await actOn(sb, 'call');
    const flop = await bb.ws.waitState((s) => s.hand?.stage === 'flop', 15_000, 'flop');
    expect(flop.seats.filter((x) => x.hasCards)).toHaveLength(3);
    expect(flop.seats[seatOf(bb)]!.stack).toBe(990);
    // Carried out, so gone; and the big blind was never handed a preflop turn.
    expect(flop.you.preAction ?? null).toBeNull();
    expect(bb.ws.messages.some((m) => m.t === 'state' && m.state.hand?.stage === 'preflop' && isMyTurn(m.state))).toBe(false);
    conserved(ps, 3000);
    onlyOwnerSees(ps, bb);
  });

  it('a bet cancels a chosen check with a notice, and the player then decides on the turn', async () => {
    const { ps, btn, sb, bb } = await threeHanded('it-pre-1');
    expect(await pre(bb, 'check')).toMatchObject({ t: 'ack' });
    await bb.ws.waitState((s) => s.you.preAction === 'check');
    const told = notice(bb);
    await actOn(btn, 'raise', 30);
    await told;
    await bb.ws.waitState((s) => (s.you.preAction ?? null) === null);
    await actOn(sb, 'fold');
    const turn = await bb.ws.waitState(isMyTurn, 15_000, 'big blind turn');
    expect(turn.you.legal.map((o) => o.type)).toEqual(expect.arrayContaining(['fold', 'call']));
    expect(turn.seats[seatOf(bb)]!.streetBet).toBe(10);
    conserved(ps, 3000);
    onlyOwnerSees(ps, bb);
  });

  it('a check/fold folds against a raise; a fold chosen in the small blind folds; chips are kept', async () => {
    const a = await threeHanded('it-pre-2');
    expect(await pre(a.bb, 'checkFold')).toMatchObject({ t: 'ack' });
    // The small blind faces 5 more: only a fold can be chosen.
    expect(await pre(a.sb, 'fold')).toMatchObject({ t: 'ack' });
    await a.sb.ws.waitState((s) => s.you.preAction === 'fold');
    await actOn(a.btn, 'raise', 30);
    // The small blind folds at once, then the big blind's check/fold still fits the bigger bet and folds.
    const done = await a.btn.ws.waitState((s) => s.hand?.stage === 'settled', 15_000, 'settled');
    expect(done.seats[seatOf(a.sb)]!.stack).toBe(995);
    expect(done.seats[seatOf(a.bb)]!.stack).toBe(990);
    expect(done.seats[seatOf(a.btn)]!.stack).toBe(1015);
    expect(done.hand!.result!.winners.map((w) => w.seatIndex)).toEqual([seatOf(a.btn)]);
    expect(a.sb.ws.messages.some((m) => m.t === 'state' && isMyTurn(m.state))).toBe(false);
    expect(a.bb.ws.messages.some((m) => m.t === 'state' && isMyTurn(m.state))).toBe(false);
    conserved(a.ps, 3000);
    // Neither saw the other's choice.
    for (const p of a.ps) for (const m of p.ws.messages) if (m.t === 'state' && m.state.you.preAction) expect([a.sb, a.bb]).toContain(p);
  });

  it('keeps nothing the table has moved past, and refuses what was never allowed', async () => {
    const { ps, btn, sb, bb } = await threeHanded('it-pre-3');
    // The player to act chooses their move directly.
    let told = notice(btn);
    expect(await pre(btn, 'fold')).toMatchObject({ t: 'ack' });
    await told;
    // An amount to call the player did not see, or another street: nothing kept.
    told = notice(bb);
    expect(await pre(bb, 'checkFold', { toCall: 5 })).toMatchObject({ t: 'ack' });
    await told;
    told = notice(bb);
    expect(await pre(bb, 'checkFold', { stage: 'flop' })).toMatchObject({ t: 'ack' });
    await told;
    expect(bb.ws.state!.you.preAction ?? null).toBeNull();
    // A check against a bet, or a fold with nothing to call, is not a pre-action.
    expect(await pre(sb, 'check', { toCall: 5 })).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(await pre(bb, 'fold', { toCall: 0 })).toMatchObject({ t: 'error', code: 'bad_request' });
    // Calls and raises cannot be chosen in advance at all: the message itself is refused.
    const refused = bb.ws.waitNext((m) => m.t === 'error' && m.code === 'bad_request', 15_000, 'schema refusal');
    bb.ws.send({ t: 'preAction', reqId: 'pre-call-0001', handId: bb.ws.state!.hand!.id, stage: 'preflop', toCall: 0, kind: 'call' });
    await refused;
    // A spectator has no seat to choose for.
    const spec = await player('it-pre-3');
    expect(await pre(spec, 'checkFold')).toMatchObject({ t: 'error', code: 'forbidden' });
    // Nothing above moved the hand.
    expect(btn.ws.state!.hand!.actorSeat).toBe(seatOf(btn));
    conserved(ps, 3000);
  });

  it('a choice sent again after it was cleared does not come back, and clearing stops it', async () => {
    const { ps, btn, sb, bb } = await threeHanded('it-pre-4');
    const s = bb.ws.state!;
    const choose = { t: 'preAction', reqId: 'pre-again-0001', handId: s.hand!.id, stage: 'preflop', toCall: 0, kind: 'check' };
    const answer = (reqId: string) => bb.ws.waitNext((m) => (m.t === 'ack' || m.t === 'error') && 'reqId' in m && m.reqId === reqId);
    let p = answer(choose.reqId);
    bb.ws.send(choose);
    expect(await p).toMatchObject({ t: 'ack' });
    await bb.ws.waitState((v) => v.you.preAction === 'check');
    expect(await pre(bb, null)).toMatchObject({ t: 'ack' });
    await bb.ws.waitState((v) => (v.you.preAction ?? null) === null);
    p = answer(choose.reqId);
    bb.ws.send(choose);
    expect(await p).toMatchObject({ t: 'ack' });
    const sync = bb.ws.waitNext((m) => m.t === 'state');
    bb.ws.send({ t: 'sync' });
    expect(((await sync) as Extract<ServerMessage, { t: 'state' }>).state.you.preAction ?? null).toBeNull();
    // Cleared: the big blind gets its own turn after the calls.
    await actOn(btn, 'call');
    await actOn(sb, 'call');
    const turn = await bb.ws.waitState(isMyTurn, 15_000, 'big blind turn');
    expect(turn.hand!.stage).toBe('preflop');
    expect(turn.you.legal.map((o) => o.type)).toContain('check');
    conserved(ps, 3000);
  });

  it('a choice the street ended without using is dropped quietly and never carried to the next street', async () => {
    const { ps, btn, sb, bb } = await threeHanded('it-pre-5');
    await actOn(btn, 'call');
    // The button has called and waits for the blinds: nothing more to call this street.
    expect(await pre(btn, 'checkFold')).toMatchObject({ t: 'ack' });
    await btn.ws.waitState((s) => s.you.preAction === 'checkFold');
    await actOn(sb, 'call');
    await actOn(bb, 'check');
    const flop = await btn.ws.waitState((s) => s.hand?.stage === 'flop', 15_000, 'flop');
    expect(flop.you.preAction ?? null).toBeNull();
    await actOn(sb, 'check');
    await actOn(bb, 'check');
    // The button decides the flop itself, and was never told anything was cancelled.
    const turn = await btn.ws.waitState(isMyTurn, 15_000, 'button flop turn');
    expect(turn.hand!.stage).toBe('flop');
    expect(btn.ws.messages.some((m) => m.t === 'notice' && m.code === 'preaction_cancelled')).toBe(false);
    conserved(ps, 3000);
  });
});
