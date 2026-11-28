import { expect } from '@playwright/test';
import { signUp, sitWith, standUp, test } from './helpers';

/**
 * A phone held on its side, on my turn: the seats take the table's corners and the action bar the column at the right,
 * so the reaction button stands in the header (Table.tsx). It and its tray lie over no control of the turn and inside
 * the screen, at the browser's text size and at 125%. One seat, a page of its own for each text size (as
 * table-text.spec.ts looks at its screens).
 */
test('가로 휴대폰 667×375, 글자 100%와 125%: 내 턴의 이모지 버튼은 헤더에 있고, 트레이를 열어도 액션 버튼을 가리지 않는다', async ({ browser }) => {
  test.setTimeout(600_000);
  const { page } = await signUp(browser);
  await sitWith(page, 'e2e-tx6', 1000);
  const state = await page.context().storageState();
  await page.goto('/');
  const found: string[] = [];
  for (const font of [16, 20]) {
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    await (await ctx.newCDPSession(p)).send('Page.setFontSizes', { fontSizes: { standard: font } });
    await p.goto('/table/e2e-tx6');
    await expect(p.getByTestId('action-bar')).toBeVisible({ timeout: 120_000 });
    const open = p.getByTestId('react-turn').getByTestId('react-open');
    await expect(open).toBeVisible();
    await expect(p.getByTestId('react-open')).toHaveCount(1);
    await open.tap();
    await expect(p.getByTestId('react-tray')).toBeVisible();
    const issues = await p.evaluate(() => {
      const box = (e: Element) => e.getBoundingClientRect();
      const meet = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      const mine = [document.querySelector('[data-testid=react-open]')!, ...Array.from(document.querySelectorAll('[data-testid=react-tray] button'))];
      const controls = Array.from(document.querySelectorAll('[data-testid=action-bar] button, [data-testid=action-bar] input, [data-testid=timebank-use]'));
      const out: string[] = [];
      for (const m of mine) {
        const id = m.getAttribute('data-testid');
        const r = box(m);
        if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) out.push(`off screen: ${id}`);
        if (r.width < 40 || r.height < 40) out.push(`small: ${id} ${Math.round(r.width)}×${Math.round(r.height)}`);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || !m.contains(hit)) out.push(`covered: ${id}`);
        for (const c of controls) if (meet(r, box(c))) out.push(`over a control: ${id} × ${c.getAttribute('data-testid') ?? c.textContent?.trim()}`);
      }
      return out;
    });
    found.push(...issues.map((x) => `${font}px ${x}`));
    await p.screenshot({ path: test.info().outputPath(`ux-side-${font}-emoji-my-turn.png`) });
    await p.keyboard.press('Escape');
    await expect(p.getByTestId('react-tray')).toHaveCount(0);
    await ctx.close();
  }
  // Back at the table to stand up, so the seat is free for the next run.
  await page.goto('/table/e2e-tx6');
  await standUp(page);
  await page.context().close();
  expect(found).toEqual([]);
});
