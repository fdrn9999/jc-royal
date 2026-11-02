import type { TableView } from '@jc/types';
import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import { balanceOf, checkOrCall, signUp, standUp, test } from './helpers';

/**
 * Plays the network for a page's table socket: drop() cuts the live connection (the server sees it close
 * too), and until restore() new connections hang the way they do with no network. Every message still
 * passes through; per connection it keeps the `state` views the server sent and the actions the page sent.
 */
async function flakyTableSocket(page: Page) {
  let offline: Promise<void> | null = null;
  let back = () => {};
  const sockets: WebSocketRoute[] = [];
  const states: TableView[][] = [];
  const actions: string[][] = [];
  await page.routeWebSocket(/\/ws\/tables\//, async (ws) => {
    sockets.push(ws);
    const seen: TableView[] = [];
    const sent: string[] = [];
    states.push(seen);
    actions.push(sent);
    if (offline) await offline;
    const server = ws.connectToServer();
    server.onMessage((message) => {
      ws.send(message);
      const msg = JSON.parse(String(message)) as { t: string; state?: TableView };
      if (msg.t === 'state') seen.push(msg.state!);
    });
    ws.onMessage((message) => {
      server.send(message);
      const msg = JSON.parse(String(message)) as { t: string; type?: string };
      if (msg.t === 'action') sent.push(msg.type!);
    });
  });
  return {
    sockets,
    states,
    actions,
    drop: async () => {
      offline = new Promise((r) => (back = r));
      await sockets.at(-1)!.close({ code: 4000, reason: 'network lost' });
    },
    restore: () => {
      offline = null;
      back();
    },
  };
}

test('game reconnect: after the network drops, the seat, stack and own cards come back and the hand plays on', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const net = await flakyTableSocket(a.page);
  await a.page.goto('/table/e2e-reconnect?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-reconnect?sit=1');
  await b.page.getByTestId('buyin-confirm').click();

  const mine = a.page.locator('[data-testid^=seat-]').filter({ hasText: a.nickname });
  const aOnB = b.page.locator('[data-testid^=seat-]').filter({ hasText: a.nickname });
  const lost = a.page.getByText(/연결이 끊겼습니다|Connection lost/);
  const faces = () => mine.locator('[data-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-card')));

  // A hand is dealt and A holds two face-up cards.
  await expect(mine.locator('[data-card]')).toHaveCount(2);
  const cards = await faces();
  const seat = await mine.getAttribute('data-testid');
  const before = net.states[0]!.at(-1)!;
  const seatIndex = before.you.seatIndex!;
  expect(before.hand).not.toBeNull();
  expect(before.seats[seatIndex]!.holeCards).toHaveLength(2);
  expect(before.hand!.deadline).not.toBeNull();
  // The cards on screen are marked, to tell after the reconnect whether they were drawn again (and dealt over).
  await mine.locator('[data-card]').evaluateAll((els) => els.forEach((e) => e.setAttribute('data-e2e-seen', '')));

  // The network drops mid-hand: A is told, and the table keeps A's seat while showing A as offline.
  await net.drop();
  const atDrop = net.states[0]!.at(-1)!;
  await expect(lost).toBeVisible();
  await expect(aOnB).toContainText(/오프라인|Offline/);
  // The client retries on its own; with no network the retry hangs and the banner stays.
  await expect.poll(() => net.sockets.length).toBe(2);
  await expect(lost).toBeVisible();
  expect(net.states[1]).toHaveLength(0);

  // Back online: the pending retry connects and the server's first state on the new connection (not the
  // view the page kept from before the drop) has the same hand, seat, stack and hole cards.
  net.restore();
  await expect.poll(() => net.states[1]!.length).toBeGreaterThan(0);
  const after = net.states[1]![0]!;
  expect(after.hand?.id).toBe(before.hand!.id);
  expect(after.you.seatIndex).toBe(seatIndex);
  expect(after.seats[seatIndex]!.userId).toBe(before.seats[seatIndex]!.userId);
  expect(after.seats[seatIndex]!.holeCards).toEqual(before.seats[seatIndex]!.holeCards);
  expect(after.seats[seatIndex]!.stack + after.seats[seatIndex]!.streetBet).toBe(before.seats[seatIndex]!.stack + before.seats[seatIndex]!.streetBet);
  // Nobody acted while A was away, and the turn's clock is the room's: the reconnect neither moved nor extended it.
  expect(after.hand!.seq).toBe(atDrop.hand!.seq);
  expect(after.hand!.deadline).toBe(atDrop.hand!.deadline);
  await expect(lost).toBeHidden();
  await expect(aOnB).not.toContainText(/오프라인|Offline/);
  await expect(mine).toHaveAttribute('data-testid', seat!);
  await expect(mine.locator('[data-card]')).toHaveCount(2);
  expect(await faces()).toEqual(cards);
  // The same card elements, not drawn again: nothing is dealt or turned over a second time.
  await expect(mine.locator('[data-card][data-e2e-seen]')).toHaveCount(2);
  const running = await mine.locator('[data-card]').evaluateAll((els) => els.flatMap((e) => e.getAnimations({ subtree: true })).filter((a) => a.playState === 'running').length);
  expect(running).toBe(0);
  expect(net.sockets).toHaveLength(2);
  await a.page.screenshot({ path: 'test-results/reconnect-restored.png' });

  // The hand plays on from the reconnected page: A's action bar comes back and A acts over the new connection.
  await expect(async () => {
    (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    await expect(a.page.getByText(/승리|Winner/).first()).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 60_000 });
  expect(net.actions[1]!.length).toBeGreaterThan(0);

  // Both stand up: every chip is back in the two wallets.
  await standUp(a.page);
  await standUp(b.page);
  await expect.poll(async () => (await balanceOf(a.page)) + (await balanceOf(b.page)), { timeout: 45_000 }).toBe(20_000);
});

