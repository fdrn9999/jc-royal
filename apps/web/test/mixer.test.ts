import { AMBIENT, GAP_MS, LENGTH_MS, MAX_VOICES, Mixer } from '@jc/audio';
import { describe, expect, it } from 'vitest';

describe('mixer', () => {
  it('plays a burst of one sound once per gap', () => {
    const m = new Mixer();
    expect(m.admit('chip', 0)).toBe(true);
    expect(m.admit('chip', GAP_MS.chip - 1)).toBe(false);
    expect(m.admit('chip', GAP_MS.chip)).toBe(true);
    // Different sounds do not hold each other back.
    expect(m.admit('call', GAP_MS.chip)).toBe(true);
  });

  it('a nine-seat deal is not merged away: cards come one gap apart', () => {
    const m = new Mixer();
    let played = 0;
    for (let i = 0; i < 18; i++) if (m.admit('deal', i * 60)) played++;
    expect(played).toBe(18);
  });

  it('too much at once drops cards and chips, never what tells the hand', () => {
    const m = new Mixer();
    const busy = ['deal', 'flip', 'chip', 'check', 'call', 'fold'] as const;
    busy.forEach((id) => expect(m.admit(id, 0)).toBe(true));
    expect(m.voices(0)).toBe(MAX_VOICES);
    for (const id of AMBIENT) expect(m.admit(id, 1)).toBe(false);
    for (const id of ['raise', 'allin', 'timer', 'showdown', 'win', 'correct', 'wrong', 'complete'] as const) expect(m.admit(id, 1)).toBe(true);
    // Once they have rung out, the background sounds are back.
    const later = 1 + Math.max(...Object.values(LENGTH_MS));
    expect(m.voices(later)).toBe(0);
    expect(m.admit('chip', later)).toBe(true);
  });

  it('every sound has a gap and a length', () => {
    expect(Object.keys(LENGTH_MS).sort()).toEqual(Object.keys(GAP_MS).sort());
    for (const id of Object.keys(GAP_MS) as (keyof typeof GAP_MS)[]) {
      expect(GAP_MS[id]).toBeGreaterThan(0);
      expect(LENGTH_MS[id]).toBeGreaterThan(0);
    }
  });
});
