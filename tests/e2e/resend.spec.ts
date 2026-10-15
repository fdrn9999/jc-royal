import { expect } from '@playwright/test';
import { balanceOf, signUp, test } from './helpers';

test('a buy-in whose answer was lost with the connection is sent again and applied once', async ({ browser }) => {
  const a = await signUp(browser);
  /** Per connection: the sit commands the page sent on it. */
  const sits: { reqId: string; buyIn: number }[][] = [];
  await a.page.routeWebSocket(/\/ws\/tables\//, (ws) => {
    const n = sits.push([]) - 1;
    const server = ws.connectToServer();
    // Once the first connection has carried a sit, nothing more from the room gets through on it.
    let cut = false;
    ws.onMessage((message) => {
      const msg = JSON.parse(String(message)) as { t: string; reqId?: string; buyIn?: number };
      if (msg.t === 'sit') sits[n]!.push({ reqId: msg.reqId!, buyIn: msg.buyIn! });
      server.send(message);
      if (msg.t === 'sit' && n === 0) cut = true;
    });
    server.onMessage((message) => {
      if (!cut) return ws.send(message);
      const msg = JSON.parse(String(message)) as { t: string; reqId?: string };
      // The room took the seat and answered; the answer goes down with the connection.
      if (msg.t === 'ack' && msg.reqId === sits[0]![0]!.reqId) void ws.close({ code: 4000, reason: 'network lost' });
    });
  });
  await a.page.goto('/table/e2e-resend?sit=1');
  await a.page.getByTestId('buyin-confirm').click();

  // The page reconnects by itself and sends the same command, with the same id, again.
  await expect.poll(() => sits[1]?.length ?? 0, { timeout: 20_000 }).toBe(1);
  expect(sits[1]![0]).toEqual(sits[0]![0]);
  // The room answers that copy without seating anyone twice: the dialog closes and A is in one seat.
  await expect(a.page.getByTestId('buyin-confirm')).toBeHidden();
  await expect(a.page.locator('[data-testid^=seat-]').filter({ hasText: a.nickname })).toHaveCount(1);
  await expect(a.page.getByRole('alert')).toHaveCount(0);
  const { buyIn } = sits[0]![0]!;
  expect(await balanceOf(a.page)).toBe(10_000 - buyIn);
  const ledger = await a.page.evaluate(async () => (await (await fetch('/api/me/ledger')).json()) as { type: string }[]);
  expect(ledger.filter((e) => e.type === 'buy_in')).toHaveLength(1);
  expect(sits).toHaveLength(2);
});
