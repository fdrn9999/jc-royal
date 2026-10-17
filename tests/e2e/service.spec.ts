import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { balanceOf, PASSWORD, signUp, test, widerThanDevice } from './helpers';
import { promoteSql } from '../support/grants';

const ADMIN = 'http://localhost:5174';

/** Runs SQL on the E2E database the running workers use, retrying while they hold it. */
function sql(command: string) {
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', 'tests/.state/e2e', '-c', 'apps/api/wrangler.jsonc', '--command', command], { stdio: 'ignore' });
    } catch (e) {
      if (i > 8) throw e;
    }
  }
}

/** The value a datetime-local input shows for a time, in the browser's time zone. */
const inputValue = (page: Page, ms: number) =>
  page.evaluate((at) => {
    const d = new Date(at);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, ms);

test('service notices and maintenance: an admin posts a bilingual notice and plans maintenance; members and visitors see them in their language; maintenance under way pauses seating and sign-in until it ends', async ({ browser }) => {
  test.setTimeout(240_000);
  const member = await signUp(browser);
  const phone = await signUp(browser, { mobile: true });
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const visitorCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await visitorCtx.addInitScript(() => localStorage.setItem('jc.locale', 'en'));
  const visitor = await visitorCtx.newPage();

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  const reauth = async () => {
    const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('reauth-confirm') });
    await dialog.getByLabel(/비밀번호|Password/).fill(PASSWORD);
    await dialog.getByTestId('reauth-confirm').click();
  };
  /** Ends whatever maintenance this test left planned or running, so later tests can seat players. */
  const stopAll = () =>
    page.evaluate(async () => {
      const r = (await (await fetch('/api/admin/service/maintenance')).json()) as { items: { id: string; state: string }[] };
      for (const w of r.items) {
        if (w.state === 'active' || w.state === 'scheduled') {
          await fetch(`/api/admin/service/maintenance/${w.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'E2E cleanup' }) });
        }
      }
    });

  try {
    await page.getByRole('link', { name: /공지·점검|Notices & maintenance/ }).first().click();
    await expect(page).toHaveURL(/\/service$/);
    await expect(page.getByTestId('maintenance-panel')).toBeVisible();

    // An urgent notice in both languages, pinned on the board and sent to every inbox (which asks first).
    await page.getByTestId('notice-new').click();
    const form = page.getByTestId('notice-form');
    await form.getByTestId('notice-kind').selectOption('urgent');
    await form.getByTestId('notice-title-ko').fill('E2E 긴급 공지');
    await form.getByTestId('notice-title-en').fill('E2E urgent notice');
    await form.getByLabel(/내용 \(한국어|Body \(Korean/).fill('결제 없이 이용하는 가상 칩 서비스입니다.');
    await form.getByLabel(/내용 \(영어|Body \(English/).fill('Virtual chips only, nothing to pay.');
    await form.getByTestId('notice-board').check();
    await form.getByTestId('notice-inbox').check();
    await page.getByTestId('notice-save').click();
    await expect(page.getByText(/모든 활성 회원에게|Every active member/)).toBeVisible();
    await page.getByTestId('notice-confirm').click();
    await expect(page.getByTestId('notice-msg')).toContainText(/명에게 발송했습니다|Sent to \d+ users/);
    const row = page.getByTestId('notice-row').filter({ hasText: 'E2E 긴급 공지' });
    await expect(row).toContainText(/긴급|Urgent/);
    await expect(row).toContainText('E2E urgent notice');

    // Maintenance two hours from now, with sign-in paused; saving asks to confirm, then for the password again.
    const start = Date.now() + 2 * 3600_000;
    await page.getByTestId('maint-new').click();
    await page.getByTestId('maint-start').fill(await inputValue(page, start));
    await page.getByTestId('maint-end').fill(await inputValue(page, start + 3600_000));
    await page.getByTestId('maint-block-login').check();
    await page.getByLabel(/안내 문구 \(한국어|Message \(Korean/).fill('데이터베이스 업그레이드');
    await page.getByLabel(/안내 문구 \(영어|Message \(English/).fill('Database upgrade');
    await page.getByTestId('maint-reason').fill('E2E 정기 점검');
    await page.getByTestId('maint-save').click();
    await expect(page.getByRole('dialog')).toContainText(/새 입장과 새 핸드가 멈춥니다|no table seats anyone new/);
    await page.getByTestId('maint-confirm').click();
    await reauth();
    await expect(page.getByTestId('maint-current')).toContainText(/점검 예정|Scheduled/);
    await expect(page.getByTestId('maint-msg')).toContainText(/곳에 바로 반영|Applied at once/);
    await page.screenshot({ path: 'test-results/admin-service.png', fullPage: true });

    // A member (Korean) sees both at the top, the notice in the inbox and on the board, and the maintenance page.
    await member.page.goto('/');
    const banner = member.page.getByTestId('service-banner');
    await expect(banner.getByTestId('notice-maintenance')).toContainText('서비스 점검 예정');
    await expect(banner.getByTestId('notice-maintenance')).toContainText('데이터베이스 업그레이드');
    await expect(banner).toContainText('E2E 긴급 공지');
    await expect(banner).not.toContainText('E2E urgent notice');
    await member.page.screenshot({ path: 'test-results/web-service-banner.png' });
    await member.page.goto('/messages');
    await expect(member.page.getByText('E2E 긴급 공지').first()).toBeVisible();
    await member.page.goto('/');
    await banner.locator('[data-testid^=notice-]').filter({ hasText: 'E2E 긴급 공지' }).getByRole('link').click();
    await expect(member.page).toHaveURL(/\/board\//);
    await expect(member.page.getByText('[English] E2E urgent notice')).toBeVisible();
    await member.page.goto('/');
    await banner.getByTestId('notice-maintenance').getByRole('link').click();
    await expect(member.page).toHaveURL(/\/maintenance$/);
    await expect(member.page.getByTestId('maintenance-state')).toHaveText('서비스 점검이 예정되어 있습니다.');
    await expect(member.page.getByTestId('maintenance-page')).toContainText('새 로그인과 회원가입도');

    // A signed-out visitor reading in English sees them on the sign-in page and the maintenance page.
    await visitor.goto('/login');
    const vb = visitor.getByTestId('service-banner');
    await expect(vb).toContainText('E2E urgent notice');
    await expect(vb).toContainText('Maintenance scheduled');
    await expect(vb).toContainText('Database upgrade');
    await expect(vb).not.toContainText('E2E 긴급 공지');
    await visitor.goto('/maintenance');
    await expect(visitor.getByTestId('maintenance-state')).toHaveText('Maintenance is scheduled.');
    // The card rises in; capture it once it has settled.
    await visitor.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await visitor.screenshot({ path: 'test-results/web-maintenance-scheduled-en.png' });

    // On a phone the banner fits the width.
    await phone.page.goto('/');
    await expect(phone.page.getByTestId('service-banner')).toContainText('E2E 긴급 공지');
    expect(await widerThanDevice(phone.page)).toBe(false);
    await phone.page.screenshot({ path: 'test-results/web-service-banner-mobile.png' });

    // Cancelled: the maintenance row goes; the notice stays.
    await page.getByTestId('maint-stop-reason').fill('E2E 일정 변경');
    await page.getByTestId('maint-stop').click();
    await page.getByTestId('maint-confirm').click();
    await expect(page.getByTestId('maint-new')).toBeVisible();
    await member.page.goto('/');
    await expect(banner).toContainText('E2E 긴급 공지');
    await expect(banner.getByTestId('notice-maintenance')).toHaveCount(0);
    // (The visitor's sign-in page is loaded before the next maintenance begins: it does not poll.)
    await visitor.goto('/login');
    await expect(vb).toContainText('E2E urgent notice');
    await expect(vb.getByTestId('notice-maintenance')).toHaveCount(0);

    // Now maintenance under way: a seated member keeps the seat and can leave; nobody sits; sign-in waits.
    // (The member's post from before, to open during it.)
    const postId = await member.page.evaluate(async () => ((await (await fetch('/api/board/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E 점검 전 글', body: '점검 전에 쓴 글' }) })).json()) as { id: string }).id);    await member.page.goto('/table/e2e-maint?sit=1');
    await member.page.getByTestId('buyin-confirm').click();
    await expect(member.page.locator('[data-testid^=seat-]').filter({ hasText: member.nickname })).toBeVisible();
    await phone.page.goto('/table/e2e-maint');
    await expect(phone.page.locator('[data-testid^=sit-]').first()).toBeVisible();
    await page.getByTestId('maint-new').click();
    await page.getByTestId('maint-end').fill(await inputValue(page, Date.now() + 3600_000));
    await page.getByTestId('maint-block-login').check();
    await page.getByTestId('maint-reason').fill('E2E 긴급 점검');
    await page.getByTestId('maint-save').click();
    await page.getByTestId('maint-confirm').click();
    await expect(page.getByTestId('maint-current')).toContainText(/점검 중|Maintenance/);

    await expect(member.page.getByRole('status').filter({ hasText: '서비스 점검 중이라 새 핸드와 입장이 멈췄습니다' })).toBeVisible();
    await expect(phone.page.getByRole('status').filter({ hasText: '서비스 점검 중이라' })).toBeVisible();
    await expect(phone.page.locator('[data-testid^=sit-]')).toHaveCount(0);
    expect(await widerThanDevice(phone.page)).toBe(false);
    await phone.page.screenshot({ path: 'test-results/table-maintenance-mobile.png' });
    await member.page.getByTestId('leave').click();
    await expect(member.page.locator('[data-testid^=seat-]').filter({ hasText: member.nickname })).toHaveCount(0);
    expect(await balanceOf(member.page)).toBe(10_000);

    await visitor.getByLabel('Email', { exact: true }).fill(member.email);
    await visitor.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await visitor.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(visitor.getByRole('alert')).toHaveText('Maintenance is under way: new games and new sign-ins are paused for now.');
    // The refusal brings the banner up to date at once.
    await expect(visitor.getByTestId('notice-maintenance')).toContainText('Maintenance under way');
    await visitor.screenshot({ path: 'test-results/web-login-maintenance-en.png' });
    await member.page.goto('/maintenance');
    await expect(member.page.getByTestId('maintenance-state')).toHaveText('지금 서비스 점검 중입니다.');
    await expect(member.page.getByTestId('maintenance-page')).toContainText('게시판 글과 댓글 쓰기도 멈춥니다');

    // The lobby: new rooms, quick play and joining wait, with a note saying why and until when; watching stays.
    await member.page.goto('/');
    await expect(member.page.getByTestId('maint-note-games')).toContainText('새 방 만들기, 빠른 참가, 테이블 참여가 잠시 멈췄습니다');
    await expect(member.page.getByTestId('room-create-open-wide')).toBeDisabled();
    await expect(member.page.getByTestId('quick-go')).toBeDisabled();
    await expect(member.page.getByTestId('lobby-enter').first()).toBeDisabled();
    await expect(member.page.getByTestId('lobby-enter').first()).toHaveText('점검 중');
    await member.page.screenshot({ path: 'test-results/lobby-maintenance.png' });
    await phone.page.setViewportSize({ width: 360, height: 740 });
    await phone.page.goto('/');
    await expect(phone.page.getByTestId('room-create-open')).toBeDisabled();
    await expect(phone.page.getByTestId('quick-go')).toBeDisabled();
    await expect(phone.page.getByTestId('maint-note-games')).toBeVisible();
    expect(await widerThanDevice(phone.page)).toBe(false);
    await phone.page.screenshot({ path: 'test-results/lobby-maintenance-mobile.png' });

    // The board: members can't write, comment or edit (the server refuses it too); reading stays. Staff can post.
    await member.page.goto('/board');
    await expect(member.page.getByTestId('write-post')).toBeDisabled();
    await expect(member.page.getByTestId('maint-note-posting')).toContainText('글과 댓글 쓰기가 잠시 멈췄습니다');
    await member.page.goto(`/board/${postId}`);
    await expect(member.page.getByText('점검 전에 쓴 글')).toBeVisible();
    await expect(member.page.getByTestId('comment-input')).toBeDisabled();
    await expect(member.page.getByTestId('comment-submit')).toBeDisabled();
    await expect(member.page.getByTestId('post-edit')).toHaveAttribute('aria-disabled', 'true');
    const refused = await member.page.evaluate(async (id) => (await fetch(`/api/board/posts/${id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: '점검 중 댓글' }) })).status, postId);
    expect(refused).toBe(503);
    await phone.page.goto(`/board/${postId}`);
    await expect(phone.page.getByTestId('maint-note-posting')).toBeVisible();
    await expect(phone.page.getByTestId('comment-submit')).toBeDisabled();
    expect(await widerThanDevice(phone.page)).toBe(false);
    await phone.page.screenshot({ path: 'test-results/board-maintenance-mobile.png' });
    await op.page.goto('/board');
    await expect(op.page.getByTestId('write-post')).toBeEnabled();
    await expect(op.page.getByTestId('maint-note-posting')).toHaveCount(0);
    await phone.page.goto('/table/e2e-maint');
    // Ended early: seats open again at once and sign-in works.
    await page.getByTestId('maint-stop-reason').fill('E2E 점검 완료');
    await page.getByTestId('maint-stop').click();
    await expect(page.getByRole('dialog')).toContainText(/점검을 지금 끝냅니다|Maintenance ends now/);
    await page.getByTestId('maint-confirm').click();
    await expect(page.getByTestId('maint-new')).toBeVisible();
    await expect(phone.page.locator('[data-testid^=sit-]').first()).toBeVisible();
    await expect(phone.page.getByRole('status').filter({ hasText: '서비스 점검 중이라' })).toHaveCount(0);
    // The lobby buttons come back.
    await member.page.goto('/');
    await expect(member.page.getByTestId('room-create-open-wide')).toBeEnabled();
    await expect(member.page.getByTestId('quick-go')).toBeEnabled();
    await expect(member.page.getByTestId('maint-note-games')).toHaveCount(0);
    await visitor.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(visitor).toHaveURL(/\/$/);

    // The notice, ended and then deleted, leaves the banner.
    await row.getByTestId('notice-end').click();
    await expect(row).toContainText(/게시 종료|Ended/);
    await member.page.goto('/');
    await expect(member.page.getByTestId('service-banner')).toHaveCount(0);
    await row.getByRole('button', { name: /삭제|Delete/ }).click();
    await page.getByTestId('notice-confirm').click();
    await expect(page.getByTestId('notice-row').filter({ hasText: 'E2E 긴급 공지' })).toHaveCount(0);
  } finally {
    await stopAll();
  }
});