test('game recovery: until the room sends its state on the new connection, the turn kept from before is locked and the banner says so', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  // When `hold` is set, the next connection reaches the room but nothing the room sends gets through until release().
  let hold = false;
  let release = () => {};
  const sockets: WebSocketRoute[] = [];
  await a.page.routeWebSocket(/\/ws\/tables\//, (ws) => {
    sockets.push(ws);
    const server = ws.connectToServer();
    let held: Promise<void> | null = null;
    if (hold) {
      hold = false;
      held = new Promise((r) => (release = r));
    }
    server.onMessage(async (message) => {
      if (held) await held;
      ws.send(message);
    });
    ws.onMessage((message) => server.send(message));
  });
  await a.page.goto('/table/e2e-recover?sit=1');
  await a.page.getByTestId('buyin-confirm').click();
  await b.page.goto('/table/e2e-recover?sit=1');
  await b.page.getByTestId('buyin-confirm').click();

  // Play on until it is A's turn.
  const bar = a.page.getByTestId('action-bar');
  await expect(async () => {
    if (!(await bar.isVisible())) await checkOrCall(b.page);
    await expect(bar).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 45_000 });
  const buttons = bar.getByRole('button', { name: /^(체크|Check|폴드|Fold)$|^(콜|Call)/ });
  await expect(buttons.first()).toBeEnabled();
  const banner = a.page.getByTestId('table-banner');

  // The connection drops on A's turn. The retry reaches the room, whose first state is held back.
  hold = true;
  await sockets.at(-1)!.close({ code: 4000, reason: 'network lost' });
  await expect.poll(() => sockets.length).toBe(2);
  // Connected again, the page shows the hand it had, but nothing is sent from it: its buttons are locked.
  await expect(banner).toHaveAttribute('data-recovery', 'restoring');
  await expect(banner).toContainText(/현재 핸드 복구 중|Restoring the current hand/);
  await expect(bar).toBeVisible();
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  await a.page.screenshot({ path: 'test-results/recovery-restoring.png' });

  // The room's state arrives: A is told it is back, the buttons open, and the note goes.
  release();
  await expect(banner).toHaveAttribute('data-recovery', 'restored');
  await expect(buttons.first()).toBeEnabled();
  await expect(banner).toBeHidden({ timeout: 5_000 });
  expect(await checkOrCall(a.page)).toBe(true);

  await standUp(a.page);
  await standUp(b.page);
  await expect.poll(async () => (await balanceOf(a.page)) + (await balanceOf(b.page)), { timeout: 45_000 }).toBe(20_000);
});
