import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';

/** Runs SQL on the E2E database the running workers use, retrying while they hold it. */
function sql(command: string) {
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'jc-royal-db', '--local', '--persist-to', 'tests/.state/e2e', '-c', 'apps/api/wrangler.jsonc', '--command', command], { stdio: 'ignore' });
    } catch (e) {
      if (i > 8) throw e;
    }
  }
}

/** The bottom navigation as drawn: each label against its tab, the gaps between labels, and the row against the screen. */
function bottomNav(page: Page, fontSize?: string) {
  return page.evaluate((fontSize) => {
    const nav = Array.from(document.querySelectorAll('nav')).find((n) => getComputedStyle(n).position === 'fixed')!;
    if (fontSize) for (const a of Array.from(nav.querySelectorAll('a'))) a.style.fontSize = fontSize;
    const tabs = Array.from(nav.querySelectorAll('a')).map((a) => {
      const range = document.createRange();
      range.selectNodeContents(a.firstChild!);
      const label = range.getBoundingClientRect();
      const box = a.getBoundingClientRect();
      return {
        text: a.firstChild!.textContent!,
        lines: range.getClientRects().length,
        inside: label.left >= box.left - 0.5 && label.right <= box.right + 0.5,
        left: label.left,
        right: label.right,
        boxRight: box.right,
        height: box.height,
        font: parseFloat(getComputedStyle(a).fontSize),
      };
    });
    return {
      tabs,
      minGap: Math.min(...tabs.slice(1).map((t, i) => t.left - tabs[i]!.right)),
      lastRight: tabs.at(-1)!.boxRight,
      scrolls: nav.scrollWidth > nav.clientWidth + 1,
    };
  }, fontSize);
}

const LABELS = {
  ko: ['로비', '토너먼트', '아카데미', '게시판', '친구', '마이페이지'],
  en: ['Lobby', 'Tourneys', 'Academy', 'Board', 'Friends', 'My Page'],
};
const TAB = { ko: '토너먼트', en: 'Tourneys' };

test('mobile: tournaments are a bottom tab of their own, whole on one line beside the other five at every phone width', async ({ browser }) => {
  const { page } = await signUp(browser, { mobile: true });
  // A ten-digit wallet, through an adjustment the ledger records (the books stay balanced): the header is at its widest.
  const id = await page.evaluate(async () => ((await (await fetch('/api/auth/me')).json()) as { id: string }).id);
  const big = 1_234_567_890;
  sql(
    `INSERT INTO chip_ledger (id, user_id, type, amount, balance_after, idempotency_key, memo, created_at) VALUES ('e2e-nav-${id}', '${id}', 'admin_adjust', ${big - 10_000}, ${big}, 'e2e-nav-${id}', 'e2e', ${Date.now()}); UPDATE users SET balance = ${big} WHERE id = '${id}'`,
  );
  await page.reload();
  await expect(page.getByTestId('balance')).toHaveText('1,234,567,890');
  const tab = page.getByTestId('nav-tournaments-mobile');

  for (const locale of ['ko', 'en'] as const) {
    if (locale === 'en') {
      await page.getByTestId('settings-open').click();
      await page.getByLabel('언어', { exact: true }).selectOption('en');
      await page.keyboard.press('Escape');
    }
    await expect(tab).toHaveText(TAB[locale]);
    for (const w of [320, 344, 360, 375, 390]) {
      await page.setViewportSize({ width: w, height: 740 });
      await page.goto('/');
      await expect(tab).toHaveText(TAB[locale]);
      const nav = await bottomNav(page);
      expect(nav.tabs.map((t) => t.text), `${locale} ${w}`).toEqual(LABELS[locale]);
      for (const t of nav.tabs) {
        expect(t.lines, `${locale} ${w}: "${t.text}" wraps`).toBe(1);
        expect(t.inside, `${locale} ${w}: "${t.text}" runs out of its tab`).toBe(true);
        expect(t.font, `${locale} ${w}: "${t.text}" is drawn too small`).toBeGreaterThanOrEqual(11);
        // As tall a target for a thumb as the five tabs were, also where the labels shrink.
        expect(t.height, `${locale} ${w}: "${t.text}" is a short target`).toBeGreaterThanOrEqual(44);
      }
      // Labels stay apart, and all six fit the screen without the row having to scroll.
      expect(nav.minGap, `${locale} ${w}: labels crowd together`).toBeGreaterThanOrEqual(4);
      expect(nav.lastRight, `${locale} ${w}: the last tab is off the screen`).toBeLessThanOrEqual(w + 0.5);
      expect(nav.scrolls, `${locale} ${w}: the row scrolls`).toBe(false);
      expect(await widerThanDevice(page)).toBe(false);
      if (w === 320) await page.screenshot({ path: test.info().outputPath(`nav-${locale}-320.png`) });

      // One tap from anywhere opens the list, and the tab says it is the current page.
      await tab.tap();
      await expect(page).toHaveURL(/\/tournaments$/);
      await expect(tab).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(locale === 'ko' ? '토너먼트' : 'Tournaments');
    }
  }

  // Text half again as large (a phone's text-size setting can do this): the row scrolls sideways instead of cutting off
  // the last tab or widening the page, and the last tab is still one tap away.
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  await expect(tab).toHaveText(TAB.en);
  const large = await bottomNav(page, '19.5px');
  expect(large.tabs.every((t) => t.lines === 1 && t.inside)).toBe(true);
  expect(large.scrolls).toBe(true);
  expect(await widerThanDevice(page)).toBe(false);
  // (A row cut off at the screen's edge instead leaves the tap nothing to scroll to: it times out off the screen.)
  await page.getByRole('link', { name: 'My Page', exact: true }).last().tap({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/me$/);
});
