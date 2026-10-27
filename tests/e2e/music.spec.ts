import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import { checkOrCall, setRange, signUp, sitWith, standUp, test } from './helpers';

/**
 * The table's background music in a real browser, which plays the mp3 itself (muted by the headless launch, its clock
 * still runs): the one element it plays on (window.__music), each play() and pause() of it, and the table's other
 * sounds alongside (every source started but the one-sample buffer that unlocks audio). `strict` plays the policy of a
 * browser that refuses media started outside a tap (iOS): play() is refused unless the page has transient activation.
 */
function watchMusic(strict: boolean) {
  type M = { els: HTMLMediaElement[]; plays: number; refused: number; pauses: number; ended: number; sfx: number };
  const m: M = { els: [], plays: 0, refused: 0, pauses: 0, ended: 0, sfx: 0 };
  (window as unknown as { __music: M }).__music = m;
  const ours = (el: HTMLMediaElement) => el.src.includes('black-table-rhythm');
  const { play, pause } = HTMLMediaElement.prototype;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!ours(this)) return play.call(this);
    if (!m.els.includes(this)) {
      m.els.push(this);
      this.addEventListener('ended', () => (m.ended += 1));
    }
    m.plays += 1;
    if (strict && !navigator.userActivation.isActive) {
      m.refused += 1;
      return Promise.reject(new DOMException('play() needs a tap', 'NotAllowedError'));
    }
    return play.call(this);
  };
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    if (ours(this)) m.pauses += 1;
    return pause.call(this);
  };
  for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype] as { start: (...a: number[]) => void }[]) {
    if (!Object.prototype.hasOwnProperty.call(proto, 'start')) continue;
    const start = proto.start;
    proto.start = function (this: AudioScheduledSourceNode, ...a: number[]) {
      if (!(this instanceof AudioBufferSourceNode && (this.buffer?.length ?? 0) <= 1)) m.sfx += 1;
      return start.apply(this, a);
    };
  }
}

function music(p: Page) {
  return p.evaluate(() => {
    const m = (window as unknown as { __music: { els: HTMLMediaElement[]; plays: number; refused: number; pauses: number; ended: number; sfx: number } }).__music;
    const el = m.els[0];
    return {
      els: m.els.length,
      plays: m.plays,
      refused: m.refused,
      pauses: m.pauses,
      ended: m.ended,
      sfx: m.sfx,
      playing: !!el && !el.paused,
      t: el?.currentTime ?? 0,
      duration: el?.duration ?? 0,
      loop: el?.loop ?? false,
      src: el?.src ?? '',
    };
  });
}

