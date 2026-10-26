import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../routes/admin';
import { CAPABILITIES, FEATURES, GRANT_OF, GRANTS, ROUTE_RULES, can, capabilitiesOf, effectiveFeatures, parseGrants } from './permissions';

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
        'PUT /bots/:id/profile',
        'PUT /bots/policy',
        'PATCH /service/maintenance/:id',
        'POST /reconcile/:id/resolve',
        'POST /referrals/:id/approve',
        'POST /referrals/:id/reject',
        'POST /referrals/pause',
        'POST /referrals/resume',
        'PUT /referrals/policy',
        'POST /refill/pause',
        'POST /refill/resume',
        'PUT /refill/policy',
        'POST /service/maintenance',
        'POST /service/maintenance/:id/stop',
        'POST /tables/:id/close',
        'POST /tables/:id/control',
        'POST /tables/:id/timer-recover',
        'PUT /time-bank/policy',
        'PUT /social/policy',
        'POST /tournaments/:id/abort',
        'POST /tournaments/:id/cancel',
        'POST /tournament-templates',
        'PUT /tournament-templates/:id',
        'POST /tournament-templates/:id/status',
        'POST /users/:id/chips',
        'POST /users/:id/disconnect',
        'POST /users/:id/reset-link',
        'POST /users/:id/role',
        'POST /users/:id/settings/reset',
        'POST /users/:id/settings/restore',
        'POST /users/:id/suspend',
        'POST /users/:id/unsuspend',
        'PATCH /users/:id/vip',
        'POST /users/export',
        'PUT /security/admins/:id/grants',
      ].sort(),
    );
    const superOnly = Object.entries(ROUTE_RULES).filter(([, r]) => r.role === 'super_admin').map(([k]) => k);
    expect(superOnly.sort()).toEqual(
      [
        'PUT /bots/policy',
        'POST /referrals/resume',
        'PUT /referrals/policy',
        'POST /refill/resume',
        'POST /users/:id/role',
        'POST /users/export',
        'PUT /refill/policy',
        'PUT /time-bank/policy',
        'PUT /social/policy',
        'POST /tournament-templates',
        'PUT /tournament-templates/:id',
        'POST /tournament-templates/:id/status',
        'GET /security/admins',
        'GET /security/admins/:id',
        'PUT /security/admins/:id/grants',
      ].sort(),
    );
    // A preview skips only the password, so only routes that answer a preview and write nothing are marked.
    const previews = Object.entries(ROUTE_RULES).filter(([, r]) => r.preview).map(([k]) => k);
    expect(previews.sort()).toEqual(
      ['POST /reports/:id', 'POST /tables/:id/close', 'PUT /bots/:id/profile', 'PUT /bots/policy', 'PUT /referrals/policy', 'PUT /refill/policy', 'POST /users/:id/chips', 'POST /users/:id/disconnect', 'POST /users/:id/role', 'POST /users/:id/settings/reset', 'POST /users/:id/settings/restore', 'POST /users/:id/suspend', 'POST /users/:id/unsuspend', 'PATCH /users/:id/vip', 'PUT /time-bank/policy', 'PUT /social/policy', 'POST /tournaments', 'POST /tournament-templates', 'PUT /tournament-templates/:id', 'PUT /security/admins/:id/grants'].sort(),
    );
    // Deciding a report and opening a tournament ask for no password, so their previews skip nothing; every other preview
    // stands before one.
    expect(previews.filter((k) => !ROUTE_RULES[k]!.reauth).sort()).toEqual(['POST /reports/:id', 'POST /tournaments']);
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

describe('per-administrator feature switches', () => {
  it('puts every feature behind a switch, every administrator or super admins only', () => {
    expect(Object.keys(GRANT_OF).sort()).toEqual([...FEATURES].sort());
    for (const g of Object.values(GRANT_OF)) expect(g === 'always' || g === 'super' || (GRANTS as readonly string[]).includes(g)).toBe(true);
    // Each switch opens at least one route a plain administrator may use.
    for (const g of GRANTS) expect(Object.values(ROUTE_RULES).some((r) => GRANT_OF[r.feature] === g && r.role === 'admin'), g).toBe(true);
  });

  it('has a switch for each delegable operation of the request', () => {
    // 대시보드·회원 조회·정지 해제·강제 연결 종료·신고·게시판·공지·쪽지·테이블 생성 수정·긴급 제어·소액 칩·원장·경제·운영 통계·추천인·봇
    const required = ['dashboard', 'members', 'sanctions', 'disconnect', 'reports', 'board', 'notices', 'messages', 'tables', 'tableControl', 'chips', 'ledger', 'economy', 'stats', 'referral', 'bots'];
    expect(required.filter((g) => !(GRANTS as readonly string[]).includes(g))).toEqual([]);
    const at = (key: string) => GRANT_OF[ROUTE_RULES[key]!.feature];
    expect(at('POST /users/:id/suspend')).toBe('sanctions');
    expect(at('POST /users/:id/disconnect')).toBe('disconnect');
    expect(at('POST /tables/:id/control')).toBe('tableControl');
    expect(at('PATCH /tables/:id')).toBe('tables');
    expect(at('GET /ledger')).toBe('ledger');
  });

  it('never delegates what only a super admin may do', () => {
    // 권한 정책·역할·고액 조정·원장 보정·회원 내보내기: super-admin-only routes have no switch to turn on for anyone else.
    // A feature whose every action is a super admin's has no switch at all.
    const rules = Object.values(ROUTE_RULES);
    for (const f of FEATURES) if (rules.filter((r) => r.feature === f).every((r) => r.role === 'super_admin')) expect(GRANT_OF[f], f).toBe('super');
    expect(GRANT_OF.roles).toBe('super');
    expect(GRANT_OF.memberExport).toBe('super');
    for (const key of ['GET /security/admins', 'GET /security/admins/:id', 'PUT /security/admins/:id/grants']) expect(ROUTE_RULES[key]!.role).toBe('super_admin');
    expect(CAPABILITIES['admins.grants']).toBe('super_admin');
    expect(effectiveFeatures('admin', [...GRANTS]).find((f) => f.feature === 'roles')!.allowed).toBe(0);
  });

  it('allows the intersection of the role and the switches', () => {
    const none = effectiveFeatures('admin', []);
    // With nothing on, only their own sessions, permissions and audit entries.
    expect(none.filter((f) => f.allowed > 0).map((f) => f.feature).sort()).toEqual(['audit', 'security']);
    const some = effectiveFeatures('admin', ['ledger']);
    expect(some.find((f) => f.feature === 'ledger')!.allowed).toBeGreaterThan(0);
    expect(some.find((f) => f.feature === 'members')!.allowed).toBe(0);
    // A switch never opens a super-admin-only action: refill's policy stays closed with refill on.
    const refill = effectiveFeatures('admin', ['refill']).find((f) => f.feature === 'refill')!;
    expect(refill.allowed).toBeLessThan(refill.total);
    expect(effectiveFeatures('super_admin', []).every((f) => f.allowed === f.total)).toBe(true);
    expect(effectiveFeatures('user', [...GRANTS]).every((f) => f.allowed === 0)).toBe(true);
  });

  it('reads only known switches from storage', () => {
    expect(parseGrants('["ledger","nope","members","ledger"]')).toEqual(['members', 'ledger']);
    expect(parseGrants('{"ledger":true}')).toEqual([]);
    expect(parseGrants('not json')).toEqual([]);
    expect(parseGrants(null)).toEqual([]);
  });
});
