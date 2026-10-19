/**
 * A member's account settings (user_settings): the table look and aids and the favourite tables, the same on every
 * device (GET/PUT /api/me/settings). Each setting and table keeps when it was last changed, by this server's clock (a
 * device sends how long ago it made the change), and the newest change wins one at a time, so two devices changing
 * different things both land and an offline device can't undo a later change made elsewhere. A device's settings from
 * before they were kept here (`legacy`) only fill what the account has nothing for.
 *
 * Administrators see counts and times only (`diagnose`), never a value, and can't edit them: they may reset them to the
 * defaults and undo that reset (routes/admin-settings.ts). A reset raises `epoch`; a device still holding the old
 * epoch is refused and drops what it had not saved, so it can't upload the old settings again.
 */
import { statsDay, statsIncrements, type SettingsMetric } from '@jc/db';
import {
  SETTINGS_FAV_MAX,
  SETTINGS_MAX_AGO_MS,
  SETTINGS_RESTORE_MS,
  SETTINGS_SCHEMA_VERSION,
  SYNCED_PREF_KEYS,
  SyncedPrefsSchema,
  type AdminSettingsDiagDto,
  type SettingsDto,
  type SettingsSave,
  type SyncedPrefKey,
  type SyncedPrefs,
} from '@jc/types';
import { fail, HttpError } from './http';

/** [value, changedAt, rev] */
export type PrefCell = [unknown, number, number];
/** [1 on | 0 off, changedAt, rev]: a table taken off stays a while (a tombstone), so an older change can't add it back. */
export type FavCell = [0 | 1, number, number];
export type StoredPrefs = Partial<Record<SyncedPrefKey, PrefCell>>;
export type StoredFav = Record<string, FavCell>;

export interface SettingsState {
  prefs: StoredPrefs;
  fav: StoredFav;
  rev: number;
  epoch: number;
  updatedAt: number | null;
}

/** synced_at is written at most this often (a load marks it only when it is older). */
export const SETTINGS_SYNC_MARK_MS = 10 * 60_000;
/** Tables taken off are remembered at most this many, and no longer than SETTINGS_MAX_AGO_MS. */
export const SETTINGS_FAV_TOMBSTONES = SETTINGS_FAV_MAX * 2;
/** A device's count of failed attempts adds at most this much per request. */
export const SETTINGS_CLIENT_FAILS_MAX = 20;

export interface SettingsRow {
  prefs: string;
  fav: string;
  rev: number;
  epoch: number;
  schema_version: number;
  updated_at: number;
  synced_at: number | null;
  reset_at: number | null;
  reset_by: string | null;
  reset_rev: number | null;
  prev: string | null;
  restored_at: number | null;
}

const isTime = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const json = (s: string | null): unknown => {
  try {
    return JSON.parse(s ?? 'null');
  } catch {
    return null;
  }
};

/** The stored settings, keeping only well-formed values (anything else reads as not set). */
export function parsePrefs(raw: string | null): StoredPrefs {
  const o = json(raw);
  const out: StoredPrefs = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of SYNCED_PREF_KEYS) {
    const c = (o as Record<string, unknown>)[k];
    if (Array.isArray(c) && c.length === 3 && isTime(c[1]) && isTime(c[2]) && SyncedPrefsSchema.shape[k].safeParse(c[0]).success) out[k] = [c[0], c[1], c[2]];
  }
  return out;
}

export function parseFav(raw: string | null): StoredFav {
  const o = json(raw);
  const out: StoredFav = {};
  if (!o || typeof o !== 'object') return out;
  for (const [id, c] of Object.entries(o as Record<string, unknown>)) {
    if (id.length < 1 || id.length > 64) continue;
    if (Array.isArray(c) && c.length === 3 && (c[0] === 0 || c[0] === 1) && isTime(c[1]) && isTime(c[2])) out[id] = [c[0], c[1], c[2]];
  }
  return out;
}

export const EMPTY_STATE: SettingsState = { prefs: {}, fav: {}, rev: 0, epoch: 0, updatedAt: null };

export function toState(row: SettingsRow | null | undefined): SettingsState {
  if (!row) return EMPTY_STATE;
  return { prefs: parsePrefs(row.prefs), fav: parseFav(row.fav), rev: row.rev, epoch: row.epoch, updatedAt: row.updated_at };
}

/** Favourite table ids, newest first. */
export function favList(fav: StoredFav): string[] {
  return Object.entries(fav)
    .filter(([, c]) => c[0] === 1)
    .sort(([a, x], [b, y]) => y[1] - x[1] || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id]) => id);
}

