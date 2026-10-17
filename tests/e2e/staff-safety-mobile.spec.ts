import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';

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

/** Same-origin JSON call with the page's session. */
async function call<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(p, { method: b === undefined ? 'GET' : 'POST', headers: b === undefined ? {} : { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return (await r.json()) as T;
    },
    [path, body] as const,
  );
}
const idOf = async (page: Page) => (await call<{ id: string }>(page, '/api/auth/me')).id;
/** Waits for the sheet to finish rising, then whether anything (the bottom bar) covers the middle of the element. */
const onTop = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate(async (el) => {
    await Promise.all(document.getAnimations().map((a) => a.finished));
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });

test('on a phone, a member is offered no block for staff and no report for the super admin, and is told why', async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await signUp(browser);
  const mod = await signUp(browser);
  const boss = await signUp(browser);
  const [aId, modId, bossId] = [await idOf(a.page), await idOf(mod.page), await idOf(boss.page)];
  sql(`UPDATE users SET role = 'admin' WHERE id = '${modId}'; UPDATE users SET role = 'super_admin' WHERE id = '${bossId}'`);
  try {
    const modPost = await call<{ id: string }>(mod.page, '/api/board/posts', { title: '운영 안내', body: '관리자 글' });
    const bossPost = await call<{ id: string }>(boss.page, '/api/board/posts', { title: '서비스 안내', body: '최고 관리자 글' });
    for (const s of [mod, boss]) {
      const sId = s === mod ? modId : bossId;
      await call(a.page, '/api/friends/requests', { userId: sId });
      await call(s.page, `/api/friends/${aId}/accept`, {});
      await call(s.page, `/api/dm/${aId}`, { text: `${s === mod ? '관리자' : '최고 관리자'}입니다` });
    }
    await a.page.setViewportSize({ width: 360, height: 740 });

    // An administrator's post can be reported; their card offers no block and says so.
    await a.page.goto(`/board/${modPost.id}`);
    await expect(a.page.getByTestId('report-post')).toBeVisible();
    await a.page.getByTestId('author-name').first().click();
    await expect(a.page.getByTestId('player-card')).toBeVisible();
    await expect(a.page.getByTestId('player-staff-note')).toContainText('운영진은 차단할 수 없습니다');
    await expect(a.page.getByTestId('player-block')).toHaveCount(0);
    await expect.poll(() => onTop(a.page, 'player-staff-note')).toBe(true);
    expect(await widerThanDevice(a.page)).toBe(false);
    await a.page.screenshot({ path: 'test-results/staff-card-admin-mobile.png' });
    await a.page.keyboard.press('Escape');

    // The super admin's post: no report button, and the card says neither is possible.
    await a.page.goto(`/board/${bossPost.id}`);
    await expect(a.page.getByTestId('author-name').first()).toBeVisible();
    await expect(a.page.getByTestId('report-post')).toHaveCount(0);
    await a.page.getByTestId('author-name').first().click();
    await expect(a.page.getByTestId('player-staff-note')).toContainText('최고 관리자는 신고하거나 차단할 수 없습니다');
    await expect(a.page.getByTestId('player-block')).toHaveCount(0);
    await expect.poll(() => onTop(a.page, 'player-staff-note')).toBe(true);
    await a.page.screenshot({ path: 'test-results/staff-card-super-mobile.png' });
    await a.page.keyboard.press('Escape');

    // 1:1 chat with an administrator: a message can be reported, the conversation cannot be blocked.
    await a.page.goto(`/friends/${modId}`);
    await expect(a.page.getByTestId('dm-title')).toBeVisible();
    await expect(a.page.getByTestId('dm-block')).toHaveCount(0);
    await a.page.getByTestId('dm-theirs').getByRole('button', { name: /관리자입니다/ }).click();
    await expect(a.page.getByTestId('dm-report')).toBeVisible();

    // With the super admin: neither, and a line says so.
    await a.page.goto(`/friends/${bossId}`);
    await expect(a.page.getByTestId('dm-staff-note')).toBeVisible();
    await expect(a.page.getByTestId('dm-block')).toHaveCount(0);
    await a.page.getByTestId('dm-theirs').getByRole('button', { name: /최고 관리자입니다/ }).click();
    await expect(a.page.getByTestId('dm-report')).toHaveCount(0);
    expect(await widerThanDevice(a.page)).toBe(false);
    await a.page.screenshot({ path: 'test-results/staff-dm-super-mobile.png' });

    // The server says the same to a request made anyway.
    const put = (id: string) => a.page.evaluate(async (u) => (await (await fetch(`/api/blocks/${u}`, { method: 'PUT' })).json()).error.code, id);
    expect(await put(modId)).toBe('block_staff');
    expect(await put(bossId)).toBe('block_staff');
    const dmId = (await call<{ messages: { id: string; fromMe: boolean }[] }>(a.page, `/api/dm/${bossId}`)).messages.find((m) => !m.fromMe)!.id;
    expect((await call(a.page, '/api/reports', { targetType: 'dm', targetId: dmId, reason: 'spam' })).error.code).toBe('report_super_admin');
  } finally {
    sql(`UPDATE users SET role = 'user' WHERE id IN ('${modId}', '${bossId}')`);
  }
});