test('a dismissed general notice stays hidden on this device, but shows again once an administrator raises it to urgent', async ({ browser }) => {
  const member = await signUp(browser);
  const op = await signUp(browser);
  sql(promoteSql(`email = '${op.email}'`));
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(ADMIN);
  await page.getByLabel(/이메일|Email/).fill(op.email);
  await page.getByLabel(/비밀번호|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /로그인|Log in/ }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  const call = (method: string, path: string, body?: unknown) =>
    page.evaluate(
      async ([m, p, b]) => {
        const r = await fetch(`/api/admin/service/notices${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
        return (await r.json()) as { id?: string };
      },
      [method, path, body] as const,
    );
  const id = (await call('POST', '', { kind: 'general', titleKo: 'E2E 일반 공지', titleEn: 'E2E general notice' })).id!;
  /** Loads the home page and waits for its notices, so a missing row means hidden, not not-yet-loaded. */
  const home = async () => {
    const loaded = member.page.waitForResponse((r) => r.url().endsWith('/api/service/status'));
    await member.page.goto('/');
    await loaded;
  };
  try {
    await home();
    const row = member.page.getByTestId(`notice-${id}`);
    await expect(row).toContainText('E2E 일반 공지');
    await row.getByRole('button', { name: '닫기' }).click();
    await expect(row).toHaveCount(0);
    await home();
    await expect(row).toHaveCount(0);

    // Raised to urgent: an urgent notice cannot be dismissed, and the earlier dismissal no longer hides it.
    await call('PATCH', `/${id}`, { kind: 'urgent' });
    await home();
    await expect(row).toContainText('E2E 일반 공지');
    await expect(row.getByRole('button', { name: '닫기' })).toHaveCount(0);
  } finally {
    await call('DELETE', `/${id}`);
  }
});
