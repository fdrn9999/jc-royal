import type { LegalOption } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { armSig, commitAction, decideTap, isRisky, shortcutFor, type KeyLike } from '../src/game/actionSafety';

/** A target whose closest() matches when one of `inside` appears in the selector (as the DOM would for those ancestors). */
const el = (...inside: string[]) => ({ closest: (sel: string) => (inside.some((s) => sel.split(', ').includes(s)) ? {} : null) });
const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key: k, code: `Key${k.toUpperCase()}`, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: el(), ...extra });

describe('shortcutFor', () => {
  it('maps F, C and R in either case', () => {
    expect(shortcutFor(key('f'), false)).toBe('fold');
    expect(shortcutFor(key('C'), false)).toBe('checkCall');
    expect(shortcutFor(key('r'), false)).toBe('raisePanel');
    expect(shortcutFor(key('x'), false)).toBeNull();
    expect(shortcutFor({ ...key('Enter'), code: 'Enter' }, false)).toBeNull();
  });

  it('ignores held-down keys and modifier combinations (copy, reload, browser shortcuts)', () => {
    expect(shortcutFor(key('c', { repeat: true }), false)).toBeNull();
    expect(shortcutFor(key('c', { ctrlKey: true }), false)).toBeNull();
    expect(shortcutFor(key('c', { metaKey: true }), false)).toBeNull();
    expect(shortcutFor(key('f', { altKey: true }), false)).toBeNull();
    expect(shortcutFor(key('c', { isComposing: true }), false)).toBeNull();
  });

  it('ignores keys typed into fields, the chat, or a dialog, and any key while a modal is open', () => {
    for (const where of ['input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])', '[role="dialog"]', '[data-no-shortcuts]']) {
      expect(shortcutFor(key('c', { target: el(where) }), false), where).toBeNull();
    }
    expect(shortcutFor(key('c'), true)).toBeNull();
    // A focused action button or the page body still takes shortcuts.
    expect(shortcutFor(key('c', { target: el('button') }), false)).toBe('checkCall');
    expect(shortcutFor(key('c', { target: null }), false)).toBe('checkCall');
  });

  it('uses the physical key when the layout gives no Latin letter (Korean IME on)', () => {
    expect(shortcutFor(key('ㄹ', { code: 'KeyF' }), false)).toBe('fold');
    expect(shortcutFor(key('ㅊ', { code: 'KeyC' }), false)).toBe('checkCall');
    expect(shortcutFor(key('ㄱ', { code: 'KeyR' }), false)).toBe('raisePanel');
    expect(shortcutFor(key('ㅁ', { code: 'KeyA' }), false)).toBeNull();
  });
});

describe('isRisky', () => {
  const facing: LegalOption[] = [{ type: 'fold' }, { type: 'call', amount: 500 }, { type: 'raise', min: 1000, max: 1200 }, { type: 'allin', amount: 1200 }];
  const free: LegalOption[] = [{ type: 'fold' }, { type: 'check' }, { type: 'bet', min: 20, max: 1000 }, { type: 'allin', amount: 1000 }];

  it('fold is risky only while a check is free', () => {
    expect(isRisky('fold', free, 1000)).toBe(true);
    expect(isRisky('fold', facing, 1000)).toBe(false);
  });

  it('a call of half the stack or more is risky', () => {
    expect(isRisky('call', facing, 1000)).toBe(true);
    expect(isRisky('call', facing, 1001)).toBe(false);
    expect(isRisky('call', free, 1000)).toBe(false);
  });

  it('a bet or raise that puts half the stack or more in is risky, counting chips already in front', () => {
    expect(isRisky('commit', free, 1000, 0, 499)).toBe(false);
    expect(isRisky('commit', free, 1000, 0, 500)).toBe(true);
    // Raise to 1000 with 200 already in: 800 more from a 1000 stack.
    expect(isRisky('commit', facing, 1000, 200, 1000)).toBe(true);
    expect(isRisky('commit', facing, 2000, 200, 1000)).toBe(false);
    expect(isRisky('allin', facing, 5000)).toBe(true);
  });
});

describe('decideTap', () => {
  const base = { key: 'call' as const, sig: armSig(7, 500), risky: true, confirmRisky: true, armed: null, busy: false, now: 10_000, readyAt: 9_000 };

  it('ignores presses while an action is in flight or right after the bar appears', () => {
    expect(decideTap({ ...base, busy: true })).toBe('ignore');
    expect(decideTap({ ...base, now: 8_999 })).toBe('ignore');
  });

  it('a risky action arms on the first press and runs on the second', () => {
    expect(decideTap(base)).toBe('arm');
    expect(decideTap({ ...base, armed: { key: 'call', sig: base.sig, until: 12_000 } })).toBe('run');
  });

  it('the arm confirms only the same action at the same amount in the same turn, before it expires', () => {
    expect(decideTap({ ...base, armed: { key: 'call', sig: base.sig, until: 10_000 } })).toBe('arm');
    expect(decideTap({ ...base, armed: { key: 'fold', sig: base.sig, until: 12_000 } })).toBe('arm');
    expect(decideTap({ ...base, armed: { key: 'call', sig: armSig(7, 400), until: 12_000 } })).toBe('arm');
    expect(decideTap({ ...base, armed: { key: 'call', sig: armSig(6, 500), until: 12_000 } })).toBe('arm');
    // Raise panel: arming at all-in then moving the amount does not carry over.
    const commit = { ...base, key: 'commit' as const, sig: armSig(7, 900) };
    expect(decideTap({ ...commit, armed: { key: 'commit', sig: armSig(7, 1200), until: 12_000 } })).toBe('arm');
  });

  it('safe actions, or confirmation turned off, run at once', () => {
    expect(decideTap({ ...base, risky: false })).toBe('run');
    expect(decideTap({ ...base, confirmRisky: false })).toBe('run');
  });
});

describe('commitAction', () => {
  const legal: LegalOption[] = [{ type: 'fold' }, { type: 'call', amount: 100 }, { type: 'raise', min: 200, max: 1000 }, { type: 'allin', amount: 1000 }];

  it('sends only amounts inside the server window, as whole chips', () => {
    expect(commitAction(legal, 199)).toBeNull();
    expect(commitAction(legal, 1001)).toBeNull();
    expect(commitAction(legal, 250.5)).toBeNull();
    expect(commitAction(legal, Number.NaN)).toBeNull();
    expect(commitAction(legal, 200)).toEqual({ type: 'raise', amount: 200 });
  });

  it('the all-in amount goes as an all-in, a bet window as a bet, and nothing without a window', () => {
    expect(commitAction(legal, 1000)).toEqual({ type: 'allin', amount: 1000 });
    expect(commitAction([{ type: 'check' }, { type: 'bet', min: 20, max: 300 }], 40)).toEqual({ type: 'bet', amount: 40 });
    expect(commitAction([{ type: 'fold' }, { type: 'call', amount: 50 }, { type: 'allin', amount: 50 }], 50)).toBeNull();
  });
});
