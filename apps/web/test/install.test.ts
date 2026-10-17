import { describe, expect, it } from 'vitest';
import { guideOsOf, isSnoozed, LATER_MS, offerVisible, parseMemo, platformOf, SNOOZE_MS, snoozed, standaloneFrom, type InstallState } from '../src/lib/install';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  // iPadOS asks for the desktop site: it says Macintosh, and only its touch points give it away.
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  iosKakao: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.5',
  iosInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 341.0.0.29.98 (iPhone15,2; iOS 17_5; ko_KR; ko; scale=3.00; 1179x2556)',
  androidNaver: 'Mozilla/5.0 (Linux; Android 14; SM-S918N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36 NAVER(inapp; search; 2000; 12.6.1)',
  androidWebView: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  pixelChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  androidEdge: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 EdgA/138.0.0.0',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
};

const base: InstallState = { platform: 'android-chrome', standalone: false, installed: false, until: 0, canPrompt: false };
const NOW = Date.UTC(2026, 9, 17, 3);

describe('install platform', () => {
  it('tells the browsers apart by the steps they need', () => {
    expect(platformOf(UA.iphoneSafari, 5)).toBe('ios-safari');
    expect(platformOf(UA.ipad, 5)).toBe('ios-safari');
    expect(platformOf(UA.ipad, 0)).toBe('desktop'); // a Mac
    expect(platformOf(UA.iosChrome, 5)).toBe('ios-other');
    expect(platformOf(UA.iosKakao, 5)).toBe('in-app-ios');
    expect(platformOf(UA.iosInstagram, 5)).toBe('in-app-ios');
    expect(platformOf(UA.androidNaver, 5)).toBe('in-app-android');
    expect(platformOf(UA.androidWebView, 5)).toBe('in-app-android');
    expect(platformOf(UA.samsung, 5)).toBe('samsung');
    expect(platformOf(UA.pixelChrome, 5)).toBe('android-chrome');
    expect(platformOf(UA.androidEdge, 5)).toBe('android-other');
    expect(platformOf(UA.androidFirefox, 5)).toBe('android-other');
    expect(platformOf(UA.windowsChrome, 0)).toBe('desktop');
  });

  it('opens the guide on the device’s own tab', () => {
    expect(['ios-safari', 'ios-other', 'in-app-ios'].map((p) => guideOsOf(p as never))).toEqual(['ios', 'ios', 'ios']);
    expect(['samsung', 'android-chrome', 'android-other', 'in-app-android'].map((p) => guideOsOf(p as never))).toEqual(['android', 'android', 'android', 'android']);
    expect(guideOsOf('desktop')).toBe('desktop');
  });
});

describe('install standalone', () => {
  const only = (mode: string) => (q: string) => q === `(display-mode: ${mode})`;
  it('counts every app display mode and iOS’s home screen flag', () => {
    for (const m of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']) expect(standaloneFrom(only(m), undefined)).toBe(true);
    expect(standaloneFrom(only('browser'), undefined)).toBe(false);
    expect(standaloneFrom(() => false, true)).toBe(true);
    expect(standaloneFrom(() => false, 'true')).toBe(false);
    expect(standaloneFrom(() => false, false)).toBe(false);
  });
});

describe('install offer', () => {
  it('reads what the device kept, and nothing broken', () => {
    expect(parseMemo(null)).toEqual({ until: 0, installed: false });
    expect(parseMemo('not json')).toEqual({ until: 0, installed: false });
    expect(parseMemo('{"until":"soon","installed":"yes"}')).toEqual({ until: 0, installed: false });
    expect(parseMemo(JSON.stringify({ until: NOW, installed: true }))).toEqual({ until: NOW, installed: true });
  });

  it('Later hides it for 3 days, the snooze for 30, and neither longer even if the clock goes back', () => {
    const later = snoozed({ until: 0, installed: false }, NOW, LATER_MS).until;
    expect(LATER_MS).toBe(3 * 86_400_000);
    expect(isSnoozed(later, NOW + LATER_MS - 1)).toBe(true);
    expect(isSnoozed(later, NOW + LATER_MS)).toBe(false);
    const month = snoozed({ until: 0, installed: false }, NOW, SNOOZE_MS).until;
    expect(SNOOZE_MS).toBe(30 * 86_400_000);
    expect(isSnoozed(month, NOW)).toBe(true);
    expect(isSnoozed(month, NOW + SNOOZE_MS - 1)).toBe(true);
    expect(isSnoozed(month, NOW + SNOOZE_MS)).toBe(false);
    // The device clock set back a year: the promise was 30 days, so it shows again.
    expect(isSnoozed(month, NOW - 365 * 86_400_000)).toBe(false);
    expect(isSnoozed(0, NOW)).toBe(false);
  });

  it('shows only where this browser can install, never in the app, after an install or while hidden', () => {
    expect(offerVisible(base, NOW)).toBe(true);
    for (const p of ['ios-safari', 'ios-other', 'in-app-ios', 'in-app-android', 'samsung', 'android-other'] as const) expect(offerVisible({ ...base, platform: p }, NOW)).toBe(true);
    // A computer: only once the browser hands over its prompt (the steps are in the settings).
    expect(offerVisible({ ...base, platform: 'desktop' }, NOW)).toBe(false);
    expect(offerVisible({ ...base, platform: 'desktop', canPrompt: true }, NOW)).toBe(true);
    expect(offerVisible({ ...base, standalone: true }, NOW)).toBe(false);
    expect(offerVisible({ ...base, standalone: true, canPrompt: true }, NOW)).toBe(false);
    expect(offerVisible({ ...base, installed: true }, NOW)).toBe(false);
    expect(offerVisible({ ...base, until: NOW + LATER_MS }, NOW)).toBe(false);
    expect(offerVisible({ ...base, until: NOW + LATER_MS, canPrompt: true }, NOW)).toBe(false);
    expect(offerVisible({ ...base, until: NOW + LATER_MS }, NOW + LATER_MS)).toBe(true);
  });
});
