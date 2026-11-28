import { expect, type Browser, type Page } from '@playwright/test';
import { checkOrCall, signUp, sitWith, test, widerThanDevice } from './helpers';
import { fold, openRoom, scene, shove, truth, watchShowdown } from './showdown-helpers';

/**
 * The table's in-game UX, played for real by two members (A on a desktop or a phone, B on a desktop): a quick reaction
 * on my own turn, chat as a speech bubble by its writer's seat, rabbit hunting from the board's empty places, and a
 * hand's end that stays to be read (the winner's banner, why I lost, the seat of a player out of chips, the skip, the
 * showdown's setting).
 */

/** When the page first drew the winner's banner, and when each seat left the table (ms on the page's clock). */
interface Marks {
  banner: number | null;
  note: number | null;
  gone: Record<string, number>;
  dealt: number | null;
}
function markResult() {
  const m: Marks = { banner: null, note: null, gone: {}, dealt: null };
  (window as unknown as { __ux: Marks }).__ux = m;
  const had = new Set<string>();
  const look = () => {
    const now = performance.now();
    if (m.banner === null && document.querySelector('[data-testid=winner-banner]')) m.banner = now;
    if (m.note === null && document.querySelector('[data-testid=outcome-note]')) m.note = now;
    const seats = new Set(Array.from(document.querySelectorAll<HTMLElement>('[data-testid=table] [data-testid^="seat-"][data-state]')).map((el) => el.dataset.testid!));
    for (const id of seats) had.add(id);
    if (m.banner !== null) for (const id of had) if (!seats.has(id) && m.gone[id] === undefined) m.gone[id] = now;
    if (m.banner !== null && m.dealt === null && !document.querySelector('[data-testid=winner-banner]')) m.dealt = now;
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'data-testid'] });
}
const marks = (p: Page) => p.evaluate(() => (window as unknown as { __ux: Marks }).__ux);

/** Whether two boxes of the page overlap (by more than a pixel). */
function overlap(page: Page, a: string, b: string) {
  return page.evaluate(
    ([sa, sb]) => {
      const A = Array.from(document.querySelectorAll(sa!)).map((e) => e.getBoundingClientRect());
      const B = Array.from(document.querySelectorAll(sb!)).map((e) => e.getBoundingClientRect());
      return A.some((x) => x.width > 0 && B.some((y) => y.width > 0 && x.left < y.right - 1 && x.right > y.left + 1 && x.top < y.bottom - 1 && x.bottom > y.top + 1));
    },
    [a, b] as const,
  );
}
const onScreen = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return r.left >= 0 && r.right <= document.documentElement.clientWidth + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1;
  }, sel);

async function say(page: Page, mobile: boolean, text: string) {
  if (mobile) await page.getByRole('button', { name: /^(채팅|Chat)$/ }).tap();
  const input = page.getByTestId('chat-input');
  // (The room takes one line a second from a member.)
  await page.waitForTimeout(1_100);
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByTestId('chat-line').filter({ hasText: text.slice(0, 20) })).toHaveCount(1);
  if (mobile) await page.getByRole('button', { name: /^(닫기|Close)$/ }).first().tap();
}

/** The page whose turn it is (its action bar shows a fold). */
async function actor(a: Page, b: Page): Promise<Page> {
  let who: Page | null = null;
  await expect(async () => {
    for (const p of [a, b]) {
      if (await p.getByTestId('action-bar').getByRole('button', { name: /^(폴드|Fold)$/ }).isVisible().catch(() => false)) {
        who = p;
        return;
      }
    }
    throw new Error('nobody to act yet');
  }).toPass({ timeout: 60_000 });
  return who!;
}

const seatIndexOf = async (page: Page, nickname: string) =>
  Number((await page.locator('[data-testid=table] [data-testid^="seat-"][data-state]').filter({ hasText: nickname }).first().getAttribute('data-testid'))!.replace('seat-', ''));