export function toDto(s: SettingsState): SettingsDto {
  const prefs: Partial<SyncedPrefs> = {};
  for (const k of SYNCED_PREF_KEYS) if (s.prefs[k]) (prefs as Record<string, unknown>)[k] = s.prefs[k]![0];
  return { epoch: s.epoch, rev: s.rev, prefs, fav: favList(s.fav), updatedAt: s.updatedAt };
}

export interface Merge {
  prefs: StoredPrefs;
  fav: StoredFav;
  /** Something the member sees changed (the revision goes up). */
  changed: boolean;
  /** Settings and tables (`fav:<id>`) sent that a newer change kept. */
  kept: string[];
  /** Something sent had been changed on another device since the revision this save was made over. */
  conflict: boolean;
  /** The device's settings from before sync filled something. */
  legacy: boolean;
}

/**
 * What a save makes of the account's settings, at `now`. Pure: the caller writes it over the revision it read. A change
 * dated at the same moment as the stored one wins (it arrived later). Sending the value the account already has
 * changes nothing. Legacy values count as made at the start of time, so any real change wins over them.
 */
export function mergeSettings(cur: SettingsState, input: SettingsSave, now: number): Merge {
  const rev = cur.rev + 1;
  const prefs: StoredPrefs = { ...cur.prefs };
  const fav: StoredFav = { ...cur.fav };
  const kept: string[] = [];
  let changed = false;
  let conflict = false;
  let legacy = false;
  const at = (ago: number) => now - Math.min(Math.max(ago, 0), SETTINGS_MAX_AGO_MS);

  for (const k of SYNCED_PREF_KEYS) {
    const ch = input.prefs?.[k];
    if (!ch) continue;
    const when = at(ch.ago);
    const c = prefs[k];
    if (c && c[0] === ch.v) continue;
    if (c && c[2] > input.base) conflict = true;
    if (c && c[1] > when) {
      kept.push(k);
      continue;
    }
    prefs[k] = [ch.v, when, rev];
    changed = true;
  }

  for (const ch of input.fav ?? []) {
    const when = at(ch.ago);
    const on = ch.on ? 1 : 0;
    const c = fav[ch.id];
    // Already so, or taking off a table the account doesn't have.
    if (c ? c[0] === on : !ch.on) continue;
    if (c && c[2] > input.base) conflict = true;
    if (c && c[1] > when) {
      kept.push(`fav:${ch.id}`);
      continue;
    }
    fav[ch.id] = [on, when, rev];
    changed = true;
  }

  if (input.legacy && cur.epoch === 0) {
    for (const k of SYNCED_PREF_KEYS) {
      const v = input.legacy.prefs?.[k];
      if (v === undefined || prefs[k]) continue;
      prefs[k] = [v, 0, rev];
      changed = legacy = true;
    }
    // Newest first on the device: older ones get earlier times, so the order stays.
    const ids = input.legacy.fav ?? [];
    ids.forEach((id, i) => {
      if (fav[id]) return;
      fav[id] = [1, ids.length - i, rev];
      changed = legacy = true;
    });
  }

  // At most SETTINGS_FAV_MAX favourites (the newest), and a bounded number of recent tombstones.
  const byNewest = (on: 0 | 1) =>
    Object.entries(fav)
      .filter(([, c]) => c[0] === on)
      .sort(([, x], [, y]) => y[1] - x[1]);
  for (const [id] of byNewest(1).slice(SETTINGS_FAV_MAX)) delete fav[id];
  byNewest(0).forEach(([id, c], i) => {
    if (i >= SETTINGS_FAV_TOMBSTONES || c[1] < now - SETTINGS_MAX_AGO_MS) delete fav[id];
  });

  return { prefs, fav, changed, kept, conflict, legacy };
}

const ROW_SELECT = 'SELECT prefs, fav, rev, epoch, schema_version, updated_at, synced_at, reset_at, reset_by, reset_rev, prev, restored_at FROM user_settings WHERE user_id = ?1';

export function readRow(db: D1Database, userId: string): Promise<SettingsRow | null> {
  return db.prepare(ROW_SELECT).bind(userId).first<SettingsRow>();
}

/** Marks that the member's devices loaded the settings (only when the mark is older than SETTINGS_SYNC_MARK_MS). */
export function markSynced(db: D1Database, userId: string, now: number) {
  return db.prepare('UPDATE user_settings SET synced_at = ?2 WHERE user_id = ?1 AND (synced_at IS NULL OR synced_at < ?3)').bind(userId, now, now - SETTINGS_SYNC_MARK_MS);
}

export const needsSyncMark = (row: SettingsRow | null, now: number) => !!row && (row.synced_at ?? 0) < now - SETTINGS_SYNC_MARK_MS;

export interface SettingsSaved {
  settings: SettingsDto;
  kept: string[];
  metrics: Partial<Record<SettingsMetric, number>>;
  /** A row exists whose synced_at should be marked (nothing was written). */
  mark: boolean;
}

