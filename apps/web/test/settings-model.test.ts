import { SETTINGS_AMOUNT_UNITS, SETTINGS_FAV_MAX, SETTINGS_THEMES, SYNCED_PREF_DEFAULTS, type SettingsDto } from '@jc/types';
import { THEMES } from '@jc/ui';
import { describe, expect, it } from 'vitest';
import { AMOUNT_UNITS } from '../src/lib/prefs';
import { EMPTY_ACCOUNT, hasChanges, legacyPrefs, parseAccount, pendingMuck, viewOf, withFavourite, withPrefs, type AccountSettings } from '../src/lib/settings-model';
import { afterLoad, afterReset, afterSave, FAV_CHANGES_MAX, saveBody } from '../src/lib/settings-save';

const NOW = 1_800_000_000_000;
const dto = (p: Partial<SettingsDto> = {}): SettingsDto => ({ epoch: 0, rev: 0, prefs: {}, fav: [], updatedAt: null, ...p });
const account = (p: Partial<AccountSettings> = {}): AccountSettings => ({ ...EMPTY_ACCOUNT, ...p });

describe('settings on this device', () => {
  it('offers the themes and amount units the screens have', () => {
    expect([...SETTINGS_THEMES]).toEqual([...THEMES]);
    expect([...AMOUNT_UNITS]).toEqual([...SETTINGS_AMOUNT_UNITS]);
  });

  it('shows the defaults, then the device’s settings from before sync under the account’s, then changes not saved yet', () => {
    const a = account({
      server: dto({ prefs: { theme: 'crimson' }, fav: ['s1'] }),
      legacy: { prefs: { theme: 'emerald', fourColor: true }, fav: ['old', 's1'] },
      pending: { prefs: { beginner: { v: true, at: NOW } }, fav: { new: { on: true, at: NOW }, s1: { on: false, at: NOW } } },
    });
    const v = viewOf(a);
    expect(v.prefs).toEqual({ ...SYNCED_PREF_DEFAULTS, theme: 'crimson', fourColor: true, beginner: true });
    expect(v.fav).toEqual(['new', 'old']);
    // Signed out: the defaults, or what this device had before sync until an account takes it; no favourites.
    expect(viewOf(null, { theme: 'sapphire' })).toEqual({ prefs: { ...SYNCED_PREF_DEFAULTS, theme: 'sapphire' }, fav: [] });
  });

  it('no longer shows or sends the device’s settings from before sync once the account was reset (epoch > 0)', () => {
    const a = account({ server: dto({ epoch: 1, rev: 4 }), legacy: { prefs: { fourColor: true }, fav: ['old'] } });
    expect(viewOf(a).prefs.fourColor).toBe(false);
    expect(viewOf(a).fav).toEqual([]);
    expect(hasChanges(a)).toBe(false);
    expect(saveBody('u1', a, NOW)).toBeNull();
  });

  it('takes only valid settings that differ from the defaults from the device store from before sync', () => {
    expect(legacyPrefs({ theme: 'royal', fourColor: true, beginner: 'yes', amountUnit: 'bb', reactions: true, other: 1 })).toEqual({ fourColor: true, amountUnit: 'bb' });
    expect(legacyPrefs('nope')).toEqual({});
  });

  it('keeps a change back to the account’s value (a save may be out with the one before), but setting what shows changes nothing', () => {
    const read = account({ server: dto({ prefs: { fourColor: true } }) });
    expect(withPrefs(read, { fourColor: true }, NOW)).toEqual(read);
    const changed = withPrefs(read, { fourColor: false }, NOW);
    expect(changed.pending.prefs.fourColor).toEqual({ v: false, at: NOW });
    expect(withPrefs(changed, { fourColor: true }, NOW + 1).pending.prefs).toEqual({ fourColor: { v: true, at: NOW + 1 } });
    // Invalid values are not taken.
    expect(withPrefs(read, { theme: 'neon' as never }, NOW).pending.prefs).toEqual({});
  });

  it('adds favourites to the front, and taking one off also takes it off the ones from before sync', () => {
    let a = account({ server: dto({ fav: ['s1'] }), legacy: { fav: ['old'] } });
    a = withFavourite(a, 'new', true, NOW);
    expect(viewOf(a).fav).toEqual(['new', 's1', 'old']);
    a = withFavourite(a, 'old', false, NOW + 1);
    expect(a.legacy?.fav).toEqual([]);
    expect(viewOf(a).fav).toEqual(['new', 's1']);
    // Added again after being taken off: one pending change, the last.
    a = withFavourite(a, 's1', false, NOW + 2);
    a = withFavourite(a, 's1', true, NOW + 3);
    expect(a.pending.fav.s1).toEqual({ on: true, at: NOW + 3 });
    // A favourite already shown, with no change pending, or an id no table has: nothing changes.
    const plain = account({ server: dto({ fav: ['s1'] }) });
    expect(withFavourite(plain, 's1', true, NOW)).toBe(plain);
    expect(withFavourite(a, 'x'.repeat(65), true, NOW)).toBe(a);
  });

  it('sends changes as how long ago they were made, the device’s old settings only at epoch 0, and failed attempts', () => {
    expect(saveBody('u1', account({ pending: { prefs: { beginner: { v: true, at: NOW } }, fav: {} } }), NOW)).toBeNull();
    const a = account({
      server: dto({ rev: 7 }),
      pending: { prefs: { beginner: { v: true, at: NOW - 1_500 } }, fav: { t1: { on: true, at: NOW - 10 } } },
      legacy: { prefs: { fourColor: true }, fav: [] },
      fails: 3,
    });
    expect(saveBody('u1', a, NOW)).toEqual({
      user: 'u1',
      epoch: 0,
      base: 7,
      prefs: { beginner: { v: true, ago: 1_500 } },
      fav: [{ id: 't1', on: true, ago: 10 }],
      legacy: { prefs: { fourColor: true } },
      fails: 3,
    });
    // A clock moved back counts as now; at most FAV_CHANGES_MAX favourite changes go at once, the newest.
    const many = account({ server: dto(), pending: { prefs: { theme: { v: 'emerald', at: NOW + 5_000 } }, fav: {} } });
    for (let i = 0; i < FAV_CHANGES_MAX + 10; i++) many.pending.fav[`t${i}`] = { on: true, at: NOW - 1_000 + i };
    const body = saveBody('u1', many, NOW)!;
    expect(body.prefs?.theme?.ago).toBe(0);
    expect(body.fav).toHaveLength(FAV_CHANGES_MAX);
    expect(body.fav![0]!.id).toBe(`t${FAV_CHANGES_MAX + 9}`);
    expect(viewOf(many).fav).toHaveLength(SETTINGS_FAV_MAX);
  });

  it('after a save, keeps only the changes made again since it was sent', () => {
    const a = account({
      server: dto({ rev: 1 }),
      pending: { prefs: { beginner: { v: true, at: NOW - 100 }, theme: { v: 'crimson', at: NOW - 100 } }, fav: { t1: { on: true, at: NOW - 100 } } },
      legacy: { prefs: { fourColor: true } },
      fails: 2,
    });
    const sent = saveBody('u1', a, NOW)!;
    // Made again while the save was out: theme changed once more, t1 taken off.
    const meanwhile = withFavourite(withPrefs(a, { theme: 'emerald' }, NOW + 50), 't1', false, NOW + 50);
    const after = afterSave(meanwhile, sent, dto({ rev: 2, prefs: { beginner: true, theme: 'crimson', fourColor: true }, fav: ['t1'] }), NOW);
    expect(after.pending.prefs).toEqual({ theme: { v: 'emerald', at: NOW + 50 } });
    expect(after.pending.fav).toEqual({ t1: { on: false, at: NOW + 50 } });
    expect(after.legacy).toBeNull();
    expect(after.fails).toBe(0);
    expect(viewOf(after).prefs.theme).toBe('emerald');
    expect(viewOf(after).fav).toEqual([]);
  });

  it('drops what was not saved when the account’s epoch moved on (an administrator reset or restored it)', () => {
    const a = account({ server: dto({ rev: 3 }), pending: { prefs: { autoMuck: { v: true, at: NOW } }, fav: {} }, legacy: { fav: ['old'] } });
    expect(pendingMuck(a)).toBe(true);
    const reset = afterLoad(a, dto({ epoch: 1, rev: 4 }));
    expect(reset.pending).toEqual({ prefs: {}, fav: {} });
    expect(reset.legacy).toBeNull();
    expect(pendingMuck(reset)).toBe(false);
    expect(afterReset(dto({ epoch: 2, rev: 9 }))).toEqual({ ...EMPTY_ACCOUNT, server: dto({ epoch: 2, rev: 9 }) });
    // The first read on this device keeps changes made before it, but the old settings only while the epoch is 0.
    const first = account({ pending: { prefs: { beginner: { v: true, at: NOW } }, fav: {} }, legacy: { prefs: { fourColor: true } } });
    expect(afterLoad(first, dto({ epoch: 0, rev: 2 })).legacy).toEqual({ prefs: { fourColor: true } });
    const afterResetEarlier = afterLoad(first, dto({ epoch: 1, rev: 2 }));
    expect(afterResetEarlier.legacy).toBeNull();
    expect(afterResetEarlier.pending.prefs.beginner).toEqual({ v: true, at: NOW });
  });

  it('reads only well-formed stored settings', () => {
    expect(parseAccount(null)).toEqual(EMPTY_ACCOUNT);
    expect(parseAccount('{')).toEqual(EMPTY_ACCOUNT);
    const raw = JSON.stringify({
      server: { epoch: 1, rev: 2, prefs: { theme: 'neon', fourColor: true }, fav: ['a', 'a', 7], updatedAt: 5 },
      pending: { prefs: { beginner: { v: 'x', at: 1 }, reactions: { v: false, at: 2 } }, fav: { b: { on: true, at: 3 }, c: { on: 'y', at: 3 } } },
      legacy: { prefs: { amountUnit: 'bb' }, fav: ['d'] },
      fails: -4,
    });
    expect(parseAccount(raw)).toEqual({
      server: { epoch: 1, rev: 2, prefs: { fourColor: true }, fav: ['a'], updatedAt: 5 },
      pending: { prefs: { reactions: { v: false, at: 2 } }, fav: { b: { on: true, at: 3 } } },
      legacy: { prefs: { amountUnit: 'bb' }, fav: ['d'] },
      fails: 0,
    });
  });
});
