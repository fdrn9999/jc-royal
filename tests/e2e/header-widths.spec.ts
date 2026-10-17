import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';

/**
 * The signed-in header between the phone layout (bottom tabs below 640px) and a wide window. Six links plus the
 * wordmark, balance, inbox, language switch, settings and logout did not fit there: Korean labels broke one letter a
 * line and in English the page grew wider than the window, pushing the settings and logout out of it.
 */
const WIDTHS = [640, 700, 768, 844, 915, 1024, 1280, 1440];

/** Labels of the header's links and buttons that wrapped onto a second line, and controls that leave the window. */
function headerProblems(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector('header')!.firstElementChild!;
    const shown = (el: Element) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    // A label wrapped when one of its text nodes lays out on more than one line (a badge beside it is another node).
    const wraps = (el: Element) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        if (!t.textContent!.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(t);
        if (new Set(Array.from(r.getClientRects(), (x) => Math.round(x.top))).size > 1) return true;
      }
      return false;
    };
    const nav = row.querySelector('nav')!;
    const controls = Array.from(row.querySelectorAll('a,button')).filter(shown);
    return {
      wrapped: controls.filter(wraps).map((el) => el.textContent!.trim()),
      // A link scrolled out of the strip is clipped by it, not outside the window.
      outside: controls
        .filter((el) => !nav.contains(el))
        .filter((el) => {
          const x = el.getBoundingClientRect();
          return x.left < 0 || x.right > window.innerWidth;
        })
        .map((el) => el.textContent!.trim() || el.getAttribute('aria-label')),
    };
  });
}

async function checkWidths(page: Page, lang: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 700 });
    await expect(page.getByTestId('header-nav')).toBeVisible();
    expect(await widerThanDevice(page), `${lang} ${width}px: page wider than the window`).toBe(false);
    expect(await headerProblems(page), `${lang} ${width}px`).toEqual({ wrapped: [], outside: [] });
    await expect(page.getByTestId('settings-open')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('inbox-link')).toBeInViewport({ ratio: 1 });
  }
}

test('header between the phone layout and a wide window: no wrapped label, nothing outside the window, every link reachable', async ({ browser }) => {
  const { page } = await signUp(browser);
  await checkWidths(page, 'ko');

  // Narrow: the strip scrolls, and the last link reached with Tab comes fully into it.
  await page.setViewportSize({ width: 640, height: 700 });
  const nav = page.getByTestId('header-nav');
  const last = nav.getByRole('link').last();
  for (let i = 0; i < 20 && !(await last.evaluate((a) => a === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(last).toBeFocused();
  const [n, a] = [(await nav.boundingBox())!, (await last.boundingBox())!];
  expect(a.x).toBeGreaterThanOrEqual(n.x);
  expect(a.x + a.width).toBeLessThanOrEqual(n.x + n.width);

  // Without the header's language switch and logout, the settings still have both.
  await page.setViewportSize({ width: 844, height: 700 });
  await expect(page.getByRole('button', { name: 'EN', exact: true })).toBeHidden();
  await page.getByTestId('settings-open').click();
  await expect(page.getByLabel('언어')).toBeVisible();
  await expect(page.getByTestId('settings-logout')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-logout')).toBeHidden();

  // English labels are the longer ones.
  await page.setViewportSize({ width: 1440, height: 900 });
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH'), page.getByRole('button', { name: 'EN', exact: true }).click()]);
  await expect(page.getByTestId('header-nav')).toContainText('Tournaments');
  await checkWidths(page, 'en');
  await page.setViewportSize({ width: 844, height: 700 });
  await page.screenshot({ path: test.info().outputPath('header-844-en.png'), clip: { x: 0, y: 0, width: 844, height: 64 } });
});
