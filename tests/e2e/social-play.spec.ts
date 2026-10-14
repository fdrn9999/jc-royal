import { expect, type Page } from '@playwright/test';
import { signUp, test } from './helpers';

/** Same-origin JSON call with the page's session. */
async function call<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return (await r.json()) as T;
    },
    [path, body] as const,
  );
}
const idOf = async (page: Page) => (await call<{ id: string }>(page, '/api/auth/me')).id;
async function befriend(x: Page, y: Page) {
  await call(x, '/api/friends/requests', { userId: await idOf(y) });
  await call(y, `/api/friends/${await idOf(x)}/accept`, {});
}
const seatOf = (page: Page, nickname: string) => page.locator('[data-testid^=seat-]').filter({ hasText: nickname });

test('play together: invite from the friends list; the card opens the table, says when it filled up, and asks for a private code', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const c = await signUp(browser);
  await befriend(a.page, b.page);
  await befriend(a.page, c.page);
  const [aId, bId, cId] = [await idOf(a.page), await idOf(b.page), await idOf(c.page)];

  // A picks a table for B from the friends list.
  await a.page.goto('/friends');
  await a.page.getByTestId('friend-item').filter({ hasText: b.nickname }).getByTestId('friend-invite').click();
  const picker = a.page.getByTestId('invite-picker');
  await expect(picker.getByTestId('invite-table').filter({ hasText: 'E2E Secret' })).toContainText('🔒');
  await expect(picker.getByTestId('invite-table').filter({ hasText: 'E2E Together' })).toContainText('0/2');
  await a.page.screenshot({ path: 'test-results/invite-picker.png' });
  await picker.getByTestId('invite-table').filter({ hasText: 'E2E Together' }).click();
  await expect(picker).toHaveCount(0);
  await expect(a.page.getByRole('status')).toContainText('E2E Together');
  await a.page.goto(`/friends/${bId}`);
  await expect(a.page.getByTestId('dm-invite')).toContainText(/초대를 보냈습니다|Invite sent/);
  await expect(a.page.getByTestId('dm-invite-join')).toHaveCount(0);

  // B sees it in the list and the conversation, and joining opens the buy-in.
  await b.page.goto('/friends');
  await expect(b.page.getByTestId('friend-item').filter({ hasText: a.nickname })).toContainText('E2E Together');
  await b.page.getByTestId('friend-item').filter({ hasText: a.nickname }).getByTestId('friend-row').click();
  const card = b.page.getByTestId('dm-invite');
  await expect(card).toContainText('E2E Together');
  await b.page.screenshot({ path: 'test-results/invite-card.png' });
  await card.getByTestId('dm-invite-join').click();
  await expect(b.page).toHaveURL(/\/table\/e2e-together/);
  await b.page.getByTestId('buyin-confirm').click();
  await expect(seatOf(b.page, b.nickname)).toBeVisible();

  // A invites C to the same table, then takes the last seat: C's card says it is full and offers to watch.
  await call(a.page, `/api/friends/${cId}/invite`, { tableId: 'e2e-together' });
  await call(a.page, `/api/friends/${cId}/invite`, { tableId: 'e2e-secret' });
  await a.page.goto('/table/e2e-together?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await expect(seatOf(a.page, a.nickname)).toBeVisible();
  await c.page.goto(`/friends/${aId}`);
  const together = c.page.getByTestId('dm-invite').filter({ hasText: 'E2E Together' });
  await together.getByTestId('dm-invite-join').click();
  await expect(together.getByTestId('dm-invite-status')).toContainText(/자리가 모두 찼습니다|All seats are taken/);
  await c.page.screenshot({ path: 'test-results/invite-full.png' });
  await together.getByTestId('dm-invite-spectate').click();
  await expect(c.page).toHaveURL(/\/table\/e2e-together$/);
  await expect(seatOf(c.page, b.nickname)).toBeVisible();
  // Arriving to sit at a full table says so instead of doing nothing.
  await c.page.goto('/table/e2e-together?sit=1');
  await expect(c.page.getByText(/대기 명단에 오를 수 있습니다|join the waitlist/)).toBeVisible();

  // A private table: the card carries no code, so joining asks for it and the table checks it.
  await c.page.goto(`/friends/${aId}`);
  await c.page.getByTestId('dm-invite').filter({ hasText: 'E2E Secret' }).getByTestId('dm-invite-join').click();
  await c.page.getByTestId('join-code').fill('secret-77');
  await c.page.getByTestId('join-code-go').click();
  await expect(c.page).toHaveURL(/\/table\/e2e-secret/);
  await c.page.getByTestId('buyin-confirm').click();
  await expect(seatOf(c.page, c.nickname)).toBeVisible();

  // A table that closed after the invite (the server answers 404 for a closed table's id here).
  await c.page.route('**/api/tables/e2e-together', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'table not found' } }) }));
  await c.page.goto(`/friends/${aId}`);
  await c.page.getByTestId('dm-invite').filter({ hasText: 'E2E Together' }).getByTestId('dm-invite-join').click();
  await expect(c.page.getByTestId('dm-invite').filter({ hasText: 'E2E Together' }).getByTestId('dm-invite-status')).toContainText(/닫혔거나|closed/);
  await c.page.unroute('**/api/tables/e2e-together');

  // Hours later the card no longer offers to join.
  await c.page.clock.setFixedTime(new Date(Date.now() + 3 * 3600_000));
  await c.page.goto(`/friends/${aId}`);
  await expect(c.page.getByTestId('dm-invite-expired')).toHaveCount(2);
  await expect(c.page.getByTestId('dm-invite-join')).toHaveCount(0);
});
