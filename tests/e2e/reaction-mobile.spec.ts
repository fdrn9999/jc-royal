import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';

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

/** Whether each element is inside the screen and on top at its middle (a tap reaches it). */
function placed(page: Page, selector: string) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll<HTMLElement>(sel)).map((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 && r.bottom <= window.innerHeight && !!top && el.contains(top);
    });
  }, selector);
}

test('mobile: a seated player sends a quick reaction from their seat, everyone sees it over the avatar, and the setting turns it off', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await signUp(browser, { mobile: true });
  await a.page.setViewportSize({ width: 360, height: 740 });
  const b = await signUp(browser);
  await a.page.goto('/table/e2e-react?sit=1');
  await a.page.getByTestId('buyin-confirm').tap();
  const opener = a.page.getByTestId('react-open');
  await expect(opener).toBeVisible();
  const seat = a.page.locator('[data-testid^="seat-"][data-state]').filter({ has: opener });
  const seatId = (await seat.getAttribute('data-testid'))!;
  const index = seatId.replace('seat-', '');

  // B watches; a spectator has no reaction button.
  await b.page.goto('/table/e2e-react');
  await expect(b.page.getByTestId(seatId)).toHaveAttribute('data-state', /.+/);
  await expect(b.page.getByTestId('react-open')).toHaveCount(0);

  // The tray: eight reactions above my seat, all on the 360px screen and tappable.
  await opener.tap();
  const tray = a.page.getByTestId('react-tray');
  await expect(tray).toBeVisible();
  await expect(tray.getByRole('button')).toHaveCount(8);
  await expect(tray.getByRole('button', { name: '불꽃' })).toBeVisible();
  expect(await placed(a.page, '[data-testid=react-tray] button')).toEqual(Array(8).fill(true));
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('reaction-tray-360.png') });

  // Sent: the tray closes, and both see it over A's avatar.
  await a.page.getByTestId('react-fire').tap();
  await expect(tray).toHaveCount(0);
  // Right after one, the tray says when the next can go (the cooldown is 2 s), and then lets it.
  await opener.tap();
  await expect(a.page.getByTestId('react-wait')).toBeVisible();
  await expect(a.page.getByTestId('react-clap')).toBeDisabled();
  await a.page.screenshot({ path: test.info().outputPath('reaction-wait-360.png'), animations: 'disabled' });
  await expect(a.page.getByTestId('react-clap')).toBeEnabled({ timeout: 5_000 });
  await a.page.keyboard.press('Escape');
  await expect(tray).toHaveCount(0);
  // It goes away by itself (it shows 2.6 s).
  for (const p of [a.page, b.page]) await expect(p.getByTestId(`reaction-${index}`)).toHaveCount(0, { timeout: 5_000 });

  // The next one, seen over A's avatar by both.
  await opener.tap();
  await a.page.getByTestId('react-heart').tap();
  for (const p of [a.page, b.page]) await expect(p.getByTestId(`reaction-${index}`)).toHaveAttribute('data-reaction', 'heart');
  // Mid-animation (it fades out at the end, which is where `animations: 'disabled'` would jump to).
  await b.page.waitForTimeout(500);
  await Promise.all([
    a.page.screenshot({ path: test.info().outputPath('reaction-seat-360.png') }),
    b.page.screenshot({ path: test.info().outputPath('reaction-other-view.png') }),
  ]);
  await a.page.waitForTimeout(2_100);

  // B turns reactions off: A's next one does not show for B (it still does for A).
  await b.page.getByRole('button', { name: /^(설정|Settings)$/ }).click();
  const box = b.page.getByTestId('settings-reactions');
  await box.scrollIntoViewIfNeeded();
  await box.uncheck();
  await b.page.getByRole('dialog').getByRole('button', { name: 'close' }).click();
  await opener.tap();
  await a.page.getByTestId('react-gg').tap();
  await expect(a.page.getByTestId(`reaction-${index}`)).toHaveAttribute('data-reaction', 'gg');
  await b.page.waitForTimeout(800);
  await expect(b.page.getByTestId(`reaction-${index}`)).toHaveCount(0);

  // A turns them off: the seat no longer offers the tray.
  await a.page.getByRole('button', { name: /^(설정|Settings)$/ }).tap();
  const mine = a.page.getByTestId('settings-reactions');
  await mine.scrollIntoViewIfNeeded();
  await expect(a.page.getByText('빠른 반응 이모지')).toBeVisible();
  await mine.tap();
  await expect(mine).not.toBeChecked();
  await a.page.getByRole('dialog').getByRole('button', { name: 'close' }).tap();
  await expect(a.page.getByTestId('react-open')).toHaveCount(0);
});

test('mobile: the emoji button puts an emoji at the caret in table chat and in a direct message', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await signUp(browser, { mobile: true });
  await a.page.setViewportSize({ width: 360, height: 740 });
  const b = await signUp(browser);

  // Table chat, opened from the table's chat button on a phone.
  await a.page.goto('/table/e2e-react');
  await a.page.getByRole('button', { name: /^(채팅|Chat)$/ }).tap();
  const chat = a.page.getByTestId('chat-input');
  await chat.fill('좋은 패');
  await chat.evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 2));
  await a.page.getByTestId('emoji-open').tap();
  const panel = a.page.getByTestId('emoji-panel');
  await expect(panel).toBeVisible();
  expect(await placed(a.page, '[data-testid=emoji-option]')).toEqual(Array(32).fill(true));
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('emoji-chat-360.png') });
  await panel.getByRole('button', { name: '🔥' }).tap();
  await expect(chat).toHaveValue('좋은🔥 패');
  // A tap outside closes it.
  await chat.tap();
  await expect(panel).toHaveCount(0);

  // A direct message to a friend.
  const [aId, bId] = [(await call<{ id: string }>(a.page, '/api/auth/me')).id, (await call<{ id: string }>(b.page, '/api/auth/me')).id];
  await call(a.page, '/api/friends/requests', { userId: bId });
  await call(b.page, `/api/friends/${aId}/accept`, {});
  await a.page.goto(`/friends/${bId}`);
  const field = a.page.getByTestId('dm-input');
  await field.fill('gg');
  await a.page.getByTestId('emoji-open').tap();
  await a.page.getByTestId('emoji-panel').getByRole('button', { name: '🤝' }).tap();
  await expect(field).toHaveValue('gg🤝');
  expect(await placed(a.page, '[data-testid=emoji-option]')).toEqual(Array(32).fill(true));
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath('emoji-dm-360.png') });
  await a.page.getByTestId('dm-send').tap();
  await expect(a.page.getByTestId('emoji-panel')).toHaveCount(0);
  await expect(a.page.getByText('gg🤝')).toBeVisible();
});