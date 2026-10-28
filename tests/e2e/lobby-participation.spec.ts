import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { balanceOf, signUp, sitWith, standUp, test } from './helpers';

/**
 * The lobby knows the tables I sit at or wait for, and takes me back to them: my seat (same seat, stack and cards, no
 * second buy-in, whatever the table takes from newcomers) and my place on a waitlist (a look at it, never a second
 * sign-up). Everyone else keeps the table's rules: the waitlist on a full table, no hands without spectating, the code
 * on a private one.
 */

const MINE = 'e2e-mine'; // 2 seats, no spectators
const WAIT = 'e2e-mine-wait'; // 2 seats, spectators welcome
const VAULT = 'e2e-mine-vault'; // 2 seats, private (mine-99), no spectators
const SWITCH = 'e2e-mine-switch'; // 2 seats, spectators welcome

const cardOf = (page: Page, id: string) => page.locator(`[data-testid=lobby-table][data-table=${id}]`);
const myGame = (page: Page, id: string) => page.locator(`[data-testid=lobby-my-game][data-table=${id}]`);
const seatOf = (page: Page, nickname: string) => page.locator('[data-testid^=seat-]').filter({ hasText: nickname });
const logo = (page: Page) => page.getByRole('link', { name: /^(로비|Lobby)$/ }).first();
const atTable = (id: string) => new RegExp(`/table/${id}$`);

/** The face-up cards on a seat, sorted (the order drawn is not the point here). */
async function cardsOn(seat: Locator) {
  const faces = seat.locator('.jc-card[data-card]');
  await expect(faces).toHaveCount(2);
  return (await faces.evaluateAll((els) => els.map((e) => e.getAttribute('data-card')!))).sort();
}

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

