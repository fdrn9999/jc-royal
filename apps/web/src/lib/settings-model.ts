/**
 * The account's settings as this device holds them (pure; the store is prefs.ts, the sync settings-sync.ts).
 *
 * - `server`: the account's settings as last answered. `pending`: changes made here and not saved yet, each with when
 *   (device clock; sent as how long ago, so the server dates it by its own clock). What the screen shows is the defaults,
 *   then the account's, then the pending changes on top.
 * - `legacy`: what this device had before settings were kept on the account (the device-wide store, and the account's
 *   favourite tables on this device). It is sent once and only fills what the account has nothing for, while no
 *   administrator has reset the account (epoch 0); until then it shows under the account's own values.
 * - Saving and taking the server's answers is settings-save.ts (loaded with the sync, not with the first page).
 */
import {
  SETTINGS_FAV_MAX,
  SYNCED_PREF_DEFAULTS,
  SYNCED_PREF_KEYS,
  SyncedPrefsSchema,
  type SettingsDto,
  type SyncedPrefKey,
  type SyncedPrefs,
} from '@jc/types';

export type PendingPrefs = { [K in SyncedPrefKey]?: { v: SyncedPrefs[K]; at: number } };
export interface Pending {
  prefs: PendingPrefs;
  fav: Record<string, { on: boolean; at: number }>;
}
export interface Legacy {
  prefs?: Partial<SyncedPrefs>;
  fav?: string[];
}
export interface AccountSettings {
  server: SettingsDto | null;
  pending: Pending;
  legacy: Legacy | null;
  /** Attempts that failed since the last answer (sent with the next request, for the operations statistics). */
  fails: number;
}
export interface SettingsView {
  prefs: SyncedPrefs;
  /** Favourite table ids, newest first. */
  fav: string[];
}

export const EMPTY_ACCOUNT: AccountSettings = { server: null, pending: { prefs: {}, fav: {} }, legacy: null, fails: 0 };
const TABLE_ID_MAX = 64;

const isKey = (k: string): k is SyncedPrefKey => (SYNCED_PREF_KEYS as string[]).includes(k);
const tableId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= TABLE_ID_MAX;
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const time = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** The valid settings among `raw` (anything else is dropped). */
export function cleanPrefs(raw: unknown): Partial<SyncedPrefs> {
  const out: Partial<Record<SyncedPrefKey, unknown>> = {};
  if (!obj(raw)) return {};
  for (const [k, v] of Object.entries(raw)) if (isKey(k) && SyncedPrefsSchema.shape[k].safeParse(v).success) out[k] = v;
  return out as Partial<SyncedPrefs>;
}

/** The settings of the device-wide store from before sync that differ from the defaults (the rest were never chosen). */
export function legacyPrefs(raw: unknown): Partial<SyncedPrefs> {
  const p = cleanPrefs(raw) as Record<SyncedPrefKey, unknown>;
  for (const k of SYNCED_PREF_KEYS) if (k in p && p[k] === SYNCED_PREF_DEFAULTS[k]) delete p[k];
  return p as Partial<SyncedPrefs>;
}

const favIds = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter(tableId))].slice(0, SETTINGS_FAV_MAX) : []);

function cleanServer(x: unknown): SettingsDto | null {
  if (!obj(x) || !Number.isInteger(x.epoch) || !Number.isInteger(x.rev)) return null;
  return { epoch: x.epoch as number, rev: x.rev as number, prefs: cleanPrefs(x.prefs), fav: favIds(x.fav), updatedAt: time(x.updatedAt) ? x.updatedAt : null };
}

