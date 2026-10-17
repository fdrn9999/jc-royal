// Free chip refill: paid once whatever the number of tabs or retries, the chips on the member's tables counted (a hand's
// bets included), held while a seat cannot be confirmed, a policy change that leaves running waits alone, the emergency
// pause, who may change what, the admin views and a mistaken refill taken back with a linked adjustment.
import { afterAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin } from '../support/client';
import { d1 } from '../support/d1';
import { TableSocket } from '../support/ws';
import { promoteSql } from '../support/grants';

const ADMIN_ORIGIN = 'http://localhost:5174';
const admin = sharedAdmin();
/** The policy migration 0020 seeds, put back after this file. */
const SEED = { enabled: true, below: 1000, amount: 2000, cooldownMs: 21_600_000 };

interface Policy { version: number; enabled: boolean; paused: boolean; below: number; amount: number; cooldownMs: number }
interface Status { policy: Policy | null; wallet: number; tables: number | null; eligible: boolean; reason: string | null; hold: string | null; nextAt: number | null; received: number; now: number }
type Member = Awaited<ReturnType<typeof newUser>>;

async function reauth(c: Client = admin) {
  const until = (await c.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  const r = await c.post('/api/admin/auth/reauth', { password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

let plain: Promise<{ c: Client; id: string }> | null = null;
function plainAdmin() {
  plain ??= (async () => {
    const u = await newUser();
    await d1(promoteSql(`id = '${u.me.id}'`));
    const c = new Client(ADMIN_ORIGIN);
    expect((await c.post('/api/admin/auth/login', { email: u.email, password: PASSWORD })).status).toBe(200);
    return { c, id: u.me.id };
  })();
  return plain;
}

const sockets: TableSocket[] = [];
afterAll(async () => {
  for (const s of sockets.splice(0)) s.close();
  // Leave the policy as the migration seeded it for the files that follow.
  await reauth();
  const p = (await admin.get('/api/admin/refill')).body.policy as Policy;
  if (p.paused) expect((await admin.post('/api/admin/refill/resume', { reason: 'refill test done' })).status).toBe(200);
  if (p.enabled !== SEED.enabled || p.below !== SEED.below || p.amount !== SEED.amount || p.cooldownMs !== SEED.cooldownMs) {
    const r = await admin.req('PUT', '/api/admin/refill/policy', { baseVersion: (await policy()).version, ...SEED, reason: 'refill test done' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});

const policy = async () => (await admin.get('/api/admin/refill')).body.policy as Policy;
async function setPolicy(change: Partial<typeof SEED>, reason = 'refill test') {
  await reauth();
  const p = await policy();
  const r = await admin.req('PUT', '/api/admin/refill/policy', { baseVersion: p.version, enabled: p.enabled, below: p.below, amount: p.amount, cooldownMs: p.cooldownMs, ...change, reason });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.policy as Policy;
}

const balance = async (id: string) => (await d1<{ balance: number }>(`SELECT balance FROM users WHERE id = '${id}'`))[0]!.balance;
const status = async (m: Member) => (await m.client.get('/api/me/refill')).body as Status;
const claim = (m: Member) => m.client.post('/api/me/refill', {});
const claims = (id: string) =>
  d1<{ id: string; seq: number; policy_version: number; amount: number; wallet: number; table_chips: number; next_at: number; created_at: number }>(
    `SELECT id, seq, policy_version, amount, wallet, table_chips, next_at, created_at FROM refill_claims WHERE user_id = '${id}' ORDER BY seq`,
  );
const refillRows = (id: string) => d1<{ id: string; amount: number; balance_after: number }>(`SELECT id, amount, balance_after FROM chip_ledger WHERE user_id = '${id}' AND type = 'free_refill'`);
const audits = (action: string) => d1<{ actor_id: string; detail: string }>(`SELECT actor_id, detail FROM admin_audit_log WHERE action = '${action}' ORDER BY created_at`);

/** Brings the wallet to `to` with a recorded adjustment (the books stay balanced). */
async function setWallet(m: Member, to: number) {
  await reauth();
  const now = await balance(m.me.id);
  if (now === to) return;
  const r = await admin.post(`/api/admin/users/${m.me.id}/chips`, { amount: to - now, memo: 'refill test', idempotencyKey: `rf-${crypto.randomUUID()}` });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(await balance(m.me.id)).toBe(to);
}

async function sit(m: Member, tableId: string, seatIndex: number, buyIn: number) {
  const ws = await TableSocket.open(m.client, tableId);
  sockets.push(ws);
  const r = await ws.request({ t: 'sit', seatIndex, buyIn });
  expect(r, JSON.stringify(r)).toMatchObject({ t: 'ack' });
  await ws.waitState((s) => s.you.seatIndex === seatIndex);
  return ws;
}

describe('free chip refill', () => {
  it('pays exactly once when several tabs claim at the same moment, and a retry pays nothing more', async () => {
    const m = await newUser();
    await setWallet(m, 500);
    const before = await status(m);
    expect(before).toMatchObject({ eligible: true, wallet: 500, tables: 0, reason: null, hold: null, received: 0, nextAt: null });
    const p = before.policy!;

    const rs = await Promise.all(Array.from({ length: 6 }, () => claim(m)));
    const paid = rs.filter((r) => r.status === 200 && r.body.duplicate === false);
    expect(paid, JSON.stringify(rs.map((r) => [r.status, r.body]))).toHaveLength(1);
    for (const r of rs) {
      if (r === paid[0]) continue;
      // The same claim seen again, or one decided after it: told to wait (or that the chips changed), never paid.
      if (r.status === 200) expect(r.body.duplicate).toBe(true);
      else expect(['refill_refused', 'refill_changed'], JSON.stringify(r.body)).toContain(r.body.error.code);
    }
    expect(paid[0]!.body).toMatchObject({ amount: p.amount, balance: 500 + p.amount });
    expect(await balance(m.me.id)).toBe(500 + p.amount);
    expect(await refillRows(m.me.id)).toHaveLength(1);
    const [row] = await claims(m.me.id);
    expect(row).toMatchObject({ seq: 1, policy_version: p.version, amount: p.amount, wallet: 500, table_chips: 0 });
    expect(row!.next_at - row!.created_at).toBe(p.cooldownMs);
    expect(row!.id).toBe((await refillRows(m.me.id))[0]!.id);

    // A retry later is told when the next one comes.
    const again = await claim(m);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('refill_refused');
    expect(again.body.error.details.status).toMatchObject({ reason: 'cooldown', nextAt: row!.next_at, received: 1 });
    expect(await balance(m.me.id)).toBe(500 + p.amount);
    expect(await status(m)).toMatchObject({ eligible: false, reason: 'cooldown', nextAt: row!.next_at, received: 1 });
  });

  it('counts the chips on the member\'s tables, a hand\'s bets included, and holds while a seat cannot be confirmed', async () => {
    const [m, other] = await Promise.all([newUser(), newUser()]);
    const ws = await sit(m, 'it-refill-0', 0, 100);
    await setWallet(m, 950);
    // 950 in the wallet and 100 on the table: at the line.
    expect(await status(m)).toMatchObject({ eligible: false, reason: 'above', wallet: 950, tables: 100 });
    expect((await claim(m)).body.error.details.status).toMatchObject({ reason: 'above', tables: 100 });

    // A hand starts: the blind is in the pot, and still counts as the member's chips.
    await sit(other, 'it-refill-0', 1, 100);
    const live = await ws.waitState((s) => !!s.hand && s.hand.stage !== 'settled', 20_000, 'hand dealt');
    const mine = live.seats.find((s) => s.userId === m.me.id)!;
    expect(mine.streetBet).toBeGreaterThan(0);
    expect(mine.stack + mine.streetBet).toBe(100);
    expect(await status(m)).toMatchObject({ reason: 'above', tables: 100 });

    await setWallet(m, 850);
    const st = await status(m);
    expect(st).toMatchObject({ eligible: true, wallet: 850, tables: 100 });
    const r = await claim(m);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await claims(m.me.id))[0]).toMatchObject({ wallet: 850, table_chips: 100 });

    // A seat D1 has open that the table does not hold: nothing is paid until it is sorted out.
    const h = await newUser();
    await setWallet(h, 300);
    const sess = `rf-${crypto.randomUUID()}`;
    await d1(`INSERT INTO table_sessions (id, table_id, user_id, seat_index, buy_in, status) VALUES ('${sess}', 'it-refill-1', '${h.me.id}', 0, 100, 'seated')`);
    try {
      expect(await status(h)).toMatchObject({ eligible: false, reason: 'held', hold: 'mismatch', tables: null });
      const held = await claim(h);
      expect(held.status).toBe(409);
      expect(held.body.error.details.status).toMatchObject({ reason: 'held', hold: 'mismatch' });
      expect(await balance(h.me.id)).toBe(300);
      expect(await claims(h.me.id)).toHaveLength(0);
    } finally {
      await d1(`UPDATE table_sessions SET status = 'closed', closed_at = ${Date.now()} WHERE id = '${sess}'`);
    }
    expect(await status(h)).toMatchObject({ eligible: true, tables: 0 });
  });

  it('counts the chips on two tables together; a claim asks both twice and pays on what they held at one moment', async () => {
    const m = await newUser();
    await sit(m, 'it-refill-2', 0, 100);
    await sit(m, 'it-refill-3', 0, 150);
    const { below } = (await status(m)).policy!;
    // Wallet and both tables together at the line: nothing to pay.
    await setWallet(m, below - 250);
    expect(await status(m)).toMatchObject({ eligible: false, reason: 'above', tables: 250 });
    expect((await claim(m)).body.error.details.status).toMatchObject({ reason: 'above', tables: 250 });
    // Below it: the tables answer the same twice (no hand runs at either), so the claim pays once on that total.
    await setWallet(m, below - 300);
    expect(await status(m)).toMatchObject({ eligible: true, wallet: below - 300, tables: 250 });
    const r = await claim(m);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await claims(m.me.id)).toEqual([expect.objectContaining({ seq: 1, wallet: below - 300, table_chips: 250 })]);
    expect(await balance(m.me.id)).toBe(below - 300 + r.body.amount);
  });

  it('applies a policy change to the next claim only: a running wait keeps its time and each refill names its version', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    await setWallet(a, 500);
    const first = await claim(a);
    expect(first.status).toBe(200);
    const v1 = (await status(a)).policy!;

    // The preview shows old and new values and writes nothing.
    await reauth();
    const auditsBefore = (await audits('refill.policy')).length;
    const pv = await admin.req('PUT', '/api/admin/refill/policy', { preview: true, baseVersion: v1.version, enabled: true, below: v1.below, amount: 1500, cooldownMs: 600_000 });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ preview: true, from: { version: v1.version, amount: v1.amount }, to: { version: v1.version + 1, amount: 1500, cooldownMs: 600_000 }, appliesFrom: 'next_claim' });
    expect(pv.body.runningWaits).toBeGreaterThanOrEqual(1);
    expect((await policy()).version).toBe(v1.version);
    expect(await audits('refill.policy')).toHaveLength(auditsBefore);

    // The same values again is not a change.
    const same = await admin.req('PUT', '/api/admin/refill/policy', { baseVersion: v1.version, enabled: v1.enabled, below: v1.below, amount: v1.amount, cooldownMs: v1.cooldownMs, reason: 'no change' });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('refill_no_change');

    const v2 = await setPolicy({ amount: 1500, cooldownMs: 600_000 }, 'shorter wait for the test');
    expect(v2.version).toBe(v1.version + 1);
    const [log] = (await audits('refill.policy')).slice(-1);
    expect(JSON.parse(log!.detail)).toMatchObject({ from: { amount: v1.amount }, to: { amount: 1500 }, reason: 'shorter wait for the test' });

    // a's wait is the one it was given.
    expect(await status(a)).toMatchObject({ reason: 'cooldown', nextAt: first.body.nextAt, policy: { version: v2.version } });
    // b's refill is paid under the new version.
    await setWallet(b, 500);
    const t = Date.now();
    const rb = await claim(b);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rb.body.amount).toBe(1500);
    const [cb] = await claims(b.me.id);
    expect(cb).toMatchObject({ policy_version: v2.version, amount: 1500 });
    expect(cb!.next_at - cb!.created_at).toBe(600_000);
    expect(cb!.created_at).toBeGreaterThanOrEqual(t - 5_000);
    expect((await claims(a.me.id))[0]!.policy_version).toBe(v1.version);

    // Two administrators editing from the same version: one change goes in, the other is shown the newer policy.
    await reauth();
    const both = await Promise.all(
      [1200, 1300].map((amount) => admin.req('PUT', '/api/admin/refill/policy', { baseVersion: v2.version, enabled: true, below: v2.below, amount, cooldownMs: v2.cooldownMs, reason: 'race' })),
    );
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const lost = both.find((r) => r.status === 409)!;
    expect(lost.body.error.code).toBe('refill_policy_conflict');
    expect(lost.body.error.details.policy.version).toBe(v2.version + 1);
    expect((await policy()).version).toBe(v2.version + 1);

    await setPolicy(SEED, 'back to the seed');
  });

  it('pauses new refills only; a plain administrator may pause but neither resume nor change the policy', async () => {
    const m = await newUser();
    await setWallet(m, 500);
    const { c: pa, id: paId } = await plainAdmin();
    const p = await policy();

    expect((await pa.get('/api/admin/refill')).status).toBe(200);
    const change = { baseVersion: p.version, enabled: true, below: p.below, amount: 1234, cooldownMs: p.cooldownMs, reason: 'not mine to change' };
    expect((await pa.req('PUT', '/api/admin/refill/policy', change)).status).toBe(403);
    expect((await pa.req('PUT', '/api/admin/refill/policy', { ...change, preview: true })).status).toBe(403);
    // The password first.
    const noPw = await pa.post('/api/admin/refill/pause', { reason: 'abuse wave' });
    expect(noPw.status).toBe(401);
    expect(noPw.body.error.code).toBe('reauth_required');
    await reauth(pa);
    const paused = await pa.post('/api/admin/refill/pause', { reason: 'abuse wave' });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.policy).toMatchObject({ version: p.version + 1, paused: true, amount: p.amount });
    expect((await pa.post('/api/admin/refill/pause', { reason: 'again' })).body.error.code).toBe('refill_already_paused');
    const [log] = (await audits('refill.pause')).slice(-1);
    expect(log!.actor_id).toBe(paId);
    expect(JSON.parse(log!.detail)).toMatchObject({ reason: 'abuse wave', version: p.version + 1 });

    const refused = await claim(m);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.status).toMatchObject({ reason: 'paused' });
    expect(await balance(m.me.id)).toBe(500);

    expect((await pa.post('/api/admin/refill/resume', { reason: 'over' })).status).toBe(403);
    await reauth();
    expect((await admin.post('/api/admin/refill/resume', { reason: 'wave over' })).status).toBe(200);
    expect((await admin.post('/api/admin/refill/resume', { reason: 'again' })).body.error.code).toBe('refill_not_paused');
    expect((await claim(m)).status).toBe(200);
    expect(await balance(m.me.id)).toBe(500 + p.amount);
  });

  it('shows refills apart in the economy, lists them, and takes a mistaken one back with an adjustment naming it', async () => {
    const [m, other] = await Promise.all([newUser(), newUser()]);
    await setWallet(m, 400);
    await setWallet(other, 400);
    const eco = async () => (await admin.get('/api/admin/economy?days=7&tz=540')).body.issued as { refill: number; total: number; signup: number; admin: number; reconcile: number; bots: number; referral: number };
    const before = await eco();
    const r = await claim(m);
    expect(r.status).toBe(200);
    expect((await claim(other)).status).toBe(200);
    const after = await eco();
    expect(after.refill - before.refill).toBe(2 * r.body.amount);
    // The total also counts what the table bots' fund and referral rewards issued (bots.test.ts and referral.test.ts, when
    // they ran first in this database).
    expect(after.total).toBe(after.signup + after.admin + after.reconcile + after.refill + after.bots + after.referral);

    const [row] = await claims(m.me.id);
    const list = await admin.get(`/api/admin/refill/claims?user=${m.me.id}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([expect.objectContaining({ id: row!.id, seq: 1, policyVersion: row!.policy_version, amount: r.body.amount, wallet: 400, tableChips: 0 })]);
    expect((await admin.get('/api/admin/refill/claims?limit=1')).body).toMatchObject({ limit: 1, hasMore: true });

    const stats = await admin.get('/api/admin/refill/stats?days=1');
    expect(stats.status).toBe(200);
    expect(stats.body.totals.n).toBeGreaterThanOrEqual(2);
    expect(stats.body.series).toHaveLength(1);
    // Claims refused earlier in this file are counted by reason.
    for (const k of ['cooldown', 'above', 'held', 'paused']) expect(stats.body.refused[k], k).toBeGreaterThanOrEqual(1);
    expect((await admin.get('/api/admin/refill/stats?days=0')).status).toBe(400);

    // Taken back: an adjustment naming the refill, shown with it on the member's page.
    await reauth();
    const bad = await admin.post(`/api/admin/users/${m.me.id}/chips`, { amount: -r.body.amount, memo: 'paid by mistake', idempotencyKey: `rf-${crypto.randomUUID()}`, refLedgerId: `missing-${crypto.randomUUID()}` });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('ref_not_found');
    const foreign = (await claims(other.me.id))[0]!.id;
    expect((await admin.post(`/api/admin/users/${m.me.id}/chips`, { amount: -r.body.amount, memo: 'paid by mistake', idempotencyKey: `rf-${crypto.randomUUID()}`, refLedgerId: foreign })).body.error.code).toBe('ref_not_found');
    const pv = await admin.post(`/api/admin/users/${m.me.id}/chips`, { preview: true, amount: -r.body.amount, memo: 'paid by mistake', idempotencyKey: `rf-${crypto.randomUUID()}`, refLedgerId: row!.id });
    expect(pv.body.ref).toMatchObject({ id: row!.id, type: 'free_refill', amount: r.body.amount });
    const fix = await admin.post(`/api/admin/users/${m.me.id}/chips`, { amount: -r.body.amount, memo: 'paid by mistake', idempotencyKey: `rf-${crypto.randomUUID()}`, refLedgerId: row!.id });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    expect(await balance(m.me.id)).toBe(400);
    // The refill itself is untouched.
    expect(await refillRows(m.me.id)).toEqual([expect.objectContaining({ id: row!.id, amount: r.body.amount })]);
    const [adj] = await d1<{ ref_id: string }>(`SELECT ref_id FROM chip_ledger WHERE user_id = '${m.me.id}' AND type = 'admin_adjust' AND memo = 'paid by mistake'`);
    expect(adj!.ref_id).toBe(row!.id);
    const [log] = await d1<{ detail: string }>(`SELECT detail FROM admin_audit_log WHERE action = 'user.chips' AND target_id = '${m.me.id}' AND detail LIKE '%paid by mistake%'`);
    expect(JSON.parse(log!.detail)).toMatchObject({ refLedgerId: row!.id, refType: 'free_refill' });

    const detail = await admin.get(`/api/admin/users/${m.me.id}/refill`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toMatchObject({ reason: 'cooldown', received: 1 });
    expect(detail.body.items).toEqual([expect.objectContaining({ id: row!.id, corrections: [expect.objectContaining({ amount: -r.body.amount })] })]);
    expect((await admin.get('/api/admin/users/nobody/refill')).status).toBe(404);
  });
});
