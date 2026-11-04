import { expect, type Page } from '@playwright/test';
import { signUp, test, widerThanDevice } from './helpers';

const TABS = ['dashboard', 'history', 'activity', 'account'] as const;
const shot = (name: string) => `test-results/me-tabs-${name}.png`;
type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page, testid: string) => (await page.getByTestId(testid).boundingBox()) as Box;

/** What My Page reads for itself (its lists and the cards on its tabs), as opposed to what every page reads. */
function pageLoads(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith('/api/me/') || pathname === '/api/auth/me/sessions') seen.push(pathname);
  });
  return seen;
}

/** Each tab at this size: nothing wider than the screen, the tabs and the header's buttons a thumb's size, a picture of each. */
async function eachTab(page: Page, name: string, tap: boolean) {
  for (const k of TABS) {
    const t = page.getByTestId(`me-tab-${k}`);
    await (tap ? t.tap() : t.click());
    await expect(t).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId(`me-panel-${k}`)).toBeVisible();
    for (const other of TABS) if (other !== k) await expect(page.getByTestId(`me-panel-${other}`)).toBeHidden();
    expect(await widerThanDevice(page), `${name} ${k}: wider than the screen`).toBe(false);
    await page.screenshot({ path: shot(`${name}-${k}`), fullPage: true, animations: 'disabled' });
  }
  for (const id of [...TABS.map((k) => `me-tab-${k}`), 'me-card', 'me-edit-profile']) {
    const b = await box(page, id);
    expect(b.height, `${name}: ${id} height`).toBeGreaterThanOrEqual(44);
    expect(b.width, `${name}: ${id} width`).toBeGreaterThanOrEqual(44);
  }
  // The four figures each keep their number inside their tile.
  const cut = await page.getByTestId('me-kpis').evaluate((g) => Array.from(g.querySelectorAll('*')).filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== 'inline').map((e) => e.textContent));
  expect(cut, `${name}: a figure runs out of its tile`).toEqual([]);
}

/** The tab is wholly in sight in its row (which scrolls sideways on a narrow phone), as it stands: nothing scrolled to it. */
async function inRow(page: Page, testid: string, name: string) {
  const seen = await page.getByTestId(testid).evaluate((t) => {
    const r = t.closest('[role="tablist"]')!.getBoundingClientRect();
    const b = t.getBoundingClientRect();
    return b.left >= r.left - 0.5 && b.right <= r.right + 0.5;
  });
  expect(seen, `${name}: ${testid} out of sight in its row`).toBe(true);
}

/** On a phone held upright the two buttons sit under the avatar and name, side by side; from 640 wide, at the header's end. */
async function headerLayout(page: Page, name: string, stacked: boolean) {
  const header = await box(page, 'me-header');
  const avatar = (await page.getByTestId('me-header').locator(':scope > div').first().boundingBox())!;
  const view = await box(page, 'me-card');
  const edit = await box(page, 'me-edit-profile');
  for (const b of [view, edit]) {
    expect(b.x, `${name}: inside the header`).toBeGreaterThanOrEqual(header.x);
    expect(b.x + b.width, `${name}: inside the header`).toBeLessThanOrEqual(header.x + header.width + 0.5);
  }
  expect(Math.abs(view.y - edit.y), `${name}: the two on one line`).toBeLessThan(1);
  if (stacked) {
    expect(view.y, `${name}: under the avatar`).toBeGreaterThan(avatar.y + avatar.height);
  } else {
    expect(view.x, `${name}: beside the avatar`).toBeGreaterThan(avatar.x + avatar.width);
    expect(view.y, `${name}: on the avatar's line`).toBeLessThan(avatar.y + avatar.height);
    expect(edit.x + edit.width, `${name}: at the header's end`).toBeGreaterThan(header.x + header.width - 40);
  }
}

