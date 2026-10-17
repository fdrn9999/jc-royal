// Account settings sync (GET/PUT /api/me/settings) and its administration (routes/admin-settings.ts): the newest change
// wins one setting or favourite at a time, a device's settings from before sync only fill what the account has nothing
// for, another account's changes are refused, auto-muck reaches the table the member sits at, and an administrator's
// reset (preview, password, reason, audit, one message in the member's language) stops old devices uploading again and
// can be undone for a week while the member changes nothing.
import { SETTINGS_FAV_MAX, SETTINGS_RESTORE_MS, type AdminSettingsDiagDto, type SettingsDto, type SettingsSave, type SettingsSaveResult } from '@jc/types';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';
import { TableSocket } from '../support/ws';
import { promoteSql } from '../support/grants';

const ADMIN_ORIGIN = 'http://localhost:5174';
/** The bootstrapped super admin. */
const admin = sharedAdmin();
const open: TableSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const DAY = 86_400_000;
const statsDay = (t: number) => Math.floor((t + 9 * 3_600_000) / DAY);

type User = Awaited<ReturnType<typeof newUser>>;
type Save = Omit<SettingsSave, 'user'> & { user?: string };

async function load(u: User, q = ''): Promise<SettingsDto> {
  const r = await u.client.get(`/api/me/settings${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const save = (u: User, body: Save) => u.client.req('PUT', '/api/me/settings', { user: u.me.id, ...body });
async function saved(u: User, body: Save): Promise<SettingsSaveResult> {
  const r = await save(u, body);
  expect(r.status, `${JSON.stringify(body)} ${JSON.stringify(r.body)}`).toBe(200);
  return r.body;
}

/** Re-confirms the password unless the window is still open (re-confirmation is rate limited per account). */
async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
/** A new member made a plain administrator in D1, signed in to the console (not re-confirmed yet). */
async function plainAdmin() {
  const u = await newUser();
  await d1(promoteSql(`id = '${u.me.id}'`));
  const c = new Client(ADMIN_ORIGIN);
  expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
  return { ...u, c };
}

async function diag(id: string, c: Client = admin): Promise<AdminSettingsDiagDto> {
  const r = await c.get(`/api/admin/users/${id}/settings`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const act = (kind: 'reset' | 'restore', id: string, body: Record<string, unknown>, c: Client = admin) => c.post(`/api/admin/users/${id}/settings/${kind}`, body);
async function done(kind: 'reset' | 'restore', id: string, rev: number, c: Client = admin) {
  await reauth(c);
  const r = await act(kind, id, { reason: `${kind} for a sync problem`, rev }, c);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { ok: true; settings: AdminSettingsDiagDto; muck: { tables: number; reached: number } | null };
}

type Audit = { action: string; outcome: string; actor: string; detail: string | null };
const audits = (target: string) =>
  d1<Audit>(`SELECT action, outcome, actor_id AS actor, detail FROM admin_audit_log WHERE target_id = '${target}' AND action GLOB 'settings.*' ORDER BY created_at, rowid`);
const messages = async (u: User) => ((await u.client.get('/api/messages')).body as { category: string; title: string; body: string }[]).filter((m) => /설정|settings/.test(m.title));

const METRICS = ['ss_save', 'ss_legacy', 'ss_conflict', 'ss_stale', 'ss_epoch', 'ss_fail_invalid', 'ss_fail_limit', 'ss_fail_busy', 'ss_fail_error', 'ss_load_fail', 'ss_client_fail', 'ss_reset', 'ss_restore'];
async function counters() {
  const rows = await d1<{ metric: string; n: number }>(`SELECT metric, n FROM daily_stats WHERE day = ${statsDay(Date.now())} AND metric GLOB 'ss_*'`);
  return new Map(rows.map((r) => [r.metric, r.n]));
}
/** Only the counters that moved. */
async function moved(before: Map<string, number>) {
  const after = await counters();
  return Object.fromEntries(METRICS.map((m) => [m, (after.get(m) ?? 0) - (before.get(m) ?? 0)]).filter(([, n]) => n !== 0));
}

/** Fills `key`'s rate-limit window, away from the window's end so the next request falls in it. */
async function fillWindow(key: string, limit: number) {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5_000) await new Promise((r) => setTimeout(r, left + 100));
  const start = Date.now() - (Date.now() % 60_000);
  await d1(`INSERT INTO rate_limits (key, window_start, count) VALUES ('${key}', ${start}, ${limit}) ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`);
}

describe('member settings', () => {
  it('answers the defaults before the first save, and dates a change by the server clock', async () => {
    const u = await newUser();
    expect(await load(u)).toEqual({ epoch: 0, rev: 0, prefs: {}, fav: [], updatedAt: null });
    const before = await counters();
    const t0 = Date.now();
    const r = await saved(u, { epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 }, fourColor: { v: true, ago: 1_000 } }, fav: [{ id: 'set-a', on: true, ago: 0 }] });
    expect(r).toMatchObject({ kept: [], settings: { epoch: 0, rev: 1, prefs: { theme: 'crimson', fourColor: true }, fav: ['set-a'] } });
    expect(r.settings.updatedAt).toBeGreaterThanOrEqual(t0 - 1_000);
    expect(r.settings.updatedAt).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(await load(u)).toEqual(r.settings);
    // The same values again change nothing.
    expect((await saved(u, { epoch: 0, base: 1, prefs: { theme: { v: 'crimson', ago: 0 } }, fav: [{ id: 'set-a', on: true, ago: 0 }] })).settings.rev).toBe(1);
    expect(await moved(before)).toEqual({ ss_save: 1 });
  });

  it('merges two devices one setting at a time: the newer change wins and the older one is named as kept', async () => {
    const u = await newUser();
    await saved(u, { epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 } }, fav: [{ id: 't1', on: true, ago: 0 }] });
    const before = await counters();
    // The other device, still at revision 0: its theme was chosen a minute ago (before the first device's), its deck now.
    const b = await saved(u, { epoch: 0, base: 0, prefs: { theme: { v: 'emerald', ago: 60_000 }, fourColor: { v: true, ago: 0 } } });
    expect(b.kept).toEqual(['theme']);
    expect(b.settings).toMatchObject({ rev: 2, prefs: { theme: 'crimson', fourColor: true } });
    expect(await moved(before)).toEqual({ ss_save: 1, ss_conflict: 1, ss_stale: 1 });
    // Chosen again now, it wins.
    expect((await saved(u, { epoch: 0, base: 0, prefs: { theme: { v: 'sapphire', ago: 0 } } })).settings.prefs.theme).toBe('sapphire');
    // Favourites the same way: an older removal is kept out, a newer one takes the table off.
    const old = await saved(u, { epoch: 0, base: 0, fav: [{ id: 't1', on: false, ago: 30_000 }, { id: 't2', on: true, ago: 0 }] });
    expect(old.kept).toEqual(['fav:t1']);
    expect(old.settings.fav).toEqual(['t2', 't1']);
    expect((await saved(u, { epoch: 0, base: old.settings.rev, fav: [{ id: 't1', on: false, ago: 0 }] })).settings.fav).toEqual(['t2']);
  });

  it('fills only what the account has nothing for from a device’s settings before sync, and never over a real change', async () => {
    const u = await newUser();
    await saved(u, { epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 } }, fav: [{ id: 'mine', on: true, ago: 0 }] });
    const before = await counters();
    const r = await saved(u, { epoch: 0, base: 1, legacy: { prefs: { theme: 'emerald', beginner: true }, fav: ['old1', 'old2', 'mine'] } });
    expect(r.settings.prefs).toEqual({ theme: 'crimson', beginner: true });
    expect(r.settings.fav).toEqual(['mine', 'old1', 'old2']);
    expect(await moved(before)).toEqual({ ss_save: 1, ss_legacy: 1 });
    // Turned off on purpose, then a second device brings its old settings: the choice stays.
    await saved(u, { epoch: 0, base: 2, prefs: { beginner: { v: false, ago: 0 } } });
    const again = await saved(u, { epoch: 0, base: 3, legacy: { prefs: { beginner: true, amountUnit: 'bb' } } });
    expect(again.settings.prefs).toEqual({ theme: 'crimson', beginner: false, amountUnit: 'bb' });
  });

  it(`keeps at most ${SETTINGS_FAV_MAX} favourite tables, the newest`, async () => {
    const u = await newUser();
    const fav = Array.from({ length: SETTINGS_FAV_MAX + 10 }, (_, i) => ({ id: `cap-${i}`, on: true, ago: i * 1_000 }));
    const r = await saved(u, { epoch: 0, base: 0, fav });
    expect(r.settings.fav).toEqual(fav.slice(0, SETTINGS_FAV_MAX).map((f) => f.id));
  });

  it('refuses another account’s changes, malformed ones and too many, and counts each, with a device’s failed attempts', async () => {
    const u = await newUser();
    const other = await newUser();
    const before = await counters();
    // The device signed in to another account meanwhile (another tab): nothing reaches this one.
    const wrong = await save(u, { user: other.me.id, epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 } } });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('settings_account');
    expect((await u.client.get(`/api/me/settings?for=${other.me.id}`)).body.error.code).toBe('settings_account');
    await load(u, `?for=${u.me.id}`);
    expect((await load(other)).rev).toBe(0);
    for (const body of [{ epoch: 0, base: 0, prefs: { theme: { v: 'neon', ago: 0 } } }, { epoch: 0, base: 0, prefs: { sound: { v: true, ago: 0 } } }, { epoch: 0, base: 0, fav: [{ id: '', on: true, ago: 0 }] }]) {
      const r = await save(u, body as Save);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('bad_request');
    }
    expect((await load(u)).rev).toBe(0);
    // Signed out: no account to save to.
    expect((await new Client().req('PUT', '/api/me/settings', { user: u.me.id, epoch: 0, base: 0 })).status).toBe(401);
    // Failed attempts on the device are counted with the next request that goes through.
    await saved(u, { epoch: 0, base: 0, prefs: { reactions: { v: false, ago: 0 } }, fails: 2 });
    await fillWindow(`settings:${u.me.id}`, 60);
    const limited = await save(u, { epoch: 0, base: 1, prefs: { reactions: { v: true, ago: 0 } } });
    expect(limited.status).toBe(429);
    expect(await moved(before)).toEqual({ ss_fail_invalid: 4, ss_save: 1, ss_client_fail: 2, ss_fail_limit: 1 });
    // On a read, they are counted after the answer.
    const read = await counters();
    await load(other, '?fails=3');
    for (let i = 0; i < 30 && !(await moved(read)).ss_client_fail; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await moved(read)).toEqual({ ss_client_fail: 3 });
  });

  it('gives the tables the member sits at the auto-muck saved from any device', async () => {
    const u = await newUser();
    const ws = await TableSocket.open(u.client, 'it-set-0');
    open.push(ws);
    expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    expect(ws.state!.you.autoMuck).toBe(false);
    const on = await saved(u, { epoch: 0, base: 0, prefs: { autoMuck: { v: true, ago: 0 } } });
    await ws.waitState((s) => s.you.autoMuck === true, 10_000, 'auto-muck on');
    await saved(u, { epoch: 0, base: on.settings.rev, prefs: { autoMuck: { v: false, ago: 0 } } });
    await ws.waitState((s) => s.you.autoMuck === false, 10_000, 'auto-muck off');
    const again = await saved(u, { epoch: 0, base: on.settings.rev + 1, prefs: { autoMuck: { v: true, ago: 0 } } });
    await ws.waitState((s) => s.you.autoMuck === true, 10_000, 'auto-muck on again');

    // An administrator's reset puts it back to the default (off) at the table too; the preview names the table.
    const pv = await act('reset', u.me.id, { preview: true, rev: again.settings.rev });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ preview: true, seatedTables: 1 });
    const r = await done('reset', u.me.id, again.settings.rev);
    expect(r.muck).toEqual({ tables: 1, reached: 1 });
    await ws.waitState((s) => s.you.autoMuck === false, 10_000, 'auto-muck reset');
    // Undone: back on.
    const back = await done('restore', u.me.id, r.settings.rev);
    expect(back.muck).toEqual({ tables: 1, reached: 1 });
    await ws.waitState((s) => s.you.autoMuck === true, 10_000, 'auto-muck restored');
  });

  it('keeps the newest auto-muck at the table when saves follow each other faster than they reach it', async () => {
    const u = await newUser();
    const ws = await TableSocket.open(u.client, 'it-set-1');
    open.push(ws);
    expect(await ws.request({ t: 'sit', seatIndex: 0, buyIn: 1000 })).toMatchObject({ t: 'ack' });
    // Each save answers before its push reaches the room (the push runs after the answer), so these pushes overlap and
    // may land in any order; the room keeps the value of the highest revision (on).
    let rev = 0;
    for (const v of [true, false, true, false, true, false, true]) {
      const r = await saved(u, { epoch: 0, base: rev, prefs: { autoMuck: { v, ago: 0 } } });
      expect(r.kept).toEqual([]);
      rev = r.settings.rev;
    }
    expect(rev).toBe(7);
    await ws.waitState((s) => s.you.autoMuck === true, 10_000, 'auto-muck on');
    // No late push turns it back.
    await new Promise((r) => setTimeout(r, 1500));
    expect(ws.state!.you.autoMuck).toBe(true);
  });
});

describe('administrator reset and restore', () => {
  it('shows what diagnosing needs, never a value', async () => {
    const u = await newUser();
    const fresh = await diag(u.me.id);
    expect(fresh).toMatchObject({ exists: false, rev: 0, epoch: 0, schemaVersion: null, fields: 0, favourites: 0, updatedAt: null, syncedAt: null, reset: null });
    const tag = `diag-${u.me.id.slice(0, 8)}`;
    await saved(u, { epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 }, amountUnit: { v: 'bb', ago: 0 } }, fav: [{ id: tag, on: true, ago: 0 }] });
    const d = await diag(u.me.id);
    expect(d).toMatchObject({ member: { nickname: u.me.nickname, role: 'user', status: 'active' }, exists: true, rev: 1, epoch: 0, schemaVersion: 1, fields: 2, favourites: 1, reset: null });
    expect(d.updatedAt).toEqual(expect.any(Number));
    expect(d.syncedAt).toEqual(expect.any(Number));
    const json = JSON.stringify(d);
    for (const value of ['crimson', tag, 'amountUnit', 'theme']) expect(json).not.toContain(value);
    expect((await admin.get('/api/admin/users/nobody-here/settings')).status).toBe(404);
  });

  it('resets after a preview, the password and a reason; old devices cannot upload again; the member is told once in Korean', async () => {
    const staff = await plainAdmin();
    const u = await newUser();
    await saved(u, { epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 } }, fav: [{ id: 'r1', on: true, ago: 0 }] });
    const before = await counters();

    // The preview names the scope without the password and changes nothing.
    const pv = await act('reset', u.me.id, { preview: true, rev: 1 }, staff.c);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ preview: true, settings: { rev: 1, fields: 1, favourites: 1 }, seatedTables: 0, restorableMs: SETTINGS_RESTORE_MS });
    expect((await diag(u.me.id)).rev).toBe(1);
    // The change needs the password, a reason and the revision looked at.
    const cold = await act('reset', u.me.id, { reason: 'theme loop on login', rev: 1 }, staff.c);
    expect(cold.status).toBe(401);
    expect(cold.body.error.code).toBe('reauth_required');
    await reauth(staff.c);
    for (const body of [{ rev: 1 }, { reason: 'x', rev: 1 }, { reason: 'theme loop on login' }]) expect((await act('reset', u.me.id, body, staff.c)).status, JSON.stringify(body)).toBe(400);
    const stale = await act('reset', u.me.id, { reason: 'theme loop on login', rev: 0 }, staff.c);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'settings_changed', details: { settings: { rev: 1 } } });
    expect(await messages(u)).toEqual([]);

    const t0 = Date.now();
    const r = await act('reset', u.me.id, { reason: 'theme loop on login', rev: 1 }, staff.c);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, muck: null, settings: { exists: true, rev: 2, epoch: 1, fields: 0, favourites: 0, reset: { by: { id: staff.me.id }, restoredAt: null } } });
    expect(r.body.settings.reset.restorableUntil).toBeGreaterThanOrEqual(t0 + SETTINGS_RESTORE_MS - 1_000);
    expect(await load(u)).toMatchObject({ epoch: 1, rev: 2, prefs: {}, fav: [] });

    // A device that still has epoch 0 is refused with the account's settings, and its old settings are never taken again.
    const old = await save(u, { epoch: 0, base: 1, prefs: { theme: { v: 'emerald', ago: 0 } }, legacy: { prefs: { fourColor: true }, fav: ['r1'] } });
    expect(old.status).toBe(409);
    expect(old.body.error).toMatchObject({ code: 'settings_reset', details: { settings: { epoch: 1, rev: 2, prefs: {}, fav: [] } } });
    const legacy = await saved(u, { epoch: 1, base: 2, legacy: { prefs: { fourColor: true }, fav: ['r1'] } });
    expect(legacy.settings).toMatchObject({ rev: 2, prefs: {}, fav: [] });

    // Nothing changed since: a second reset is refused (and tells the member nothing).
    expect((await act('reset', u.me.id, { preview: true, rev: 2 })).body.error.code).toBe('settings_already_reset');
    await reauth();
    expect((await act('reset', u.me.id, { reason: 'again please', rev: 2 })).body.error.code).toBe('settings_already_reset');

    const told = await messages(u);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ category: 'admin', title: '계정 설정 초기화 안내' });
    expect(told[0]!.body).not.toContain('theme loop');

    const rows = await audits(u.me.id);
    const ok = rows.filter((x) => x.action === 'settings.reset' && x.outcome === 'ok');
    expect(ok).toHaveLength(1);
    expect(ok[0]!.actor).toBe(staff.me.id);
    expect(JSON.parse(ok[0]!.detail!)).toEqual({
      reason: 'theme loop on login',
      before: { rev: 1, epoch: 0, fields: 1, favourites: 1 },
      after: { rev: 2, epoch: 1, fields: 0, favourites: 0 },
      restorable: true,
      muck: null,
    });
    expect(ok[0]!.detail).not.toContain('crimson');
    expect(rows.filter((x) => x.action === 'settings.reset.failed').length).toBeGreaterThanOrEqual(2);
    expect(await moved(before)).toEqual({ ss_reset: 1, ss_epoch: 1 });
  });

  it('can reset an account that never saved (stopping its devices’ old settings), told in English, with nothing to undo', async () => {
    const u = await newUser(undefined, { locale: 'en' });
    await reauth();
    const r = await done('reset', u.me.id, 0);
    expect(r.settings).toMatchObject({ exists: true, rev: 1, epoch: 1, reset: { restorableUntil: null } });
    expect((await saved(u, { epoch: 1, base: 1, legacy: { prefs: { fourColor: true } } })).settings.prefs).toEqual({});
    const told = await messages(u);
    expect(told.map((m) => m.title)).toEqual(['Your account settings were reset']);
    expect((await act('restore', u.me.id, { preview: true, rev: 1 })).body.error.code).toBe('settings_not_restorable');
  });

  it('restores what the reset took within a week while the member changed nothing, once', async () => {
    const u = await newUser();
    const mine = await saved(u, { epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 }, fourColor: { v: true, ago: 0 } }, fav: [{ id: 'k1', on: true, ago: 5_000 }, { id: 'k2', on: true, ago: 0 }] });
    const reset = await done('reset', u.me.id, mine.settings.rev);
    const before = await counters();
    const pv = await act('restore', u.me.id, { preview: true, rev: reset.settings.rev });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ preview: true, restore: { fields: 2, favourites: 2 }, seatedTables: 0 });
    expect((await act('restore', u.me.id, { reason: 'wrong member', rev: reset.settings.rev - 1 })).body.error.code).toBe('settings_changed');

    const r = await done('restore', u.me.id, reset.settings.rev);
    expect(r.settings).toMatchObject({ rev: reset.settings.rev + 1, epoch: 2, fields: 2, favourites: 2, reset: { restorableUntil: null } });
    expect(r.settings.reset!.restoredAt).toEqual(expect.any(Number));
    const back = await load(u);
    expect(back).toMatchObject({ epoch: 2, prefs: mine.settings.prefs, fav: mine.settings.fav });
    // A device still at the reset's epoch takes them on.
    expect((await save(u, { epoch: 1, base: reset.settings.rev, prefs: { beginner: { v: true, ago: 0 } } })).body.error.code).toBe('settings_reset');
    // Once only.
    expect((await act('restore', u.me.id, { preview: true, rev: r.settings.rev })).body.error.code).toBe('settings_not_restorable');

    expect((await messages(u)).map((m) => m.title).sort()).toEqual(['계정 설정 복구 안내', '계정 설정 초기화 안내']);
    const row = (await audits(u.me.id)).find((x) => x.action === 'settings.restore' && x.outcome === 'ok')!;
    expect(JSON.parse(row.detail!)).toMatchObject({
      reason: 'restore for a sync problem',
      before: { rev: reset.settings.rev, epoch: 1, fields: 0, favourites: 0 },
      after: { rev: r.settings.rev, epoch: 2, fields: 2, favourites: 2 },
      muck: null,
    });
    expect(row.detail).not.toContain('crimson');
    expect(await moved(before)).toEqual({ ss_restore: 1, ss_epoch: 1 });
  });

  it('cannot undo a reset once the member changed something since, or after a week', async () => {
    const changed = await newUser();
    const a = await saved(changed, { epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 } } });
    const ra = await done('reset', changed.me.id, a.settings.rev);
    await saved(changed, { epoch: 1, base: ra.settings.rev, prefs: { beginner: { v: true, ago: 0 } } });
    const d = await diag(changed.me.id);
    expect(d.reset).toMatchObject({ restorableUntil: null, restoredAt: null });
    expect((await act('restore', changed.me.id, { preview: true, rev: d.rev })).body.error.code).toBe('settings_not_restorable');
    // Changed since: it can be reset again.
    expect((await act('reset', changed.me.id, { preview: true, rev: d.rev })).status).toBe(200);

    const late = await newUser();
    const b = await saved(late, { epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 } } });
    const rb = await done('reset', late.me.id, b.settings.rev);
    expect((await diag(late.me.id)).reset!.restorableUntil).toEqual(expect.any(Number));
    await d1(`UPDATE user_settings SET reset_at = reset_at - ${SETTINGS_RESTORE_MS + 60_000} WHERE user_id = '${late.me.id}'`);
    expect((await diag(late.me.id)).reset!.restorableUntil).toBeNull();
    await reauth();
    expect((await act('restore', late.me.id, { reason: 'too late now', rev: rb.settings.rev })).body.error.code).toBe('settings_not_restorable');
  });

  it('refuses one’s own account, table bots, withdrawn members, and administrators to a plain administrator', async () => {
    const staff = await plainAdmin();
    const other = await plainAdmin();
    const selfId = (await admin.get('/api/admin/auth/me')).body.user.id as string;
    const self = await act('reset', selfId, { preview: true, rev: 0 });
    expect(self.status).toBe(400);

    const bot = await newUser();
    await d1(`UPDATE users SET is_bot = 1 WHERE id = '${bot.me.id}'`);
    try {
      const r = await act('reset', bot.me.id, { preview: true, rev: 0 });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('bot_account');
    } finally {
      await d1(`UPDATE users SET is_bot = 0 WHERE id = '${bot.me.id}'`);
    }

    // Another administrator's settings: a super admin only.
    const refused = await act('reset', other.me.id, { preview: true, rev: 0 }, staff.c);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'forbidden', message: 'only a super admin can reset or restore the settings of administrators' });
    expect((await act('reset', other.me.id, { preview: true, rev: 0 })).status).toBe(200);
    // A plain administrator may diagnose and reset a member.
    expect((await diag(bot.me.id, staff.c)).exists).toBe(false);
    expect((await act('reset', bot.me.id, { preview: true, rev: 0 }, staff.c)).status).toBe(200);
    const failed = (await audits(other.me.id)).filter((x) => x.action === 'settings.reset.failed');
    expect(failed.map((x) => [x.actor, x.outcome])).toContainEqual([staff.me.id, 'failed']);

    // Withdrawn: the settings go with the account, and there is nothing to reset.
    const gone = await newUser();
    await saved(gone, { epoch: 0, base: 0, prefs: { theme: { v: 'crimson', ago: 0 } }, fav: [{ id: 'g1', on: true, ago: 0 }] });
    expect((await d1(`SELECT user_id FROM user_settings WHERE user_id = '${gone.me.id}'`)).length).toBe(1);
    expect((await gone.client.post('/api/auth/me/delete', { password: PASSWORD })).status).toBe(200);
    expect(await d1(`SELECT user_id FROM user_settings WHERE user_id = '${gone.me.id}'`)).toEqual([]);
    expect((await act('reset', gone.me.id, { preview: true, rev: 0 })).status).toBe(404);
  });
});

describe('operations statistics', () => {
  it('show the settings counters of each finished day, kept when days are rolled up again', async () => {
    const yesterday = statsDay(Date.now()) - 1;
    const read = async () => new Map((await d1<{ metric: string; n: number }>(`SELECT metric, n FROM daily_stats WHERE day = ${yesterday} AND metric GLOB 'ss_*'`)).map((r) => [r.metric, r.n]));
    const seeded = { ss_save: 5, ss_conflict: 2, ss_fail_busy: 1, ss_reset: 1 };
    const add = (sign: 1 | -1) =>
      d1(
        Object.entries(seeded)
          .map(([m, n]) => `INSERT INTO daily_stats (day, metric, n) VALUES (${yesterday}, '${m}', ${sign * n}) ON CONFLICT (day, metric) DO UPDATE SET n = n + ${sign * n}`)
          .join('; '),
      );
    await add(1);
    const kept = await read();
    try {
      await d1(`INSERT INTO daily_stats (day, metric, n) VALUES (0, 'rolled_through', ${yesterday - 1}) ON CONFLICT (day, metric) DO UPDATE SET n = excluded.n`);
      const r = await admin.get('/api/admin/stats?unit=day&n=1');
      expect(r.status).toBe(200);
      expect(r.body.rolled).toMatchObject({ days: 1 });
      expect(await read()).toEqual(kept);
      expect(Object.keys(r.body.total.settings).sort()).toEqual([...METRICS].sort());
      for (const m of METRICS) expect(r.body.periods[0].settings[m], m).toBe(kept.get(m) ?? 0);
    } finally {
      await add(-1);
      await d1(`DELETE FROM daily_stats WHERE day = ${yesterday} AND metric GLOB 'ss_*' AND n = 0`);
    }
  });
});
