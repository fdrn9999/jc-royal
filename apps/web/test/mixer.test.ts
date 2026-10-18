import { AMBIENT, GAP_MS, LENGTH_MS, MAX_VOICES, Mixer, type SoundId } from '@jc/audio';
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

  it('never more than MAX_VOICES at once, whatever comes: a sound that tells the hand takes the place of one playing', () => {
    const m = new Mixer();
    const ids = Object.keys(GAP_MS) as SoundId[];
    let seed = 3;
    let admitted = 0;
    for (let i = 0; i < 3000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const id = ids[seed % ids.length]!;
      // A burst: a sound every 7 ms, now and then a quiet moment.
      const now = i * 7 + Math.floor(i / 200) * 1000;
      if (m.admit(id, now)) admitted++;
      expect(m.voices(now), `${id} at ${now}`).toBeLessThanOrEqual(MAX_VOICES);
    }
    expect(admitted).toBeGreaterThan(500);
  });

  it('the background sound nearest its end is stopped for it, then the one that tells the hand nearest its end', () => {
    const m = new Mixer();
    const stopped: SoundId[] = [];
    for (const id of ['deal', 'flip', 'chip', 'select', 'check', 'call'] as const) expect(m.admit(id, 0, undefined, () => stopped.push(id))).toBe(true);
    expect(m.admit('raise', 1, undefined, () => stopped.push('raise'))).toBe(true);
    expect(stopped).toEqual(['select']);
    expect(m.voices(1)).toBe(MAX_VOICES);
    for (const id of ['allin', 'timer', 'win'] as const) m.admit(id, 2, undefined, () => stopped.push(id));
    expect(stopped).toEqual(['select', 'flip', 'chip', 'deal']);
    m.admit('showdown', 3);
    expect(stopped).toEqual(['select', 'flip', 'chip', 'deal', 'check']);
    expect(m.voices(3)).toBe(MAX_VOICES);
  });

  it('every sound has a gap and a length', () => {
    expect(Object.keys(LENGTH_MS).sort()).toEqual(Object.keys(GAP_MS).sort());
    for (const id of Object.keys(GAP_MS) as (keyof typeof GAP_MS)[]) {
      expect(GAP_MS[id]).toBeGreaterThan(0);
      expect(LENGTH_MS[id]).toBeGreaterThan(0);
    }
  });
});
