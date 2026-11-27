import { expect } from '@playwright/test';
import { checkOrCall, signUp, sitWith, standUp, test } from './helpers';
import { expectLit, expectRestored, expectScene, fold, lasting, openRoom, phasesOf, scene, scenesDone, SEEN, shootPhases, shove, sitRebuy, truth, watchShowdown } from './showdown-helpers';

/**
 * The showdown's scene in a real browser, against what the room sent each page: it plays for the server's showdown
 * and for nothing else, once, in its order, lights only what the showdown turned over, and leaves nothing behind.
 */
test('쇼다운 연출: 폴드 승리에는 없고, 쇼다운에서 한 번(회색 → SHOWDOWN → 공개 → 승리 패 → 정산 → 복원), 관전자에게도 같고, 새로고침·모션 줄이기에는 다시 나오지 않는다', async ({ browser }) => {
  test.setTimeout(420_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  const c = await signUp(browser);
  for (const p of [a.page, b.page, c.page]) await p.addInitScript(watchShowdown);
  const ta = truth(a.page);
  const tb = truth(b.page);
  const tc = truth(c.page);
  const id = await openRoom(a.page);
  await c.page.goto(`/table/${id}`);
  await sitWith(a.page, id, 500);
  await sitWith(b.page, id, 500);

  // 1. A pot won by a fold: the hand settles, and nothing of the scene is drawn for anyone.
  await expect(async () => {
    if (!ta.settled.length) (await fold(a.page)) || (await fold(b.page));
    expect(ta.settled.length).toBeGreaterThanOrEqual(1);
  }).toPass({ timeout: 90_000 });
  expect(ta.settled[0]).toMatchObject({ showdown: false, shown: [] });
  await a.page.waitForTimeout(1500);
  for (const p of [a.page, b.page, c.page]) expect(await scene(p)).toMatchObject({ phases: [], titles: 0 });
  await a.page.screenshot({ path: 'test-results/showdown-foldwin.png' });

  // 2. A hand checked down to its showdown: the scene, once, on both players' pages and the spectator's.
  const shots = shootPhases(a.page, 'showdown-hu', 0);
  const played = () => ta.settled.find((h) => h.showdown);
  await expect(async () => {
    if (!played()) (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    expect(played()).toBeTruthy();
  }).toPass({ timeout: 150_000 });
  const hand = played()!;
  for (const p of [a.page, b.page, c.page]) await expect.poll(() => scenesDone(p), { timeout: 20_000 }).toBe(1);
  console.log('phases photographed (asked:in):', (await shots).join(' '));
  await a.page.waitForTimeout(900);
  const wa = await scene(a.page);
  // (Order, and no phase twice, are expectScene's to check: here, that none of the lasting ones was passed by.)
  expect(lasting(phasesOf(wa, 0)), 'an unhurried showdown goes through every phase').toEqual(SEEN);
  expect(wa.titles).toBe(1);
  for (const [p, t] of [
    [a.page, ta],
    [b.page, tb],
    [c.page, tc],
  ] as const) {
    const w = await scene(p);
    const mine = t.settled.find((h) => h.id === hand.id)!;
    expect(mine, 'the same hand on every page').toBeTruthy();
    expectScene(w, 0, mine, t.mySeat);
    expect(w.titles).toBe(1);
  }
  expect(tc.mySeat).toBeNull();
  // What the page had drawn: grey everywhere under the title; then the board, the pot and the showdown's hands in
  // colour over a grey table; then everything its own colour again.
  const under = wa.styles.find((s) => s.phase === 'title')!;
  expect(under.now).toBe('title');
  for (const v of [under.felt, under.board, under.pot, under.header]) expect(v).toMatch(/grayscale\(1\)/);
  for (const s of Object.values(under.seats)) expect(s.plate).toMatch(/grayscale\(1\)/);
  expect(under.title).toMatchObject({ pointer: 'none', inside: true });
  expect(under.title!.font).toMatch(/Cinzel/);
  expect(expectLit(wa, 0, hand)).toBe(true);
  expect(expectRestored(wa, 0)).toBe(true);
  await expect(a.page.locator('[data-showdown]')).toHaveCount(0);
  await expect(a.page.getByTestId('showdown-title')).toHaveCount(0);

  // 3. The spectator asks for less motion, and one player reloads while the title is up: neither sees the scene of
  // the next showdown (not replayed for a hand found settled), the other player sees it once as before.
  await c.page.emulateMedia({ reducedMotion: 'reduce' });
  await c.page.reload();
  const reloaded = b.page.waitForSelector('[data-showdown="title"]', { timeout: 200_000 }).then(() => b.page.reload());
  const next = () => ta.settled.find((h) => h.showdown && h.id !== hand.id);
  await expect(async () => {
    if (!next()) (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    expect(next()).toBeTruthy();
  }).toPass({ timeout: 200_000 });
  await reloaded;
  await expect(b.page.getByTestId('table')).toBeVisible();
  await expect.poll(() => scenesDone(a.page), { timeout: 20_000 }).toBe(2);
  await b.page.waitForTimeout(2500);
  expect(await scene(b.page), 'no scene after a reload').toMatchObject({ phases: [], titles: 0 });
  expect(await scene(c.page), 'no scene with reduced motion').toMatchObject({ phases: [], titles: 0 });
  const again = await scene(a.page);
  expect(again.titles).toBe(2);
  expectScene(again, 1, next()!, ta.mySeat);

  // The table goes on: the next hand is dealt and played with no scene left over.
  await expect.poll(() => ta.current?.id !== next()!.id && !!ta.current && !ta.settled.some((h) => h.id === ta.current!.id), { timeout: 30_000 }).toBe(true);
  await expect(a.page.locator('[data-showdown]')).toHaveCount(0);
  for (const p of [a.page, b.page]) await standUp(p);
});

test('쇼다운 연출: 올인 런아웃은 패를 먼저 펴고 보드를 차례로 깐 뒤 결과를 보인다', async ({ browser }) => {
  test.setTimeout(300_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  for (const p of [a.page, b.page]) await p.addInitScript(watchShowdown);
  const ta = truth(a.page);
  const tb = truth(b.page);
  const id = await openRoom(a.page);
  // (Whoever loses everything buys in again by their own standing order: a seat left mid-scene ends the staging.)
  await sitRebuy(a.page, id, 300);
  await sitRebuy(b.page, id, 300);
  const shots = shootPhases(a.page, 'showdown-allin', 0);
  const played = () => ta.settled.find((h) => h.showdown);
  await expect(async () => {
    if (!played()) (await shove(a.page)) || (await shove(b.page));
    expect(played()).toBeTruthy();
  }).toPass({ timeout: 150_000 });
  const hand = played()!;
  for (const p of [a.page, b.page]) await expect.poll(() => scenesDone(p), { timeout: 20_000 }).toBe(1);
  console.log('phases photographed (asked:in):', (await shots).join(' '));
  // Both hands are in the showdown (all in: both are turned over), on both pages.
  expect(hand.shown.map((x) => x.seatIndex).sort()).toEqual([0, 1]);
  for (const [p, t] of [
    [a.page, ta],
    [b.page, tb],
  ] as const) {
    const w = await scene(p);
    expectScene(w, 0, t.settled.find((h) => h.id === hand.id)!, t.mySeat);
    // The hands turned over before the board was run out, the board complete before anyone was marked a winner.
    const snaps = w.snaps;
    const turned = snaps.find((s) => s.phase === 'reveal')!;
    expect(turned.board.length, 'the board when the hands turned').toBeLessThan(5);
    for (const k of ['0', '1']) expect(turned.seats[k]).toMatchObject({ sd: 'in', winner: false });
    for (const k of ['0', '1']) expect(turned.seats[k]!.cards).toHaveLength(2);
    const result = snaps.find((s) => s.phase === 'highlight' || s.phase === 'settlement')!;
    expect(result.board).toHaveLength(5);
  }
  const wa = await scene(a.page);
  expectLit(wa, 0, hand);
  await a.page.waitForTimeout(900);
  expectRestored(await scene(a.page), 0);
  await expect(a.page.locator('[data-showdown]')).toHaveCount(0);
});

test('쇼다운 연출: 칩을 모두 잃은 플레이어가 자리에서 일어나도 연출은 끝까지 나온다', async ({ browser }) => {
  test.setTimeout(300_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  for (const p of [a.page, b.page]) await p.addInitScript(watchShowdown);
  const ta = truth(a.page);
  const tb = truth(b.page);
  const id = await openRoom(a.page);
  // No standing order to buy in again: whoever loses everything is stood up by the room right after the result.
  await sitWith(a.page, id, 300);
  await sitWith(b.page, id, 300);
  const played = () => ta.settled.find((h) => h.showdown && h.winners.length === 1);
  await expect(async () => {
    if (!played()) (await shove(a.page)) || (await shove(b.page));
    expect(ta.settled.some((h) => h.showdown)).toBe(true);
  }).toPass({ timeout: 150_000 });
  const hand = played();
  test.skip(!hand, 'the pot was split: nobody lost everything');
  const loser = [0, 1].find((s) => !hand!.winners.includes(s))!;
  for (const [p, t] of [
    [a.page, ta],
    [b.page, tb],
  ] as const) {
    await expect.poll(() => scenesDone(p), { timeout: 20_000 }).toBe(1);
    const w = await scene(p);
    // The whole scene, the loser's seat in it to the end (their hand was turned over: all in).
    expectScene(w, 0, t.settled.find((h) => h.id === hand!.id)!, t.mySeat === loser ? null : t.mySeat);
    expect(phasesOf(w, 0)).toEqual(expect.arrayContaining(['title', 'reveal', 'settlement']));
    const paid = w.snaps.find((s) => s.phase === 'settlement')!;
    expect(paid.seats[String(loser)], 'the loser is still drawn while the pot is paid').toMatchObject({ sd: 'in' });
    expect(paid.seats[String(loser)]!.cards).toHaveLength(2);
    // Once it is over the seat is free, as the room said.
    await expect(p.getByTestId(`seat-${loser}`)).toHaveCount(0);
    await expect(p.locator('[data-showdown]')).toHaveCount(0);
  }
});

test('쇼다운 연출: 세 명 올인의 메인·사이드 팟마다 실제 승자가 모두 표시된다', async ({ browser }) => {
  test.setTimeout(360_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  const c = await signUp(browser);
  const d = await signUp(browser);
  for (const p of [a.page, b.page, c.page, d.page]) await p.addInitScript(watchShowdown);
  const ts = [truth(a.page), truth(b.page), truth(c.page), truth(d.page)];
  const id = await openRoom(a.page, { maxSeats: 6, maxBuyIn: 400 });
  await d.page.goto(`/table/${id}`);
  await sitRebuy(a.page, id, 100);
  await sitRebuy(b.page, id, 200);
  await sitRebuy(c.page, id, 400);
  const players = [a.page, b.page, c.page];
  const shots = shootPhases(d.page, 'showdown-sidepot', 0);
  // A hand begun before the third sat is folded; the first one dealt to all three is played all in.
  const played = () => ts[0]!.settled.find((h) => h.showdown && h.pots >= 2);
  await expect(async () => {
    if (!played()) {
      const three = ts[0]!.current?.dealt === 3;
      for (const p of players) if (three ? await shove(p) : await fold(p)) break;
    }
    expect(ts[0]!.settled.some((h) => h.showdown)).toBe(true);
  }).toPass({ timeout: 240_000 });
  const hand = ts[0]!.settled.find((h) => h.showdown)!;
  // Three stacks of different sizes all in: a main pot and a side pot at least, each with its winner.
  expect(hand.pots, JSON.stringify(hand)).toBeGreaterThanOrEqual(2);
  expect(hand.shown).toHaveLength(3);
  for (const p of [...players, d.page]) await expect.poll(() => scenesDone(p), { timeout: 20_000 }).toBe(1);
  console.log('phases photographed (asked:in):', (await shots).join(' '), 'winners:', hand.winners.join(','), 'pots:', hand.pots);
  for (const [i, p] of [...players, d.page].entries()) {
    const t = ts[i]!;
    expectScene(await scene(p), 0, t.settled.find((h) => h.id === hand.id)!, t.mySeat);
  }
  expectLit(await scene(d.page), 0, hand);
});
