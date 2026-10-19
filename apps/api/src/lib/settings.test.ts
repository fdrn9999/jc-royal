import { SETTINGS_FAV_MAX, SETTINGS_MAX_AGO_MS, SETTINGS_RESTORE_MS, type SettingsSave } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { HttpError } from './http';
import { clientFails, EMPTY_STATE, favList, mergeSettings, parseFav, parsePrefs, resetInfo, saveFailure, toDto, type SettingsRow, type SettingsState } from './settings';

const NOW = 10_000_000_000;
const save = (p: Partial<SettingsSave>): SettingsSave => ({ user: 'u1', epoch: 0, base: 0, ...p });
const state = (p: Partial<SettingsState>): SettingsState => ({ ...EMPTY_STATE, ...p });

describe('mergeSettings', () => {
  it('takes a change the account has nothing for, dated by the server clock', () => {
    const m = mergeSettings(EMPTY_STATE, save({ prefs: { theme: { v: 'emerald', ago: 5_000 } } }), NOW);
    expect(m.changed).toBe(true);
    expect(m.prefs.theme).toEqual(['emerald', NOW - 5_000, 1]);
    expect(m.kept).toEqual([]);
    expect(m.conflict).toBe(false);
  });

  it('keeps a newer change made on another device and names it', () => {
    const cur = state({ rev: 4, prefs: { theme: ['crimson', NOW - 1_000, 4] } });
    // Made 10 s ago on a device that last loaded revision 3: the stored change (1 s ago) is newer.
    const m = mergeSettings(cur, save({ base: 3, prefs: { theme: { v: 'emerald', ago: 10_000 } } }), NOW);
    expect(m.changed).toBe(false);
    expect(m.prefs.theme).toEqual(['crimson', NOW - 1_000, 4]);
    expect(m.kept).toEqual(['theme']);
    expect(m.conflict).toBe(true);
  });

  it('lets the later change win over a revision it had not seen, and counts the conflict', () => {
    const cur = state({ rev: 4, prefs: { theme: ['crimson', NOW - 60_000, 4] } });
    const m = mergeSettings(cur, save({ base: 3, prefs: { theme: { v: 'emerald', ago: 1_000 } } }), NOW);
    expect(m.prefs.theme).toEqual(['emerald', NOW - 1_000, 5]);
    expect(m.conflict).toBe(true);
    expect(m.kept).toEqual([]);
  });

  it('merges different settings changed on two devices', () => {
    const cur = state({ rev: 2, prefs: { theme: ['crimson', NOW - 1_000, 2] } });
    const m = mergeSettings(cur, save({ base: 1, prefs: { fourColor: { v: true, ago: 30_000 } } }), NOW);
    expect(m.prefs.theme?.[0]).toBe('crimson');
    expect(m.prefs.fourColor?.[0]).toBe(true);
    expect(m.conflict).toBe(false);
  });

  it('changes nothing for the value the account already has', () => {
    const cur = state({ rev: 2, prefs: { beginner: [true, NOW - 1_000, 2] } });
    const m = mergeSettings(cur, save({ base: 1, prefs: { beginner: { v: true, ago: 0 } } }), NOW);
    expect(m.changed).toBe(false);
    expect(m.conflict).toBe(false);
  });

  it('dates a change from a device offline for long no earlier than SETTINGS_MAX_AGO_MS', () => {
    const m = mergeSettings(EMPTY_STATE, save({ prefs: { beginner: { v: true, ago: SETTINGS_MAX_AGO_MS * 3 } } }), NOW);
    expect(m.prefs.beginner?.[1]).toBe(NOW - SETTINGS_MAX_AGO_MS);
  });

  it('fills only what the account has nothing for from a device’s settings before sync, and never wins over a real change', () => {
    const cur = state({ rev: 1, prefs: { theme: ['royal', NOW - 5_000, 1] } });
    const m = mergeSettings(cur, save({ base: 1, legacy: { prefs: { theme: 'crimson', fourColor: true }, fav: ['b', 'a'] } }), NOW);
    expect(m.prefs.theme?.[0]).toBe('royal');
    expect(m.prefs.fourColor).toEqual([true, 0, 2]);
    expect(m.legacy).toBe(true);
    expect(favList(m.fav)).toEqual(['b', 'a']);
    // Any later change, from any device, wins over it.
    const next = mergeSettings(state({ rev: 2, prefs: m.prefs, fav: m.fav }), save({ base: 0, prefs: { fourColor: { v: false, ago: SETTINGS_MAX_AGO_MS } } }), NOW);
    expect(next.prefs.fourColor?.[0]).toBe(false);
  });

  it('ignores a device’s settings before sync once an administrator reset the account (epoch > 0)', () => {
    const m = mergeSettings(state({ rev: 3, epoch: 1 }), save({ epoch: 1, base: 3, legacy: { prefs: { beginner: true }, fav: ['a'] } }), NOW);
    expect(m.changed).toBe(false);
    expect(m.legacy).toBe(false);
    expect(m.prefs).toEqual({});
  });

  it('adds and takes off favourites one at a time, newest first, and keeps a removal against an older add', () => {
    const cur = state({ rev: 2, fav: { a: [1, NOW - 50_000, 1], b: [0, NOW - 1_000, 2] } });
    const m = mergeSettings(
      cur,
      save({
        base: 1,
        fav: [
          { id: 'c', on: true, ago: 0 },
          { id: 'b', on: true, ago: 20_000 }, // older than the removal stored: kept off
          { id: 'a', on: false, ago: 10 },
        ],
      }),
      NOW,
    );
    expect(favList(m.fav)).toEqual(['c']);
    expect(m.fav.a?.[0]).toBe(0);
    expect(m.kept).toEqual(['fav:b']);
  });

  it('keeps the newest SETTINGS_FAV_MAX favourites and forgets old removals', () => {
    const fav: SettingsState['fav'] = {};
    for (let i = 0; i < SETTINGS_FAV_MAX; i++) fav[`t${i}`] = [1, NOW - 100_000 + i, 1];
    fav.gone = [0, NOW - SETTINGS_MAX_AGO_MS - 1, 1];
    const m = mergeSettings(state({ rev: 1, fav }), save({ base: 1, fav: [{ id: 'new', on: true, ago: 0 }] }), NOW);
    const list = favList(m.fav);
    expect(list).toHaveLength(SETTINGS_FAV_MAX);
    expect(list[0]).toBe('new');
    expect(list).not.toContain('t0');
    expect(m.fav.gone).toBeUndefined();
  });

  // Auto-muck always applies now (2026-10-19): an older page still sends the setting, which is kept like any other and
  // goes nowhere else (it replaced a test that the tables were told of a change).
  it('accepts the auto-muck an older page sends, and reports nothing for the tables', () => {
    const m = mergeSettings(EMPTY_STATE, save({ prefs: { autoMuck: { v: true, ago: 0 } } }), NOW);
    expect(m.changed).toBe(true);
    expect(m.prefs.autoMuck?.[0]).toBe(true);
    expect('muck' in m).toBe(false);
  });
});