/** What is stored for an account on this device, as valid settings (anything unreadable counts as nothing). */
export function parseAccount(raw: string | null): AccountSettings {
  try {
    const v = JSON.parse(raw ?? 'null') as unknown;
    if (!obj(v)) return EMPTY_ACCOUNT;
    const pending: Pending = { prefs: {}, fav: {} };
    if (obj(v.pending) && obj(v.pending.prefs))
      for (const [k, c] of Object.entries(v.pending.prefs))
        if (isKey(k) && obj(c) && time(c.at) && SyncedPrefsSchema.shape[k].safeParse(c.v).success) (pending.prefs as Record<string, unknown>)[k] = { v: c.v, at: c.at };
    if (obj(v.pending) && obj(v.pending.fav))
      for (const [id, c] of Object.entries(v.pending.fav)) if (tableId(id) && obj(c) && typeof c.on === 'boolean' && time(c.at)) pending.fav[id] = { on: c.on, at: c.at };
    const legacy = obj(v.legacy) ? { prefs: cleanPrefs(v.legacy.prefs), fav: favIds(v.legacy.fav) } : null;
    return { server: cleanServer(v.server), pending, legacy, fails: Number.isInteger(v.fails) ? Math.min(Math.max(v.fails as number, 0), 1_000) : 0 };
  } catch {
    return EMPTY_ACCOUNT;
  }
}

/** `legacy` still counts: nothing answered yet, or the account was never reset. */
export const legacyOn = (a: AccountSettings) => !!a.legacy && (!a.server || a.server.epoch === 0);

/** What the screen shows: defaults, then `legacy` under the account's values, then the account's, then the pending changes. */
export function viewOf(a: AccountSettings | null, device: Partial<SyncedPrefs> = {}): SettingsView {
  if (!a) return { prefs: { ...SYNCED_PREF_DEFAULTS, ...device }, fav: [] };
  const pend: Partial<Record<SyncedPrefKey, unknown>> = {};
  for (const [k, c] of Object.entries(a.pending.prefs)) pend[k as SyncedPrefKey] = c.v;
  const old = legacyOn(a) ? a.legacy! : null;
  const prefs = { ...SYNCED_PREF_DEFAULTS, ...old?.prefs, ...a.server?.prefs, ...pend } as SyncedPrefs;
  const base = [...(a.server?.fav ?? [])];
  if (old?.fav) for (const id of old.fav) if (!base.includes(id)) base.push(id);
  const changes = Object.entries(a.pending.fav).sort((x, y) => y[1].at - x[1].at);
  const added = changes.filter(([, c]) => c.on).map(([id]) => id);
  const removed = new Set(changes.filter(([, c]) => !c.on).map(([id]) => id));
  const fav = [...added, ...base.filter((id) => !added.includes(id) && !removed.has(id))].slice(0, SETTINGS_FAV_MAX);
  return { prefs, fav };
}

/**
 * The settings changed on this device, as pending changes. Setting what already shows, with no change of it pending,
 * changes nothing; any other change is kept, even one back to the account's value (a save may be out with the one
 * before it, and the newest choice must win).
 */
export function withPrefs(a: AccountSettings, patch: Partial<SyncedPrefs>, now: number): AccountSettings {
  const shown = viewOf(a).prefs;
  const prefs: PendingPrefs = { ...a.pending.prefs };
  for (const [k, v] of Object.entries(cleanPrefs(patch))) {
    const key = k as SyncedPrefKey;
    if (shown[key] === v && !prefs[key]) continue;
    (prefs as Record<string, unknown>)[key] = { v, at: now };
  }
  return { ...a, pending: { ...a.pending, prefs } };
}

/** A favourite table added or taken off on this device (taken off, it is no longer one this device had before sync either). */
export function withFavourite(a: AccountSettings, id: string, on: boolean, now: number): AccountSettings {
  if (!tableId(id) || (viewOf(a).fav.includes(id) === on && !a.pending.fav[id])) return a;
  const legacy = !on && a.legacy?.fav?.includes(id) ? { ...a.legacy, fav: a.legacy.fav.filter((x) => x !== id) } : a.legacy;
  return { ...a, legacy, pending: { ...a.pending, fav: { ...a.pending.fav, [id]: { on, at: now } } } };
}

export const hasChanges = (a: AccountSettings) => Object.keys(a.pending.prefs).length > 0 || Object.keys(a.pending.fav).length > 0 || legacyOn(a);