test('participation: back from the lobby to my own seat — the same seat, stack and cards, nothing paid again; a full table without spectating keeps the others out', async ({ browser }) => {
  const a = await signUp(browser);
  await sitWith(a.page, MINE, 500);
  const b = await signUp(browser);
  await sitWith(b.page, MINE, 500);
  // The hand is dealt; nobody acts (a minute a turn), so it is the same hand when A comes back.
  const seat = seatOf(a.page, a.nickname);
  const cards = await cardsOn(seat);
  const seatId = await seat.getAttribute('data-testid');
  const stack = await seat.locator('[data-testid^=stack-]').textContent();
  const balance = await balanceOf(a.page);

  // To the lobby by the logo: the first time, the table says the seat and the clock stay.
  await logo(a.page).click();
  await expect(a.page.getByTestId('lobby-ask')).toContainText(/좌석은 유지되며|keeps your seat/);
  await a.page.screenshot({ path: 'test-results/participation-lobby-ask.png' });
  await a.page.getByTestId('lobby-ask-go').click();
  await expect(a.page.getByTestId('quick-play')).toBeVisible();

  // My table: the badge beside the others, one way back, no watch, join or waitlist; and at the top, 내 게임.
  const mine = cardOf(a.page, MINE);
  await expect(mine.getByTestId('lobby-mine-badge')).toHaveText(/^(내가 참여 중|You're Seated)$/);
  await expect(mine.getByTestId('full-badge')).toBeVisible();
  await expect(mine.getByTestId('lobby-continue')).toHaveText(/^(계속 플레이|Continue Playing)$/);
  for (const id of ['lobby-watch', 'lobby-enter', 'lobby-view-waitlist', 'lobby-wait-hint']) await expect(mine.getByTestId(id)).toHaveCount(0);
  await expect(myGame(a.page, MINE)).toHaveAttribute('data-kind', 'seat');
  await expect(myGame(a.page, MINE)).toContainText(/계속 플레이|Continue Playing/);
  await a.page.screenshot({ path: 'test-results/participation-my-games.png' });
  await mine.scrollIntoViewIfNeeded();
  await mine.screenshot({ path: 'test-results/participation-seated-card.png' });

  // Back: the same seat in the same hand, the same stack and cards, no buy-in and nothing taken from the wallet.
  await mine.getByTestId('lobby-continue').click();
  await expect(a.page).toHaveURL(atTable(MINE));
  await expect(seat).toHaveAttribute('data-testid', seatId!);
  expect(await cardsOn(seat)).toEqual(cards);
  await expect(seat.locator('[data-testid^=stack-]')).toHaveText(stack!);
  await expect(a.page.getByTestId('buyin-confirm')).toHaveCount(0);
  await expect(a.page.getByTestId('arrival-note')).toHaveCount(0);
  expect(await balanceOf(a.page)).toBe(balance);

  // An old ?sit=1 link while seated: said so, never a second seat. The note is in the status line, which the action bar
  // takes on my turn, so it is the one of the two not to act who opens the link.
  await expect.poll(async () => (await a.page.getByTestId('action-bar').count()) + (await b.page.getByTestId('action-bar').count())).toBe(1);
  const idle = (await a.page.getByTestId('action-bar').count()) ? b : a;
  const idleSeat = seatOf(idle.page, idle.nickname);
  const idleId = await idleSeat.getAttribute('data-testid');
  const idleBalance = await balanceOf(idle.page);
  await idle.page.goto(`/table/${MINE}?sit=1`);
  await expect(idle.page.getByTestId('arrival-note')).toHaveAttribute('data-kind', 'seated');
  await expect(idle.page.getByTestId('arrival-note')).toContainText(/내 좌석으로 돌아왔습니다|back at your seat/);
  await expect(idle.page.getByTestId('buyin-confirm')).toHaveCount(0);
  await expect(idleSeat).toHaveAttribute('data-testid', idleId!);
  await expect(idle.page).toHaveURL(atTable(MINE));
  expect(await balanceOf(idle.page)).toBe(idleBalance);

  // Asked once only. A filter that hides the table leaves 내 게임 above it; quick play asks before finding another.
  await logo(a.page).click();
  await expect(a.page.getByTestId('lobby-ask')).toHaveCount(0);
  await expect(a.page.getByTestId('quick-play')).toBeVisible();
  await a.page.getByTestId('lobby-filter-empty').click();
  await expect(cardOf(a.page, MINE)).toHaveCount(0);
  await expect(myGame(a.page, MINE)).toBeVisible();
  await a.page.getByTestId('quick-go').click();
  await expect(a.page.getByTestId('quick-seated')).toContainText(/현재 참여 중인 게임|already have a game/);
  await expect(a.page).not.toHaveURL(/\/table\//);
  await a.page.getByTestId('quick-back').click();
  await expect(a.page).toHaveURL(atTable(MINE));
  await expect(seat).toHaveAttribute('data-testid', seatId!);

  // A newcomer: the full table offers the waitlist and no watching; straight to it, the hands stay hidden.
  const c = await signUp(browser);
  const theirs = cardOf(c.page, MINE);
  await expect(theirs.getByTestId('lobby-enter')).toHaveAttribute('data-entry', 'wait');
  await expect(theirs.getByTestId('lobby-watch')).toBeDisabled();
  for (const id of ['lobby-mine-badge', 'lobby-continue']) await expect(theirs.getByTestId(id)).toHaveCount(0);
  await expect(myGame(c.page, MINE)).toHaveCount(0);
  await c.page.goto(`/table/${MINE}`);
  await expect(c.page.getByTestId('viewer-status')).toContainText(/관전할 수 없는 테이블|Spectating is off/);
  for (const nick of [a.nickname, b.nickname]) {
    await expect(seatOf(c.page, nick)).toBeVisible();
    await expect(seatOf(c.page, nick).locator('.jc-card[data-card]')).toHaveCount(0);
  }

  // An invite to the table B sits at: the way back to that seat, not a buy-in.
  await befriend(a.page, b.page);
  await call(a.page, `/api/friends/${await idOf(b.page)}/invite`, { tableId: MINE });
  await b.page.goto(`/friends/${await idOf(a.page)}`);
  const invite = b.page.getByTestId('dm-invite').filter({ hasText: 'E2E Mine' });
  await invite.getByTestId('dm-invite-join').click();
  await expect(invite.getByTestId('dm-invite-status')).toContainText(/이미 참여 중인 테이블|already playing at this table/);
  await b.page.screenshot({ path: 'test-results/participation-invite-seated.png' });
  await invite.getByTestId('dm-invite-continue').click();
  await expect(b.page).toHaveURL(atTable(MINE));
  await expect(seatOf(b.page, b.nickname)).toBeVisible();
  await expect(b.page.getByTestId('buyin-confirm')).toHaveCount(0);
});

test('participation: my place on a waitlist — shown in the lobby and the invite, looked at without signing up again; a freed seat kept for it is said so', async ({ browser }) => {
  const a = await signUp(browser);
  await sitWith(a.page, WAIT, 500);
  const b = await signUp(browser);
  await sitWith(b.page, WAIT, 500);

  const c = await signUp(browser);
  const card = cardOf(c.page, WAIT);
  await expect(card.getByTestId('lobby-enter')).toHaveAttribute('data-entry', 'wait');
  await card.getByTestId('lobby-enter').click();
  await expect(c.page).toHaveURL(atTable(WAIT));
  await expect(c.page.getByTestId('viewer-status')).toContainText(/대기열 1번째|#1 on the waitlist/);

  // The lobby: my place, and a look at it instead of joining again.
  await c.page.goto('/');
  await expect(card.getByTestId('lobby-waiting-badge')).toHaveText(/^(내가 대기 중|You're Waiting)$/);
  await expect(card.getByTestId('lobby-wait-place')).toHaveText(/^(대기열 1번째|No\. 1 on the waitlist)$/);
  await expect(card.getByTestId('lobby-view-waitlist')).toHaveText(/^(대기 현황 확인|View Waitlist)$/);
  for (const id of ['lobby-enter', 'lobby-watch', 'lobby-continue', 'lobby-mine-badge']) await expect(card.getByTestId(id)).toHaveCount(0);
  await expect(card).toContainText(/대기 1|Waitlist 1/);
  await expect(myGame(c.page, WAIT)).toHaveAttribute('data-kind', 'wait');
  await expect(myGame(c.page, WAIT)).toContainText(/대기열 1번째|No\. 1 on the waitlist/);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: 'test-results/participation-waiting-card.png' });

  await card.getByTestId('lobby-view-waitlist').click();
  await expect(c.page).toHaveURL(atTable(WAIT));
  await expect(c.page.getByTestId('arrival-note')).toHaveAttribute('data-kind', 'waiting');
  await expect(c.page.getByTestId('viewer-status')).toContainText(/대기열 1번째|#1 on the waitlist/);
  // An old ?wait=1 link: said so, and nothing sent (joining again would put C at the back).
  await c.page.goto(`/table/${WAIT}?wait=1`);
  await expect(c.page.getByTestId('arrival-note')).toHaveAttribute('data-kind', 'waiting');
  await expect(c.page.getByTestId('viewer-status')).toContainText(/대기열 1번째|#1 on the waitlist/);

  // A second player waits behind C; each sees only their own place.
  const d = await signUp(browser);
  await cardOf(d.page, WAIT).getByTestId('lobby-enter').click();
  await expect(d.page.getByTestId('viewer-status')).toContainText(/대기열 2번째|#2 on the waitlist/);
  await d.page.goto('/');
  await expect(cardOf(d.page, WAIT).getByTestId('lobby-wait-place')).toHaveText(/대기열 2번째|No\. 2 on the waitlist/);
  await c.page.goto('/');
  await expect(card.getByTestId('lobby-wait-place')).toHaveText(/대기열 1번째|No\. 1 on the waitlist/);
  await expect.poll(async () => (await call<{ waitlist: number; myParticipation: unknown }>(c.page, `/api/tables/${WAIT}`)).myParticipation).toEqual({ status: 'waiting', position: 1 });

  // An invite to the table C waits for: a look at the place, not a second sign-up.
  await befriend(a.page, c.page);
  await call(a.page, `/api/friends/${await idOf(c.page)}/invite`, { tableId: WAIT });
  await c.page.goto(`/friends/${await idOf(a.page)}`);
  const invite = c.page.getByTestId('dm-invite').filter({ hasText: 'E2E Mine Waitlist' });
  await invite.getByTestId('dm-invite-join').click();
  await expect(invite.getByTestId('dm-invite-status')).toContainText(/대기열 1번째|No\. 1 on this table's waitlist/);
  await invite.getByTestId('dm-invite-view-waitlist').click();
  await expect(c.page).toHaveURL(atTable(WAIT));
  await expect(c.page.getByTestId('viewer-status')).toContainText(/대기열 1번째|#1 on the waitlist/);

  // A stands up: the seat is kept for C, and A, sent back to sit, is told so; A's card no longer says it is A's.
  await standUp(a.page);
  // The hand A folded ends first; then the seat frees and is held for the head of the waitlist.
  await expect(a.page.getByText(new RegExp(`${c.nickname}님을 위해 좌석이 예약|reserved for ${c.nickname}`))).toBeVisible({ timeout: 30_000 });
  await a.page.goto(`/table/${WAIT}?sit=1`);
  await expect(a.page.getByTestId('arrival-note')).toHaveAttribute('data-kind', 'held');
  await expect(a.page.getByTestId('arrival-note')).toContainText(/예약되어 있습니다|kept for players on the waitlist/);
  await expect(a.page.getByTestId('buyin-confirm')).toHaveCount(0);
  await a.page.goto('/');
  await expect(cardOf(a.page, WAIT).getByTestId('lobby-mine-badge')).toHaveCount(0);
  await expect(myGame(a.page, WAIT)).toHaveCount(0);
});

test('participation: a private table takes its seated player back without the code; everyone else still needs it, and no seat lends access', async ({ browser }) => {
  const a = await signUp(browser);
  await cardOf(a.page, VAULT).getByTestId('lobby-enter').click();
  await a.page.getByTestId('join-code').fill('mine-99');
  await a.page.getByTestId('join-code-go').click();
  await expect(a.page).toHaveURL(new RegExp(`/table/${VAULT}`));
  await a.page.getByTestId('buyin-confirm').click();
  await expect(seatOf(a.page, a.nickname)).toBeVisible();
  // The access ticket is gone (expired, another device): the seat alone takes A back.
  await a.page.context().clearCookies({ name: `jc_room_${VAULT}` });
  await a.page.goto('/');
  const mine = cardOf(a.page, VAULT);
  await expect(mine.getByTestId('lobby-mine-badge')).toBeVisible();
  await expect(mine.getByTestId('lobby-enter')).toHaveCount(0);
  await mine.getByTestId('lobby-continue').click();
  await expect(a.page).toHaveURL(atTable(VAULT));
  await expect(seatOf(a.page, a.nickname)).toBeVisible();
  await expect(a.page.getByTestId('join-code')).toHaveCount(0);
  await expect(a.page.getByText(/비공개 방입니다|This is a private room/)).toHaveCount(0);
  await expect(a.page.getByTestId('buyin-confirm')).toHaveCount(0);

  // A newcomer: the lobby asks for the code, and the table without it stays locked; A's seat lends nothing.
  const b = await signUp(browser);
  const theirs = cardOf(b.page, VAULT);
  for (const id of ['lobby-mine-badge', 'lobby-continue']) await expect(theirs.getByTestId(id)).toHaveCount(0);
  await theirs.getByTestId('lobby-enter').click();
  await expect(b.page.getByTestId('join-code')).toBeVisible();
  await b.page.getByRole('dialog').getByRole('button', { name: /^(취소|Cancel)$/ }).click();
  for (const path of [`/table/${VAULT}`, `/table/${VAULT}?sit=1`]) {
    await b.page.goto(path);
    await expect(b.page.getByText(/비공개 방입니다|This is a private room/)).toBeVisible();
    await expect(b.page.getByTestId('buyin-confirm')).toHaveCount(0);
  }
  expect((await call<{ myParticipation: unknown }>(b.page, `/api/tables/${VAULT}`)).myParticipation).toEqual({ status: 'none' });
});

test("participation: another tab switching this browser to another account never leaves the previous account's seat in the lobby, even when the list does not come or an old one arrives late", async ({ browser }) => {
  const a = await signUp(browser);
  await sitWith(a.page, SWITCH, 500);
  await a.page.goto('/');
  await expect(cardOf(a.page, SWITCH).getByTestId('lobby-mine-badge')).toBeVisible();
  await expect(myGame(a.page, SWITCH)).toBeVisible();
  const aList = await call(a.page, '/api/tables');

  // A refresh goes out as A and its answer is held back; every list asked after it fails.
  let held: Route | null = null;
  await a.page.route('**/api/tables', (r) => {
    if (!held) held = r;
    else void r.abort();
  });
  await a.page.getByTestId('lobby-refresh').click();
  await expect.poll(() => !!held).toBe(true);

  // Another tab of this browser signs out and signs in as B: the cookies are B's, and this tab learns it on focus.
  const b = await signUp(browser);
  await a.page.context().addCookies(await b.page.context().cookies());
  const switched = a.page.waitForResponse((r) => r.url().endsWith('/api/auth/me'));
  await a.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await switched;
  await expect(a.page.getByTestId('balance')).toHaveText(await b.page.getByTestId('balance').innerText());
  // A's answer arrives only now.
  await held!.fulfill({ json: aList }).catch(() => {});
  await a.page.waitForTimeout(1_000);
  for (const id of ['lobby-mine-badge', 'lobby-continue']) await expect(a.page.getByTestId(id)).toHaveCount(0);
  await expect(a.page.getByTestId('lobby-my-game')).toHaveCount(0);

  // B's own list, once it comes: the table is one B may join; A's seat is still A's.
  await a.page.unroute('**/api/tables');
  await a.page.getByTestId('lobby-refresh').click();
  await expect(cardOf(a.page, SWITCH).getByTestId('lobby-enter')).toHaveAttribute('data-entry', 'join');
  await expect(a.page.getByTestId('lobby-mine-badge')).toHaveCount(0);
  expect((await call<{ myParticipation: unknown }>(a.page, `/api/tables/${SWITCH}`)).myParticipation).toEqual({ status: 'none' });
});