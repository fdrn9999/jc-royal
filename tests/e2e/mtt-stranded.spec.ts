import { expect, type WebSocketRoute } from '@playwright/test';
import { sql } from './analytics-helpers';
import { signUp, test } from './helpers';

// A table the coordinator sent me to can break and close before I get there (tests/integration/mtt.test.ts meets this
// when the timing falls that way): the API refuses its socket, so no state, and with it no `movedTo`, ever comes. The
// page then asks the tournament where I sit and goes there. A multi-table tournament is off in this environment, so the
// tables do not exist and their sockets are refused for real (404); only the tournament's answer is made up.
test('mtt: a page sent to a table that closed first follows the tournament to the player\'s table', async ({ browser }) => {
  test.setTimeout(60_000);
  const { page } = await signUp(browser, { mobile: true });
  const tid = `e2e${Date.now().toString(36)}`;
  const asked: string[] = [];
  await page.route(`**/api/tournaments/${tid}`, (r) => {
    asked.push(new URL(r.request().url()).pathname);
    return r.fulfill({ json: { id: tid, format: 'mtt', status: 'running', me: { status: 'playing', place: null, tableId: `mtt-${tid}-3` } } });
  });
  const opened: string[] = [];
  page.on('websocket', (ws) => {
    if (ws.url().includes('/ws/tables/')) opened.push(new URL(ws.url()).pathname);
  });

  await page.goto(`/table/mtt-${tid}-2`);
  await expect(page).toHaveURL(new RegExp(`/table/mtt-${tid}-3$`), { timeout: 15_000 });
  expect(opened[0]).toBe(`/ws/tables/mtt-${tid}-2`);
  expect(asked[0]).toBe(`/api/tournaments/${tid}`);

  // Where the tournament says I already am, the page stays (and keeps trying this table, and asking).
  const before = asked.length;
  await expect.poll(() => asked.length, { timeout: 15_000 }).toBeGreaterThan(before + 1);
  await expect(page).toHaveURL(new RegExp(`/table/mtt-${tid}-3$`));
  expect(opened.filter((p) => p === `/ws/tables/mtt-${tid}-3`).length).toBeGreaterThan(1);
  await page.screenshot({ path: test.info().outputPath('mtt-stranded-390.png') });
});

// The table I sat at can also close while my connection is down (Codex r9 A): the page has that table's state, its
// socket no longer opens, and the `movedTo` it would have shown never comes. The page asks the tournament here too. The
// one state this MTT table sends is a real table's first state, played back; then its connection goes and stays gone.
test('mtt: a page that had its table and lost the connection while that table closed follows the tournament too', async ({ browser }) => {
  test.setTimeout(60_000);
  const { page } = await signUp(browser, { mobile: true });
  const tid = `e2e${Date.now().toString(36)}r`;
  const real = `e2e-mtt-src-${Date.now().toString(36)}`;
  sql(`INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in) VALUES ('${real}', 'E2E MTT Source', 6, 5, 10, 100, 1000)`);
  const asked: string[] = [];
  await page.route(`**/api/tournaments/${tid}`, (r) => {
    asked.push(new URL(r.request().url()).pathname);
    return r.fulfill({ json: { id: tid, format: 'mtt', status: 'running', me: { status: 'playing', place: null, tableId: `mtt-${tid}-3` } } });
  });
  let frame: string | null = null;
  const fake: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/tables\//, (ws) => {
    const path = new URL(ws.url()).pathname;
    if (path === `/ws/tables/${real}`) {
      const server = ws.connectToServer();
      server.onMessage((m) => {
        ws.send(m);
        if (!frame && (JSON.parse(String(m)) as { t: string }).t === 'state') frame = String(m);
      });
      ws.onMessage((m) => server.send(m));
      return;
    }
    if (path === `/ws/tables/mtt-${tid}-2`) {
      fake.push(ws);
      if (fake.length === 1) ws.send(frame!);
      else void ws.close({ code: 4000, reason: 'table gone' });
      return;
    }
    void ws.close({ code: 4000, reason: 'not here' });
  });

  await page.goto(`/table/${real}`);
  await expect.poll(() => frame !== null).toBe(true);
  await page.goto(`/table/mtt-${tid}-2`);
  await expect(page.getByTestId('table-title')).toContainText('E2E MTT Source');
  // While the table answers, nobody asks.
  expect(asked).toEqual([]);
  await fake[0]!.close({ code: 4000, reason: 'network lost' });
  await expect(page).toHaveURL(new RegExp(`/table/mtt-${tid}-3$`), { timeout: 15_000 });
  expect(asked[0]).toBe(`/api/tournaments/${tid}`);
});
