/**
 * A multi-table tournament (docs/TOURNAMENT_MTT.md): the seating its coordinator (coordinator.ts) keeps across the
 * tournament's tables, and the steps it takes when one of them calls. Pure: the coordinator stores this state, writes
 * D1 and wakes tables up; each table deals, plays and settles its own hands as a Sit & Go table does (room.ts).
 *
 * A player is in exactly one table's roster. A move takes two steps, so nobody is ever seated at two tables: the table
 * they leave is sent a roster without them (it applies it between hands), and only once it says it applied that roster
 * do they join the other table's. Moves out of a table are decided only when that table calls between its hands; moves
 * into a table only take seats nobody holds or is moving to there. Chips move with the player, so the total stays.
 */
import { advanceLevel, rankBusts, shuffledWith, TOURNAMENT_FINISH_LINGER_MS, type Rand, type VipColor } from '@jc/types';
import { markAborted, playersLeft, runClock, seedTourney, stopClock, type TournamentRow, type TourneyPlace, type TourneyState } from './tournament';

// The first seating is the api's (it opens the tables); the coordinator's tests deal it the same way.
export { mttDeal, mttTableCount, type Rand } from '@jc/types';

export interface MttBank {
  ms: number;
  hands: number;
}

export interface MttPlayer {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  role: string;
  vip?: VipColor;
  stack: number;
  /** The table whose roster has the player (while moving: the one they leave). */
  table: string;
  seat: number;
  out: boolean;
  /** The time bank they had after their table's last hand (it goes with them to the next table). */
  bank?: MttBank | null;
  /**
   * Leaving `table` for `to`: done once `table` says it applied roster `rev`, the first without them (or, sent on, the
   * first to say where to now). `via`: the tables they were sent to before, each of which broke first.
   */
  moving?: { to: string; seat: number; rev: number; via?: string[] } | null;
}

export interface MttTable {
  id: string;
  /** The last of this table's hands taken (a report sent again changes nothing). */
  seq: number;
  /** The roster revision the table last said it applied. */
  applied: number;
  /** The roster revision now: raised whenever the table's roster changes. */
  rev: number;
  /** The roster revision the table was last answered with. */
  told: number;
  /** Its players in the order the big blind reaches them, as of its last report (the first moves first). */
  order: string[];
  /** Broken: its players leave, nobody joins, it closes once empty. */
  broken: boolean;
}

export interface MttState {
  /** The tournament's clock, places and players, as a Sit & Go keeps them (tournament.ts). */
  t: TourneyState;
  /** Seats at each table. */
  seats: number;
  players: Record<string, MttPlayer>;
  tables: Record<string, MttTable>;
  /** The final table once one table is left: its seats are drawn again once everyone has arrived. */
  final: { table: string; drawn: boolean } | null;
  /** Players whose stack, table or seat D1 does not have yet. */
  touched: string[];
}

/** A table's report after a hand: the hand's number there, everyone dealt in, and the order of the next big blinds. */
export interface MttReport {
  seq: number;
  stacks: { userId: string; stack: number; startStack: number; bank?: MttBank | null }[];
  order: string[];
}

/** A table's call: the roster revision it last applied, and its last hand's report until one is answered. */
export interface MttCall {
  table: string;
  applied: number;
  report?: MttReport | null;
}

export interface MttSeat {
  userId: string;
  seat: number;
  stack: number;
  nickname: string;
  avatarUrl: string | null;
  role: string;
  vip?: VipColor;
  bank?: MttBank | null;
}

