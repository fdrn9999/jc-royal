import { SETTINGS_AMOUNT_UNITS, type SyncedPrefs } from '@jc/types';
import { useSyncExternalStore } from 'react';
import { takeLegacyFavourites } from './lobby';
import { EMPTY_ACCOUNT, hasChanges, legacyPrefs, parseAccount, pendingMuck, viewOf, withFavourite, withPrefs, type AccountSettings, type SettingsView } from './settings-model';

/** How table amounts read (see amount.ts). Kept here so loading the preferences needs nothing else. */
export const AMOUNT_UNITS = SETTINGS_AMOUNT_UNITS;
export type AmountUnit = (typeof AMOUNT_UNITS)[number];

/**
 * The table look and aids (theme, four-colour deck, beginner mode, confirming risky actions, auto-muck, amount unit,
 * reactions) and the favourite tables. Signed in, they are the account's (settings-sync.ts keeps them in step with the
 * server, settings-model.ts says how): every device signed in to the account shows them, a change made here shows at
 * once and is saved in the background, and a failed save keeps it on this device until it goes through. Signed out,
 * the defaults show (or what this device had before settings were kept on the account, until an account takes it).
 * Sound, recently opened tables and the install offer stay on each device (sound.ts, lobby.ts, install.ts).
 */
export type Prefs = SyncedPrefs;

/** The device-wide store from before sync; the first account signed in on this device takes it (then it is removed). */
const DEVICE_KEY = 'jc.prefs';
const accountKey = (uid: string) => `jc.settings:${uid}`;
/** The account last signed in on this device: its look shows from the first paint, before sign-in is confirmed. */
const LAST_KEY = 'jc.settings.last';

export type SyncState = 'off' | 'loading' | 'saving' | 'saved' | 'error';
export interface SyncStatus {
  state: SyncState;
  /** When the account's settings were last read or saved (epoch ms), in this session. */
  at: number;
  /** An administrator reset or restored the account's settings while this device had them. */
  reset: boolean;
  /** Changes made here that a newer change on another device kept, at the last save. */
  kept: number;
}

let uid: string | null = null;
let account: AccountSettings | null = null;
let view: SettingsView = viewOf(null);
let status: SyncStatus = { state: 'off', at: 0, reset: false, kept: 0 };
const listeners = new Set<() => void>();
const statusListeners = new Set<() => void>();

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked: kept for this session only */
  }
}

/** The device-wide store from before sync, as the settings it changed from the defaults. */
const devicePrefs = () => {
  try {
    return legacyPrefs(JSON.parse(readStore(DEVICE_KEY) ?? 'null'));
  } catch {
    return {};
  }
};

function publish() {
  const next = viewOf(account, uid ? {} : devicePrefs());
  if (JSON.stringify(next) !== JSON.stringify(view)) view = next;
  applyLook();
  for (const l of listeners) l();
}

function persist() {
  if (uid && account) writeStore(accountKey(uid), JSON.stringify(account));
}

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  for (const l of statusListeners) l();
}

/** The settings sync, registered by settings-sync.ts while an account is open. */
interface SyncHooks {
  changed(): void;
  pull(force?: boolean): void;
  flush(ms: number): Promise<void>;
}
let hooks: SyncHooks | null = null;
export function registerSettingsSync(h: SyncHooks | null) {
  hooks = h;
}

/**
 * Opens an account's settings on this device: what it held here before, or, the first time, what this device had
 * before sync (the device-wide settings, which go to this account and leave the device store, and the account's
 * favourite tables kept on this device), to send once.
 */
export function openAccount(id: string) {
  if (uid === id) return;
  uid = id;
  const stored = readStore(accountKey(id));
  if (stored !== null) account = parseAccount(stored);
  else {
    const prefs = devicePrefs();
    const fav = takeLegacyFavourites(id);
    account = { ...EMPTY_ACCOUNT, legacy: Object.keys(prefs).length || fav.length ? { prefs, fav } : null };
    persist();
    writeStore(DEVICE_KEY, null);
  }
  writeStore(LAST_KEY, id);
  setStatus({ state: 'loading', at: 0, reset: false, kept: 0 });
  publish();
}

