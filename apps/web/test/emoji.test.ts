import { describe, expect, it } from 'vitest';
import { insertAt, PICKER_EMOJI } from '../src/lib/emoji';

describe('insertAt', () => {
  it('puts the emoji at the caret and keeps the text on both sides', () => {
    expect(insertAt('좋은 패', 2, 2, '🔥', 200)).toEqual({ value: '좋은🔥 패', caret: 4 });
    expect(insertAt('', 0, 0, '👍', 200)).toEqual({ value: '👍', caret: 2 });
    expect(insertAt('gg', 2, 2, '🤝', 200)).toEqual({ value: 'gg🤝', caret: 4 });
  });

  it('replaces a selection, in either direction', () => {
    expect(insertAt('nice hand', 5, 9, '😎', 200)).toEqual({ value: 'nice 😎', caret: 7 });
    expect(insertAt('nice hand', 9, 5, '😎', 200)).toEqual({ value: 'nice 😎', caret: 7 });
  });

  it('keeps a caret past the end, or before the start, inside the text', () => {
    expect(insertAt('ab', 10, 10, '👏', 200)).toEqual({ value: 'ab👏', caret: 4 });
    expect(insertAt('ab', -3, -1, '👏', 200)).toEqual({ value: '👏ab', caret: 2 });
  });

  it('refuses an emoji that would pass the limit instead of cutting it in half', () => {
    const full = 'x'.repeat(199);
    expect(insertAt(full, 199, 199, '😂', 200)).toBeNull();
    expect(insertAt(full, 199, 199, '♠', 200)).toEqual({ value: `${full}♠`, caret: 200 });
    // Replacing a selection frees its length first.
    expect(insertAt(`${full}y`, 198, 200, '😂', 200)).toEqual({ value: `${'x'.repeat(198)}😂`, caret: 200 });
  });

  it('counts the limit in UTF-16 units, as the field and the server do', () => {
    for (const e of PICKER_EMOJI) {
      const r = insertAt('', 0, 0, e, 200)!;
      expect(r.value.length).toBe(e.length);
      expect(r.caret).toBe(e.length);
    }
  });
});

describe('PICKER_EMOJI', () => {
  it('offers each emoji once, in rows of eight', () => {
    expect(new Set(PICKER_EMOJI).size).toBe(PICKER_EMOJI.length);
    expect(PICKER_EMOJI.length % 8).toBe(0);
  });
});
