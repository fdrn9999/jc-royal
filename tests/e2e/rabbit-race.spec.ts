import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import { expectHudBars, signUp, sitWith, test, widerThanDevice } from './helpers';

/**
 * Rabbit hunting against the room's own clock, in a real browser with the page's table connection held up on the way
 * (a proxy between the page and the real room): the request that reaches the room after the next deal, the one that is
 * lost, the room that refuses it, answers that come twice or for another hand, and a connection that drops with the
 * request on it. What the player pressed for is always answered or said, and nothing of a hand before is ever drawn on
 * the board of the hand played now.
 */
/** The pick button on the seat of the member named `nickname` (it carries their name). */
const seatOf = (page: Page, nickname: string) => page.locator(`[data-testid^="seat-pick-"][aria-label="${nickname}"]`);
/** The screens everything here has to fit: two phones (one of them also on its side), a tablet, a laptop, a desktop. */
const SCREENS = [[320, 568], [390, 844], [667, 375], [768, 1024], [1366, 768], [1920, 1080]] as const;
const fold = (page: Page) => page.getByTestId('action-bar').getByRole('button', { name: /^(폴드|Fold)/ });
const cardsIn = (page: Page, selector: string) => page.locator(selector).evaluateAll((els) => els.map((e) => e.getAttribute('data-card') ?? ''));

interface Ask {
  reqId: string;
  handId: string;
  raw: string;
}
interface Wire {
  /** Every `rabbit` request the page sent, in order. */
  asks: Ask[];
  /** The room's `rabbit` answers that reached the proxy. */
  answers: { reqId: string; handId: string; cards: string[] }[];
  /** How many hands the room has dealt since the page connected first. */
  deals: number;
  /** The hand the room shows now. */
  hand: string | null;
  toRoom: (raw: string) => void;
  toPage: (m: unknown) => void;
  /** Ends the connection, as a network that went away would. */
  cut: () => void;
}
interface Rules {
  /** A `rabbit` request from the page: true keeps it from the room. */
  ask?: (w: Wire, a: Ask) => boolean;
  /** The room dealt another hand (the state is already with the page). */
  deal?: (w: Wire) => void;
  /** The room's answer went to the page. */
  answered?: (w: Wire, a: Wire['answers'][number]) => void;
}

/** Puts a proxy on the page's table connection. */
async function wire(page: Page, rules: Rules): Promise<Wire> {
  let cur: { ws: WebSocketRoute; server: WebSocketRoute } | null = null;
  const w: Wire = {
    asks: [],
    answers: [],
    deals: 0,
    hand: null,
    toRoom: (raw) => cur?.server.send(raw),
    toPage: (m) => cur?.ws.send(JSON.stringify(m)),
    cut: () => {
      const c = cur;
      cur = null;
      void c?.server.close();
      void c?.ws.close();
    },
  };
  await page.routeWebSocket(/\/ws\/tables\//, (ws) => {
    const server = ws.connectToServer();
    const mine = { ws, server };
    cur = mine;
    server.onMessage((message) => {
      if (cur !== mine) return;
      ws.send(message);
      const m = JSON.parse(String(message)) as { t: string; reqId?: string; handId?: string; cards?: string[]; state?: { hand: { id: string } | null } };
      if (m.t === 'rabbit') {
        const a = { reqId: m.reqId!, handId: m.handId!, cards: m.cards! };
        w.answers.push(a);
        rules.answered?.(w, a);
      }
      if (m.t !== 'state' || !m.state?.hand) return;
      const dealt = w.hand !== null && m.state.hand.id !== w.hand;
      w.hand = m.state.hand.id;
      if (dealt) {
        w.deals++;
        rules.deal?.(w);
      }
    });
    ws.onMessage((message) => {
      if (cur !== mine) return;
      const raw = String(message);
      const m = JSON.parse(raw) as { t: string; reqId?: string; handId?: string };
      if (m.t === 'rabbit') {
        const a = { reqId: m.reqId!, handId: m.handId!, raw };
        w.asks.push(a);
        if (rules.ask?.(w, a)) return;
      }
      server.send(message);
    });
  });
  return w;
}

