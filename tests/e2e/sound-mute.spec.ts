import { expect, type Page } from '@playwright/test';
import { checkOrCall, signUp, sitWith, test } from './helpers';

/**
 * Counts the sounds the page starts (window.__sounds): every oscillator and buffer started on an AudioContext, but the
 * one-sample buffer the sound engine starts to unlock audio on a tap.
 */
function countSounds() {
  const w = window as unknown as { __sounds: number };
  w.__sounds = 0;
  for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype] as { start: (...a: number[]) => void }[]) {
    if (!Object.prototype.hasOwnProperty.call(proto, 'start')) continue;
    const start = proto.start;
    proto.start = function (this: AudioScheduledSourceNode, ...a: number[]) {
      if (!(this instanceof AudioBufferSourceNode && (this.buffer?.length ?? 0) <= 1)) w.__sounds += 1;
      return start.apply(this, a);
    };
  }
}
const sounds = (p: Page) => p.evaluate(() => (window as unknown as { __sounds: number }).__sounds);

/** Makes `n` moves at the table (check or call, else fold), waiting for the bot between them. */
async function play(p: Page, n: number) {
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
  // Sounds planned for later (a street's cards, chips on their way) have had their time.
  await p.waitForTimeout(2000);
}

/** Opens the settings at the table, sets mute, and closes them. */
async function setMute(p: Page, on: boolean) {
  await p.getByRole('button', { name: /^(설정|Settings)$/ }).click();
  const mute = p.getByRole('dialog').getByLabel(/^(음소거|Mute)$/);
  await (on ? mute.check() : mute.uncheck());
  await p.keyboard.press('Escape');
  await expect(p.getByRole('dialog')).toHaveCount(0);
}

test('음소거: 켜면 테이블이 어떤 소리도 내지 않고, 새로고침 뒤에도 유지되며, 끄면 다시 소리가 난다', async ({ browser }) => {
  test.setTimeout(300_000);
  const { page } = await signUp(browser);
  await page.addInitScript(countSounds);
  await sitWith(page, 'e2e-sound', 1000);
  await expect(page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(2, { timeout: 90_000 });

  // Sound on (the clicks so far unlocked it): the table's moves make sounds.
  await play(page, 2);
  await expect.poll(() => sounds(page), { message: 'sounds with mute off' }).toBeGreaterThan(0);

  await setMute(page, true);
  const muted = await sounds(page);
  await play(page, 3);
  expect(await sounds(page), 'sounds started while muted').toBe(muted);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jc.audio') ?? '{}').muted)).toBe(true);

  // Still muted after a reload: the box is ticked and the table stays silent (the counter starts again at 0).
  await page.reload();
  await expect(page.locator('[data-testid=table] [data-testid^="seat-"][data-state]')).toHaveCount(2);
  await page.getByRole('button', { name: /^(설정|Settings)$/ }).click();
  await expect(page.getByRole('dialog').getByLabel(/^(음소거|Mute)$/)).toBeChecked();
  await page.keyboard.press('Escape');
  await play(page, 3);
  expect(await sounds(page), 'sounds started while muted after a reload').toBe(0);

  // Mute off: the sounds come back.
  await setMute(page, false);
  await play(page, 2);
  await expect.poll(() => sounds(page), { message: 'sounds after mute is turned off' }).toBeGreaterThan(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jc.audio') ?? '{}').muted)).toBe(false);

  await page.getByTestId('leave').click();
});
