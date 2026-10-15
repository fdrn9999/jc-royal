import type { HandDetailDto, HandSummaryDto } from '@jc/types';
import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, test, widerThanDevice } from './helpers';

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

/** Face-up cards on the replay's board and in one seat. */
const faceUp = (page: Page, seat: number) =>
  page.evaluate(
    (i) => {
      const r = document.querySelector('[data-testid=hand-replay]')!;
      return { board: r.querySelectorAll('[data-testid=board] [data-card]').length, seat: r.querySelectorAll(`[data-testid=seat-${i}] [data-card]`).length };
    },
    seat,
  );

/** On screen and not covered anywhere along its middle, top to bottom, so a tap lands on it without scrolling. */
const reachable = (page: Page, testId: string) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-testid=${id}]`)!;
    const r = el.getBoundingClientRect();
    const covered = [0.1, 0.5, 0.9].some((f) => {
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height * f);
      return !hit || !el.contains(hit);
    });
    return r.top >= 0 && r.bottom <= innerHeight && !covered;
  }, testId);

/** A screenshot once the cards dealt or turned over by the last step have finished moving. */
async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(900);
  await page.screenshot({ path: test.info().outputPath(name), fullPage });
}

test('mobile: a finished hand replays action by action on the table, hiding the other hand until the showdown', async ({ browser }) => {
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser);
  await b.page.goto('/table/e2e-replay?sit=1');
  await b.page.getByTestId('buyin-confirm').click();
  await a.page.goto('/table/e2e-replay?sit=1');
  await a.page.getByTestId('buyin-confirm').tap();

  // Check a hand down to the river: both hands are shown down.
  let hand: HandDetailDto | undefined;
  await expect(async () => {
    (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    for (const s of (await call<HandSummaryDto[]>(a.page, '/api/me/hands')).filter((x) => x.board.length === 5)) {
      const d = await call<HandDetailDto>(a.page, `/api/me/hands/${s.id}`);
      if (d.players.length === 2 && d.players.every((p) => p.holeCards)) hand = d;
    }
    expect(hand).toBeDefined();
  }).toPass({ timeout: 120_000 });
  const h = hand!;
  const me = h.players.find((p) => p.isYou)!.seatIndex;
  const opp = h.players.find((p) => !p.isYou)!.seatIndex;

  await a.page.goto(`/me/hands/${h.id}`);
  const replay = a.page.getByTestId('hand-replay');
  await expect(replay).toBeVisible();
  const index = a.page.getByTestId('replay-index');
  const total = Number((await index.textContent())!.split('/')[1]);
  // Deal, at least the blinds' callers and checks, three streets, the showdown and the payout.
  expect(total).toBeGreaterThanOrEqual(10);
  await expect(index).toHaveText(`1/${total}`);
  await expect(a.page.getByTestId('replay-step')).toHaveText(/카드 배분|Cards dealt/);
  expect(await faceUp(a.page, me)).toEqual({ board: 0, seat: 2 });
  expect(await faceUp(a.page, opp)).toEqual({ board: 0, seat: 0 });
  expect(await widerThanDevice(a.page)).toBe(false);
  // The controls are in reach as the page opens, not under the bottom navigation.
  for (const id of ['replay-play', 'replay-next']) expect(await reachable(a.page, id), id).toBe(true);
  await shot(a.page, 'replay-deal.png');
  // Scrolled a little, the whole table shows between the header and the controls.
  const room = await a.page.evaluate(() => {
    const q = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const table = () => q('[data-testid=hand-replay] .jc-game-surface');
    scrollBy(0, table().bottom - q('[data-testid=replay-controls]').top + 8);
    return { top: table().top - q('header').bottom, bottom: q('[data-testid=replay-controls]').top - table().bottom };
  });
  expect(room.top).toBeGreaterThanOrEqual(0);
  expect(room.bottom).toBeGreaterThanOrEqual(0);
  for (const id of ['replay-play', 'replay-next']) expect(await reachable(a.page, id), id).toBe(true);
  await shot(a.page, 'replay-scrolled.png');

  // Step forward: the board comes out street by street; the other hand stays face down until the showdown.
  const next = a.page.getByTestId('replay-next');
  const boards: number[] = [];
  for (let k = 1; k < total; k++) {
    if (/쇼다운|Showdown/.test((await a.page.getByTestId('replay-step').textContent()) ?? '')) break;
    expect((await faceUp(a.page, opp)).seat).toBe(0);
    boards.push((await faceUp(a.page, opp)).board);
    await next.tap();
    await expect(index).toHaveText(`${k + 1}/${total}`);
    if ((await faceUp(a.page, opp)).board === 3 && !boards.includes(3)) await shot(a.page, 'replay-flop.png');
  }
  expect([...new Set(boards)]).toEqual([0, 3, 4, 5]);
  await expect(a.page.getByTestId('replay-step')).toHaveText(/쇼다운|Showdown/);
  expect(await faceUp(a.page, opp)).toEqual({ board: 5, seat: 2 });
  await shot(a.page, 'replay-showdown.png');

  // The last step pays the pot out to the winner(s).
  await next.tap();
  await expect(index).toHaveText(`${total}/${total}`);
  await expect(next).toBeDisabled();
  const pots = a.page.getByTestId('replay-pots');
  await expect(pots).toBeVisible();
  await expect(a.page.getByTestId('replay-pot-row')).toHaveCount(h.pots!.length);
  for (const w of h.pots!.flatMap((p) => p.winners)) await expect(pots).toContainText(h.players.find((p) => p.seatIndex === w.seatIndex)!.nickname);
  await pots.scrollIntoViewIfNeeded();
  await shot(a.page, 'replay-result.png', true);
  await a.page.getByTestId('replay-prev').tap();
  await expect(index).toHaveText(`${total - 1}/${total}`);

  // Play from the start at double speed, then pause: it stays where it was paused.
  await a.page.getByTestId('replay-first').tap();
  await expect(index).toHaveText(`1/${total}`);
  await a.page.getByTestId('replay-speed-2').tap();
  await expect(a.page.getByTestId('replay-speed-2')).toHaveAttribute('aria-pressed', 'true');
  const play = a.page.getByTestId('replay-play');
  await play.tap();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await expect(index).not.toHaveText(`1/${total}`, { timeout: 3000 });
  await play.tap();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  const paused = await index.textContent();
  await a.page.waitForTimeout(1500);
  await expect(index).toHaveText(paused!);

  // Shared as a hand review: anyone opens the same replay from the post, seen from the author's seat.
  const post = await call<{ id: string }>(a.page, '/api/board/posts', { title: '리플레이 확인', body: '이 핸드 어땠나요?', handIds: [h.id] });
  await b.page.goto(`/board/${post.id}`);
  await b.page.getByTestId('replay-toggle').click();
  await expect(b.page.getByTestId('hand-replay')).toBeVisible();
  expect(await faceUp(b.page, me)).toEqual({ board: 0, seat: 2 });
  expect(await faceUp(b.page, opp)).toEqual({ board: 0, seat: 0 });
  await b.page.getByTestId('replay-last').click();
  await expect(b.page.getByTestId('replay-pots')).toBeVisible();
  expect(await faceUp(b.page, opp)).toEqual({ board: 5, seat: 2 });
  await shot(b.page, 'replay-review-desktop.png', true);
});