/** Both sit, and whoever is to act folds before the flop: the hand that has a rabbit hunt of five cards. */
async function foldedHand(a: Page, b: Page, table: string) {
  await sitWith(a, table, 1000);
  await sitWith(b, table, 1000);
  await expect(async () => {
    for (const p of [a, b]) {
      if (await fold(p).isVisible().catch(() => false)) return void (await fold(p).click());
    }
    throw new Error('nobody to act yet');
  }).toPass({ timeout: 45_000 });
  await expect(a.getByTestId('rabbit-hunt')).toBeVisible();
}

const boxes = (page: Page) =>
  page.evaluate(() =>
    ['table', 'board', 'table-stack'].map((id) => {
      const r = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
    }),
  );

/** The dock's own buttons the panel lies over: none, it stands in what the dock leaves free above them. */
const covered = (page: Page) =>
  page.evaluate(() => {
    const p = document.querySelector('[data-testid="rabbit-panel"]')!.getBoundingClientRect();
    return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="table-stack"] button'))
      .filter((b) => !b.closest('[data-testid="rabbit-panel"]'))
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top;
      })
      .map((b) => (b.textContent || b.getAttribute('aria-label') || b.dataset.testid) ?? '?');
  });

test('a rabbit hunt asked in time, its request reaching the room only after the next deal: answered as the hand before’s in a panel of its own, never on the board; pressed twice, sent once; on a 320 px phone', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  let held: Ask | null = null;
  const net = await wire(a.page, {
    ask: (_, x) => ((held = x), true),
    deal: (w) => {
      if (held) w.toRoom(held.raw);
      held = null;
    },
  });
  await foldedHand(a.page, b.page, 'e2e-rabbit-late');
  await a.page.setViewportSize({ width: 320, height: 568 });
  const ask = a.page.getByTestId('rabbit-hunt');
  // The icon, not the emoji.
  await expect(ask.locator('svg.lucide-rabbit')).toHaveCount(1);
  expect(await ask.innerText()).not.toMatch(/\p{Extended_Pictographic}/u);
  // The other player asks in time and sees the five cards on their own board.
  await b.page.getByTestId('rabbit-hunt').click();
  await expect(b.page.getByTestId('rabbit-card')).toHaveCount(5);
  const real = await cardsIn(b.page, '[data-testid="rabbit-card"]');

  await ask.tap();
  // Asked: the button is busy and takes no second press.
  await expect(ask).toBeDisabled();
  await expect(ask).toHaveAttribute('data-phase', 'requesting');
  await expect(ask).toContainText('카드 확인 중');
  await ask.tap({ force: true }).catch(() => {});
  await expect.poll(() => net.asks.length).toBe(1);
  await expect(a.page.getByTestId('rabbit-card')).toHaveCount(0);

  // The next hand is dealt, and only then does the request reach the room.
  await expect.poll(() => net.deals, { timeout: 20_000 }).toBe(1);
  const panel = a.page.getByTestId('rabbit-panel');
  await expect(panel).toHaveAttribute('data-phase', 'success');
  await expect(panel.getByTestId('rabbit-panel-hand')).toHaveText(/^이전 핸드 #\d+$/);
  await expect(panel.locator('svg.lucide-rabbit')).toHaveCount(1);
  await expect(panel).toHaveAccessibleName('래빗헌팅');
  await expect(panel).toContainText('실제 게임 결과에는 영향을 주지 않습니다.');
  // The same five cards the hand's deck held, and none of them on the board of the hand played now.
  expect(await cardsIn(a.page, '[data-testid="rabbit-panel-card"]')).toEqual(real);
  await expect(a.page.getByTestId('rabbit-card')).toHaveCount(0);
  await expect(a.page.getByTestId('rabbit-label')).toHaveCount(0);
  await expect(a.page.getByTestId('board').locator('.jc-card[data-card]')).toHaveCount(0);
  expect(net.asks).toHaveLength(1);
  expect(net.answers).toHaveLength(1);
  expect(net.answers[0]).toMatchObject({ reqId: net.asks[0]!.reqId, handId: net.asks[0]!.handId });
  expect(net.answers[0]!.handId).not.toBe(net.hand);
  // Inside the screen, and the table, the board and the dock are where they are without it.
  await expect(panel).toBeInViewport({ ratio: 1 });
  expect(await widerThanDevice(a.page)).toBe(false);
  expect(await covered(a.page)).toEqual([]);
  await a.page.screenshot({ path: 'test-results/rabbit-late-320.png', animations: 'disabled' });
  const withPanel = await boxes(a.page);
  await panel.getByTestId('rabbit-panel-close').tap();
  await expect(panel).toHaveCount(0);
  expect(await boxes(a.page)).toEqual(withPanel);
});