/** What a table is told: the tournament now, and the roster it seats between hands. */
export interface MttAnswer {
  status: TourneyState['status'];
  level: number;
  levelEndsAt: number | null;
  levelLeftMs: number | null;
  stoppedAt: number | null;
  paused: boolean;
  players: Record<string, string>;
  places: TourneyPlace[];
  winnerId: string | null;
  finishedAt: number | null;
  hands: number;
  /** Who sits where here (nobody else: a seat not listed is given up). */
  seats: MttSeat[];
  /** Players this table lets go, and where to. */
  moves: { userId: string; to: string }[];
  /** The roster's revision (the table says it applied it with its next call). */
  rev: number;
  /** Broken and empty: the table closes. */
  closed: boolean;
  /** The final table waiting for its players: no deal until its seats are drawn. */
  hold: boolean;
  /** This is the final table, its seats drawn. */
  final: boolean;
  /** Tables still open. */
  tables: number;
}

const live = (s: MttState) => Object.values(s.players).filter((p) => !p.out);
const bound = (p: MttPlayer) => p.moving?.to ?? p.table;
const inRoster = (p: MttPlayer, table: string) => !p.out && p.table === table && !p.moving;
const openTables = (s: MttState) => Object.values(s.tables).filter((t) => !t.broken).sort((a, b) => (a.id < b.id ? -1 : 1));

function touch(s: MttState, userId: string) {
  if (!s.touched.includes(userId)) s.touched.push(userId);
}

/** A new roster revision: always above the last, and above any from before the state was built again (a time). */
function bump(t: MttTable, now: number) {
  t.rev = Math.max(t.rev + 1, now);
}

/** Players at (or on their way to) each open table. */
function counts(s: MttState): Map<string, number> {
  const n = new Map(openTables(s).map((t) => [t.id, 0]));
  for (const p of live(s)) {
    const at = bound(p);
    if (n.has(at)) n.set(at, n.get(at)! + 1);
  }
  return n;
}

/** Seats at `table` nobody holds or is moving to. */
function freeSeats(s: MttState, table: string): number[] {
  const taken = new Set<number>();
  for (const p of live(s)) {
    if (p.moving?.to === table) taken.add(p.moving.seat);
    else if (p.table === table && !p.moving) taken.add(p.seat);
  }
  return Array.from({ length: s.seats }, (_, i) => i).filter((i) => !taken.has(i));
}

/** The open table with the fewest players (ties: the last by id, so the lowest numbers stay), not `except`. */
function smallest(s: MttState, n: Map<string, number>, except?: string): string | null {
  let best: string | null = null;
  for (const t of openTables(s)) {
    if (t.id === except) continue;
    if (best === null || n.get(t.id)! <= n.get(best)!) best = t.id;
  }
  return best;
}

/** The open table with the most players (ties: the first by id). */
function largest(s: MttState, n: Map<string, number>): string | null {
  let best: string | null = null;
  for (const t of openTables(s)) if (best === null || n.get(t.id)! > n.get(best)!) best = t.id;
  return best;
}


/**
 * The coordinator's state from D1 (at the start, or should its storage be lost): everyone where D1 last had them, the
 * clock as D1 has it, no move under way. Tables D1 has closing or closed count as broken; with one table left it is
 * the final table, its seats as they are.
 */
