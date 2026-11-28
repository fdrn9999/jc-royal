import { describe, expect, it } from 'vitest';
import { addBubble, bubbleText, CHAT_BUBBLE_CHARS, CHAT_BUBBLE_MS, dropBubble, seatBubbles, type ChatBubble } from '../src/game/chatBubbles';

/** Table chat as speech bubbles: one per player, once per line, by the writer's seat, and never for a hidden player. */
const line = (id: string, userId: string, text: string) => ({ id, userId, text });
const NONE: ReadonlySet<string> = new Set();
const SEATS = [
  { seatIndex: 0, userId: 'a' },
  { seatIndex: 1, userId: null },
  { seatIndex: 2, userId: 'b' },
];

describe('chat bubbles', () => {
  it('stays four seconds', () => {
    expect(CHAT_BUBBLE_MS).toBe(4_000);
  });

  it('is one line of text, cut with an ellipsis', () => {
    expect(bubbleText('  hello \n\n there  ')).toBe('hello there');
    const long = bubbleText('가'.repeat(200));
    expect(Array.from(long)).toHaveLength(CHAT_BUBBLE_CHARS);
    expect(long.endsWith('…')).toBe(true);
    // An emoji is one character, never cut in half.
    expect(bubbleText('😀'.repeat(200)).endsWith('😀…')).toBe(true);
    // Markup is only ever text.
    expect(bubbleText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('a new line takes the place of the same player’s earlier one', () => {
    let q: ChatBubble[] = [];
    q = addBubble(q, line('1', 'a', 'one'), NONE);
    q = addBubble(q, line('2', 'b', 'two'), NONE);
    q = addBubble(q, line('3', 'a', 'three'), NONE);
    expect(q.map((x) => x.id)).toEqual(['2', '3']);
  });

  it('a line delivered twice, or already shown, shows once; an empty one never', () => {
    const q = addBubble([], line('1', 'a', 'one'), NONE);
    expect(addBubble(q, line('1', 'a', 'one'), NONE)).toBe(q);
    expect(addBubble([], line('1', 'a', 'one'), new Set(['1']))).toEqual([]);
    expect(addBubble(q, line('2', 'b', '   '), NONE)).toBe(q);
  });

  it('drops by id, and only its own', () => {
    const q = addBubble(addBubble([], line('1', 'a', 'one'), NONE), line('2', 'a', 'two'), NONE);
    // The first line's timer finds its bubble already replaced: the newer one stays.
    expect(dropBubble(q, '1')).toBe(q);
    expect(dropBubble(q, '2')).toEqual([]);
  });

  it('is drawn by the writer’s seat: not with the setting off, not for a hidden player, not for a spectator', () => {
    const q = [
      { id: '1', userId: 'a', text: 'one' },
      { id: '2', userId: 'b', text: 'two' },
      { id: '3', userId: 'watcher', text: 'three' },
    ];
    expect([...seatBubbles(q, true, NONE, SEATS).keys()]).toEqual([0, 2]);
    expect(seatBubbles(q, false, NONE, SEATS).size).toBe(0);
    expect([...seatBubbles(q, true, new Set(['a']), SEATS).keys()]).toEqual([2]);
    // The writer stood up: the bubble goes with them.
    expect([...seatBubbles(q, true, NONE, [{ seatIndex: 2, userId: 'b' }]).keys()]).toEqual([2]);
  });
});