/**
 * Saves `input` over the revision read, retrying when another save landed in between (each retry merges again over
 * the newer one). A save made under another epoch (an administrator reset or restored the settings since the device
 * last loaded them) is refused with the account's settings, so the device adopts them. A member who withdrew while the
 * save was on its way gets nothing written.
 */
export async function saveSettings(db: D1Database, userId: string, input: SettingsSave, now = Date.now()): Promise<SettingsSaved> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await readRow(db, userId);
    const cur = toState(row);
    if (input.epoch !== cur.epoch) fail(409, 'settings_reset', 'the account settings were reset; load them again', { settings: toDto(cur) });
    const m = mergeSettings(cur, input, now);
    const metrics: Partial<Record<SettingsMetric, number>> = {};
    if (m.conflict) metrics.ss_conflict = 1;
    if (m.kept.length) metrics.ss_stale = 1;
    if (!m.changed) return { settings: toDto(cur), kept: m.kept, metrics, mark: needsSyncMark(row, now) };
    const up = await db
      .prepare(
        `INSERT INTO user_settings (user_id, prefs, fav, rev, epoch, schema_version, created_at, updated_at, synced_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?8, ?6, ?6, ?6
         WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1 AND status != 'deleted')
         ON CONFLICT (user_id) DO UPDATE SET
           prefs = excluded.prefs, fav = excluded.fav, rev = excluded.rev, updated_at = excluded.updated_at, synced_at = excluded.synced_at,
           -- The member changed something after a reset: it can't be undone any more.
           reset_rev = NULL, prev = NULL
         WHERE user_settings.rev = ?7 AND user_settings.epoch = ?5
         RETURNING rev`,
      )
      .bind(userId, JSON.stringify(m.prefs), JSON.stringify(m.fav), cur.rev + 1, cur.epoch, now, cur.rev, SETTINGS_SCHEMA_VERSION)
      .first<{ rev: number }>();
    if (up) {
      metrics.ss_save = 1;
      if (m.legacy) metrics.ss_legacy = 1;
      const settings = toDto({ prefs: m.prefs, fav: m.fav, rev: up.rev, epoch: cur.epoch, updatedAt: now });
      return { settings, kept: m.kept, metrics, mark: false };
    }
  }
  return fail(409, 'settings_busy', 'the settings changed while saving; try again');
}

/** Adds the counters for a load or save. Never fails the answer. */
export async function countSettings(db: D1Database, counts: Partial<Record<SettingsMetric, number>>, now = Date.now()) {
  if (!Object.values(counts).some((n) => (n ?? 0) > 0)) return;
  await db.batch(statsIncrements(db, statsDay(now), counts)).catch(() => undefined);
}

/** The counter of a refused or failed save. */
export function saveFailure(e: unknown): SettingsMetric {
  if (!(e instanceof HttpError)) return 'ss_fail_error';
  if (e.status === 429) return 'ss_fail_limit';
  if (e.status === 400 || e.code === 'settings_account') return 'ss_fail_invalid';
  if (e.code === 'settings_reset') return 'ss_epoch';
  if (e.code === 'settings_busy') return 'ss_fail_busy';
  return 'ss_fail_error';
}

export const clientFails = (n: number | undefined) => Math.min(Math.max(Math.trunc(n ?? 0), 0), SETTINGS_CLIENT_FAILS_MAX);

/** The reset, if any, and until when it can be undone. */
export function resetInfo(row: SettingsRow | null, now: number) {
  if (!row?.reset_at) return null;
  const until = row.reset_at + SETTINGS_RESTORE_MS;
  const restorable = row.prev !== null && row.reset_rev !== null && row.reset_rev === row.rev && now < until;
  return { at: row.reset_at, by: row.reset_by, restorableUntil: restorable ? until : null, restoredAt: row.restored_at };
}

/** What an administrator sees: counts and times, never a value. */
export function diagnose(
  member: AdminSettingsDiagDto['member'],
  row: SettingsRow | null,
  resetBy: { id: string; nickname: string | null } | null,
  now: number,
): AdminSettingsDiagDto {
  const s = toState(row);
  const r = resetInfo(row, now);
  return {
    member,
    exists: !!row,
    rev: s.rev,
    epoch: s.epoch,
    schemaVersion: row?.schema_version ?? null,
    fields: Object.keys(s.prefs).length,
    favourites: favList(s.fav).length,
    updatedAt: row?.updated_at ?? null,
    syncedAt: row?.synced_at ?? null,
    reset: r ? { at: r.at, by: resetBy, restorableUntil: r.restorableUntil, restoredAt: r.restoredAt } : null,
  };
}
