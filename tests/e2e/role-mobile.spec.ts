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

const GOLD = 'rgb(248, 227, 176)';
const BLUE = 'rgb(143, 208, 255)';

/** Each staff seat's name: the mark in front, the long name cut inside the plate, and nothing over another seat or the board. */
function staffSeats(page: Page) {
  return page.evaluate(() => {
    const overlap = (x: DOMRect, y: DOMRect) => x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
    const seats = Array.from(document.querySelectorAll('[data-testid^="seat-"]')).filter((e) => /^seat-\d+$/.test(e.getAttribute('data-testid')!));
    const board = document.querySelector('[data-testid=board]')?.getBoundingClientRect() ?? null;
    return seats
      .filter((s) => s.querySelector('[data-testid=role-icon]'))
      .map((s) => {
        const plate = s.querySelector('[data-testid^="seat-pick-"]')!.getBoundingClientRect();
        const label = s.querySelector('[data-testid=member-name]')!.getBoundingClientRect();
        const icon = s.querySelector('[data-testid=role-icon]')!;
        const nameEl = s.querySelector<HTMLElement>('.jc-role-name')!;
        const name = nameEl.getBoundingClientRect();
        const within = (x: DOMRect, y: DOMRect) => x.left >= y.left - 0.5 && x.right <= y.right + 0.5 && x.top >= y.top - 0.5 && x.bottom <= y.bottom + 0.5;
        return {
          role: icon.getAttribute('data-role'),
          color: getComputedStyle(nameEl).color,
          iconFirst: icon.getBoundingClientRect().right <= name.left + 0.5,
          cut: nameEl.scrollWidth > nameEl.clientWidth,
          inPlate: within(label, plate),
          onScreen: label.left >= 0 && label.right <= document.documentElement.clientWidth,
          clear: !(board && overlap(label, board)) && !seats.filter((o) => o !== s && o.getAttribute('data-state') !== 'empty').some((o) => overlap(label, o.getBoundingClientRect())),
        };
      })
      .sort((a, b) => a.role!.localeCompare(b.role!));
  });
}

/** Each staff chat line: the badge after the name and clear of it, everything inside the chat drawer. */
function staffLines(page: Page) {
  return page.evaluate(() => {
    const overlap = (x: DOMRect, y: DOMRect) => x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
    return Array.from(document.querySelectorAll<HTMLElement>('[data-testid=chat-line].jc-role-line')).map((line) => {
      const panel = line.closest('aside')!.getBoundingClientRect();
      const name = line.querySelector('.jc-role-name')!.getBoundingClientRect();
      const badge = line.querySelector('[data-testid=role-badge]')!;
      const b = badge.getBoundingClientRect();
      const r = line.getBoundingClientRect();
      return {
        role: line.dataset.role,
        badge: badge.textContent,
        icon: line.querySelector('[data-testid=role-icon]')?.getAttribute('data-role'),
        badgeClear: !overlap(b, name),
        inPanel: r.left >= panel.left && r.right <= panel.right + 0.5 && b.right <= panel.right + 0.5 && name.right <= panel.right + 0.5,
        tinted: getComputedStyle(line).backgroundImage.includes('gradient'),
      };
    });
  });
}

test('mobile: staff names at 360px keep the crown or shield, the color and the badge without covering the table or the chat', async ({ browser }) => {
  const boss = await signUp(browser);
  const mod = await signUp(browser);
  const viewer = await signUp(browser, { mobile: true });
  await viewer.page.setViewportSize({ width: 360, height: 740 });
  // The longest names allowed (16), in Korean, which runs wider than Latin. The role is read when the table connects.
  const bossName = `최고관리자의긴닉네임${boss.nickname.slice(-6)}`;
  const modName = `관리자입니다긴닉네임${mod.nickname.slice(-6)}`;
  sql(`UPDATE users SET role = 'super_admin', nickname = '${bossName}' WHERE email = '${boss.email}'`);
  sql(`UPDATE users SET role = 'admin', nickname = '${modName}' WHERE email = '${mod.email}'`);

  for (const p of [boss.page, mod.page]) {
    await p.goto('/table/e2e-role?sit=1');
    await p.getByTestId('buyin-confirm').click();
    await expect(p.getByTestId('buyin-confirm')).toHaveCount(0);
  }
  await viewer.page.goto('/table/e2e-role?sit=1');
  await viewer.page.getByTestId('buyin-confirm').tap();
  await expect(viewer.page.getByTestId('buyin-confirm')).toHaveCount(0);

  // Seats.
  await expect(viewer.page.locator('[data-testid=role-icon][data-role=super_admin]')).toHaveCount(1);
  await expect(viewer.page.locator('[data-testid=role-icon][data-role=admin]')).toHaveCount(1);
  await expect(viewer.page.getByText('👑')).toHaveCount(0);
  expect(await staffSeats(viewer.page)).toEqual([
    { role: 'admin', color: BLUE, iconFirst: true, cut: true, inPlate: true, onScreen: true, clear: true },
    { role: 'super_admin', color: GOLD, iconFirst: true, cut: true, inPlate: true, onScreen: true, clear: true },
  ]);
  expect(await widerThanDevice(viewer.page)).toBe(false);
  await viewer.page.screenshot({ path: test.info().outputPath('role-seats-360.png'), animations: 'disabled' });

  // The player card: the full name and the badge.
  await viewer.page.getByRole('button', { name: bossName }).tap();
  const card = viewer.page.getByRole('dialog');
  await expect(card.getByTestId('role-badge')).toHaveText('SUPER ADMIN');
  const cardBox = (await card.boundingBox())!;
  const badgeBox = (await card.getByTestId('role-badge').boundingBox())!;
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
  await viewer.page.screenshot({ path: test.info().outputPath('role-card-360.png'), animations: 'disabled' });
  await card.getByRole('button', { name: 'close' }).tap();
  await expect(viewer.page.getByRole('dialog')).toHaveCount(0);

  // Chat lines from both, read in the mobile drawer.
  for (const [p, text] of [
    [boss.page, '오늘 밤 10시에 점검이 있습니다'],
    [mod.page, '신고는 메뉴에서 해 주세요'],
  ] as const) {
    const box = p.getByRole('textbox', { name: /^(채팅|Chat)$/ });
    await box.fill(text);
    await box.press('Enter');
    await expect(viewer.page.getByTestId('chat-line').filter({ hasText: text })).toHaveCount(1);
  }
  await viewer.page.getByRole('button', { name: /^(채팅|Chat)$/ }).tap();
  await expect(viewer.page.getByTestId('chat-line').first()).toBeVisible();
  expect(await staffLines(viewer.page)).toEqual([
    { role: 'super_admin', badge: 'SUPER ADMIN', icon: 'super_admin', badgeClear: true, inPanel: true, tinted: true },
    { role: 'admin', badge: 'ADMIN', icon: 'admin', badgeClear: true, inPanel: true, tinted: true },
  ]);
  expect(await widerThanDevice(viewer.page)).toBe(false);
  await viewer.page.screenshot({ path: test.info().outputPath('role-chat-360.png'), animations: 'disabled' });

  // The same table on a desktop screen.
  await expect(mod.page.getByTestId('chat-line').filter({ hasText: '점검' }).getByTestId('role-badge')).toHaveText('SUPER ADMIN');
  await mod.page.screenshot({ path: test.info().outputPath('role-desktop-1440.png'), animations: 'disabled' });
});
