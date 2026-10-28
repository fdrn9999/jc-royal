import { expect, type Page, type Route } from '@playwright/test';
import { signUp, test } from './helpers';

/** Same-origin JSON call with the page's session. */
async function call<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return (await r.json()) as T;
    },
    [path, body] as const,
  );
}
const idOf = async (page: Page) => (await call<{ id: string }>(page, '/api/auth/me')).id;

/**
 * The realtime socket with its hello held back until `open()`. Until then the page counts it as not yet up, and what
 * the server sends is dropped: no event reaches a page before its socket is up. `open()` returns once the page has
 * answered the hello with its topics and its screens had a moment to take the socket being up.
 */
async function heldHello(page: Page) {
  let opened = false;
  const held: (() => void)[] = [];
  let subscribed: (() => void) | undefined;
  await page.routeWebSocket(/\/ws\/realtime/, (ws) => {
    const server = ws.connectToServer();
    let open = opened;
    let hello: string | undefined;
    held.push(() => {
      open = true;
      if (hello) ws.send(hello);
    });
    server.onMessage((m) => {
      if (open) ws.send(m);
      else if (String(m).includes('"hello"')) hello = String(m);
    });
    ws.onMessage((m) => {
      server.send(m);
      // A page sends its topics on every hello (and whenever a screen asks for one, hello or not).
      if (open && String(m).includes('"sub"')) subscribed?.();
    });
  });
  return {
    async open() {
      const sub = new Promise<void>((r) => (subscribed = r));
      opened = true;
      for (const f of held) f();
      await sub;
      await page.waitForTimeout(1_000);
    },
  };
}

/** The first request `match` sees: the server answers it now (its read is taken now), and the page gets the answer only on `answer()`. */
async function holdFirst(page: Page, match: (r: Route) => boolean) {
  let answer: (() => Promise<void>) | undefined;
  let held: () => void = () => undefined;
  const seen = new Promise<void>((r) => (held = r));
  let taken = false;
  await page.route(/\/api\//, async (route) => {
    if (taken || !match(route)) return route.fallback();
    taken = true;
    const res = await route.fetch();
    answer = () => route.fulfill({ response: res });
    held();
  });
  return { seen, answer: () => answer!() };
}

test('realtime: a room opened after the lobby\'s first read and before its socket is up shows once the socket is up, without waiting for the next poll', async ({ browser }) => {
  const host = await signUp(browser);
  const { page: first } = await signUp(browser);
  const page = await first.context().newPage();
  const sock = await heldHello(page);
  const read = await holdFirst(page, (r) => r.request().method() === 'GET' && new URL(r.request().url()).pathname === '/api/tables');
  await page.goto('/');
  await read.seen;

  // A room opens after that read; the page has not subscribed yet, so no event will tell it.
  const name = `RS ${Date.now() % 100_000}`;
  const id = await host.page.evaluate(async (n) => {
    const r = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n, maxSeats: 6, bigBlind: 10, minBuyIn: 100, maxBuyIn: 1000 }) });
    return ((await r.json()) as { id: string }).id;
  }, name);
  await page.waitForTimeout(1_000);
  // The socket comes up while that read is still on its way; then its answer, without the room, arrives.
  await sock.open();
  await read.answer();
  // With the socket up the list is polled once a minute: only a read begun after the socket came up shows the room.
  await expect(page.locator(`[data-testid="lobby-table"][data-table="${id}"]`)).toContainText(name, { timeout: 10_000 });
  expect(await host.page.evaluate(async (t) => (await fetch(`/api/rooms/${t}/close`, { method: 'POST' })).status, id)).toBe(200);
});