test('a rabbit hunt whose request is lost on the way: said as a failure, asked again with one press as a new request for the same hand, and answered although the next hand is being played', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  let lose = true;
  const net = await wire(a.page, { ask: () => lose });
  await foldedHand(a.page, b.page, 'e2e-rabbit-lost');
  await a.page.getByTestId('rabbit-hunt').click();
  await expect(a.page.getByTestId('rabbit-hunt')).toBeDisabled();
  // The next deal comes with no answer: it is still being asked, beside the game.
  const panel = a.page.getByTestId('rabbit-panel');
  await expect(panel).toHaveAttribute('data-phase', 'requesting', { timeout: 20_000 });
  await expect(panel).toContainText('카드 확인 중');
  expect(net.deals).toBe(1);
  // No answer: a failure with a way to ask again (not "too late", and not a toast over the game).
  await expect(panel).toHaveAttribute('data-phase', 'error', { timeout: 15_000 });
  await expect(panel).toContainText('응답을 받지 못했습니다.');
  await expect(a.page.getByTestId('table-stack').getByRole('alert')).toHaveCount(0);
  expect(await covered(a.page)).toEqual([]);
  await a.page.screenshot({ path: 'test-results/rabbit-failed-desktop.png', animations: 'disabled' });
  lose = false;
  await panel.getByTestId('rabbit-panel-retry').click();
  await expect(panel).toHaveAttribute('data-phase', 'success');
  await expect(panel.getByTestId('rabbit-panel-card')).toHaveCount(5);
  await expect(a.page.getByTestId('rabbit-card')).toHaveCount(0);
  expect(net.asks).toHaveLength(2);
  expect(net.asks[1]!.handId).toBe(net.asks[0]!.handId);
  expect(net.asks[1]!.reqId).not.toBe(net.asks[0]!.reqId);
  expect(net.answers).toEqual([expect.objectContaining({ reqId: net.asks[1]!.reqId, handId: net.asks[0]!.handId })]);
  expect(await covered(a.page)).toEqual([]);
  await a.page.screenshot({ path: 'test-results/rabbit-late-desktop.png', animations: 'disabled' });
});

test('a room that no longer answers for the hand before (an older game worker, or its time is up) refuses the late request: said as too late, with nothing to ask again, and it closes by itself', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  let held: Ask | null = null;
  const net = await wire(a.page, {
    ask: (_, x) => ((held = x), true),
    // What a room from before this change answers once the next hand is dealt.
    deal: (w) => held && w.toPage({ t: 'error', reqId: held.reqId, code: 'conflict', message: 'no finished hand to rabbit hunt' }),
  });
  await foldedHand(a.page, b.page, 'e2e-rabbit-old');
  await a.page.getByTestId('rabbit-hunt').click();
  const panel = a.page.getByTestId('rabbit-panel');
  await expect(panel).toHaveAttribute('data-phase', 'expired', { timeout: 20_000 });
  await expect(panel).toContainText('확인할 수 있는 시간이 지났습니다.');
  await expect(panel.getByTestId('rabbit-panel-retry')).toHaveCount(0);
  await expect(panel.getByTestId('rabbit-panel-card')).toHaveCount(0);
  await expect(a.page.getByTestId('table-stack').getByRole('alert')).toHaveCount(0);
  await expect(a.page.getByTestId('rabbit-card')).toHaveCount(0);
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  expect(net.asks).toHaveLength(1);
});