export function mttSeed(row: TournamentRow, tables: readonly { id: string; open: boolean }[], seats: number, now: number): MttState {
  const t = seedTourney(row, now);
  const ids = tables.map((x) => x.id);
  const players: Record<string, MttPlayer> = {};
  for (const e of row.entries) {
    const out = e.status !== 'playing' || (e.stack ?? row.startStack) <= 0;
    players[e.userId] = {
      userId: e.userId,
      nickname: e.nickname,
      avatarUrl: e.avatarUrl,
      role: e.role,
      ...(e.vip ? { vip: e.vip } : {}),
      stack: out ? 0 : (e.stack ?? row.startStack),
      table: e.tableId && ids.includes(e.tableId) ? e.tableId : (ids[0] ?? ''),
      seat: e.seat ?? 0,
      out,
    };
  }
  const s: MttState = {
    t,
    seats,
    players,
    tables: Object.fromEntries(tables.map((x) => [x.id, { id: x.id, seq: 0, applied: 0, rev: now, told: 0, order: [], broken: !x.open }])),
    final: null,
    touched: [],
  };
  const open = openTables(s);
  // Anyone D1 last had at a table now closing (a move it had not heard of yet), or in a seat someone else holds, is
  // given the open table with the most free seats instead, in its lowest free seat.
  const held = new Map(open.map((x) => [x.id, new Set<number>()]));
  const stray: MttPlayer[] = [];
  for (const p of Object.values(players).sort((a, b) => (a.userId < b.userId ? -1 : 1))) {
    if (p.out) continue;
    const at = held.get(p.table);
    if (!at || at.has(p.seat) || p.seat < 0 || p.seat >= seats) stray.push(p);
    else at.add(p.seat);
  }
  for (const p of stray) {
    const to = [...held].sort((a, b) => a[1].size - b[1].size || (a[0] < b[0] ? -1 : 1))[0];
    const seat = to ? Array.from({ length: seats }, (_, i) => i).find((i) => !to[1].has(i)) : undefined;
    if (!to || seat === undefined) break;
    p.table = to[0];
    p.seat = seat;
    to[1].add(seat);
    s.touched.push(p.userId);
  }
  if (open.length === 1 && t.status === 'running') s.final = { table: open[0]!.id, drawn: true };
  return s;
}

/**
 * Whether the level clock runs: not during an operator's pause or a maintenance (`run` false), when it stops with the
 * time left kept; again from that time once both are over. Returns whether anything changed.
 */
export function mttClock(s: MttState, run: boolean, now: number): boolean {
  if (s.t.status !== 'running') return false;
  const changed = run ? runClock(s.t, now) : stopClock(s.t, now);
  if (changed) s.t.dirty = true;
  return changed;
}

function place(s: MttState, p: MttPlayer, n: number, now: number): TourneyPlace {
  return { userId: p.userId, nickname: s.t.players[p.userId] ?? p.nickname, place: n, hand: s.t.hands, at: now, ...(p.vip ? { vip: p.vip } : {}) };
}

/**
 * One table's call, between its hands. In order: moves out of it that it has now applied are finished (the players
 * join their new table's roster); its hand's report is taken once (stacks, places for those who lost their last chip,
 * the winner); then, while the tournament runs, the table is broken up or balanced if the tournament needs it, the
 * final table's seats are drawn once everyone is there, and the level clock moves on. Returns the other tables that
 * have something to pick up now.
 */
export function mttCall(s: MttState, call: MttCall, now: number, rand: Rand): string[] {
  const tb = s.tables[call.table];
  if (!tb) return [];
  const wake = new Set<string>();
  if (call.applied > tb.applied) {
    tb.applied = call.applied;
    for (const p of live(s)) {
      if (p.table !== tb.id || !p.moving || p.moving.rev > tb.applied) continue;
      const to = s.tables[p.moving.to]!;
      p.table = to.id;
      p.seat = p.moving.seat;
      p.moving = null;
      touch(s, p.userId);
      bump(to, now);
      wake.add(to.id);
    }
  }
  const r = call.report;
  if (r && r.seq > tb.seq && s.t.status === 'running') {
    tb.seq = r.seq;
    tb.order = r.order.filter((u) => !!s.players[u] && inRoster(s.players[u]!, tb.id));
    const busts: { userId: string; startStack: number }[] = [];
    // Everyone the table dealt in (one it was letting go, too: their chips are where they played them).
    for (const x of r.stacks) {
      const p = s.players[x.userId];
      if (!p || p.out || p.table !== tb.id) continue;
      if (p.stack !== x.stack) touch(s, p.userId);
      p.stack = x.stack;
      if (x.bank !== undefined) p.bank = x.bank;
      if (x.stack === 0) busts.push({ userId: p.userId, startStack: x.startStack });
    }
    s.t.hands += 1;
    s.t.dirty = true;
    if (busts.length) {
      const before = playersLeft(s.t);
      for (const b of rankBusts(before, busts)) {
        const p = s.players[b.userId]!;
        p.out = true;
        s.t.places.push(place(s, p, b.place, now));
      }
      bump(tb, now);
      if (playersLeft(s.t) <= 1) {
        const winner = live(s)[0] ?? null;
        s.t.status = 'finished';
        s.t.winnerId = winner?.userId ?? null;
        s.t.finishedAt = now;
        s.t.closeAt = now + TOURNAMENT_FINISH_LINGER_MS;
        if (winner) s.t.places.push(place(s, winner, 1, now));
      }
    }
  }
  if (s.t.status === 'running') {
    plan(s, tb, now, rand, wake);
    drawFinal(s, now, rand, wake);
    tick(s, now);
  }
  // The caller is answered with its roster as it is now.
  tb.told = tb.rev;
  wake.delete(tb.id);
  return [...wake];
}

