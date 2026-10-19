import { expect, type Page } from '@playwright/test';
import { SYNCED_PREF_KEYS } from '@jc/types';
import { ADMIN, adminLogin, sql } from './analytics-helpers';
import { PASSWORD, signUp, test } from './helpers';

/** What the server keeps for the account signed in on this page (read as that device would). */
const serverSettings = (page: Page) =>
  page.evaluate(async () => {
    const me = (await (await fetch('/api/auth/me')).json()) as { id: string };
    return (await (await fetch(`/api/me/settings?for=${me.id}`)).json()) as { epoch: number; rev: number; prefs: Record<string, unknown>; fav: string[] };
  });
const idOf = (page: Page) => page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);

async function logIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel(/^(이메일|Email)$/).fill(email);
  await page.getByLabel(/^(비밀번호|Password)$/).fill(PASSWORD);
  await page.getByRole('button', { name: /^(로그인|Log in)$/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

const openSettings = async (page: Page) => {
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-sync')).toBeVisible();
};
const closeSettings = async (page: Page) => {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-sync')).toHaveCount(0);
};
const pickTheme = (page: Page, theme: string) => page.getByRole('dialog').locator(`button[data-theme="${theme}"]`).click();
const fourColor = (page: Page) => page.getByRole('dialog').getByLabel(/^(4색 덱|Four-colour deck)$/);
const favStar = (page: Page) => page.getByTestId('lobby-table').filter({ hasText: 'E2E Lobby Fav' }).getByTestId('fav-toggle');
const look = (page: Page) => page.locator('html');

/** Makes this page's saves fail (no network) while `failing()` says so; reading still works. */
const failSaves = (page: Page, failing: () => boolean) =>
  page.route(
    (u) => u.pathname === '/api/me/settings',
    (r) => (r.request().method() === 'PUT' && failing() ? r.abort('internetdisconnected') : r.continue()),
  );

async function reauthIfAsked(page: Page) {
  const prompt = page.getByTestId('reauth-confirm');
  if (await prompt.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
    await page.getByRole('dialog').getByLabel(/비밀번호|Password/).fill(PASSWORD);
    await prompt.click();
  }
}

test('account settings: a second device keeps the account values over its own, fills only what the account lacks, keeps a change it could not save, and switching accounts never mixes them', async ({ browser }) => {
  test.setTimeout(150_000);
  // Device A: the account's look and a favourite table.
  const a = await signUp(browser);
  await openSettings(a.page);
  await pickTheme(a.page, 'crimson');
  await fourColor(a.page).check();
  await closeSettings(a.page);
  await favStar(a.page).click();
  await expect.poll(() => serverSettings(a.page)).toMatchObject({ prefs: { theme: 'crimson', fourColor: true }, fav: ['e2e-lobby-fav'] });

  // Device B had its own settings before signing in (kept on the device, as before accounts kept them).
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const b = await ctx.newPage();
  await b.goto('/login');
  await b.evaluate(() => localStorage.setItem('jc.prefs', JSON.stringify({ theme: 'emerald', fourColor: false, beginner: true })));
  await b.reload();
  await expect(look(b)).toHaveAttribute('data-theme', 'emerald');
  await logIn(b, a.email);
  // The account's values win over the device's (its default fourColor included); beginner, which the account lacked, is taken.
  await expect(look(b)).toHaveAttribute('data-theme', 'crimson');
  await expect(favStar(b)).toHaveAttribute('aria-pressed', 'true');
  await openSettings(b);
  await expect(fourColor(b)).toBeChecked();
  await expect(b.getByTestId('settings-beginner')).toBeChecked();
  await expect.poll(() => serverSettings(b)).toMatchObject({ prefs: { theme: 'crimson', fourColor: true, beginner: true }, fav: ['e2e-lobby-fav'] });
  expect(await b.evaluate(() => localStorage.getItem('jc.prefs'))).toBeNull();

  // A save that fails: the change still applies here, the line says it was not saved and offers a retry.
  let failing = true;
  await failSaves(b, () => failing);
  await pickTheme(b, 'sapphire');
  await expect(look(b)).toHaveAttribute('data-theme', 'sapphire');
  await expect(b.getByTestId('settings-sync')).toHaveAttribute('data-state', 'error');
  await expect(b.getByTestId('settings-sync-retry')).toBeVisible();
  // A reload keeps it, over the account's older value read again.
  await b.reload();
  await expect(look(b)).toHaveAttribute('data-theme', 'sapphire');
  await openSettings(b);
  await expect(b.getByTestId('settings-sync')).toHaveAttribute('data-state', 'error');
  failing = false;
  await b.getByTestId('settings-sync-retry').click();
  await expect(b.getByTestId('settings-sync')).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await serverSettings(b)).prefs.theme).toBe('sapphire');
  // Device A takes it on its next load.
  await a.page.reload();
  await expect(look(a.page)).toHaveAttribute('data-theme', 'sapphire');

  // Signing out: the defaults show, and nothing of the account stays on the device (all of it was saved).
  await b.getByTestId('settings-logout').click();
  await expect(b).toHaveURL(/\/login/);
  await expect(look(b)).toHaveAttribute('data-theme', 'royal');
  expect(await b.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('jc.settings')))).toEqual([]);

  // Another member signs in on the same device: their own (default) settings, none of A's.
  const c = await signUp(browser);
  await logIn(b, c.email);
  await expect(look(b)).toHaveAttribute('data-theme', 'royal');
  await expect(favStar(b)).toHaveAttribute('aria-pressed', 'false');
  await openSettings(b);
  await expect(fourColor(b)).not.toBeChecked();
  await expect(b.getByTestId('settings-beginner')).not.toBeChecked();
  await expect(b.getByTestId('settings-sync')).toHaveAttribute('data-state', 'saved');
  expect(await serverSettings(b)).toMatchObject({ prefs: {}, fav: [] });
  await b.getByTestId('settings-logout').click();
  await expect(b).toHaveURL(/\/login/);

  // A again: all of A's settings are back.
  await logIn(b, a.email);
  await expect(look(b)).toHaveAttribute('data-theme', 'sapphire');
  await expect(favStar(b)).toHaveAttribute('aria-pressed', 'true');
  await openSettings(b);
  await expect(fourColor(b)).toBeChecked();
  await expect(b.getByTestId('settings-beginner')).toBeChecked();
});