test('My Page: a header with its actions, four figures and four tabs that fit every screen, keep the address, and read nothing again', async ({ browser }) => {
  test.setTimeout(240_000);
  const { page } = await signUp(browser, { mobile: true });
  const loads = pageLoads(page);
  await page.goto('/me');
  await expect(page.getByTestId('me-tab-dashboard')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('ledger')).toBeVisible();
  // A new member has played nothing: no rate, not 0%.
  await expect(page.getByTestId('me-kpi-hands')).toContainText('0');
  await expect(page.getByTestId('me-kpi-winrate')).toContainText('—');
  await expect(page.getByTestId('me-kpi-bb100')).toContainText('—');
  await expect(page.getByTestId('me-kpi-bb100')).toContainText('0핸드 기준');
  await page.waitForLoadState('networkidle');
  const before = loads.length;
  expect(before).toBeGreaterThan(0);

  for (const [w, h] of [
    [320, 568],
    [360, 640],
    [390, 844],
    [430, 932],
    [667, 375],
    [812, 375],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.getByTestId('me-tab-dashboard').tap();
    await headerLayout(page, `${w}x${h}`, w < 640);
    await eachTab(page, `${w}x${h}`, true);
  }
  // Going through every tab, six times over, read nothing again: each list was read once, when the page opened.
  expect(loads.slice(before), 'reads after the page opened').toEqual([]);

  // The tab is in the address: a reload, or the address given, opens it; the dashboard has none.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('me-tab-activity').tap();
  await expect(page).toHaveURL('/me?tab=activity');
  await page.reload();
  await expect(page.getByTestId('me-tab-activity')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('me-panel-activity')).toBeVisible();
  await expect(page.getByTestId('me-panel-activity')).toContainText('내가 쓴 글');
  await page.getByTestId('me-tab-dashboard').tap();
  await expect(page).toHaveURL('/me');
  await page.goto('/me?tab=nothing');
  await expect(page.getByTestId('me-tab-dashboard')).toHaveAttribute('aria-selected', 'true');

  // 프로필 편집 opens the form, ready to type in; 프로필 보기 is the public card.
  await page.getByTestId('me-edit-profile').tap();
  await expect(page).toHaveURL('/me?tab=account');
  await expect(page.locator('#profile input').first()).toBeFocused();
  // The tab it opened is in sight in its row; so is one the address opens, on the narrowest phone too.
  await inRow(page, 'me-tab-account', '390x844 edit');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/me?tab=account');
  await expect(page.getByTestId('me-tab-account')).toHaveAttribute('aria-selected', 'true');
  await inRow(page, 'me-tab-account', '320x568 address');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('me-card').tap();
  await expect(page).toHaveURL(/\/players\/[\w-]+$/);
  await page.context().close();

  // A computer: the actions at the header's end; the arrow keys go from tab to tab.
  const d = await signUp(browser);
  const p = d.page;
  await p.goto('/me');
  for (const [w, h] of [
    [1024, 768],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await p.setViewportSize({ width: w, height: h });
    await p.getByTestId('me-tab-dashboard').click();
    await headerLayout(p, `${w}x${h}`, false);
    await eachTab(p, `${w}x${h}`, false);
  }
  await p.getByTestId('me-tab-dashboard').click();
  await p.keyboard.press('ArrowRight');
  await expect(p.getByTestId('me-tab-history')).toBeFocused();
  await expect(p.getByTestId('me-tab-history')).toHaveAttribute('aria-selected', 'true');
  await expect(p).toHaveURL('/me?tab=history');
  await p.keyboard.press('End');
  await expect(p.getByTestId('me-tab-account')).toBeFocused();
  await expect(p.getByTestId('me-panel-account')).toBeVisible();
  await p.keyboard.press('ArrowRight');
  await expect(p.getByTestId('me-tab-dashboard')).toBeFocused();
  await expect(p).toHaveURL('/me');
  // Only the chosen tab is in the tab order; its panel is named by it.
  await expect(p.getByTestId('me-tab-history')).toHaveAttribute('tabindex', '-1');
  await expect(p.getByRole('tabpanel', { name: '대시보드' })).toBeVisible();
});