describe('stored settings', () => {
  it('reads only well-formed values', () => {
    expect(parsePrefs(JSON.stringify({ theme: ['neon', 1, 1], fourColor: [true, 2, 1], beginner: 'x', other: [1, 1, 1] }))).toEqual({ fourColor: [true, 2, 1] });
    expect(parsePrefs('not json')).toEqual({});
    expect(parseFav(JSON.stringify({ a: [1, 5, 1], b: [2, 5, 1], ['x'.repeat(65)]: [1, 1, 1] }))).toEqual({ a: [1, 5, 1] });
  });

  it('answers values only, favourites newest first', () => {
    const dto = toDto(state({ rev: 3, epoch: 1, prefs: { theme: ['crimson', 5, 3] }, fav: { a: [1, 5, 1], b: [1, 9, 2], c: [0, 10, 3] }, updatedAt: 99 }));
    expect(dto).toEqual({ epoch: 1, rev: 3, prefs: { theme: 'crimson' }, fav: ['b', 'a'], updatedAt: 99 });
  });

  it('can undo a reset only while it stands and within SETTINGS_RESTORE_MS', () => {
    const row = { rev: 5, reset_at: NOW, reset_by: 'adm', reset_rev: 5, prev: '{}', restored_at: null } as SettingsRow;
    expect(resetInfo(row, NOW + 1)?.restorableUntil).toBe(NOW + SETTINGS_RESTORE_MS);
    expect(resetInfo(row, NOW + SETTINGS_RESTORE_MS)?.restorableUntil).toBeNull();
    expect(resetInfo({ ...row, rev: 6 }, NOW + 1)?.restorableUntil).toBeNull();
    expect(resetInfo({ ...row, prev: null }, NOW + 1)?.restorableUntil).toBeNull();
    expect(resetInfo({ ...row, reset_at: null }, NOW)).toBeNull();
  });

  it('counts failures per reason, and a device’s failed attempts within bounds', () => {
    expect(saveFailure(new HttpError(429, 'rate_limited', 'x'))).toBe('ss_fail_limit');
    expect(saveFailure(new HttpError(400, 'bad_request', 'x'))).toBe('ss_fail_invalid');
    expect(saveFailure(new HttpError(409, 'settings_reset', 'x'))).toBe('ss_epoch');
    expect(saveFailure(new HttpError(409, 'settings_busy', 'x'))).toBe('ss_fail_busy');
    expect(saveFailure(new HttpError(409, 'settings_account', 'x'))).toBe('ss_fail_invalid');
    expect(saveFailure(new Error('d1'))).toBe('ss_fail_error');
    expect(clientFails(undefined)).toBe(0);
    expect(clientFails(-3)).toBe(0);
    expect(clientFails(500)).toBe(20);
  });
});
