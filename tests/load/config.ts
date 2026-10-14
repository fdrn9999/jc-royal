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

export function loadConfig(): LoadConfig {
  return {
    tables: int('LOAD_TABLES', 10, 1, 60),
    players: int('LOAD_PLAYERS', 4, 2, 6),
    spectators: int('LOAD_SPECTATORS', 2, 0, 20),
    hands: int('LOAD_HANDS', 5, 1, 200),
    raiseChance: 0.15,
  };
}
