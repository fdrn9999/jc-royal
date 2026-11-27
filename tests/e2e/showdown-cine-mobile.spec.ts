import { expect } from '@playwright/test';
import { checkOrCall, signUp, sitWith, test, widerThanDevice } from './helpers';
import { expectLit, expectRestored, expectScene, lasting, openRoom, phasesOf, scene, scenesDone, SEEN, shootPhases, truth, watchShowdown } from './showdown-helpers';

test('mobile: 쇼다운 연출이 휴대폰 화면 안에서 자리를 바꾸지 않고 한 번 나오고, 탭을 막지 않는다', async ({ browser }) => {
  test.setTimeout(300_000);
  const a = await signUp(browser, { mobile: true });
  const b = await signUp(browser, { mobile: true });
  for (const p of [a.page, b.page]) await p.addInitScript(watchShowdown);
  const ta = truth(a.page);
  const id = await openRoom(a.page);
  await sitWith(a.page, id, 500);
  await sitWith(b.page, id, 500);

  // Where everything is before the scene (a hand under way): nothing may have moved or changed size at its title.
  const places = () =>
    a.page.evaluate(() =>
      Object.fromEntries(
        // (Not the pot: it is as wide as the chips in it.)
        ['table', 'board', 'felt', 'seat-0', 'seat-1'].map((id) => {
          const r = document.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect();
          return [id, [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]];
        }),
      ),
    );
  await expect(a.page.getByTestId('board')).toBeVisible();
  const before = await places();
  const atTitle = a.page.waitForSelector('[data-showdown="title"]', { timeout: 200_000 }).then(async () => ({ places: await places(), wide: await widerThanDevice(a.page) }));
  const shots = shootPhases(a.page, 'showdown-mobile', 0);
  const played = () => ta.settled.find((h) => h.showdown);
  await expect(async () => {
    if (!played()) (await checkOrCall(a.page)) || (await checkOrCall(b.page));
    expect(played()).toBeTruthy();
  }).toPass({ timeout: 200_000 });
  for (const p of [a.page, b.page]) await expect.poll(() => scenesDone(p), { timeout: 20_000 }).toBe(1);
  console.log('phases photographed (asked:in):', (await shots).join(' '));
  const during = await atTitle;
  expect(during.places).toEqual(before);
  expect(during.wide).toBe(false);
  await a.page.waitForTimeout(900);
  const w = await scene(a.page);
  expect(lasting(phasesOf(w, 0))).toEqual(SEEN);
  expectScene(w, 0, played()!, ta.mySeat);
  // The title: inside the phone's screen, in the display face, taking no tap.
  const under = w.styles.find((s) => s.phase === 'title')!;
  expect(under.title).toMatchObject({ pointer: 'none', inside: true });
  expectLit(w, 0, played()!);
  expect(expectRestored(w, 0)).toBe(true);
  expect(await widerThanDevice(a.page)).toBe(false);
  expect(await places()).toEqual(before);
});