export async function socialScenario(browser: Browser, mobile: boolean) {
  test.setTimeout(240_000);
  const tag = mobile ? 'mobile' : 'desktop';
  const a = await signUp(browser, { mobile });
  const b = await signUp(browser);
  const id = await openRoom(a.page);
  await sitWith(a.page, id, 1000);
  await sitWith(b.page, id, 1000);
  const seatA = await seatIndexOf(b.page, a.nickname);

  // --- A quick reaction on my own turn: the button is there, beside the betting controls and never over them.
  // (A is made the one to act: B, when first, calls or checks.)
  await expect(async () => {
    const who = await actor(a.page, b.page);
    // (A hand under way: no rabbit hunt is offered.)
    for (const p of [a.page, b.page]) expect(await p.getByTestId('rabbit-hunt').count()).toBe(0);
    if (who !== a.page) {
      await checkOrCall(b.page);
      throw new Error('B acted; waiting for A');
    }
  }).toPass({ timeout: 90_000 });
  const bar = a.page.getByTestId('action-bar');
  const slot = a.page.getByTestId('react-turn');
  await expect(slot).toBeVisible();
  const open = slot.getByTestId('react-open');
  await expect(open).toBeVisible();
  expect(await overlap(a.page, '[data-testid=react-turn] button', '[data-testid=action-bar] button, [data-testid=action-bar] input')).toBe(false);
  expect(await onScreen(a.page, '[data-testid=react-open]')).toBe(true);
  await (mobile ? open.tap() : open.click());
  const tray = a.page.getByTestId('react-tray');
  await expect(tray).toBeVisible();
  expect(await overlap(a.page, '[data-testid=react-tray] button', '[data-testid=action-bar] button, [data-testid=action-bar] input')).toBe(false);
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath(`ux-${tag}-emoji-my-turn.png`) });
  const fire = a.page.getByTestId('react-fire');
  await (mobile ? fire.tap() : fire.click());
  await expect(tray).toHaveCount(0);
  for (const p of [a.page, b.page]) await expect(p.getByTestId(`reaction-${seatA}`)).toBeVisible();
  // Still my turn, the controls as they were: a reaction is no action.
  await expect(bar.getByRole('button', { name: /^(폴드|Fold)$/ })).toBeEnabled();
  await expect(b.page.getByTestId('action-bar').getByRole('button', { name: /^(폴드|Fold)$/ })).toHaveCount(0);

  // --- Chat as a speech bubble by its writer's seat: plain text, once, four seconds, the panel keeps the line.
  const markup = '<b>안녕</b> <img src=x onerror="window.__xss=1"> 좋은 패!';
  await say(a.page, mobile, markup);
  for (const p of [a.page, b.page]) {
    const bubble = p.getByTestId(`chat-bubble-${seatA}`);
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText('<b>안녕</b>');
    expect(await bubble.locator('b, img').count()).toBe(0);
    await expect(p.locator('[data-testid^="chat-bubble-"]')).toHaveCount(1);
    expect(await onScreen(p, `[data-testid=chat-bubble-${seatA}]`)).toBe(true);
    expect(await overlap(p, `[data-testid=chat-bubble-${seatA}]`, '[data-testid=board] .jc-card[data-card], [data-testid=action-bar] button')).toBe(false);
  }
  expect(await a.page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await b.page.screenshot({ path: test.info().outputPath(`ux-${tag}-chat-bubble-seen-by-other.png`) });
  await a.page.screenshot({ path: test.info().outputPath(`ux-${tag}-chat-bubble-mine.png`) });
  for (const p of [a.page, b.page]) await expect(p.getByTestId(`chat-bubble-${seatA}`)).toHaveCount(0, { timeout: 8_000 });
  await expect(b.page.getByTestId('chat-line').filter({ hasText: '좋은 패!' })).toHaveCount(1);

  // A long line: clamped with an ellipsis, inside the screen; a second line takes the first one's place.
  const long = `긴메시지 ${'가나다라마바사아자차카타파하 '.repeat(12)}`.trim();
  await say(a.page, mobile, long);
  const bubbleB = b.page.getByTestId(`chat-bubble-${seatA}`);
  await expect(bubbleB).toBeVisible();
  expect(((await bubbleB.textContent()) ?? '').endsWith('…')).toBe(true);
  expect((await bubbleB.boundingBox())!.width).toBeLessThanOrEqual(170);
  expect((await bubbleB.boundingBox())!.height).toBeLessThanOrEqual(60);
  expect(await onScreen(a.page, `[data-testid=chat-bubble-${seatA}]`)).toBe(true);
  await a.page.screenshot({ path: test.info().outputPath(`ux-${tag}-chat-bubble-long.png`) });
  await say(a.page, mobile, '두 번째');
  await expect(bubbleB).toHaveText('두 번째');
  await expect(b.page.locator('[data-testid^="chat-bubble-"]')).toHaveCount(1);
  await expect(bubbleB).toHaveCount(0, { timeout: 8_000 });

  // The setting, off: B sees the line in the panel and no bubble; A, who left it on, still does.
  await b.page.getByRole('button', { name: /^(설정|Settings)$/ }).click();
  const toggle = b.page.getByTestId('settings-chat-bubbles');
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeChecked();
  await b.page.screenshot({ path: test.info().outputPath(`ux-${tag}-settings.png`) });
  await toggle.uncheck();
  await b.page.keyboard.press('Escape');
  await say(a.page, mobile, '말풍선 끔');
  await expect(b.page.getByTestId('chat-line').filter({ hasText: '말풍선 끔' })).toHaveCount(1);
  await expect(a.page.getByTestId(`chat-bubble-${seatA}`)).toBeVisible();
  await expect(b.page.locator('[data-testid^="chat-bubble-"]')).toHaveCount(0);

  // --- Rabbit hunting from the board's empty places, once the hand is over by a fold.
  // (The button is up for the few seconds a folded hand's result is: on a slow runner the turn's clock can end the hand
  // under way before the fold here, the next one dealt by then. So a hand is folded until the button is seen.)
  const hunt = a.page.getByTestId('rabbit-hunt');
  await expect(async () => {
    if (!(await hunt.isVisible().catch(() => false))) (await fold(a.page)) || (await fold(b.page));
    await expect(hunt).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000 });
  await expect(hunt).toHaveAttribute('title', /남은 커뮤니티 카드|would have come/);
  const inBoard = await a.page.evaluate(() => {
    const h = document.querySelector('[data-testid=rabbit-hunt]')!.getBoundingClientRect();
    const bd = document.querySelector('[data-testid=board]')!.getBoundingClientRect();
    const top = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2);
    return { inside: h.left >= bd.left - 1 && h.right <= bd.right + 1 && h.top >= bd.top - 8 && h.bottom <= bd.bottom + 8, w: h.width, h: h.height, hit: !!top && !!top.closest('[data-testid=rabbit-hunt]') };
  });
  expect(inBoard).toMatchObject({ inside: true, hit: true });
  expect(inBoard.w).toBeGreaterThanOrEqual(44);
  expect(inBoard.h).toBeGreaterThanOrEqual(44);
  expect(await overlap(a.page, '[data-testid=rabbit-hunt]', '[data-testid=board] .jc-card[data-card]')).toBe(false);
  // (The bubble of the line just written, if still up, is clear of the buttons that show my cards.)
  expect(await overlap(a.page, '[data-testid^="chat-bubble-"]', '[data-testid=show-cards] button, [data-testid=show-cards] span')).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath(`ux-${tag}-rabbit-button.png`) });
  await (mobile ? hunt.tap() : hunt.click());
  await expect(a.page.getByTestId('rabbit-card')).toHaveCount(5);
  await expect(hunt).toHaveCount(0);
  await expect(b.page.getByTestId('rabbit-card')).toHaveCount(0);
  await a.page.screenshot({ path: test.info().outputPath(`ux-${tag}-rabbit-cards.png`) });
}

