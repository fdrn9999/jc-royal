// The tournament rules that need no room or D1 (docs/TOURNAMENT.md): a structure's values holding together, the level
// clock (moving on, stopping with the time left kept, starting again), places for players out in the same hand, the
// winner, an abort after places D1 never took, and when operators are shown a tournament as needing recovery.
import {
  advanceLevel,
  blindsAt,
  rankBusts,
  TOURNAMENT_FINISH_LINGER_MS,
  TOURNAMENT_RECOVERY_MS as R,
  tournamentRecovery,
  tournamentStructureProblem,
  type TournamentRecoveryInput,
  type TournamentStructure,
} from '@jc/types';
import { describe, expect, it } from 'vitest';
import { bustOut, markAborted, playersLeft, runClock, seedTourney, stopClock, toTournamentRow, type TournamentRow, type TourneyState } from './tournament';

const MIN = 60_000;
const structure: TournamentStructure = {
  name: 'Friday SNG',
  capacity: 6,
  minPlayers: 2,
  startStack: 1500,
  levels: [
    { sb: 10, bb: 20 },
    { sb: 15, bb: 30 },
    { sb: 25, bb: 50 },
  ],
  levelMinutes: 5,
  turnSeconds: 20,
  timeBank: { enabled: true, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 10, refillMs: 5_000 },
  minHands: 0,
  requireVerified: false,
  autoStart: true,
};

describe('tournament structure', () => {
  it('holds together or names the first problem', () => {
    expect(tournamentStructureProblem(structure)).toBeNull();
    expect(tournamentStructureProblem({ ...structure, minPlayers: 7 })).toBe('min_players_over_capacity');
    expect(tournamentStructureProblem({ ...structure, levels: [{ sb: 20, bb: 20 }] })).toBe('small_blind_not_below_big');
    expect(tournamentStructureProblem({ ...structure, levels: [{ sb: 20, bb: 40 }, { sb: 15, bb: 30 }] })).toBe('levels_decrease');
    // The starting stack is at least ten big blinds of the first level.
    expect(tournamentStructureProblem({ ...structure, startStack: 199 })).toBe('start_stack_too_small');
    expect(tournamentStructureProblem({ ...structure, startStack: 200 })).toBeNull();
    expect(tournamentStructureProblem({ ...structure, timeBank: { ...structure.timeBank, initialMs: 70_000 } })).toBe('initial_over_max');
    // A time bank that is off is not checked.
    expect(tournamentStructureProblem({ ...structure, timeBank: { ...structure.timeBank, enabled: false, initialMs: 70_000 } })).toBeNull();
  });

  it('gives the last level past the end', () => {
    expect(blindsAt(structure.levels, 0)).toEqual({ sb: 10, bb: 20 });
    expect(blindsAt(structure.levels, 2)).toEqual({ sb: 25, bb: 50 });
    expect(blindsAt(structure.levels, 9)).toEqual({ sb: 25, bb: 50 });
    expect(blindsAt(structure.levels, -1)).toEqual({ sb: 10, bb: 20 });
  });
});

