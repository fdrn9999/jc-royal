import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export * as schema from './schema';
export * from './ledger';
export * from './ops';
export { HAND_STATS_SQL } from './handStats';

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
export type Db = ReturnType<typeof createDb>;

export function newId(): string {
  return crypto.randomUUID();
}
