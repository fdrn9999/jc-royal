import { readFileSync } from 'node:fs';
import { expect, type Download, type Page } from '@playwright/test';
import type { HandDetailDto } from '@jc/types';
import { signUp, test, widerThanDevice } from './helpers';
import { build, HAND_2, HAND_6, HAND_9 } from './replay-hands';

const TEMPLATES = ['betline', 'classic', 'summary', 'highlight', 'minimal'] as const;
const RATIOS = { '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920], '16:9': [1920, 1080] } as const;
type Ratio = keyof typeof RATIOS;

/** Heads-up all-in for nearly a billion chips each: the longest amounts there are. */
const HAND_BIG = build(
  'e2e-share-big',
  2,
  0,
  ['Ks', 'Qd', '7h', '4c', '2d'],
  [
    { seat: 0, name: '가나다라마바사아자차카타파하거너', stack: 987_654_321, cards: ['Ah', 'Kd'], rank: 'pair', best: ['Kd', 'Ks', 'Ah', 'Qd', '7h'] },
    { seat: 1, name: 'MMMMMMMMMMMMMMMM', stack: 987_654_321, cards: ['Qs', 'Qc'], rank: 'three-of-a-kind', best: ['Qs', 'Qc', 'Qd', 'Ks', '7h'] },
  ],
  [
    [0, 'preflop', 'post-sb', 50],
    [1, 'preflop', 'post-bb', 100],
    [0, 'preflop', 'allin', 987_654_271],
    [1, 'preflop', 'call', 987_654_221],
  ],
  [{ amount: 1_975_308_642, eligible: [0, 1], winners: [[1, 1_975_308_642]] }],
);

/** Six seats, a raise everyone folds to: no showdown, and the viewer (seat 0) folded. */
const HAND_FOLD = build(
  'e2e-share-fold',
  6,
  5,
  [],
  [
    { seat: 0, name: '내닉네임', stack: 10_000, cards: ['9s', '9d'] },
    { seat: 1, name: 'small_blind_1', stack: 10_000 },
    { seat: 2, name: 'big_blind_2', stack: 10_000 },
    { seat: 3, name: '레이즈한사람', stack: 10_000 },
    { seat: 4, name: 'folder_4', stack: 10_000 },
    { seat: 5, name: 'button_5', stack: 10_000 },
  ],
  [
    [1, 'preflop', 'post-sb', 50],
    [2, 'preflop', 'post-bb', 100],
    [3, 'preflop', 'raise', 300],
    [4, 'preflop', 'fold', 0],
    [5, 'preflop', 'fold', 0],
    [0, 'preflop', 'fold', 0],
    [1, 'preflop', 'fold', 0],
    [2, 'preflop', 'fold', 0],
  ],
  [{ amount: 450, eligible: [3], winners: [[3, 450]] }],
);

/** A PNG's width and height from its header, a WebP's from its first chunk. */
function dims(buf: Buffer): { type: 'png' | 'webp'; w: number; h: number } {
  if (buf.subarray(1, 4).toString('latin1') === 'PNG') return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WEBP') throw new Error('neither PNG nor WebP');
  const chunk = buf.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') return { type: 'webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { type: 'webp', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return { type: 'webp', w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
}

async function open(p: Page, hand: HandDetailDto) {
  await p.route(`**/api/me/hands/${hand.id}`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hand) }));
  await p.goto(`/me/hands/${hand.id}`);
  await expect(p.getByTestId('replay-index')).toHaveText(/^1\//);
}

/** Opens the dialog at the step shown and waits for its preview. */
async function dialog(p: Page) {
  await p.getByTestId('replay-share-open').click();
  await expect(p.getByTestId('share-dialog')).toBeVisible();
  await expect(p.getByTestId('share-preview')).toHaveAttribute('data-ready', '1', { timeout: 15_000 });
}

/** Picks `template` and `ratio` and waits for the preview to be drawn for them. */
async function choose(p: Page, template: string, ratio: Ratio) {
  await p.getByTestId(`share-template-${template}`).click();
  await p.getByTestId(`share-ratio-${ratio}`).click();
  const preview = p.getByTestId('share-preview');
  await expect(preview).toHaveAttribute('width', String(RATIOS[ratio][0]));
  await expect(preview).toHaveAttribute('height', String(RATIOS[ratio][1]));
  await expect(preview).toHaveAttribute('data-ready', '1');
}

async function save(p: Page, button = 'share-save'): Promise<{ d: Download; buf: Buffer }> {
  const [d] = await Promise.all([p.waitForEvent('download'), p.getByTestId(button).click()]);
  const path = await d.path();
  return { d, buf: readFileSync(path) };
}

/**
 * How far the saved image is from the preview, pixel by pixel: the file drawn at the preview's size over it, the mean
 * difference per channel (0–255). Line art and text resampled from double the size differ a little at their edges.
 */
function apart(p: Page, buf: Buffer, mime: string) {
  return p.evaluate(
    async ({ b64, mime }) => {
      const preview = document.querySelector<HTMLCanvasElement>('[data-testid=share-preview]')!;
      const img = new Image();
      img.src = `data:${mime};base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = preview.width;
      c.height = preview.height;
      const x = c.getContext('2d')!;
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, c.width, c.height);
      const a = x.getImageData(0, 0, c.width, c.height).data;
      const b = preview.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
      return { mean: sum / ((a.length / 4) * 3), opaque: a.every((v, i) => i % 4 !== 3 || v === 255) };
    },
    { b64: buf.toString('base64'), mime },
  );
}

test('share image: every template at every ratio saves a PNG of its size, named by the hand and the step, the same as its preview', async ({ browser }) => {
  test.setTimeout(300_000);
  const { page: p } = await signUp(browser);
  await open(p, HAND_9);
  await p.getByTestId('replay-last').click();
  await dialog(p);
  await expect(p.getByTestId('share-step')).toContainText(/결과|Result/);
  for (const tpl of TEMPLATES)
    for (const ratio of Object.keys(RATIOS) as Ratio[]) {
      const where = `${tpl} ${ratio}`;
      await choose(p, tpl, ratio);
      const { d, buf } = await save(p);
      expect(d.suggestedFilename(), where).toBe('JC-ROYAL_Hand-42_Result.png');
      expect(dims(buf), where).toEqual({ type: 'png', w: RATIOS[ratio][0], h: RATIOS[ratio][1] });
      await expect(p.getByTestId('share-status')).toHaveAttribute('data-state', 'saved');
      await expect(p.getByTestId('share-status')).toContainText('JC-ROYAL_Hand-42_Result.png');
      // The file is the preview's own pixels, with no transparent background.
      const diff = await apart(p, buf, 'image/png');
      expect(diff.opaque, where).toBe(true);
      expect(diff.mean, where).toBeLessThan(0.01);
      await d.saveAs(test.info().outputPath(`share-9-${tpl}-${ratio.replace(':', 'x')}.png`));
    }

  // Twice the resolution, as WebP: the same picture at double the size.
  await p.getByTestId('share-more').locator('summary').click();
  await p.getByTestId('share-format-webp').click();
  await p.getByTestId('share-res-2').click();
  await choose(p, 'highlight', '4:5');
  await expect(p.getByTestId('share-save')).toContainText('WebP');
  const big = await save(p);
  expect(big.d.suggestedFilename()).toBe('JC-ROYAL_Hand-42_Result.webp');
  expect(dims(big.buf)).toEqual({ type: 'webp', w: 2160, h: 2700 });
  const diff = await apart(p, big.buf, 'image/webp');
  expect(diff.opaque).toBe(true);
  expect(diff.mean).toBeLessThan(6);
  await big.d.saveAs(test.info().outputPath('share-9-highlight-4x5@2x.webp'));
  test.info().annotations.push({ type: 'webp@2x vs preview', description: `mean channel difference ${diff.mean.toFixed(2)} / 255` });

  // Names, the log and the amount off: still a whole image.
  await p.getByTestId('share-format-png').click();
  await p.getByTestId('share-res-1').click();
  for (const id of ['share-names', 'share-log', 'share-win']) await p.getByTestId(id).uncheck();
  await p.getByTestId('share-bg-plain').click();
  await choose(p, 'summary', '9:16');
  const off = await save(p);
  expect(dims(off.buf)).toEqual({ type: 'png', w: 1080, h: 1920 });
  await off.d.saveAs(test.info().outputPath('share-9-summary-9x16-anon-plain.png'));

  // Closing it puts the focus back where it was opened from.
  await p.keyboard.press('Escape');
  await expect(p.getByTestId('share-dialog')).toHaveCount(0);
  await expect(p.getByTestId('replay-share-open')).toBeFocused();
});

test('share image: the step it shows is the step it was asked at — earlier streets, a hand nobody called, the longest amounts', async ({ browser }) => {
  test.setTimeout(300_000);
  const { page: p } = await signUp(browser);
  const shots: [HandDetailDto, string, string | null, Ratio[]][] = [
    [HAND_9, 'flop', 'Flop', ['16:9', '9:16']],
    [HAND_6, 'showdown', 'Showdown', ['1:1', '9:16']],
    [HAND_2, 'river', 'River', ['4:5']],
    [HAND_BIG, 'result', 'Result', ['1:1', '9:16', '16:9']],
    [HAND_FOLD, 'result', 'Result', ['1:1', '4:5']],
  ];
  for (const [hand, phase, file, ratios] of shots) {
    await open(p, hand);
    if (phase === 'result') await p.getByTestId('replay-last').click();
    else await p.getByTestId(`replay-phase-${phase}`).click();
    await dialog(p);
    for (const tpl of TEMPLATES)
      for (const ratio of ratios) {
        await choose(p, tpl, ratio);
        const { d, buf } = await save(p);
        expect(d.suggestedFilename()).toBe(`JC-ROYAL_Hand-42_${file}.png`);
        expect(dims(buf)).toEqual({ type: 'png', w: RATIOS[ratio][0], h: RATIOS[ratio][1] });
        await d.saveAs(test.info().outputPath(`share-${hand.id.replace('e2e-', '')}-${phase}-${tpl}-${ratio.replace(':', 'x')}.png`));
      }
    await p.keyboard.press('Escape');
    await expect(p.getByTestId('share-dialog')).toHaveCount(0);
  }
});

test('share image: the betting line by default, up to the step or of the whole hand as chosen, in chips or big blinds', async ({ browser }) => {
  test.setTimeout(180_000);
  const { page: p } = await signUp(browser);
  await open(p, HAND_9);
  await p.getByTestId('replay-phase-flop').click();
  await dialog(p);
  await expect(p.getByTestId('share-template-betline')).toHaveAttribute('aria-pressed', 'true');
  await expect(p.getByTestId('share-span-step')).toHaveAttribute('aria-pressed', 'true');
  const step = await save(p);
  expect(step.d.suggestedFilename()).toBe('JC-ROYAL_Hand-42_Flop.png');
  await step.d.saveAs(test.info().outputPath('share-9-flop-betline-step.png'));

  // The whole hand: said so under the preview, named by its last step; the replay itself stays at the flop.
  await p.getByTestId('share-span-hand').click();
  await expect(p.getByTestId('share-step')).toContainText(/핸드 전체|whole hand/);
  await expect(p.getByTestId('share-preview')).toHaveAttribute('data-ready', '1');
  const whole = await save(p);
  expect(whole.d.suggestedFilename()).toBe('JC-ROYAL_Hand-42_Result.png');
  expect(dims(whole.buf)).toEqual({ type: 'png', w: 1080, h: 1080 });
  expect((await apart(p, whole.buf, 'image/png')).mean).toBeLessThan(0.01);
  await whole.d.saveAs(test.info().outputPath('share-9-hand-betline.png'));

  // In big blinds: another picture of the same hand.
  await p.getByTestId('share-more').locator('summary').click();
  await p.getByTestId('share-unit-bb').click();
  await expect(p.getByTestId('share-preview')).toHaveAttribute('data-ready', '1');
  const bb = await save(p);
  expect((await apart(p, whole.buf, 'image/png')).mean).toBeGreaterThan(0.01);
  expect((await apart(p, bb.buf, 'image/png')).mean).toBeLessThan(0.01);
  await bb.d.saveAs(test.info().outputPath('share-9-hand-betline-bb.png'));

  // Kept for the quick save, whose label says what it saves.
  await p.keyboard.press('Escape');
  await p.getByTestId('replay-capture-open').click();
  await expect(p.getByTestId('replay-share-quick')).toHaveText(/핸드 전체|whole hand/);
});

test('share image on a phone: the capture mode saves at once, keeps the step it was asked at while it is made, and a failed save can be tried again', async ({ browser }) => {
  test.setTimeout(240_000);
  const { page } = await signUp(browser);
  const state = await page.context().storageState();
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const p = await ctx.newPage();
  await open(p, HAND_9);
  // The share button sits with the capture and the fold buttons in the narrow screen's row.
  await expect(p.getByTestId('replay-tools').getByRole('button')).toHaveCount(3);
  expect(await widerThanDevice(p)).toBe(false);

  // At the showdown, a quick save from the capture mode; the replay moved on meanwhile (made slow here), the file is
  // still the showdown's.
  await p.getByTestId('replay-phase-showdown').click();
  await p.getByTestId('replay-capture-open').click();
  await expect(p.getByTestId('replay-capture')).toBeVisible();
  const index = p.getByTestId('replay-index');
  const at = await index.textContent();
  await p.evaluate(() => {
    const real = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
      real.call(this, (b) => setTimeout(() => cb(b), 1500), ...rest);
    };
    (window as { __realToBlob?: typeof real }).__realToBlob = real;
  });
  const quick = p.getByTestId('replay-share-quick');
  const downloaded = p.waitForEvent('download');
  await quick.click();
  await expect(quick).toHaveAttribute('data-state', 'making');
  await p.keyboard.press('ArrowRight');
  await expect(index).not.toHaveText(at!);
  const d = await downloaded;
  expect(d.suggestedFilename()).toBe('JC-ROYAL_Hand-42_Showdown.png');
  expect(dims(readFileSync(await d.path()))).toEqual({ type: 'png', w: 1080, h: 1080 });
  await expect(quick).toHaveAttribute('data-state', 'saved');
  await expect(p.getByTestId('replay-share-quick-status')).toContainText('JC-ROYAL_Hand-42_Showdown.png');
  await d.saveAs(test.info().outputPath('share-phone-quick-showdown.png'));
  // Moving on clears the saved mark.
  await p.keyboard.press('ArrowLeft');
  await expect(quick).toHaveAttribute('data-state', 'idle');

  // A canvas that cannot make a file: the quick save opens the dialog saying so, with a retry that works once it can.
  await p.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function (cb) {
      setTimeout(() => cb(null), 0);
    };
  });
  await quick.click();
  await expect(p.getByTestId('share-dialog')).toBeVisible();
  const status = p.getByTestId('share-status');
  await expect(status).toHaveAttribute('data-state', 'failed');
  await expect(p.getByTestId('share-retry')).toBeVisible();
  // The capture's keys are off under the dialog: the arrows do not move the replay behind it.
  const under = await index.textContent();
  await p.keyboard.press('ArrowRight');
  await expect(index).toHaveText(under!);
  // The page under the capture stays out of reach under the dialog too: Tab goes round the dialog and the capture
  // (and the browser's), never into the page.
  expect(await p.evaluate(() => document.getElementById('root')!.inert)).toBe(true);
  for (let k = 0; k < 8; k++) {
    await p.keyboard.press('Tab');
    expect(await p.evaluate(() => !document.getElementById('root')!.contains(document.activeElement)), `Tab ${k + 1}`).toBe(true);
  }
  await p.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = (window as { __realToBlob?: typeof HTMLCanvasElement.prototype.toBlob }).__realToBlob!;
  });
  await p.getByTestId('share-retry').click();
  await expect(status).not.toHaveAttribute('data-state', 'failed');
  await expect(p.getByTestId('share-preview')).toHaveAttribute('data-ready', '1', { timeout: 15_000 });

  // The dialog fits the phone: nothing wider than the screen, the preview and the save button in reach.
  expect(await widerThanDevice(p)).toBe(false);
  const box = await p.getByTestId('share-preview').boundingBox();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375.5);
  await choose(p, 'summary', '9:16');
  await p.screenshot({ path: test.info().outputPath('share-phone-dialog.png') });
  const s = await save(p);
  expect(s.d.suggestedFilename()).toBe('JC-ROYAL_Hand-42_Showdown.png');
  expect(dims(s.buf)).toEqual({ type: 'png', w: 1080, h: 1920 });
  await expect(status).toHaveAttribute('data-state', 'saved');

  // Closed, the capture is as it was, the page under it still out of reach; opened by its button, the focus goes back
  // to that button.
  await p.keyboard.press('Escape');
  await expect(p.getByTestId('share-dialog')).toHaveCount(0);
  await expect(p.getByTestId('replay-capture')).toBeVisible();
  expect(await p.evaluate(() => document.getElementById('root')!.inert)).toBe(true);
  const share = p.getByTestId('replay-share-open-capture');
  await share.click();
  await expect(p.getByTestId('share-dialog')).toBeVisible();
  await p.keyboard.press('Escape');
  await expect(p.getByTestId('share-dialog')).toHaveCount(0);
  await expect(share).toBeFocused();
  await ctx.close();
});