describe('the level clock', () => {
  const levelMs = 5 * MIN;
  it('moves past every level whose time is up, and has no end at the last level', () => {
    const t0 = 1_000_000;
    expect(advanceLevel({ level: 0, levelEndsAt: t0 + levelMs }, 3, levelMs, t0 + levelMs - 1)).toEqual({ level: 0, levelEndsAt: t0 + levelMs });
    expect(advanceLevel({ level: 0, levelEndsAt: t0 + levelMs }, 3, levelMs, t0 + levelMs)).toEqual({ level: 1, levelEndsAt: t0 + 2 * levelMs });
    // A long wait between hands: both levels left behind, and the last level has no end.
    expect(advanceLevel({ level: 0, levelEndsAt: t0 + levelMs }, 3, levelMs, t0 + 10 * levelMs)).toEqual({ level: 2, levelEndsAt: null });
    expect(advanceLevel({ level: 2, levelEndsAt: null }, 3, levelMs, t0 + 99 * levelMs)).toEqual({ level: 2, levelEndsAt: null });
    // A stopped clock (no end) stays where it is.
    expect(advanceLevel({ level: 1, levelEndsAt: null }, 3, levelMs, t0 + 99 * levelMs)).toEqual({ level: 1, levelEndsAt: null });
    expect(advanceLevel({ level: 0, levelEndsAt: t0 }, 1, levelMs, t0)).toEqual({ level: 0, levelEndsAt: null });
  });

  it('keeps the time left while stopped and starts again from it', () => {
    const t = seedTourney(row({ levelEndsAt: null, levelLeftMs: null }), 0);
    // A tournament the room meets for the first time: the clock waits for the first deal with the whole level.
    expect([t.levelEndsAt, t.levelLeftMs, t.stoppedAt]).toEqual([null, levelMs, 0]);
    expect(runClock(t, 10_000)).toBe(true);
    expect([t.level, t.levelEndsAt, t.levelLeftMs, t.stoppedAt]).toEqual([0, 10_000 + levelMs, null, null]);
    expect(runClock(t, 20_000)).toBe(false);
    // Paused 2 minutes in: 3 minutes kept, however long the pause lasts.
    expect(stopClock(t, 10_000 + 2 * MIN)).toBe(true);
    expect([t.levelEndsAt, t.levelLeftMs, t.stoppedAt]).toEqual([null, 3 * MIN, 10_000 + 2 * MIN]);
    expect(stopClock(t, 10_000 + 50 * MIN)).toBe(false);
    expect(t.levelLeftMs).toBe(3 * MIN);
    expect(runClock(t, 100 * MIN)).toBe(true);
    expect([t.level, t.levelEndsAt]).toEqual([0, 103 * MIN]);
    // The level moves on at a deal after its time.
    expect(runClock(t, 103 * MIN)).toBe(true);
    expect([t.level, t.levelEndsAt]).toEqual([1, 108 * MIN]);
    // Stopped at the last level: nothing to keep.
    expect(runClock(t, 108 * MIN)).toBe(true);
    expect(stopClock(t, 109 * MIN)).toBe(true);
    expect([t.level, t.levelLeftMs]).toEqual([2, null]);
    expect(runClock(t, 200 * MIN)).toBe(true);
    expect([t.level, t.levelEndsAt]).toEqual([2, null]);
  });
});

