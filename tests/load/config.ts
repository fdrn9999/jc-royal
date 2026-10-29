/** Scenario size, overridable through the environment (see docs/LOAD_TEST.md). */
export interface LoadConfig {
  /** Six-max tables played at the same time. */
  tables: number;
  /** Seated players per table (2–6). */
  players: number;
  /** Spectator sockets per table. */
  spectators: number;
  /** Hands each table plays before everyone leaves. */
  hands: number;
  /** Chance that a bot min-raises when it may, so hands are not all check-downs. */
  raiseChance: number;
}

function int(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const v = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return v;
}

/** The realtime scenario (realtime.load.ts); it uses the first tables LOAD_TABLES seeds. */
export interface RealtimeLoadConfig {
  /** Lobby pages, one member and one realtime socket each, that every lobby event reaches. */
  viewers: number;
  /** Tables where a seat is taken and then given up, one change at a time (also how many members sit). */
  changes: number;
  /** Spectators who open one table at the same moment, then leave it together (the burst). */
  burst: number;
  /** Members granted chips by an administrator, and how many pages (devices) each has open. */
  grantees: number;
  devices: number;
}

/**
 * The viewers play every part, in groups that do not overlap where an event would be counted twice: the first `changes`
 * sit, the next one opens a room, the next `grantees` are granted chips; the last `burst` are the spectators.
 */
export function realtimeConfig(): RealtimeLoadConfig {
  const tables = loadConfig().tables;
  const viewers = int('RT_VIEWERS', 100, 10, 2_000);
  const changes = int('RT_CHANGES', Math.min(6, tables - 1), 1, 59);
  const c = {
    viewers,
    changes,
    burst: int('RT_BURST', Math.min(30, viewers), 1, viewers),
    grantees: int('RT_GRANTEES', Math.min(20, viewers - changes - 1), 1, viewers),
    // A member's sockets on one hub stop at 10 (apps/game-worker/src/realtime.ts).
    devices: int('RT_DEVICES', 3, 1, 10),
  };
  if (changes + 1 > tables) throw new Error(`RT_CHANGES needs LOAD_TABLES of at least ${changes + 1}`);
  if (changes + 1 + c.grantees > viewers) throw new Error(`RT_GRANTEES is at most RT_VIEWERS - RT_CHANGES - 1`);
  return c;
}

export function loadConfig(): LoadConfig {
  return {
    tables: int('LOAD_TABLES', 10, 1, 60),
    players: int('LOAD_PLAYERS', 4, 2, 6),
    spectators: int('LOAD_SPECTATORS', 2, 0, 20),
    hands: int('LOAD_HANDS', 5, 1, 200),
    raiseChance: 0.15,
  };
}
