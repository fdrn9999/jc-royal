/**
 * Saving the account's settings and taking the server's answers (pure; loaded with settings-sync.ts, not with the first
 * page; what the device holds is settings-model.ts).
 *
 * An answer with another epoch than the one the pending changes were made under means an administrator reset (or
 * restored) the account's settings: the pending changes and `legacy` are dropped, so they are not uploaded again.
 */
import { SETTINGS_FAV_MAX, type SettingsDto, type SettingsSave, type SyncedPrefKey } from '@jc/types';
import { hasChanges, legacyOn, type AccountSettings, type PendingPrefs } from './settings-model';

/** At most this many favourite changes go in one save (the newest); the rest follow in the next. */
export const FAV_CHANGES_MAX = SETTINGS_FAV_MAX * 2;
/** The save to send, or null when there is nothing to send or the account's settings were never read on this device. */
export function saveBody(user: string, a: AccountSettings, now: number): SettingsSave | null {
  if (!a.server || !hasChanges(a)) return null;
  const ago = (at: number) => Math.min(Math.max(Math.round(now - at), 0), Number.MAX_SAFE_INTEGER);
  const prefs: NonNullable<SettingsSave['prefs']> = {};
  for (const [k, c] of Object.entries(a.pending.prefs)) (prefs as Record<string, unknown>)[k] = { v: c.v, ago: ago(c.at) };
  const fav = Object.entries(a.pending.fav)
    .sort((x, y) => y[1].at - x[1].at)
    .slice(0, FAV_CHANGES_MAX)
    .map(([id, c]) => ({ id, on: c.on, ago: ago(c.at) }));
  const body: SettingsSave = { user, epoch: a.server.epoch, base: a.server.rev };
  if (Object.keys(prefs).length) body.prefs = prefs;
  if (fav.length) body.fav = fav;
  if (legacyOn(a)) body.legacy = { ...(a.legacy!.prefs && Object.keys(a.legacy!.prefs).length ? { prefs: a.legacy!.prefs } : {}), ...(a.legacy!.fav?.length ? { fav: a.legacy!.fav } : {}) };
  if (a.fails) body.fails = a.fails;
  return body;
}

/** The account's settings read: an epoch other than the one the pending changes were made under drops them and `legacy`. */
export function afterLoad(a: AccountSettings, dto: SettingsDto): AccountSettings {
  const reset = !!a.server && a.server.epoch !== dto.epoch;
  return reset ? { server: dto, pending: { prefs: {}, fav: {} }, legacy: null, fails: 0 } : { ...a, server: dto, legacy: legacyOn({ ...a, server: dto }) ? a.legacy : null, fails: 0 };
}

/** A save answered (`sentAt`: when its body was made): the changes sent (unless made again since) and `legacy` are done. */
export function afterSave(a: AccountSettings, sent: SettingsSave, dto: SettingsDto, sentAt: number): AccountSettings {
  const prefs: PendingPrefs = { ...a.pending.prefs };
  for (const [k, c] of Object.entries(sent.prefs ?? {})) {
    const cur = prefs[k as SyncedPrefKey];
    // Sent as made `ago` before `sentAt`: the same change unless made again since.
    if (cur && c && cur.v === c.v && sentAt - cur.at >= c.ago) delete prefs[k as SyncedPrefKey];
  }
  const fav = { ...a.pending.fav };
  for (const c of sent.fav ?? []) if (fav[c.id] && fav[c.id]!.on === c.on && sentAt - fav[c.id]!.at >= c.ago) delete fav[c.id];
  return { server: dto, pending: { prefs, fav }, legacy: null, fails: 0 };
}

/** An administrator reset (or restored) the account's settings: only the account's count from now on. */
export const afterReset = (dto: SettingsDto): AccountSettings => ({ server: dto, pending: { prefs: {}, fav: {} }, legacy: null, fails: 0 });