/**
 * Breaks the calling table up when the others can seat everyone left, else evens the tables out from it when it is
 * the largest and two or more above the smallest. A table that should act but did not call is woken instead.
 */
function plan(s: MttState, tb: MttTable, now: number, rand: Rand, wake: Set<string>) {
  if (tb.broken) return;
  const n = counts(s);
  const open = openTables(s);
  const left = live(s).length;
  const marked: MttPlayer[] = [];
  const sentOn: MttPlayer[] = [];
  if (open.length > 1 && left <= (open.length - 1) * s.seats) {
    const target = smallest(s, n);
    if (target !== tb.id) {
      if (target) wake.add(target);
      return;
    }
    tb.broken = true;
    const rest = openTables(s);
    // Its players, and any on their way to it, go to the table with the most free seats each time.
    const leaving = live(s).filter((p) => inRoster(p, tb.id) || p.moving?.to === tb.id);
    for (const p of leaving) {
      const to = rest.map((t) => ({ id: t.id, free: freeSeats(s, t.id) })).sort((a, b) => b.free.length - a.free.length || (a.id < b.id ? -1 : 1))[0];
      if (!to || to.free.length === 0) break;
      const seat = to.free[rand(to.free.length)]!;
      if (p.moving) {
        p.moving = { ...p.moving, to: to.id, seat, via: [...(p.moving.via ?? []), tb.id] };
        sentOn.push(p);
      } else {
        p.moving = { to: to.id, seat, rev: 0 };
        marked.push(p);
      }
    }
    if (rest.length === 1) {
      s.final = { table: rest[0]!.id, drawn: false };
      wake.add(rest[0]!.id);
    }
  } else if (open.length > 1) {
    const big = largest(s, n);
    const small = smallest(s, n, big ?? undefined);
    if (!big || !small || n.get(big)! - n.get(small)! < 2) return;
    if (n.get(tb.id)! < n.get(big)!) {
      wake.add(big);
      return;
    }
    for (;;) {
      const to = smallest(s, n, tb.id);
      if (!to || n.get(tb.id)! - n.get(to)! < 2 || n.get(tb.id)! < Math.max(...n.values())) break;
      const free = freeSeats(s, to);
      // The next big blind moves first (then by seat, for players the last report did not order).
      const next = tb.order.map((u) => s.players[u]).find((x) => !!x && inRoster(x, tb.id));
      const p = next ?? live(s).filter((x) => inRoster(x, tb.id)).sort((a, b) => a.seat - b.seat)[0];
      if (!p || free.length === 0) break;
      p.moving = { to, seat: free[rand(free.length)]!, rev: 0 };
      marked.push(p);
      n.set(tb.id, n.get(tb.id)! - 1);
      n.set(to, n.get(to)! + 1);
    }
  }
  if (marked.length) {
    bump(tb, now);
    for (const p of marked) p.moving!.rev = tb.rev;
  }
  // The table a player sent on is still leaving tells them where to now, and they leave it once it has.
  for (const src of new Set(sentOn.map((p) => p.table))) {
    const from = s.tables[src]!;
    bump(from, now);
    for (const p of sentOn) if (p.table === src) p.moving!.rev = from.rev;
    wake.add(src);
  }
}

