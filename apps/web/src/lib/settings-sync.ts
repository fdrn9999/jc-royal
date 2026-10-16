/**
 * Keeps the open account's settings (prefs.ts) in step with the server while someone is signed in.
 *
 * - Reads them on sign-in, then again when the page comes back after STALE_MS, and when the settings or a table open
 *   after FRESH_MS (pullSettings). A change is saved SAVE_DELAY_MS after the last one; one request is out at a time.
 * - A failed request keeps the change on this device (the screen already shows it) and is retried with a growing delay,
 *   and at once when the connection returns; the number of failures goes with the next request (operations stats).
 * - 409 settings_reset: an administrator reset or restored the account's settings, so what this device had not saved is
 *   dropped and the account's are taken. 409 settings_account or 401: another account (or none) is signed in now, so
 *   nothing more is sent for this one and the sign-in is read again.
 * - Leaving the page with changes not saved sends them without waiting for the answer; they stay pending here and are
 *   sent again on the next sign-in (the same value again changes nothing).
 */
import type { SettingsDto, SettingsSave, SettingsSaveResult } from '@jc/types';
import { api, ApiError } from './api';
import { registerSettingsSync, setSyncState, syncAccount, syncApply, syncPending } from './prefs';
import { afterLoad, afterReset, afterSave, saveBody } from './settings-save';

export const SAVE_DELAY_MS = 800;
export const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
export const STALE_MS = 5 * 60_000;
export const FRESH_MS = 30_000;

const syncBody = (now: number) => {
  const open = syncAccount();
  return open ? saveBody(open.uid, open.account, now) : null;
};
const applyLoad = (forUid: string, dto: SettingsDto) => {
  const server = syncAccount()?.account.server;
  syncApply(forUid, (a) => afterLoad(a, dto), { at: Date.now(), ...(server && server.epoch !== dto.epoch ? { reset: true } : {}) });
};
const applySave = (forUid: string, sent: SettingsSave, dto: SettingsDto, sentAt: number, kept: number) =>
  syncApply(forUid, (a) => afterSave(a, sent, dto, sentAt), { at: Date.now(), kept });
const applyReset = (forUid: string, dto: SettingsDto) => syncApply(forUid, () => afterReset(dto), { at: Date.now(), reset: true, kept: 0 });
/** The changes the server refused as invalid (never expected): dropped, so they are not sent again and again. */
const dropChanges = (forUid: string) => syncApply(forUid, (a) => ({ ...a, pending: { prefs: {}, fav: {} }, legacy: null }), {});
const countFailure = (forUid: string) => syncApply(forUid, (a) => ({ ...a, fails: Math.min(a.fails + 1, 1_000) }), { state: 'error' });

/** Starts syncing `userId`'s settings (already opened in prefs.ts); returns a stop function. */
export function startSettingsSync(userId: string, onAccountChanged: () => void): () => void {
  let stopped = false;
  let busy: Promise<void> | null = null;
  let again = false;
  let wantRead = true;
  let readAt = 0;
  let retries = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    clearTimeout(saveTimer);
    if (busy) {
      again = true;
      return busy;
    }
    busy = (async () => {
      try {
        do {
          again = false;
          await pass();
        } while (again && !stopped);
      } finally {
        busy = null;
      }
    })();
    return busy;
  };

  async function pass() {
    const open = syncAccount();
    if (!open || open.uid !== userId) return;
    try {
      if (wantRead || !open.account.server) {
        if (!syncPending()) setSyncState('loading');
        const fails = open.account.fails;
        const dto = await api<SettingsDto>(`/api/me/settings?for=${encodeURIComponent(userId)}${fails ? `&fails=${fails}` : ''}`);
        if (stopped) return;
        wantRead = false;
        readAt = Date.now();
        applyLoad(userId, dto);
      }
      const sentAt = Date.now();
      const body = syncBody(sentAt);
      if (body) {
        setSyncState('saving');
        const r = await api<SettingsSaveResult>('/api/me/settings', { method: 'PUT', body });
        if (stopped) return;
        readAt = Date.now();
        applySave(userId, body, r.settings, sentAt, r.kept.length);
        // Changed again while it was out: the next pass sends that.
        if (syncPending()) again = true;
      }
      retries = 0;
      clearTimeout(retryTimer);
      setSyncState(syncPending() ? 'saving' : 'saved');
    } catch (e) {
      if (stopped) return;
      if (e instanceof ApiError && e.code === 'settings_reset') {
        const dto = (e.details as { settings?: SettingsDto } | undefined)?.settings;
        if (dto) {
          readAt = Date.now();
          applyReset(userId, dto);
          setSyncState('saved');
        } else wantRead = true;
        retries = 0;
        return;
      }
      if (e instanceof ApiError && (e.code === 'settings_account' || e.status === 401)) {
        stopped = true;
        setSyncState('error');
        onAccountChanged();
        return;
      }
      if (e instanceof ApiError && e.status === 400) {
        // Never expected (what is sent is checked here first): retrying would only fail again.
        dropChanges(userId);
        wantRead = true;
        setSyncState('error');
        return;
      }
      countFailure(userId);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void run(), RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
    }
  }

  const pull = (force = false) => {
    if (stopped || (!force && Date.now() - readAt < FRESH_MS)) return;
    wantRead = true;
    void run();
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - readAt >= STALE_MS) pull(true);
    // Going to the background (the page may not come back): save now rather than after the delay.
    if (document.visibilityState === 'hidden' && syncPending()) void run();
  };
  const onOnline = () => {
    if (syncPending() || retries > 0) {
      retries = 0;
      void run();
    }
  };
  /** Leaving: the changes not saved yet go without waiting for the answer (again if one is out: the same values change nothing). */
  const sendNow = () => {
    if (stopped || !syncPending()) return;
    const body = syncBody(Date.now());
    if (!body) return;
    void fetch('/api/me/settings', { method: 'PUT', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  };

  registerSettingsSync({
    changed() {
      if (stopped) return;
      setSyncState('saving');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void run(), SAVE_DELAY_MS);
    },
    pull,
    async flush(ms) {
      if (stopped || !syncPending()) return;
      await Promise.race([run(), new Promise<void>((r) => setTimeout(r, ms))]);
    },
  });
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pagehide', sendNow);
  window.addEventListener('online', onOnline);
  void run();

  return () => {
    stopped = true;
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', sendNow);
    window.removeEventListener('online', onOnline);
    registerSettingsSync(null);
  };
}
