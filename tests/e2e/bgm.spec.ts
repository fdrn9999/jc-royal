import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, sitWith, test } from './helpers';
import { bgm, expectPlaying, expectSilent, watchBgm } from './bgm-helpers';
import { openRoom } from './showdown-helpers';

/** Goes to another page of the app the way its own links do (no reload: the page, its audio and its music live on). */
const go = (p: Page, path: string) =>
  p.evaluate((to) => {
    history.pushState(null, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);

async function settings(p: Page, change: (dialog: ReturnType<Page['getByRole']>) => Promise<void>) {
  await p.getByRole('button', { name: /^(설정|Settings)$/ }).click();
  await expect(p.getByTestId('settings-music')).toBeVisible();
  await change(p.getByRole('dialog'));
  await p.keyboard.press('Escape');
  await expect(p.getByRole('dialog')).toHaveCount(0);
}

test('테이블 BGM: 방을 만들며 Tournament를 골라 미리 듣고, 방장과 들어온 유저가 그 곡을 듣고, 다른 곡의 테이블로 옮기면 한 요소에서 곡이 바뀌며, 음소거·끄기·여러 탭이 전과 같다', async ({ browser }) => {
  test.setTimeout(300_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  for (const p of [a.page, b.page]) await p.addInitScript(watchBgm);
  const files: string[] = [];
  a.page.on('response', (r) => void (/\.mp3(\?|$)/.test(r.url()) && files.push(`${r.status()} ${r.url().split('/').pop()}`)));
  await a.page.goto('/');

  // The room's form: the catalogue, the default chosen; a track is heard before the room exists, and stops again.
  await a.page.getByTestId('room-create-open-wide').click();
  await a.page.getByTestId('room-name').fill('E2E 토너먼트 곡');
  await a.page.getByTestId('room-seats-2').click();
  await a.page.getByTestId('room-bb-10').click();
  await expect(a.page.getByTestId('room-bgm-black-table-rhythm')).toHaveAttribute('aria-checked', 'true');
  await expect(a.page.getByTestId('room-bgm-black-table-rhythm')).toContainText('검은 테이블의 리듬');
  await expect(a.page.getByTestId('room-bgm-tournament')).toContainText('Tournament');
  await expect(a.page.getByTestId('room-bgm-none')).toContainText(/BGM 없음|No BGM/);
  await a.page.getByTestId('room-bgm-none').click();
  await expect(a.page.getByTestId('room-bgm-preview')).toHaveCount(0);
  await a.page.getByTestId('room-bgm-tournament').click();
  await expect(a.page.getByTestId('room-bgm-tournament')).toHaveAttribute('aria-checked', 'true');
  expect((await bgm(a.page)).plays, 'nothing plays until asked').toBe(0);
  await a.page.getByTestId('room-bgm-preview').click();
  await expectPlaying(a.page, 'tournament');
  await a.page.screenshot({ path: 'test-results/bgm-room-create.png', animations: 'disabled' });
  await a.page.getByTestId('room-bgm-preview').click();
  await expectSilent(a.page);
  await a.page.getByTestId('room-create').click();
  await expect(a.page).toHaveURL(/\/table\/[\w-]+/);
  const id = a.page.url().match(/\/table\/([\w-]+)/)![1]!;
  await a.page.getByTestId('buyin-confirm').click();
  await expect(a.page.getByTestId('seat-0').getByTestId('host-mark')).toBeVisible();

  // The host hears the room's track, and so does whoever comes in (the room told them, not their own choice).
  await expectPlaying(a.page, 'tournament');
  await sitWith(b.page, id, 500);
  await expectPlaying(b.page, 'tournament');
  expect((await bgm(b.page)).loaded).toBe('tournament');
  await a.page.screenshot({ path: 'test-results/bgm-table-tournament.png' });

  // To a table with the other track and back, without a reload: the one element changes its recording.
  await go(a.page, '/table/e2e-music');
  await expectPlaying(a.page, 'black-table-rhythm');
  await go(a.page, `/table/${id}`);
  await expectPlaying(a.page, 'tournament');
  expect((await bgm(a.page)).els).toBe(1);
  expect(files.every((f) => f.startsWith('200') || f.startsWith('206')), files.join(' | ')).toBe(true);
  expect(files.some((f) => /tournament/.test(f))).toBe(true);

  // Mute and the music's own switch stop it; back on, the room's track again (not the default one).
  await settings(a.page, (d) => d.getByLabel(/^(음소거|Mute)$/).check());
  await expectSilent(a.page);
  await settings(a.page, (d) => d.getByLabel(/^(음소거|Mute)$/).uncheck());
  await expectPlaying(a.page, 'tournament');
  await settings(a.page, () => a.page.getByTestId('settings-music').uncheck());
  await expectSilent(a.page);
  await settings(a.page, () => a.page.getByTestId('settings-music').check());
  await expectPlaying(a.page, 'tournament');

  // The same table in a second tab: the music plays in one of them only.
  const tab = await a.page.context().newPage();
  await tab.addInitScript(watchBgm);
  await tab.goto(`/table/${id}`);
  await tab.getByTestId('table').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await bgm(tab)).playing + (await bgm(a.page)).playing, { timeout: 30_000 }).toBe(1);
  await tab.waitForTimeout(2500);
  expect((await bgm(tab)).playing + (await bgm(a.page)).playing).toBe(1);
  await tab.close();
});

test('테이블 BGM: 「BGM 없음」 방은 음악 없이 효과음만 나고, 기본 방은 전과 같은 곡이 난다', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await signUp(browser);
  const b = await signUp(browser);
  for (const p of [a.page, b.page]) await p.addInitScript(watchBgm);
  const quiet = await openRoom(a.page, { bgmId: 'none' });
  await sitWith(a.page, quiet, 500);
  await sitWith(b.page, quiet, 500);
  // A few moves: the table's sounds are heard, and no recording was ever started.
  let made = 0;
  await expect(async () => {
    if ((await checkOrCall(a.page)) || (await checkOrCall(b.page))) made += 1;
    expect(made).toBeGreaterThanOrEqual(4);
  }).toPass({ timeout: 120_000 });
  await a.page.waitForTimeout(1500);
  for (const p of [a.page, b.page]) {
    const m = await bgm(p);
    expect(m.sfx, 'the table still sounds').toBeGreaterThan(0);
    expect(m).toMatchObject({ playing: 0, plays: 0, els: 0 });
  }
  // From the silent room to one made without a choice (the default track), and back to silence.
  const plain = await openRoom(b.page, { name: `E2E plain ${Date.now().toString(36)}` });
  await go(a.page, `/table/${plain}`);
  await a.page.getByTestId('table').click({ position: { x: 5, y: 5 } });
  await expectPlaying(a.page, 'black-table-rhythm');
  await go(a.page, `/table/${quiet}`);
  await expectSilent(a.page);
});