/** The final table's seats, drawn again once nobody is still on the way. */
function drawFinal(s: MttState, now: number, rand: Rand, wake: Set<string>) {
  const f = s.final;
  if (!f || f.drawn || live(s).some((p) => p.moving)) return;
  const here = live(s).filter((p) => inRoster(p, f.table));
  const seats = shuffledWith(Array.from({ length: s.seats }, (_, i) => i), rand);
  here.forEach((p, i) => {
    p.seat = seats[i]!;
    touch(s, p.userId);
  });
  f.drawn = true;
  bump(s.tables[f.table]!, now);
  wake.add(f.table);
}

/** The level clock moves on (a running one; the coordinator stops and starts it for a pause). */
export function tick(s: MttState, now: number) {
  const t = s.t;
  if (t.status !== 'running' || t.stoppedAt !== null) return;
  const c = advanceLevel({ level: t.level, levelEndsAt: t.levelEndsAt }, t.levels.length, t.levelMs, now);
  if (c.level === t.level && c.levelEndsAt === t.levelEndsAt) return;
  t.level = c.level;
  t.levelEndsAt = c.levelEndsAt;
  t.dirty = true;
}

/** What `table` is told now. */
export function mttAnswer(s: MttState, table: string): MttAnswer {
  const t = s.t;
  const tb = s.tables[table];
  const ps = Object.values(s.players);
  return {
    status: t.status,
    level: t.level,
    levelEndsAt: t.levelEndsAt,
    levelLeftMs: t.levelLeftMs,
    stoppedAt: t.stoppedAt,
    paused: t.pauseRequested,
    players: t.players,
    places: t.places,
    winnerId: t.winnerId,
    finishedAt: t.finishedAt,
    hands: t.hands,
    // Once finished only the winner is left in a roster; once aborted nobody is.
    seats: t.status !== 'aborted'
      ? ps
          .filter((p) => inRoster(p, table))
          .map((p) => ({
            userId: p.userId,
            seat: p.seat,
            stack: p.stack,
            nickname: p.nickname,
            avatarUrl: p.avatarUrl,
            role: p.role,
            ...(p.vip ? { vip: p.vip } : {}),
            ...(p.bank ? { bank: p.bank } : {}),
          }))
      : [],
    // Its own players on their way, and any sent on from it while on their way here (they may have come already).
    moves: ps.filter((p) => !p.out && p.moving && (p.table === table || p.moving.via?.includes(table))).map((p) => ({ userId: p.userId, to: p.moving!.to })),
    rev: tb?.rev ?? 0,
    closed: !tb || (tb.broken && !ps.some((p) => !p.out && p.table === table)),
    hold: s.final?.table === table && !s.final.drawn,
    final: s.final?.table === table && s.final.drawn,
    tables: openTables(s).length,
  };
}

/** D1 says the tournament was aborted: nobody moves on, and every table still open is told (then closes). */
export function mttAbort(s: MttState, now: number) {
  if (s.t.status === 'aborted') return;
  markAborted(s.t, now);
  for (const p of live(s)) p.moving = null;
  for (const tb of Object.values(s.tables)) bump(tb, now);
}

/**
 * Tables to wake up again (a poke lost on the way): one not yet told its roster as it is now — and, while the
 * tournament runs, one that has players to let go (a broken one until it is empty) or too few players to deal (it may
 * be the one to break up, or wait for players). A broken table with nobody left has closed.
 */
export function mttStale(s: MttState): string[] {
  const n = counts(s);
  const ps = live(s);
  return Object.values(s.tables)
    .filter((t) => {
      const here = ps.some((p) => p.table === t.id);
      if (t.broken && !here) return false;
      if (t.rev > t.told) return true;
      if (s.t.status !== 'running') return false;
      return t.broken || ps.some((p) => p.table === t.id && p.moving) || (n.get(t.id) ?? 0) < 2;
    })
    .map((t) => t.id)
    .sort();
}