/**
 * Closes the account (signed out, or another account signed in): the screen shows the defaults again. What it saved is
 * dropped from this device; changes not saved yet stay, under the account, for its next sign-in here.
 */
export function closeAccount() {
  if (!uid) {
    // Signed out on opening: the account last signed in here no longer shows (its unsaved changes stay for its next sign-in).
    const last = readStore(LAST_KEY);
    if (last) {
      if (!hasChanges(parseAccount(readStore(accountKey(last))))) writeStore(accountKey(last), null);
      writeStore(LAST_KEY, null);
    }
    publish();
    return;
  }
  if (account && !hasChanges(account)) writeStore(accountKey(uid), null);
  if (readStore(LAST_KEY) === uid) writeStore(LAST_KEY, null);
  uid = null;
  account = null;
  setStatus({ state: 'off', at: 0, reset: false, kept: 0 });
  publish();
}

/** Another tab changed this account's settings on this device: read them again. */
function onStorage(e: StorageEvent) {
  if (uid && e.key === accountKey(uid)) {
    account = parseAccount(e.newValue);
    publish();
  }
}
if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

// ------------------------------------------------------------------ for settings-sync.ts

export const syncAccount = () => (uid && account ? { uid, account } : null);

/** Changes the open account's settings (an answer taken), unless another account was opened meanwhile. */
export function syncApply(forUid: string, change: (a: AccountSettings) => AccountSettings, next: Partial<SyncStatus>) {
  if (uid !== forUid || !account) return;
  account = change(account);
  persist();
  setStatus(next);
  publish();
}
export function setSyncState(state: SyncState) {
  if (uid) setStatus({ state });
}
export const syncPending = () => !!account && hasChanges(account);

// ------------------------------------------------------------------ for the screens

export function setPrefs(patch: Partial<Prefs>) {
  if (uid && account) {
    account = withPrefs(account, patch, Date.now());
    persist();
    publish();
    hooks?.changed();
    return;
  }
  // Signed out (the sign-in pages): this device only, until an account takes it.
  const next = { ...devicePrefs(), ...patch };
  writeStore(DEVICE_KEY, JSON.stringify(next));
  publish();
}

/** Adds or takes off a favourite table of the account signed in. */
export function setFavourite(id: string, on: boolean) {
  if (!uid || !account) return;
  account = withFavourite(account, id, on, Date.now());
  persist();
  publish();
  hooks?.changed();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => view.prefs);
}

/** The favourite table ids of the account signed in, newest first. */
export function useFavourites(): string[] {
  return useSyncExternalStore(subscribe, () => view.fav);
}

export function useSettingsSync(): SyncStatus {
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => status,
  );
}

/** Reads the account's settings again (`force`: even if they were read a moment ago); a no-op signed out. */
export const pullSettings = (force = false) => hooks?.pull(force);
/** Sends what is not saved yet and waits for it, at most `ms` (before signing out). */
export const flushSettings = (ms: number) => hooks?.flush(ms) ?? Promise.resolve();
/** Whether auto-muck was changed on this device and is not saved yet (the table takes this device's value then). */
export const hasPendingMuck = () => pendingMuck(account);

/** The first paint: the look of the account last signed in on this device, or of the device. */
export function applyInitialTheme() {
  const last = readStore(LAST_KEY);
  const stored = last ? readStore(accountKey(last)) : null;
  view = viewOf(stored !== null ? parseAccount(stored) : null, stored !== null ? {} : devicePrefs());
  applyLook();
}

/** The table theme and the colour vision mode, on <html> (styles.css reads both). */
function applyLook() {
  document.documentElement.dataset.theme = view.prefs.theme;
  document.documentElement.dataset.cv = view.prefs.colorVision;
}
