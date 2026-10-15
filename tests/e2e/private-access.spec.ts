import { expect, type Page } from '@playwright/test';
import { signUp, test } from './helpers';

const CODE = 'vault-88';

/** Every WebSocket address the page opens. */
function sockets(page: Page) {
  const urls: string[] = [];
  page.on('websocket', (ws) => urls.push(ws.url()));
  return urls;
}

const cancelBuyIn = (page: Page) => page.getByRole('dialog').getByRole('button', { name: /^(취소|Cancel)$/ }).click();

test('private table: the join code is traded for a ticket and never appears in a page or socket address', async ({ browser }) => {
  // From the lobby: a wrong code is refused inside the dialog; the right one opens the table to sit.
  const a = await signUp(browser);
  const aWs = sockets(a.page);
  await a.page.locator('[data-testid=lobby-table][data-table=e2e-vault]').getByTestId('lobby-enter').click();
  await a.page.getByTestId('join-code').fill('wrong-1');
  await a.page.getByTestId('join-code-go').click();
  await expect(a.page.getByTestId('join-code-error')).toContainText(/참가 코드가 맞지 않습니다|not right/);
  await a.page.getByTestId('join-code').fill(CODE);
  await a.page.getByTestId('join-code-go').click();
  await expect(a.page).toHaveURL(/\/table\/e2e-vault/);
  await expect(a.page.getByTestId('buyin-confirm')).toBeVisible();
  // The ticket is HttpOnly: scripts on the page cannot read it.
  expect(await a.page.evaluate(() => document.cookie)).not.toContain('jc_room_');
  await cancelBuyIn(a.page);

  // Straight to the table without the code (no spectators here): locked until the code is entered on the page.
  const b = await signUp(browser);
  const bWs = sockets(b.page);
  await b.page.goto('/table/e2e-vault');
  await expect(b.page.getByText(/비공개 방입니다|This is a private room/)).toBeVisible();
  await b.page.screenshot({ path: 'test-results/private-locked.png', animations: 'disabled' });
  await b.page.getByTestId('enter-code').click();
  await b.page.getByTestId('join-code').fill(CODE);
  await b.page.getByTestId('join-code-go').click();
  await expect(b.page.getByTestId('buyin-confirm')).toBeVisible();
  await cancelBuyIn(b.page);
  // A reload keeps the access: the ticket outlives the page.
  await b.page.reload();
  await expect(b.page.getByText(/비공개 방입니다|This is a private room/)).toHaveCount(0);
  await expect(b.page.getByText(/참가 코드가 필요합니다|Join code required/)).toHaveCount(0);
  await expect(b.page.getByTestId('sit-0')).toBeVisible();

  // An older link with the code in it: the code leaves the address at once and still lets the member in.
  const c = await signUp(browser);
  const cWs = sockets(c.page);
  await c.page.goto(`/table/e2e-vault?code=${CODE}&sit=1`);
  await expect(c.page.getByTestId('buyin-confirm')).toBeVisible();
  expect(c.page.url()).not.toContain(CODE);

  for (const [page, urls] of [
    [a.page, aWs],
    [b.page, bWs],
    [c.page, cWs],
  ] as const) {
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).not.toContain(CODE);
    expect(page.url()).not.toContain(CODE);
  }
});
