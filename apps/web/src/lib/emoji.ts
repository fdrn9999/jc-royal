/** The emoji the chat and message pickers offer: a fixed set, so no emoji library or data file is loaded. */
export const PICKER_EMOJI = [
  '😀', '😂', '🤣', '😊', '😍', '😎', '🤔', '😮',
  '😅', '😢', '😭', '😡', '😱', '🥳', '😴', '🙄',
  '👍', '👎', '👏', '🙏', '🤝', '💪', '✌️', '👋',
  '❤️', '🔥', '🎉', '💯', '💰', '🍀', '🃏', '♠️',
] as const;

/**
 * Puts `emoji` in place of the selection [start, end) of `value` (a caret is an empty selection) and returns the new
 * text with the caret just after the emoji, or null when the text would pass `maxLength` (counted, like the field's own
 * limit and the server's, in UTF-16 units, so an emoji is never cut in half).
 */
export function insertAt(value: string, start: number, end: number, emoji: string, maxLength: number): { value: string; caret: number } | null {
  const a = Math.max(0, Math.min(start, end, value.length));
  const b = Math.max(a, Math.min(Math.max(start, end), value.length));
  const next = value.slice(0, a) + emoji + value.slice(b);
  if (next.length > maxLength) return null;
  return { value: next, caret: a + emoji.length };
}
