import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../routes/admin';
import { CAPABILITIES, ROUTE_RULES, can, capabilitiesOf } from './permissions';

/** Every admin API route as `METHOD /path` (the /auth routes sign in and out, before any role is known). */
const declared = [
  ...new Set(
    adminRoutes.routes
      .filter((r) => r.method !== 'ALL' && !r.path.startsWith('/auth/') && r.path !== '/auth')
      .map((r) => `${r.method} ${r.path}`),
  ),
];

describe('admin permission table', () => {
  it('has a rule for every admin route, and a route for every rule', () => {
    expect(declared.length).toBeGreaterThan(40);
    expect(declared.filter((k) => !Object.hasOwn(ROUTE_RULES, k))).toEqual([]);
    expect(Object.keys(ROUTE_RULES).filter((k) => !declared.includes(k))).toEqual([]);
  });

  it('declares each route once, with no guard of its own', () => {
    // A route-level middleware registers the same method and path again; the table is the only guard.
    const all = adminRoutes.routes.filter((r) => r.method !== 'ALL' && !r.path.startsWith('/auth/')).map((r) => `${r.method} ${r.path}`);
    expect(all.length).toBe(declared.length);
  });

  it('keeps the sensitive actions behind the password and super-admin-only actions for super admins', () => {
    const reauth = Object.entries(ROUTE_RULES).filter(([, r]) => r.reauth).map(([k]) => k);
    expect(reauth.sort()).toEqual(
      [
        'GET /hands/:id',
        'POST /bots/stop',
        'PUT /bots/policy',
        'PATCH /service/maintenance/:id',
        'POST /reconcile/:id/resolve',
        'POST /refill/pause',
        'POST /refill/resume',
        'PUT /refill/policy',
        'POST /service/maintenance',
        'POST /service/maintenance/:id/stop',
        'POST /tables/:id/close',
        'POST /tables/:id/control',
        'POST /users/:id/chips',
        'POST /users/:id/disconnect',
        'POST /users/:id/reset-link',
        'POST /users/:id/role',
        'POST /users/:id/suspend',
        'POST /users/:id/unsuspend',
        'POST /users/export',
      ].sort(),
    );
    const superOnly = Object.entries(ROUTE_RULES).filter(([, r]) => r.role === 'super_admin').map(([k]) => k);
    expect(superOnly.sort()).toEqual(['PUT /bots/policy', 'POST /refill/resume', 'POST /users/:id/role', 'POST /users/export', 'PUT /refill/policy'].sort());
    // A preview skips only the password, so only routes that answer a preview and write nothing are marked.
    const previews = Object.entries(ROUTE_RULES).filter(([, r]) => r.preview).map(([k]) => k);
    expect(previews.sort()).toEqual(
      ['POST /reports/:id', 'POST /tables/:id/close', 'PUT /bots/policy', 'PUT /refill/policy', 'POST /users/:id/chips', 'POST /users/:id/disconnect', 'POST /users/:id/role', 'POST /users/:id/suspend', 'POST /users/:id/unsuspend'].sort(),
    );
    // Deciding a report asks for no password, so its preview skips nothing; every other preview stands before one.
    expect(previews.filter((k) => !ROUTE_RULES[k]!.reauth)).toEqual(['POST /reports/:id']);
  });

  it('gives super admins every capability and plain administrators none of the super-admin ones', () => {
    expect(capabilitiesOf('super_admin')).toEqual(Object.keys(CAPABILITIES));
    expect(capabilitiesOf('admin')).toEqual([]);
    expect(capabilitiesOf('user')).toEqual([]);
    expect(can('admin', 'audit.all')).toBe(false);
    expect(can('super_admin', 'audit.all')).toBe(true);
    expect(can(undefined, 'sessions.all')).toBe(false);
  });
});
