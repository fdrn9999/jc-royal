// The order of the account's reads (src/lib/accountReads.ts): a late answer never signs a page back in or shows another
// account, and an answer that came around a save of the same account is read again rather than dropped or trusted.
import { describe, expect, it } from 'vitest';
import { AccountReads } from '../src/lib/accountReads';

describe('the account reads', () => {
  it('shows answers in the order they were asked', () => {
    const r = new AccountReads();
    const first = r.ask();
    const second = r.ask();
    expect(r.answer(second, 'me')).toBe('show');
    // Asked before the one that shows: older, and nothing to read again for.
    expect(r.answer(first, 'me')).toBe('drop');
    expect(r.answer(first, null)).toBe('drop');
    expect(r.answer(r.ask(), 'me')).toBe('show');
  });

  it('drops a read from before a save once a read asked after the save has shown', () => {
    const r = new AccountReads();
    r.set('me');
    const before = r.ask();
    r.set('me');
    expect(r.answer(r.ask(), 'me')).toBe('show');
    expect(r.answer(before, 'me')).toBe('drop');
  });

  it('drops a read begun before signing out, whatever it answers', () => {
    const r = new AccountReads();
    r.set('me');
    const out = r.ask();
    r.set(null);
    expect(r.answer(out, 'me')).toBe('drop');
    const gone = r.ask();
    r.set(null);
    expect(r.answer(gone, null)).toBe('drop');
  });

  it('drops a read of the account before another one signed in', () => {
    const r = new AccountReads();
    r.set('a');
    const old = r.ask();
    r.set('b');
    expect(r.answer(old, 'a')).toBe('drop');
  });

  it('reads again when a save of the same account answered while a read was out (the read may be the newer)', () => {
    // A locale save (balance 100 when the server saved it) and a read asked meanwhile (balance 200 after a grant): the
    // save's answer comes first. Neither is known to be the newer, so the account is read once more.
    const r = new AccountReads();
    r.set('me');
    const meanwhile = r.ask();
    r.set('me');
    expect(r.answer(meanwhile, 'me')).toBe('again');
    // The read again is asked after the save: it shows.
    expect(r.answer(r.ask(), 'me')).toBe('show');
    // So does a sign-in that went (401) around a save: read again, and the second answer stands.
    const before = r.ask();
    r.set('me');
    expect(r.answer(before, null)).toBe('again');
    expect(r.answer(r.ask(), null)).toBe('show');
  });
});
