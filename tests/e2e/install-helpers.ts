import { expect, type Page } from '@playwright/test';

export const DAY = 86_400_000;
export const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
export const KAKAO_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.5';

/**
 * The browser's side of installing, emulated in the page (no real device or install): the user agent and iOS's
 * home screen flag (`navigator.standalone`) or an app display mode, read from sessionStorage so a reload can switch
 * them, and `beforeinstallprompt` / `appinstalled` fired when a test says. Whatever install prompt the browser itself
 * offers is counted (`__realBip`) and kept from the page, so a test decides when one arrives.
 */
export async function emulateInstall(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __realBip: number; __prompts: string[]; __fireBip: (outcome: string) => void };
    w.__realBip = 0;
    w.__prompts = [];
    window.addEventListener('beforeinstallprompt', (e) => {
      if ((e as Event & { __fake?: boolean }).__fake) return;
      w.__realBip += 1;
      e.stopImmediatePropagation();
    });
    w.__fireBip = (outcome) => {
      const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        __fake: true,
        prompt: async () => void w.__prompts.push(outcome),
        userChoice: Promise.resolve({ outcome, platform: 'web' }),
      });
      window.dispatchEvent(e);
    };
    const ua = sessionStorage.getItem('e2e.ua');
    if (ua) {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua });
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 5 });
    }
    const standalone = sessionStorage.getItem('e2e.standalone');
    if (standalone === 'ios') Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
    if (standalone === 'display') {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q: string) =>
        q === '(display-mode: standalone)'
          ? ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as unknown as MediaQueryList)
          : real(q);
    }
  });
}

/** Switches the emulation (see emulateInstall) and reloads. */
export async function emulateAs(page: Page, opts: { ua?: string; standalone?: 'ios' | 'display' }) {
  await page.evaluate((o) => {
    for (const [k, v] of [['e2e.ua', o.ua], ['e2e.standalone', o.standalone]] as const) {
      if (v) sessionStorage.setItem(k, v);
      else sessionStorage.removeItem(k);
    }
  }, opts);
  await page.reload();
}

export const fireBip = (page: Page, outcome: 'accepted' | 'dismissed') => page.evaluate((o) => (window as unknown as { __fireBip: (x: string) => void }).__fireBip(o), outcome);
export const prompts = (page: Page) => page.evaluate(() => (window as unknown as { __prompts: string[] }).__prompts);
export const realBip = (page: Page) => page.evaluate(() => (window as unknown as { __realBip: number }).__realBip);
export const memo = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('jc.install') ?? '{}') as { until?: number; installed?: boolean });

/**
 * Opens the settings, which loads the install module: from then on the lobby offer is in the page if it shows at all,
 * so its absence means something.
 */
export async function openSettings(page: Page, mobile: boolean) {
  const gear = page.getByTestId('settings-open');
  await (mobile ? gear.tap() : gear.click());
  await expect(page.getByTestId('settings-install')).toBeVisible();
}
