// A multi-table tournament's seating without rooms or D1 (docs/TOURNAMENT_MTT.md): the first deal, a table broken up
// once the others can seat everyone, tables evened out, the final table waiting for its players and drawn again, a
// report taken once — and, over many random tournaments played to the end, nobody ever at two tables, no chip made or
// lost on the way, and places that run from the last to 1 with one winner.
import { describe, expect, it } from 'vitest';
import { mttAnswer, mttCall, mttClock, mttDeal, mttSeed, mttStale, mttTableCount, type MttAnswer, type MttReport, type MttState, type Rand } from './mtt';
import type { TournamentEntryRow, TournamentRow } from './tournament';

const T0 = 1_800_000_000_000;

function rng(seed: number): Rand {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

function row(entries: TournamentEntryRow[], over: Partial<TournamentRow> = {}): TournamentRow {
  return {
    id: 'tn1',
    name: 'MTT',
    status: 'running',
    format: 'mtt',
    tableSeats: 6,
    startStack: 1000,
    levels: [
      { sb: 10, bb: 20 },
      { sb: 20, bb: 40 },
    ],
    levelMs: 60_000,
    pauseRequested: false,
    tb: { enabled: false, initialMs: 0, maxMs: 0, unitMs: 0, refillHands: 1, refillMs: 0 },
    level: 0,
    levelEndsAt: null,
    levelLeftMs: null,
    pausedAt: T0,
    hands: 0,
    entries,
    ...over,
  };
}

/** A tournament of `n` players dealt to tables of `seats`, as the api starts one. */
function start(n: number, seats: number, rand: Rand): MttState {
  const ids = Array.from({ length: n }, (_, i) => `u${i}`);
  const tables = Array.from({ length: mttTableCount(n, seats) }, (_, k) => `mtt-tn1-${k + 1}`);
  const deal = mttDeal(ids, seats, tables, rand);
  const entries = deal.map(
    (d): TournamentEntryRow => ({ userId: d.userId, seat: d.seat, stack: 1000, status: 'playing', place: null, nickname: d.userId, avatarUrl: null, role: 'user', tableId: d.table }),
  );
  const s = mttSeed(row(entries, { tableSeats: seats }), tables.map((id) => ({ id, open: true })), seats, T0);
  mttClock(s, true, T0);
  return s;
}

/** A table as a room keeps it: the roster it last applied, and the stacks it plays with. */
interface Sim {
  id: string;
  rev: number;
  seq: number;
  seats: Map<string, { seat: number; stack: number }>;
  hold: boolean;
  closed: boolean;
  pending: MttReport | null;
  /** A call went unanswered: no deal until one is (as a room does). */
  need: boolean;
}

function take(r: Sim, a: MttAnswer) {
  r.seats = new Map(a.seats.map((x) => [x.userId, { seat: x.seat, stack: x.stack }]));
  r.rev = a.rev;
  r.hold = a.hold;
  r.closed = a.closed;
  r.need = false;
}

/** Nobody at two tables or two players in one seat, no table over its seats, and every chip where it was. */
function check(s: MttState, sims: Sim[]) {
  const at = new Map<string, string>();
  for (const r of sims) {
    if (r.closed) expect(r.seats.size).toBe(0);
    expect(r.seats.size).toBeLessThanOrEqual(s.seats);
    expect(new Set([...r.seats.values()].map((x) => x.seat)).size).toBe(r.seats.size);
    for (const u of r.seats.keys()) {
      expect(at.get(u), `${u} at ${at.get(u)} and ${r.id}`).toBeUndefined();
      at.set(u, r.id);
    }
  }
  const total = Object.values(s.players).reduce((a, p) => a + (p.out ? 0 : p.stack), 0);
  expect(total).toBe(Object.keys(s.players).length * 1000);
}

/**
 * A tournament played to the end: tables call in a random order, play a hand when they can (a random player loses a
 * random part of their stack to another, sometimes all of it) and sometimes leave a move unacknowledged for a while.
 */
function play(n: number, seats: number, seed: number) {
  const rand = rng(seed);
  const s = start(n, seats, rand);
  const sims: Sim[] = Object.keys(s.tables).map((id) => ({ id, rev: 0, seq: 0, seats: new Map(), hold: false, closed: false, pending: null, need: false }));
  let now = T0;
  for (let step = 0; step < 20_000 && s.t.status === 'running'; step++) {
    now += 500;
    const open = sims.filter((r) => !r.closed);
    const r = open[rand(open.length)]!;
    if (!r.pending && !r.need && r.seats.size >= 2 && !r.hold && rand(10) < 8) {
      const ids = [...r.seats.keys()];
      const before = new Map(ids.map((u) => [u, r.seats.get(u)!.stack]));
      const loser = ids[rand(ids.length)]!;
      const winner = ids.filter((u) => u !== loser)[rand(ids.length - 1)]!;
      const l = r.seats.get(loser)!;
      const lost = rand(3) === 0 ? l.stack : Math.max(1, Math.floor(l.stack * (rand(5) + 1) * 0.1));
      l.stack -= lost;
      r.seats.get(winner)!.stack += lost;
      r.seq += 1;
      r.pending = { seq: r.seq, stacks: ids.map((u) => ({ userId: u, stack: r.seats.get(u)!.stack, startStack: before.get(u)! })), order: ids };
    }
    // A call that gets no answer (lost on the way) changes nothing the next one would not.
    const lostAnswer = rand(20) === 0;
    const wake = mttCall(s, { table: r.id, applied: r.rev, report: r.pending }, now, rand);
    expect(wake).not.toContain(r.id);
    if (lostAnswer) {
      r.need = true;
      continue;
    }
    r.pending = null;
    const a = mttAnswer(s, r.id);
    take(r, a);
    check(s, sims);
    // The room acknowledges the roster it applied at once, unless it left it for later.
    if (a.moves.length && rand(4) !== 0) {
      mttCall(s, { table: r.id, applied: r.rev }, now, rand);
      take(r, mttAnswer(s, r.id));
      check(s, sims);
    }
  }
  return s;
}

describe('MTT seating', () => {
  it('deals the players round the tables', () => {
    const rand = rng(1);
    expect(mttTableCount(13, 6)).toBe(3);
    expect(mttTableCount(12, 6)).toBe(2);
    expect(mttTableCount(5, 9)).toBe(1);
    const deal = mttDeal(Array.from({ length: 13 }, (_, i) => `u${i}`), 6, ['a', 'b', 'c'], rand);
    const by = (t: string) => deal.filter((d) => d.table === t);
    expect([by('a').length, by('b').length, by('c').length]).toEqual([5, 4, 4]);
    for (const t of ['a', 'b', 'c']) expect(new Set(by(t).map((d) => d.seat)).size).toBe(by(t).length);
    expect(deal.every((d) => d.seat >= 0 && d.seat < 6)).toBe(true);
  });

  it('takes a report once', () => {
    const s = start(13, 6, rng(2));
    const [t1] = Object.keys(s.tables);
    const roster = mttAnswer(s, t1!).seats;
    const report: MttReport = {
      seq: 1,
      stacks: roster.map((x, i) => ({ userId: x.userId, stack: i === 0 ? 0 : i === 1 ? 2000 : 1000, startStack: 1000 })),
      order: roster.map((x) => x.userId),
    };
    mttCall(s, { table: t1!, applied: 0, report }, T0 + 1000, rng(3));
    expect(s.t.places).toHaveLength(1);
    expect(s.t.places[0]!.place).toBe(13);
    expect(s.t.hands).toBe(1);
    mttCall(s, { table: t1!, applied: 0, report }, T0 + 2000, rng(3));
    expect(s.t.places).toHaveLength(1);
    expect(s.t.hands).toBe(1);
    expect(mttAnswer(s, t1!).seats.map((x) => x.userId)).not.toContain(roster[0]!.userId);
  });

  it('breaks a table once the others can seat everyone, and holds the final table until its seats are drawn', () => {
    // 7 players at 6 seats: two tables (4 and 3); one bust leaves 6, which one table seats.
    const s = start(7, 6, rng(4));
    const [a, b] = Object.keys(s.tables) as [string, string];
    const small = mttAnswer(s, a).seats.length < mttAnswer(s, b).seats.length ? a : b;
    const big = small === a ? b : a;
    const roster = mttAnswer(s, big).seats;
    const stacks = roster.map((x, i) => ({ userId: x.userId, stack: i === 0 ? 0 : i === 1 ? 2000 : 1000, startStack: 1000 }));
    // The big table reports the bust: the small one is the one to break, so it is woken.
    expect(mttCall(s, { table: big, applied: 0, report: { seq: 1, stacks, order: roster.map((x) => x.userId) } }, T0 + 1000, rng(5))).toEqual([small]);
    expect(s.tables[small]!.broken).toBe(false);
    // The small one calls between hands: its players are sent on, it waits to close, the other is the final table.
    mttCall(s, { table: small, applied: 0 }, T0 + 2000, rng(6));
    const out = mttAnswer(s, small);
    expect(out.seats).toEqual([]);
    expect(out.moves.map((m) => m.to)).toEqual([big, big, big]);
    expect(out.closed).toBe(false);
    expect(mttAnswer(s, big).hold).toBe(true);
    expect(mttAnswer(s, big).seats).toHaveLength(3);
    // Once it applied that roster the players join the final table, which is drawn again and deals.
    const wake = mttCall(s, { table: small, applied: out.rev }, T0 + 3000, rng(7));
    expect(wake).toEqual([big]);
    expect(mttAnswer(s, small).closed).toBe(true);
    const fin = mttAnswer(s, big);
    expect(fin.hold).toBe(false);
    expect(fin.final).toBe(true);
    expect(fin.seats).toHaveLength(6);
    expect(new Set(fin.seats.map((x) => x.seat)).size).toBe(6);
    expect(fin.tables).toBe(1);
  });

  it('evens the tables out from the largest, the next big blind first', () => {
    // 18 at 6 seats: three full tables. Four busts at one table leave 2 / 6 / 6 — 14 players, more than two tables seat.
    const s = start(18, 6, rng(8));
    const [a, b, c] = Object.keys(s.tables) as [string, string, string];
    const ra = mttAnswer(s, a).seats;
    const stacks = ra.map((x, i) => ({ userId: x.userId, stack: i < 4 ? 0 : 3000, startStack: 1000 + i }));
    mttCall(s, { table: a, applied: 0, report: { seq: 1, stacks, order: ra.map((x) => x.userId) } }, T0 + 1000, rng(9));
    expect(mttAnswer(s, a).seats).toHaveLength(2);
    // a woke b, (one of) the largest: b sends its next big blind to a, and stops once c is larger.
    const rb = mttAnswer(s, b).seats;
    const order = [rb[3]!.userId, rb[1]!.userId, rb[0]!.userId, rb[2]!.userId, rb[4]!.userId, rb[5]!.userId];
    mttCall(s, { table: b, applied: 0, report: { seq: 1, stacks: rb.map((x) => ({ userId: x.userId, stack: x.stack, startStack: x.stack })), order } }, T0 + 2000, rng(10));
    const moves = mttAnswer(s, b).moves;
    expect(moves.map((m) => m.userId)).toEqual([order[0]]);
    expect(moves[0]!.to).toBe(a);
    // c (now the largest) sends one when it calls: 2 / 6 / 6 ends 4 / 5 / 5, counting those on the way.
    mttCall(s, { table: c, applied: 0 }, T0 + 3000, rng(11));
    expect(mttAnswer(s, c).moves).toHaveLength(1);
    // Each was answered with its roster; b and c still have players to let go.
    expect(mttStale(s)).toEqual([b, c].sort());
    // Once they say they applied it, the players join a, which has a new roster to be told.
    mttCall(s, { table: b, applied: mttAnswer(s, b).rev }, T0 + 4000, rng(12));
    mttCall(s, { table: c, applied: mttAnswer(s, c).rev }, T0 + 5000, rng(13));
    expect(mttStale(s)).toEqual([a]);
    mttCall(s, { table: a, applied: mttAnswer(s, a).rev }, T0 + 6000, rng(14));
    expect(mttStale(s)).toEqual([]);
    expect([a, b, c].map((id) => mttAnswer(s, id).seats.length)).toEqual([4, 5, 5]);
  });

  it('built again from D1, seats anyone left at a closing table or in a taken seat at an open one', () => {
    const e = (userId: string, tableId: string, seat: number, status = 'playing'): TournamentEntryRow => ({
      userId,
      seat,
      stack: status === 'playing' ? 1000 : 0,
      status,
      place: status === 'playing' ? null : 9,
      nickname: userId,
      avatarUrl: null,
      role: 'user',
      tableId,
    });
    const entries = [e('u1', 'a', 0), e('u2', 'a', 0), e('u3', 'b', 2), e('u4', 'c', 1), e('u5', 'c', 3, 'eliminated')];
    const s = mttSeed(row(entries), [{ id: 'a', open: true }, { id: 'b', open: true }, { id: 'c', open: false }], 6, T0);
    const at = (u: string) => [s.players[u]!.table, s.players[u]!.seat];
    expect(at('u1')).toEqual(['a', 0]);
    expect(at('u3')).toEqual(['b', 2]);
    // u2 shared u1's seat, u4 was at the closing table: each goes to the table with fewer players (a tie: the first by
    // id), in its lowest free seat.
    expect(at('u2')).toEqual(['a', 1]);
    expect(at('u4')).toEqual(['b', 0]);
    expect(s.touched.sort()).toEqual(['u2', 'u4']);
    expect(s.players.u5!.out).toBe(true);
    expect(mttAnswer(s, 'c').closed).toBe(true);
    expect(s.final).toBeNull();
  });

  it('keeps the level clock through a pause and moves it on', () => {
    const s = start(13, 6, rng(12));
    expect(s.t.stoppedAt).toBeNull();
    expect(s.t.levelEndsAt).toBe(T0 + 60_000);
    mttClock(s, false, T0 + 20_000);
    expect(s.t.levelLeftMs).toBe(40_000);
    mttClock(s, true, T0 + 100_000);
    expect(s.t.levelEndsAt).toBe(T0 + 140_000);
    const [t1] = Object.keys(s.tables);
    mttCall(s, { table: t1!, applied: 0 }, T0 + 140_000, rng(13));
    expect(s.t.level).toBe(1);
    expect(s.t.levelEndsAt).toBeNull();
  });

  it.each([
    [13, 6, 1],
    [13, 6, 2],
    [20, 6, 3],
    [27, 9, 4],
    [40, 9, 5],
    [7, 6, 6],
    [2, 6, 7],
  ])('plays %i players at %i seats to the end (seed %i)', (n, seats, seed) => {
    const s = play(n, seats, seed);
    expect(s.t.status).toBe('finished');
    const places = s.t.places.map((p) => p.place).sort((x, y) => x - y);
    expect(places).toHaveLength(n);
    // Ties share the better place and the next is skipped (1, 2, 3, 3, 5 …).
    places.forEach((p) => expect(p).toBe(places.indexOf(p) + 1));
    expect(places.filter((p) => p === 1)).toHaveLength(1);
    expect(s.t.places.find((p) => p.place === 1)!.userId).toBe(s.t.winnerId);
    expect(Object.values(s.players).filter((p) => !p.out).map((p) => p.userId)).toEqual([s.t.winnerId]);
  });
});
