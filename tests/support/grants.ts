/**
 * Every per-administrator feature switch (apps/api/src/lib/permissions.ts GRANTS; admin-permissions.test.ts checks the
 * two lists stay equal). A plain administrator starts with every feature off, so tests that make one straight in D1
 * turn them all on, as before the switches existed; tests of the switches set their own.
 */
export const ALL_GRANTS = [
  'dashboard',
  'members',
  'sanctions',
  'disconnect',
  'reports',
  'board',
  'notices',
  'messages',
  'tables',
  'tableControl',
  'chips',
  'ledger',
  'economy',
  'stats',
  'referral',
  'bots',
  'tournaments',
  'refill',
  'hands',
  'reconcile',
  'settings',
  'resetLinks',
  'maintenance',
] as const;

/** SQL that switches features on for the accounts matching `where` (an SQL condition on users), replacing what they had. */
export const grantSql = (where: string, grants: readonly string[] = ALL_GRANTS) =>
  `INSERT OR REPLACE INTO admin_permissions (user_id, grants, version, updated_by) SELECT id, '${JSON.stringify(grants)}', 1, 'test' FROM users WHERE ${where}`;

/** SQL that makes the accounts matching `where` plain administrators with every feature on (or `grants`). */
export const promoteSql = (where: string, grants: readonly string[] = ALL_GRANTS) => `UPDATE users SET role = 'admin' WHERE ${where}; ${grantSql(where, grants)}`;
