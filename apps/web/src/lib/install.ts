import { useSyncExternalStore } from 'react';

/**
 * Installing JC ROYAL as an app from the browser (home screen icon, its own window, no address bar).
 *
 * Installing needs no service worker: the browsers that install from a page (Chrome, Edge, Samsung Internet, Safari)
 * do it from the manifest alone. The only one (public/sw.js) is for push notifications, installed when a member turns
 * them on, and nothing — games, sign-in, cards — is ever cached for offline use. Installing is never
 * assumed to be possible: the lobby only offers it where a browser can do it, and the guide says menus differ.
 */

const DAY = 86_400_000;
/** "Later" hides the lobby offer for this long. */
export const LATER_MS = 3 * DAY;
/** "Not for 30 days". */
export const SNOOZE_MS = 30 * DAY;

/**
 * Where the page is open, which decides the steps the guide shows. In-app browsers (KakaoTalk, NAVER, Instagram,
 * Facebook, LINE, Daum, Android WebViews) cannot install; iOS installs from Safari, and since 16.4 maybe from another
 * browser's share menu; Samsung Internet and Chrome have their own menus.
 */
export type InstallPlatform = 'ios-safari' | 'ios-other' | 'in-app-ios' | 'in-app-android' | 'samsung' | 'android-chrome' | 'android-other' | 'desktop';
/** The guide's tabs: iPhone·iPad, Android, computer. */
export type GuideOs = 'ios' | 'android' | 'desktop';

const IN_APP = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|FB_IAB|\bLine\/|DaumApps|everytimeApp|; wv\)/i;
const IOS_OTHER = /CriOS|EdgiOS|FxiOS|OPiOS|YaBrowser|Whale|DuckDuckGo|GSA\//;
const ANDROID_OTHER = /EdgA|OPR\/|Firefox|YaBrowser|Whale|SamsungBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser/;

/** `maxTouchPoints` tells an iPad (which says Macintosh since iPadOS 13) from a Mac. */
export function platformOf(ua: string, maxTouchPoints = 0): InstallPlatform {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  const android = /Android/.test(ua);
  if (IN_APP.test(ua) && (ios || android)) return ios ? 'in-app-ios' : 'in-app-android';
  if (ios) return IOS_OTHER.test(ua) || !/Safari\//.test(ua) ? 'ios-other' : 'ios-safari';
  if (android) {
    if (/SamsungBrowser/.test(ua)) return 'samsung';
    return /Chrome\/\d/.test(ua) && !ANDROID_OTHER.test(ua) ? 'android-chrome' : 'android-other';
  }
  return 'desktop';
}

export function guideOsOf(p: InstallPlatform): GuideOs {
  if (p === 'ios-safari' || p === 'ios-other' || p === 'in-app-ios') return 'ios';
  return p === 'desktop' ? 'desktop' : 'android';
}

/** Open as an installed app: any app display mode, or iOS's own flag for a home screen web app. */
export function standaloneFrom(matches: (query: string) => boolean, iosStandalone: unknown): boolean {
  return iosStandalone === true || ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].some((m) => matches(`(display-mode: ${m})`));
}

/** What this device remembers (localStorage): until when the lobby offer stays hidden, and that the browser said it installed. */
export interface InstallMemo {
  until: number;
  installed: boolean;
}

export function parseMemo(raw: string | null): InstallMemo {
  try {
    const m = JSON.parse(raw ?? '{}') as Partial<InstallMemo>;
    return { until: Number.isFinite(m.until) ? Number(m.until) : 0, installed: m.installed === true };
  } catch {
    return { until: 0, installed: false };
  }
}

/** Hidden from now for `ms`. */
export const snoozed = (memo: InstallMemo, now: number, ms: number): InstallMemo => ({ ...memo, until: now + ms });

/** Still hidden: never longer than the 30 days promised, even if the device clock went back. */
export function isSnoozed(until: number, now: number): boolean {
  return until > now && until - now <= SNOOZE_MS;
}

export interface InstallState {
  platform: InstallPlatform;
  /** Running as the installed app right now. */
  standalone: boolean;
  /** The browser reported an install (`appinstalled`) and has not offered it since. */
  installed: boolean;
  /** Until when the lobby offer is hidden (0: not hidden). */
  until: number;
  /** The browser handed over its install prompt (`beforeinstallprompt`). */
  canPrompt: boolean;
}

/**
 * The lobby offer: never in the app itself or after an install, not while hidden, and on a computer only when the
 * browser can install there and then (elsewhere the steps are in the settings).
 */
export function offerVisible(s: InstallState, now: number): boolean {
  if (s.standalone || s.installed || isSnoozed(s.until, now)) return false;
  return s.canPrompt || s.platform !== 'desktop';
}

/* ---------- The page's install state ---------- */

/** Chrome's install prompt event (not in the DOM typings). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const KEY = 'jc.install';
let memo: InstallMemo = { until: 0, installed: false };
let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { platform: 'desktop', standalone: false, installed: false, until: 0, canPrompt: false };
const listeners = new Set<() => void>();

function readMemo(): InstallMemo {
  try {
    return parseMemo(localStorage.getItem(KEY));
  } catch {
    return { until: 0, installed: false };
  }
}

function setMemo(next: InstallMemo) {
  memo = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(memo));
  } catch {
    /* this visit only */
  }
}

function standaloneNow() {
  return standaloneFrom((q) => window.matchMedia?.(q).matches === true, (navigator as Navigator & { standalone?: unknown }).standalone);
}

function publish() {
  state = { platform: state.platform, standalone: standaloneNow(), installed: memo.installed, until: memo.until, canPrompt: deferred !== null };
  for (const l of listeners) l();
}

/** Called once at start-up, before the browser can offer its prompt. */
export function startInstallWatch() {
  memo = readMemo();
  state = { ...state, platform: platformOf(navigator.userAgent, navigator.maxTouchPoints ?? 0) };
  window.addEventListener('beforeinstallprompt', (e) => {
    // Kept for the lobby and settings buttons rather than shown at a moment of the browser's choosing.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    // Chrome offers it only while the app is not installed: an earlier install has been removed.
    if (memo.installed) setMemo({ ...memo, installed: false });
    publish();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    setMemo({ ...memo, installed: true });
    publish();
  });
  for (const m of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']) window.matchMedia?.(`(display-mode: ${m})`).addEventListener?.('change', publish);
  publish();
}

export function useInstall(): InstallState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** Shows the browser's own install dialog (a prompt works once; the browser may offer a new one later). */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null;
  publish();
  try {
    await e.prompt();
    return (await e.userChoice).outcome;
  } catch {
    return 'unavailable';
  }
}

/** Hides the lobby offer for `ms` (LATER_MS or SNOOZE_MS). */
export function hideInstallOffer(ms: number) {
  setMemo(snoozed(memo, Date.now(), ms));
  publish();
}

/** Settings: show the lobby offer again. */
export function showInstallOffer() {
  setMemo({ ...memo, until: 0 });
  publish();
}