test('answers that come twice, for another hand, or unasked change nothing: the board shows the cards of its own hand’s answer, and an answer about a hand before never lands on the hand played now', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  const fake = ['2c', '2d', '2h', '2s', '3c'];
  const net = await wire(a.page, {
    answered: (w, x) => {
      // The same answer again, the same hand with other cards, and an answer about some other hand.
      w.toPage({ t: 'rabbit', ...x });
      w.toPage({ t: 'rabbit', reqId: x.reqId, handId: x.handId, cards: fake });
      w.toPage({ t: 'rabbit', reqId: 'nobody-asked', handId: 'some-other-hand', cards: fake });
    },
    deal: (w) => {
      // After the deal: about the hand before, and about the hand played now, which nobody asked.
      for (const handId of [w.asks[0]?.handId, w.hand]) w.toPage({ t: 'rabbit', reqId: w.asks[0]?.reqId ?? 'x', handId, cards: fake });
      w.toPage({ t: 'chat', message: { id: 'mark', userId: 'x', nickname: 'mark', text: 'after-the-fakes', at: Date.now() } });
    },
  });
  await foldedHand(a.page, b.page, 'e2e-rabbit-dup');
  await b.page.getByTestId('rabbit-hunt').click();
  await expect(b.page.getByTestId('rabbit-card')).toHaveCount(5);
  const real = await cardsIn(b.page, '[data-testid="rabbit-card"]');
  await a.page.getByTestId('rabbit-hunt').click();
  await expect(a.page.getByTestId('rabbit-card')).toHaveCount(5);
  await expect.poll(() => net.answers.length).toBe(1);
  expect(await cardsIn(a.page, '[data-testid="rabbit-card"]')).toEqual(real);
  await expect(a.page.getByTestId('rabbit-note')).toContainText('래빗헌팅 결과');
  await expect(a.page.getByTestId('rabbit-note').locator('svg.lucide-rabbit')).toHaveCount(1);
  await expect(a.page.getByTestId('rabbit-label').locator('svg.lucide-rabbit')).toHaveCount(1);
  expect(net.asks).toHaveLength(1);

  // The next hand: the fakes went to the page before this state was drawn; its board holds no card at all.
  await expect.poll(() => net.deals, { timeout: 20_000 }).toBe(1);
  await expect(a.page.getByTestId('rabbit-card')).toHaveCount(0);
  await expect(a.page.getByTestId('board').locator('.jc-card[data-card]')).toHaveCount(0);
  for (const c of await cardsIn(a.page, '[data-testid="rabbit-panel-card"]')) expect(real).toContain(c);
  // (The real answer is from a shuffled deck and may hold one of the fakes' cards itself: those say nothing.)
  for (const c of fake.filter((x) => !real.includes(x))) await expect(a.page.locator(`[data-testid="board"] [data-card="${c}"], [data-testid="rabbit-panel"] [data-card="${c}"]`)).toHaveCount(0);
});

test('the connection drops with the rabbit request on it: the page reconnects and sends the same request again by itself, and the cards are shown', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  const net = await wire(a.page, {
    ask: (w) => {
      if (w.asks.length > 1) return false;
      w.cut();
      return true;
    },
  });
  await foldedHand(a.page, b.page, 'e2e-rabbit-drop');
  await a.page.getByTestId('rabbit-hunt').click();
  // On the board if the page was back before the deal, in the panel of the hand before if not: the five cards either way.
  await expect(a.page.locator('[data-testid="rabbit-card"], [data-testid="rabbit-panel-card"]')).toHaveCount(5, { timeout: 20_000 });
  expect(net.asks).toHaveLength(2);
  expect(net.asks[1]).toMatchObject({ reqId: net.asks[0]!.reqId, handId: net.asks[0]!.handId });
  expect(net.answers).toHaveLength(1);
});