const seated = (p: Page) => expect(p.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(2, { timeout: 90_000 });

/** Goes to another page of the app the way its own links do (no reload: the page, its audio and its music live on). */
const go = (p: Page, path: string) =>
  p.evaluate((to) => {
    history.pushState(null, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);

/** Makes `n` moves at the table (check or call, else fold), waiting for the bot between them. */
async function moves(p: Page, n: number) {
  let made = 0;
  await expect(async () => {
    if (await checkOrCall(p)) made += 1;
    else {
      const fold = p.getByTestId('action-bar').getByRole('button', { name: /^(폴드|Fold)$/ });
      if (await fold.isVisible().catch(() => false)) {
        await fold.click();
        made += 1;
      }
    }
    expect(made).toBeGreaterThanOrEqual(n);
  }).toPass({ timeout: 120_000 });
  await p.waitForTimeout(2000);
}

const stored = (p: Page) => p.evaluate(() => JSON.parse(localStorage.getItem('jc.audio') ?? '{}') as { musicOn?: boolean; music?: number });

async function openSettings(p: Page) {
  await p.getByRole('button', { name: /^(설정|Settings)$/ }).click();
  await expect(p.getByTestId('settings-music')).toBeVisible();
}

async function closeSettings(p: Page) {
  await p.keyboard.press('Escape');
  await expect(p.getByRole('dialog')).toHaveCount(0);
}

test('배경음악: 테이블에서 한 번 시작해 핸드·재연결·반복·테이블 이동 내내 이어지고, 효과음과 함께 나며, 테이블을 떠나면 멈추고, 켜기/끄기와 볼륨이 새로고침 뒤에도 남는다', async ({ browser }) => {
  test.setTimeout(300_000);
  const { page } = await signUp(browser);
  await page.addInitScript(watchMusic, false);
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws\/tables\//, (ws) => {
    sockets.push(ws);
    ws.connectToServer();
  });
  const files: { url: string; type: string }[] = [];
  page.on('response', (r) => {
    if (r.url().includes('black-table-rhythm')) files.push({ url: r.url(), type: r.headers()['content-type'] ?? '' });
  });
  await sitWith(page, 'e2e-music', 1000);
  await seated(page);

  // On by default: the tap that sat down started it, once, looping, streamed from its own file (not in a script).
  await expect.poll(async () => (await music(page)).playing, { message: 'music at the table' }).toBe(true);
  let s = await music(page);
  expect(s).toMatchObject({ els: 1, plays: 1, pauses: 0, loop: true });
  expect(s.src).toMatch(/\/assets\/black-table-rhythm-[\w-]+\.mp3$/);
  expect(files.length).toBeGreaterThan(0);
  expect(files[0]!.type).toContain('audio/mpeg');
  await expect.poll(async () => (await music(page)).duration).toBeGreaterThan(147);
  expect((await music(page)).duration).toBeLessThan(149);
  const t0 = (await music(page)).t;
  await page.waitForTimeout(1500);
  expect((await music(page)).t, 'its clock runs').toBeGreaterThan(t0 + 0.5);

  // Hands go on: the table's own sounds play alongside, and the music is the same element, never started again.
  await moves(page, 3);
  s = await music(page);
  expect(s.sfx, 'the table’s sounds with the music').toBeGreaterThan(0);
  expect(s).toMatchObject({ els: 1, plays: 1, pauses: 0, playing: true });

  // The socket drops and comes back: the music plays through it.
  const before = sockets.length;
  await sockets.at(-1)!.close({ code: 4000, reason: 'network lost' });
  await expect.poll(() => sockets.length, { message: 'reconnected', timeout: 30_000 }).toBeGreaterThan(before);
  await seated(page);
  await page.waitForTimeout(1000);
  expect(await music(page)).toMatchObject({ els: 1, plays: 1, pauses: 0, playing: true });

  // The loop: near its end it comes round to its start by itself, with no 'ended' and no new play().
  await page.evaluate(() => {
    const el = (window as unknown as { __music: { els: HTMLMediaElement[] } }).__music.els[0]!;
    el.currentTime = el.duration - 1;
  });
  await expect.poll(async () => (await music(page)).t, { message: 'came round to the start', timeout: 10_000 }).toBeLessThan(5);
  expect(await music(page)).toMatchObject({ els: 1, plays: 1, pauses: 0, ended: 0, playing: true });

  // Another table: it plays on (the leaving table's fade is called off by the next one opening).
  const t1 = (await music(page)).t;
  await go(page, '/table/e2e-music-b');
  await expect(page.getByTestId('table')).toBeVisible();
  await page.waitForTimeout(2500);
  s = await music(page);
  expect(s).toMatchObject({ els: 1, plays: 1, pauses: 0, playing: true });
  expect(s.t).toBeGreaterThan(t1);

  // Away from the tables: it fades out and stops.
  await go(page, '/');
  await expect.poll(async () => (await music(page)).playing, { message: 'stopped in the lobby', timeout: 10_000 }).toBe(false);
  expect(await music(page)).toMatchObject({ els: 1, pauses: 1 });

  // Back at a table: the same element plays again.
  await go(page, '/table/e2e-music');
  await seated(page);
  await expect.poll(async () => (await music(page)).playing, { message: 'music back at the table' }).toBe(true);
  expect(await music(page)).toMatchObject({ els: 1, plays: 2 });

  // The settings: 25% to start with; a volume set and the music turned off stay so after a reload.
  await openSettings(page);
  const volume = page.getByTestId('settings-music-volume');
  const readout = volume.locator('xpath=..');
  await expect(page.getByTestId('settings-music')).toBeChecked();
  await expect(volume).toHaveValue('0.25');
  await expect(readout).toContainText('25%');
  await setRange(volume, 0.5);
  await expect(readout).toContainText('50%');
  expect(await music(page)).toMatchObject({ plays: 2, playing: true });
  await page.getByTestId('settings-music').uncheck();
  await expect(volume).toBeDisabled();
  await closeSettings(page);
  await expect.poll(async () => (await music(page)).playing, { message: 'turned off', timeout: 10_000 }).toBe(false);
  expect(await stored(page)).toMatchObject({ musicOn: false, music: 0.5 });

  await page.reload();
  await seated(page);
  // Taps at the table (opening the settings) unlock audio, and the music stays off: never even loaded.
  await openSettings(page);
  await expect(page.getByTestId('settings-music')).not.toBeChecked();
  await expect(page.getByTestId('settings-music-volume')).toHaveValue('0.5');
  await page.waitForTimeout(1000);
  expect((await music(page)).els, 'off after a reload: no music element').toBe(0);
  await page.getByTestId('settings-music').check();
  await closeSettings(page);
  await expect.poll(async () => (await music(page)).playing, { message: 'turned on again' }).toBe(true);
  expect(await stored(page)).toMatchObject({ musicOn: true, music: 0.5 });

  await standUp(page);
});

test('배경음악: 탭 전에는 시작하지 않고 첫 탭에 시작하며, 탭 밖에서의 재생을 거절하는 브라우저에서도 다음 탭에 이어진다', async ({ browser }) => {
  test.setTimeout(240_000);
  const { page } = await signUp(browser);
  await page.addInitScript(watchMusic, true);
  await sitWith(page, 'e2e-music-b', 1000);
  await seated(page);
  // Started inside the tap that sat down: allowed even by the strict policy.
  await expect.poll(async () => (await music(page)).playing, { message: 'music at the table' }).toBe(true);
  expect(await music(page)).toMatchObject({ plays: 1, refused: 0 });

  // A reload: nothing plays until the first tap, which starts it.
  await page.reload();
  await seated(page);
  await page.waitForTimeout(2000);
  expect((await music(page)).playing, 'no music before a tap').toBe(false);
  await page.getByTestId('table').click({ position: { x: 4, y: 4 } });
  await expect.poll(async () => (await music(page)).playing, { message: 'started by the first tap' }).toBe(true);
  expect(await music(page)).toMatchObject({ els: 1, refused: 0 });

  // The tab hidden: it fades out and stops. Shown again long after the last tap, the browser refuses it; the next tap
  // plays it again, the same element. Playwright runs each page.evaluate as a user gesture (transient activation, 5s in
  // Chromium), so the page shows itself again on a timer of its own, 8s after the last evaluate, with none meanwhile.
  await page.evaluate(() => {
    const w = window as unknown as { __hidden: boolean; __shownWithTap?: boolean };
    w.__hidden = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (w.__hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
    setTimeout(() => {
      w.__shownWithTap = navigator.userActivation.isActive;
      w.__hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    }, 14_000);
  });
  await page.waitForTimeout(6000);
  expect((await music(page)).playing, 'stopped while hidden').toBe(false);
  await page.waitForTimeout(9000);
  expect(await page.evaluate(() => (window as unknown as { __shownWithTap?: boolean }).__shownWithTap), 'shown again outside a tap').toBe(false);
  await expect.poll(async () => (await music(page)).refused, { message: 'refused outside a tap' }).toBe(1);
  expect((await music(page)).playing).toBe(false);
  await page.getByTestId('table').click({ position: { x: 4, y: 4 } });
  await expect.poll(async () => (await music(page)).playing, { message: 'played by the next tap' }).toBe(true);
  expect(await music(page)).toMatchObject({ els: 1, refused: 1 });

  await standUp(page);
});