test('admin settings reset: counts only, a preview with its scope, reason and re-authentication; a device holding an unsaved change does not upload it again; undo restores; one message each', async ({ browser }) => {
  test.setTimeout(150_000);
  const m = await signUp(browser);
  const op = await signUp(browser);
  sql(`UPDATE users SET role = 'super_admin' WHERE email = '${op.email}'`);
  const mId = await idOf(m.page);
  await openSettings(m.page);
  await pickTheme(m.page, 'emerald');
  await closeSettings(m.page);
  await favStar(m.page).click();
  await expect.poll(() => serverSettings(m.page)).toMatchObject({ epoch: 0, prefs: { theme: 'emerald' }, fav: ['e2e-lobby-fav'] });

  const admin = await adminLogin(browser, op.email);
  await admin.goto(`${ADMIN}/users/${mId}`);
  const panel = admin.getByTestId('member-settings');
  await expect(panel).toHaveAttribute('data-epoch', '0');
  await expect(admin.getByTestId('member-settings-fields')).toHaveText(`1 / ${SYNCED_PREF_KEYS.length}`);
  // How many, never which values.
  await expect(panel).not.toContainText(/emerald|에메랄드|e2e-lobby-fav/i);
  await expect(admin.getByTestId('member-settings-restore')).toHaveCount(0);

  // The member's device makes a change it cannot save before the reset (offline).
  let failing = true;
  await failSaves(m.page, () => failing);
  await openSettings(m.page);
  await pickTheme(m.page, 'crimson');
  await expect(m.page.getByTestId('settings-sync')).toHaveAttribute('data-state', 'error');
  await closeSettings(m.page);

  // Reset: the preview shows what goes, the reason is required, then re-authentication.
  await admin.getByTestId('member-settings-reset').click();
  const scope = admin.getByTestId('settings-pv-scope');
  await expect(scope).toHaveAttribute('data-fields', '1');
  await expect(scope).toHaveAttribute('data-favourites', '1');
  // Auto-muck always applies now, so the preview no longer counts the tables the member sits at.
  await expect(scope).not.toHaveAttribute('data-seated');
  await expect(admin.getByTestId('settings-act-confirm')).toBeDisabled();
  await admin.getByTestId('settings-act-reason').fill('E2E 설정 초기화 사유');
  await admin.getByTestId('settings-act-confirm').click();
  await reauthIfAsked(admin);
  await expect(admin.getByTestId('member-settings-feedback')).toContainText(/초기화했습니다|Settings reset/);
  await expect(panel).toHaveAttribute('data-epoch', '1');
  await expect(admin.getByTestId('member-settings-fields')).toHaveText(`0 / ${SYNCED_PREF_KEYS.length}`);
  const afterReset = await serverSettings(m.page);
  expect(afterReset).toMatchObject({ epoch: 1, prefs: {}, fav: [] });

  // The device comes back online: its unsaved change is refused, not uploaded again; it shows the account's defaults and says why.
  failing = false;
  await openSettings(m.page);
  const retry = m.page.getByTestId('settings-sync-retry');
  // The device also retries by itself (2 s after the failure): if that answer removes the button first, the click must not wait for it.
  if (await retry.isVisible()) await retry.click({ timeout: 3_000 }).catch(() => {});
  await expect(look(m.page)).toHaveAttribute('data-theme', 'royal');
  await expect(m.page.getByTestId('settings-sync')).toHaveAttribute('data-state', 'saved');
  await expect(m.page.getByTestId('settings-sync')).toContainText(/초기화하거나 되돌려|reset or restored/);
  await closeSettings(m.page);
  await expect(favStar(m.page)).toHaveAttribute('aria-pressed', 'false');
  // Nor after a reload: nothing was saved over the reset.
  await m.page.reload();
  await openSettings(m.page);
  await expect(m.page.getByTestId('settings-sync')).toHaveAttribute('data-state', 'saved');
  expect(await serverSettings(m.page)).toMatchObject({ epoch: 1, rev: afterReset.rev, prefs: {}, fav: [] });
  await closeSettings(m.page);

  // Undo: the values before the reset come back, on the device at its next load.
  await admin.reload();
  await admin.getByTestId('member-settings-restore').click();
  await expect(scope).toHaveAttribute('data-fields', '1');
  await expect(scope).toHaveAttribute('data-favourites', '1');
  await admin.getByTestId('settings-act-reason').fill('E2E 설정 복구 사유');
  await admin.getByTestId('settings-act-confirm').click();
  await reauthIfAsked(admin);
  await expect(admin.getByTestId('member-settings-feedback')).toContainText(/되돌렸습니다|Reset undone/);
  await expect(panel).toHaveAttribute('data-epoch', '2');
  await expect(admin.getByTestId('member-settings-fields')).toHaveText(`1 / ${SYNCED_PREF_KEYS.length}`);
  await expect(admin.getByTestId('member-settings-restore')).toHaveCount(0);
  await m.page.reload();
  await expect(look(m.page)).toHaveAttribute('data-theme', 'emerald');
  await expect(favStar(m.page)).toHaveAttribute('aria-pressed', 'true');

  // One message for each, in the member's language, without the operator's reason.
  const inbox = (await m.page.evaluate(async () => (await (await fetch('/api/messages')).json()) as { title: string; body: string }[])).filter((x) =>
    /계정 설정 (초기화|복구) 안내|Your account settings were (reset|restored)/.test(x.title),
  );
  expect(inbox).toHaveLength(2);
  expect(JSON.stringify(inbox)).not.toMatch(/E2E 설정 (초기화|복구) 사유/);

  // The audit log: the reason and counts before → after, never the values.
  const audit = await admin.evaluate(async () => JSON.stringify(await (await fetch('/api/admin/audit?paged=1&action=settings.reset&limit=20')).json()));
  expect(audit).toContain(mId);
  expect(audit).toContain('E2E 설정 초기화 사유');
  expect(audit).not.toMatch(/emerald|crimson|e2e-lobby-fav/);
});