test('on two phones, a tablet, a laptop and a desktop: the panel of the hand before stands clear of the dock’s buttons and the board, and the HUD’s bars fit their card; figures asked for one seat never show in another’s card', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  let held: Ask | null = null;
  await wire(a.page, {
    ask: (_, x) => ((held = x), true),
    deal: (w) => {
      if (held) w.toRoom(held.raw);
      held = null;
    },
  });
  await foldedHand(a.page, b.page, 'e2e-rabbit-sizes');
  await a.page.getByTestId('rabbit-hunt').click();
  const panel = a.page.getByTestId('rabbit-panel');
  await expect(panel).toHaveAttribute('data-phase', 'success', { timeout: 20_000 });
  for (const [width, height] of SCREENS) {
    await a.page.setViewportSize({ width, height });
    await expect(panel, `${width}`).toBeInViewport({ ratio: 1 });
    expect(await widerThanDevice(a.page), `${width}`).toBe(false);
    expect(await covered(a.page), `${width}`).toEqual([]);
    // All of it inside its own box: the five cards and the button that closes it, none cut off at its edge.
    const out = await panel.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const parts = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="rabbit-panel-card"], [data-testid="rabbit-panel-close"], [data-testid="rabbit-panel-hand"]'));
      return parts.filter((x) => ((r) => r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)(x.getBoundingClientRect())).map((x) => x.dataset.testid);
    });
    expect(out, `${width}`).toEqual([]);
    await expect(panel.getByTestId('rabbit-panel-card'), `${width}`).toHaveCount(5);
    await expect(panel.getByTestId('rabbit-panel-close'), `${width}`).toBeInViewport({ ratio: 1 });
    // Clear of the board as well: nothing of the hand before over the cards of this one.
    const [p, board] = [(await panel.boundingBox())!, (await a.page.getByTestId('board').boundingBox())!];
    expect(p.y >= board.y + board.height || p.y + p.height <= board.y || p.x >= board.x + board.width || p.x + p.width <= board.x, `${width}`).toBe(true);
    await a.page.screenshot({ path: `test-results/rabbit-panel-${width}x${height}.png`, animations: 'disabled' });
  }
  await panel.getByTestId('rabbit-panel-close').click();

  // My own HUD, opened, on the same five screens.
  await seatOf(a.page, a.nickname).click();
  const card = a.page.getByTestId('player-card');
  const hud = card.getByTestId('seat-hud');
  await hud.getByTestId('seat-hud-more').click();
  for (const [width, height] of SCREENS) {
    await a.page.setViewportSize({ width, height });
    await expect.poll(() => expectHudBars(hud), `${width}`).toBe(8);
    expect(await widerThanDevice(a.page), `${width}`).toBe(false);
    const box = (await hud.boundingBox())!;
    expect(box.x, `${width}`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${width}`).toBeLessThanOrEqual(width);
    await a.page.screenshot({ path: `test-results/hud-bars-${width}x${height}.png`, animations: 'disabled' });
  }
  await a.page.setViewportSize({ width: 1440, height: 900 });
  await a.page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // My figures answered late, after I have gone on to the other seat (private): they are not drawn into that card.
  const aId = await a.page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);
  const mine = new RegExp(`/api/players/${aId}/hud`);
  await a.page.route(mine, async (route) => {
    await new Promise((done) => setTimeout(done, 1_500));
    await route.continue().catch(() => {});
  });
  const late = a.page.waitForResponse((r) => mine.test(r.url()));
  await seatOf(a.page, a.nickname).click();
  await expect(card).toContainText(a.nickname);
  await a.page.keyboard.press('Escape');
  await seatOf(a.page, b.nickname).click();
  await expect(card).toContainText(b.nickname);
  await expect(card.getByTestId('seat-hud-hidden')).toBeVisible();
  expect((await late).status()).toBe(200);
  await expect(card.getByTestId('seat-hud-hidden')).toBeVisible();
  await expect(a.page.getByTestId('seat-hud')).toHaveCount(0);
  await expect(a.page.locator('[data-fill]')).toHaveCount(0);
});
