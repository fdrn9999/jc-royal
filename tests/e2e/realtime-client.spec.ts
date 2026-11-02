import { expect, type WebSocketRoute } from '@playwright/test';
import { signUp, test } from './helpers';

test('a sign-in gone while the socket was down: the next opening is refused, and the page signs out instead of trying on', async ({ browser }) => {
  const { page } = await signUp(browser);
  // The first socket is cut by the test; the ones after go to the server as they are.
  let first: WebSocketRoute | undefined;
  let sockets = 0;
  await page.routeWebSocket(/\/ws\/realtime/, (ws) => {
    sockets += 1;
    if (!first) first = ws;
    const server = ws.connectToServer();
    server.onMessage((m) => ws.send(m));
    ws.onMessage((m) => server.send(m));
    server.onClose((code, reason) => ws.close({ code, reason }));
  });
  await page.goto('/');
  await expect(page.getByTestId('bell')).toBeVisible();
  await expect.poll(() => sockets).toBe(1);

  // The sign-in ends where the hub cannot hear of it (here: its cookie goes), then the connection drops. The API refuses
  // the next opening with 401, which the page sees only as a socket that closed.
  await page.context().clearCookies();
  await first!.close({ code: 1011, reason: 'gone' });

  await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
  await expect(page.getByTestId('bell')).toHaveCount(0);
  // Signed out, it stops: no socket is opened for a sign-in that is gone.
  const opened = sockets;
  await page.waitForTimeout(5_000);
  expect(sockets).toBe(opened);
});

test('an account read begun before signing out does not sign the page back in when its answer comes late', async ({ browser }) => {
  const { page } = await signUp(browser);
  await page.goto('/');
  await expect(page.getByTestId('bell')).toBeVisible();

  // The next read of the account is answered by the server while still signed in, and that answer is held until the
  // sign-out is done.
  let taken!: () => void;
  const answered = new Promise<void>((r) => (taken = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let delivered!: () => void;
  const given = new Promise<void>((r) => (delivered = r));
  await page.route(
    '**/api/auth/me',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      taken();
      await held;
      await route.fulfill({ response: res });
      delivered();
    },
    { times: 1 },
  );
  // Coming back to the page reads the account.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await answered;

  await page.getByTestId('settings-open').click();
  await page.getByTestId('settings-logout').click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('bell')).toHaveCount(0);

  // A stale answer applied would show the signed-in header and leave the sign-in page, if only for a moment: its realtime
  // socket is refused (the sign-in is gone) and signs the page out again. So what the page shows is watched, not only
  // how it ends.
  await page.evaluate(() => {
    const w = window as unknown as { __back: string[] };
    w.__back = [];
    const look = () => {
      if (location.pathname !== '/login') w.__back.push(location.pathname);
      if (document.querySelector('[data-testid="bell"]')) w.__back.push('bell');
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
  });
  release();
  await given;
  await page.waitForTimeout(1_500);
  expect(await page.evaluate(() => (window as unknown as { __back: string[] }).__back)).toEqual([]);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('bell')).toHaveCount(0);
});