export async function bustScenario(browser: Browser, mobile: boolean) {
  test.setTimeout(300_000);
  const tag = mobile ? 'mobile' : 'desktop';
  const a = await signUp(browser, { mobile });
  const b = await signUp(browser);
  for (const p of [a.page, b.page]) {
    await p.addInitScript(watchShowdown);
    await p.addInitScript(markResult);
  }
  const ta = truth(a.page);
  const id = await openRoom(a.page);
  // No standing order to buy in again: whoever loses everything is stood up by the room right after the result.
  await sitWith(a.page, id, 300);
  await sitWith(b.page, id, 300);
  const seatA = await seatIndexOf(b.page, a.nickname);
  const played = () => ta.settled.find((h) => h.showdown && h.winners.length === 1);
  await expect(async () => {
    if (!played()) (await shove(a.page)) || (await shove(b.page));
    expect(ta.settled.some((h) => h.showdown)).toBe(true);
  }).toPass({ timeout: 150_000 });
  const hand = played();
  test.skip(!hand, 'the pot was split: nobody lost everything');
  const loserSeat = [0, 1].find((s) => !hand!.winners.includes(s))!;
  const [loser, winner] = loserSeat === seatA ? [a, b] : [b, a];

  // The banner, on both screens, names the winner; the loser reads why, from the hands the showdown turned over.
  for (const p of [a.page, b.page]) {
    const banner = p.getByTestId('winner-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText('WINNER');
    await expect(banner.getByTestId('winner-name')).toHaveText(winner.nickname);
    await expect(banner.getByTestId('winner-hand')).not.toBeEmpty();
    expect(await onScreen(p, '[data-testid=winner-banner]')).toBe(true);
    expect(await overlap(p, '[data-testid=winner-banner]', '[data-testid=board] .jc-card[data-card]')).toBe(false);
  }
  const note = loser.page.getByTestId('outcome-note');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('data-kind', 'lost');
  await expect(note).toContainText('LOST AT SHOWDOWN');
  await expect(note.getByTestId('outcome-mine')).toContainText('YOUR HAND');
  await expect(note.getByTestId('outcome-winning')).toContainText('WINNING HAND');
  await expect(note.getByTestId('outcome-winning')).toContainText(winner.nickname);
  await expect(winner.page.getByTestId('outcome-note')).toHaveCount(0);
  // The room has already stood the loser up (the server's state has no player at the seat); the screen keeps the seat,
  // its cards face up, for the result.
  await expect.poll(() => loser.page.evaluate(() => !!document.querySelector('[data-testid=action-bar]'))).toBe(false);
  for (const p of [a.page, b.page]) {
    const seat = p.getByTestId(`seat-${loserSeat}`);
    await expect(seat).toBeVisible();
    await expect(seat.locator('.jc-card[data-card]')).toHaveCount(2);
  }
  expect(await widerThanDevice(a.page)).toBe(false);
  await loser.page.screenshot({ path: test.info().outputPath(`ux-${tag}-bust-result-${loser === a ? 'A-loser' : 'B-loser'}.png`) });
  await a.page.screenshot({ path: test.info().outputPath(`ux-${tag}-bust-result-A.png`) });
  // A window at 150% zoom (853×480 CSS pixels, the note in the narrow column): no line of the reason is cut short.
  if (!mobile) {
    const size = loser.page.viewportSize()!;
    await loser.page.setViewportSize({ width: 853, height: 480 });
    await expect(note).toBeVisible();
    const cut = await note.evaluate((n) =>
      Array.from(n.querySelectorAll<HTMLElement>('*'))
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible')
        .map((e) => `${e.textContent} ${e.scrollWidth}>${e.clientWidth}`),
    );
    expect(await onScreen(loser.page, '[data-testid=outcome-note]')).toBe(true);
    await loser.page.screenshot({ path: test.info().outputPath(`ux-${tag}-bust-result-loser-853x480.png`) });
    expect(cut).toEqual([]);
    await loser.page.setViewportSize(size);
  }

  // Read at leisure: from the banner (the pot paid) the loser's seat stays six seconds or more, then is free.
  for (const p of [a.page, b.page]) await expect(p.getByTestId(`seat-${loserSeat}`)).toHaveCount(0, { timeout: 25_000 });
  const held: number[] = [];
  for (const p of [a.page, b.page]) {
    const m = await marks(p);
    const ms = m.gone[`seat-${loserSeat}`]! - m.banner!;
    held.push(Math.round(ms));
    expect(ms, 'the seat of the player out of chips stays through the result').toBeGreaterThanOrEqual(5_900);
    expect(ms).toBeLessThanOrEqual(12_500);
    // The scene played whole, the loser in it to the end.
    const w = await scene(p);
    expect(w.phases).toEqual(expect.arrayContaining(['title', 'reveal', 'settlement']));
    const paid = w.snaps.find((s) => s.phase === 'settlement')!;
    expect(paid.seats[String(loserSeat)]).toMatchObject({ sd: 'in' });
  }
  test.info().annotations.push({ type: 'held', description: `bust seat kept after the banner: A ${held[0]} ms, B ${held[1]} ms` });
  console.log(`[ingame-ux ${tag}] bust seat kept after the banner: A ${held[0]} ms, B ${held[1]} ms`);
  // The loser can sit again: nothing of the result is in the way.
  await expect(loser.page.locator('[data-showdown]')).toHaveCount(0);
}

export async function paceScenario(browser: Browser, mobile: boolean) {
  test.setTimeout(360_000);
  const tag = mobile ? 'mobile' : 'desktop';
  const a = await signUp(browser, { mobile });
  const b = await signUp(browser);
  for (const p of [a.page, b.page]) {
    await p.addInitScript(watchShowdown);
    await p.addInitScript(markResult);
  }
  const ta = truth(a.page);
  const id = await openRoom(a.page);
  await sitWith(a.page, id, 1000);
  await sitWith(b.page, id, 1000);
  const showdowns = () => ta.settled.filter((h) => h.showdown).length;
  const toShowdown = async (n: number) => {
    await expect(async () => {
      if (showdowns() < n) (await checkOrCall(a.page)) || (await checkOrCall(b.page));
      expect(showdowns()).toBeGreaterThanOrEqual(n);
    }).toPass({ timeout: 150_000 });
  };

  // 1. A showdown nobody was all in for: the result stays four seconds or more after the banner, on both screens,
  //    and the next hand is dealt to both at the room's time.
  await toShowdown(1);
  for (const p of [a.page, b.page]) await expect(p.getByTestId('winner-banner')).toBeVisible({ timeout: 20_000 });
  await a.page.screenshot({ path: test.info().outputPath(`ux-${tag}-showdown-result.png`) });
  for (const p of [a.page, b.page]) await expect(p.getByTestId('winner-banner')).toHaveCount(0, { timeout: 20_000 });
  const read: number[] = [];
  for (const p of [a.page, b.page]) {
    const m = await marks(p);
    read.push(Math.round(m.dealt! - m.banner!));
    expect(m.dealt! - m.banner!, 'the result stays to be read').toBeGreaterThanOrEqual(3_900);
  }
  test.info().annotations.push({ type: 'held', description: `showdown result readable: A ${read[0]} ms, B ${read[1]} ms` });
  console.log(`[ingame-ux ${tag}] showdown result readable (banner to next deal): A ${read[0]} ms, B ${read[1]} ms`);

  // 2. Skip: A's screen jumps to the result; B's plays on; the next hand comes to both all the same.
  const before = (await scene(b.page)).phases.length;
  const skip = a.page.getByTestId('showdown-skip');
  const skipped = (async () => {
    await skip.waitFor({ timeout: 150_000 });
    await a.page.waitForFunction(() => !!document.querySelector('[data-showdown]'), undefined, { timeout: 10_000, polling: 'raf' }).catch(() => {});
    const t0 = Date.now();
    await (mobile ? skip.tap({ timeout: 3_000 }) : skip.click({ timeout: 3_000 }));
    await a.page.waitForFunction(() => !document.querySelector('[data-showdown]') && !!document.querySelector('[data-testid=winner-banner]'), undefined, { timeout: 2_000, polling: 'raf' });
    return Date.now() - t0;
  })();
  await toShowdown(2);
  const took = await skipped;
  expect(took, 'a skip shows the result at once').toBeLessThan(1_500);
  await expect(skip).toHaveCount(0);
  await expect(a.page.getByTestId('winner-banner')).toBeVisible();
  await a.page.screenshot({ path: test.info().outputPath(`ux-${tag}-skipped.png`) });
  // B was not skipped: its scene went on to the pot's payment.
  await expect.poll(async () => (await scene(b.page)).phases.slice(before)).toEqual(expect.arrayContaining(['settlement']));
  // The next hand: A acts in it as ever (a skipped scene costs no turn).
  const hands = ta.settled.length;
  await expect(async () => {
    (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    expect(ta.current && !ta.settled.some((h) => h.id === ta.current!.id)).toBe(true);
    expect(ta.settled.length).toBe(hands);
  }).toPass({ timeout: 30_000 });

  // 3. The setting, Fast: A's screen plays no scene at all (the result at once, the banner all the same); B's does.
  await a.page.getByRole('button', { name: /^(설정|Settings)$/ }).click();
  const fast = a.page.getByTestId('settings-showdown-fast');
  await fast.scrollIntoViewIfNeeded();
  await expect(a.page.getByTestId('settings-showdown-cinematic')).toHaveAttribute('aria-checked', 'true');
  await (mobile ? fast.tap() : fast.click());
  await expect(fast).toHaveAttribute('aria-checked', 'true');
  expect(await widerThanDevice(a.page)).toBe(false);
  await a.page.screenshot({ path: test.info().outputPath(`ux-${tag}-settings-showdown.png`) });
  await a.page.keyboard.press('Escape');
  await expect(fast).toHaveCount(0);
  const mineBefore = (await scene(a.page)).phases.length;
  const theirsBefore = (await scene(b.page)).phases.length;
  await toShowdown(3);
  await expect(a.page.getByTestId('winner-banner')).toBeVisible({ timeout: 3_000 });
  await expect.poll(async () => (await scene(b.page)).phases.slice(theirsBefore)).toEqual(expect.arrayContaining(['title', 'settlement']));
  expect((await scene(a.page)).phases.slice(mineBefore).filter(Boolean)).toEqual([]);
  await expect(a.page.getByTestId('showdown-skip')).toHaveCount(0);
}