describe('places', () => {
  it('a bigger stack at the start of the hand places higher; equal stacks share the higher place', () => {
    const places = (before: number, stacks: number[]) =>
      Object.fromEntries(rankBusts(before, stacks.map((s, i) => ({ id: `p${i}`, startStack: s }))).map((b) => [b.id, b.place]));
    expect(places(4, [100, 300])).toEqual({ p0: 4, p1: 3 });
    expect(places(3, [200, 200])).toEqual({ p0: 2, p1: 2 });
    expect(places(5, [50, 200, 200])).toEqual({ p0: 5, p1: 3, p2: 3 });
    expect(places(2, [10])).toEqual({ p0: 2 });
  });

  it('busts players one hand at a time down to a winner, and plays on after nothing', () => {
    const t = seeded(['a', 'b', 'c']);
    expect(playersLeft(t)).toBe(3);
    t.hands = 4;
    expect(bustOut(t, dealt({ a: 300, b: 500, c: 700 }), new Map([['a', 0], ['b', 800], ['c', 700]]), 1000)).toEqual(['a']);
    expect(t.places).toEqual([{ userId: 'a', nickname: 'A', place: 3, hand: 4, at: 1000 }]);
    expect([t.status, playersLeft(t), t.dirty]).toEqual(['running', 2, true]);
    // A hand nobody lost every chip in places nobody; one already placed is not placed again.
    expect(bustOut(t, dealt({ a: 0, b: 800, c: 700 }), new Map([['a', 0], ['b', 750], ['c', 750]]), 1100)).toEqual([]);
    t.hands = 9;
    expect(bustOut(t, dealt({ b: 750, c: 750 }), new Map([['b', 1500], ['c', 0]]), 2000)).toEqual(['c']);
    expect(t).toMatchObject({ status: 'finished', winnerId: 'b', finishedAt: 2000, closeAt: 2000 + TOURNAMENT_FINISH_LINGER_MS });
    expect(t.places.map((p) => [p.userId, p.place, p.hand])).toEqual([
      ['a', 3, 4],
      ['c', 2, 9],
      ['b', 1, 9],
    ]);
    expect(playersLeft(t)).toBe(1);
    // Over: nothing more is placed.
    expect(bustOut(t, dealt({ b: 1500 }), new Map([['b', 0]]), 3000)).toEqual([]);
  });

  it('two out in the same hand: placed by the stack each started it with, the winner first', () => {
    const t = seeded(['a', 'b', 'c']);
    expect(bustOut(t, dealt({ a: 200, b: 600, c: 700 }), new Map([['a', 0], ['b', 0], ['c', 1500]]), 1000).sort()).toEqual(['a', 'b']);
    expect(t.places.map((p) => [p.userId, p.place])).toEqual([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);
    expect([t.status, t.winnerId, playersLeft(t)]).toEqual(['finished', 'c', 1]);
  });

  it('a stop drops places D1 never took and leaves no winner', () => {
    const t = seeded(['a', 'b']);
    bustOut(t, dealt({ a: 100, b: 2900 }), new Map([['a', 0], ['b', 3000]]), 1000);
    expect(t.winnerId).toBe('b');
    markAborted(t, 5000);
    expect(t).toMatchObject({ status: 'aborted', winnerId: null, finishedAt: null, places: [], dirty: false });
    // The close time the finish set stays.
    expect(t.closeAt).toBe(1000 + TOURNAMENT_FINISH_LINGER_MS);

    const u = seeded(['a', 'b', 'c']);
    bustOut(u, dealt({ a: 100, b: 1000, c: 1000 }), new Map([['a', 0], ['b', 1050], ['c', 1050]]), 1000);
    u.confirmed = 1;
    bustOut(u, dealt({ b: 1050, c: 1050 }), new Map([['b', 2100], ['c', 0]]), 2000);
    markAborted(u, 3000);
    expect(u.places.map((p) => [p.userId, p.place])).toEqual([['a', 3]]);
    expect(u.closeAt).toBe(2000 + TOURNAMENT_FINISH_LINGER_MS);
    const before = { ...u };
    markAborted(u, 4000);
    expect(u).toEqual(before);
  });
});

describe('the tournament the room reads from D1', () => {
  it('reads its row, and refuses one it cannot read', () => {
    const raw = JSON.stringify({ ...rowJson(), pauseRequested: 1, tb: { enabled: 1, initialMs: 30_000, maxMs: 60_000, unitMs: 10_000, refillHands: 0, refillMs: 5_000 } });
    const r = toTournamentRow(raw)!;
    expect(r).toMatchObject({ id: 'tn1', status: 'running', pauseRequested: true, levels: structure.levels, tb: { enabled: true, refillHands: 1 } });
    expect(toTournamentRow(null)).toBeNull();
    expect(toTournamentRow('{')).toBeNull();
    expect(toTournamentRow(JSON.stringify({ ...rowJson(), status: 'paused' }))).toBeNull();
    expect(toTournamentRow(JSON.stringify({ ...rowJson(), levels: [{ sb: 10, bb: 20 }, { sb: 30, bb: 30 }] }))).toBeNull();
    expect(toTournamentRow(JSON.stringify({ ...rowJson(), level: 99 }))!.level).toBe(2);
  });

  it('seeds places, the winner and a running or stopped clock', () => {
    const running = seedTourney(row({ levelEndsAt: 9_000, level: 1 }), 5_000);
    expect([running.level, running.levelEndsAt, running.levelLeftMs, running.stoppedAt]).toEqual([1, 9_000, null, null]);
    const paused = seedTourney(row({ level: 1, levelEndsAt: null, levelLeftMs: 70_000, pausedAt: 4_000, pauseRequested: true }), 5_000);
    expect([paused.levelEndsAt, paused.levelLeftMs, paused.stoppedAt, paused.pauseRequested]).toEqual([null, 70_000, 4_000, true]);
    const ended = seedTourney(
      row({
        status: 'finished',
        entries: [entry('a', 'eliminated', 3), entry('b', 'won', 1), entry('c', 'eliminated', 2)],
      }),
      5_000,
    );
    expect(ended).toMatchObject({ status: 'finished', winnerId: 'b', closeAt: 5_000 });
    expect(ended.places.map((p) => [p.userId, p.place])).toEqual([
      ['a', 3],
      ['c', 2],
    ]);
    expect(playersLeft(ended)).toBe(1);
    expect(seedTourney(row({ status: 'aborted', entries: [entry('a', 'stopped', null), entry('b', 'eliminated', 2)] }), 1).places.map((p) => p.userId)).toEqual(['b']);
  });
});

describe('needs recovery', () => {
  const now = 100 * MIN;
  const base: TournamentRecoveryInput = {
    status: 'running',
    pauseRequested: false,
    pauseChangedAt: null,
    pausedAt: null,
    roomSeenAt: now - MIN,
    startedAt: now - 30 * MIN,
    endedAt: null,
    tableStatus: 'playing',
    autoStart: true,
    registered: 2,
    capacity: 2,
    updatedAt: now - MIN,
  };
  const codes = (o: Partial<TournamentRecoveryInput>) => tournamentRecovery({ ...base, ...o }, now);

  it('flags nothing while a tournament runs as it should', () => {
    expect(codes({})).toEqual([]);
    // Paused by an operator, the clock stopped: as asked, however long.
    expect(codes({ pauseRequested: true, pauseChangedAt: now - 60 * MIN, pausedAt: now - 59 * MIN, roomSeenAt: now - 59 * MIN })).toEqual([]);
    expect(codes({ status: 'finished', endedAt: now - 60 * MIN, tableStatus: 'closed' })).toEqual([]);
  });

  it('flags a silent room, a pause or resume the room did not take, and a clock stopped with no pause', () => {
    expect(codes({ roomSeenAt: null, startedAt: now - R.firstWrite - 1 })).toEqual(['room_silent']);
    expect(codes({ roomSeenAt: null, startedAt: now - R.firstWrite + 1000 })).toEqual([]);
    expect(codes({ roomSeenAt: now - R.silent - 1 })).toEqual(['room_silent']);
    expect(codes({ pauseRequested: true, pauseChangedAt: now - R.pauseStuck - 1 })).toEqual(['pause_stuck']);
    expect(codes({ pauseChangedAt: now - R.resumeStuck - 1, pausedAt: now - 5 * MIN })).toEqual(['resume_stuck']);
    // Everyone away (or a long maintenance): no operator's pause, the clock stopped for 15 minutes.
    expect(codes({ pausedAt: now - R.stalled + 1000 })).toEqual([]);
    expect(codes({ pausedAt: now - R.stalled - 1, roomSeenAt: now - R.stalled - 1 })).toEqual(['stalled']);
    expect(codes({ pauseRequested: true, pauseChangedAt: now - 20 * MIN, pausedAt: now - R.stalled - 1 })).toEqual([]);
  });

  it('flags a table left open after the end, and an automatic start that did not happen', () => {
    expect(codes({ status: 'aborted', endedAt: now - R.tableOpen - 1, tableStatus: 'playing' })).toEqual(['table_open']);
    expect(codes({ status: 'aborted', endedAt: now - R.tableOpen - 1, tableStatus: null })).toEqual([]);
    expect(codes({ status: 'registering', updatedAt: now - R.startStuck - 1 })).toEqual(['start_stuck']);
    expect(codes({ status: 'registering', registered: 1, updatedAt: now - R.startStuck - 1 })).toEqual([]);
    expect(codes({ status: 'registering', autoStart: false, updatedAt: now - R.startStuck - 1 })).toEqual([]);
  });
});

function entry(userId: string, status: string, place: number | null) {
  return { userId, seat: null, stack: null, status, place, nickname: userId.toUpperCase(), avatarUrl: null, role: 'user' };
}
function rowJson() {
  return {
    id: 'tn1',
    name: 'Friday SNG',
    status: 'running',
    startStack: 1500,
    levels: structure.levels,
    levelMs: 5 * MIN,
    pauseRequested: 0,
    tb: { enabled: 0 },
    level: 0,
    levelEndsAt: null,
    levelLeftMs: null,
    pausedAt: null,
    hands: 0,
    entries: [],
  };
}
function row(over: Partial<TournamentRow> = {}): TournamentRow {
  return { ...toTournamentRow(JSON.stringify(rowJson()))!, ...over };
}
function seeded(users: string[]): TourneyState {
  return seedTourney(row({ entries: users.map((u) => entry(u, 'playing', null)) }), 0);
}
function dealt(stacks: Record<string, number>) {
  return Object.entries(stacks).map(([playerId, stack]) => ({ playerId, displayName: playerId, stack }));
}