test('realtime: a message sent while an open conversation\'s poll is out and before the socket is up shows once the socket is up', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const [aId, bId] = [await idOf(a.page), await idOf(b.page)];
  await call(a.page, '/api/friends/requests', { userId: bId });
  await call(b.page, `/api/friends/${aId}/accept`, {});
  const page = await a.page.context().newPage();
  const sock = await heldHello(page);
  await page.goto(`/friends/${bId}`);
  await expect(page.getByTestId('dm-title')).toHaveText(b.nickname);

  // Without the socket the conversation is polled every few seconds: the next poll is read now, answered later.
  const poll = await holdFirst(page, (r) => /^\/api\/dm\/[^/]+$/.test(new URL(r.request().url()).pathname) && new URL(r.request().url()).searchParams.has('afterSeq'));
  await poll.seen;
  // B writes after that read; its event never reaches the page (the socket is not up yet).
  await call(b.page, `/api/dm/${aId}`, { text: '소켓이 열리기 전에 보낸 메시지' });
  await page.waitForTimeout(1_000);
  await sock.open();
  await poll.answer();
  // With the socket up the conversation is polled every 30 s: only a poll begun after the socket came up shows it.
  await expect(page.getByTestId('dm-theirs').filter({ hasText: '소켓이 열리기 전에' })).toBeVisible({ timeout: 10_000 });
});

/** Two friends; `a` gets a second page, the one under test. */
async function friends(browser: Parameters<typeof signUp>[0]) {
  const a = await signUp(browser);
  const b = await signUp(browser);
  const [aId, bId] = [await idOf(a.page), await idOf(b.page)];
  await call(a.page, '/api/friends/requests', { userId: bId });
  await call(b.page, `/api/friends/${aId}/accept`, {});
  return { b, aId, bId, page: await a.page.context().newPage() };
}
const firstRead = (bId: string) => (r: Route) => {
  const u = new URL(r.request().url());
  return r.request().method() === 'GET' && u.pathname === `/api/dm/${bId}` && !u.searchParams.has('afterSeq');
};

test('realtime: a message sent while a conversation\'s first read is out and before the socket is up shows once both are', async ({ browser }) => {
  const { b, aId, bId, page } = await friends(browser);
  const sock = await heldHello(page);
  const read = await holdFirst(page, firstRead(bId));
  await page.goto(`/friends/${bId}`);
  await read.seen;

  // B writes after that read; its event never reaches the page (the socket is not up yet).
  await call(b.page, `/api/dm/${aId}`, { text: '첫 읽기 중에 보낸 메시지' });
  await page.waitForTimeout(1_000);
  // The socket comes up while the conversation is still being read; then that read, without the message, lands.
  await sock.open();
  await read.answer();
  await expect(page.getByTestId('dm-title')).toHaveText(b.nickname);
  // With the socket up the conversation is polled every 30 s: only a poll asked for while it was being read shows it.
  await expect(page.getByTestId('dm-theirs').filter({ hasText: '첫 읽기 중에' })).toBeVisible({ timeout: 10_000 });
});

test('realtime: a message whose event comes while a conversation\'s first read is out shows once that read lands', async ({ browser }) => {
  const { b, aId, bId, page } = await friends(browser);
  // The socket is up on the friends list: going to the conversation keeps it (no new hello).
  let events: (f: string) => void = () => undefined;
  const up = new Promise<void>((resolve) =>
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/ws/realtime')) return;
      ws.on('framereceived', (f) => {
        if (String(f.payload).includes('"hello"')) resolve();
        events(String(f.payload));
      });
    }),
  );
  await page.goto('/friends');
  await up;
  const read = await holdFirst(page, firstRead(bId));
  await page.getByTestId('friend-row').filter({ hasText: b.nickname }).click();
  await read.seen;

  // B writes after that read; its event reaches the page while the conversation is still being read.
  const delivered = new Promise<void>((r) => (events = (m) => m.includes('social.dm.created') && r()));
  await call(b.page, `/api/dm/${aId}`, { text: '첫 읽기 중에 온 알림' });
  await delivered;
  await page.waitForTimeout(500);
  await read.answer();
  await expect(page.getByTestId('dm-title')).toHaveText(b.nickname);
  await expect(page.getByTestId('dm-theirs').filter({ hasText: '첫 읽기 중에 온' })).toBeVisible({ timeout: 10_000 });
});
