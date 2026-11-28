/**
 * Table chat as speech bubbles by the sender's seat. Made from the chat lines the room already sends (no message of its
 * own): a live line shows for CHAT_BUBBLE_MS by the seat of the player who wrote it, one bubble per player (a new line
 * takes the old one's place). The chat panel keeps the full text; a bubble is only ever drawn as plain text, clamped.
 * Pure: the socket hook keeps the timers.
 */
import type { ChatMessage } from '@jc/types';

/** How long a bubble stays by a seat. */
export const CHAT_BUBBLE_MS = 4_000;
/** The most of a line a bubble holds (it clamps to two lines on screen; the rest reads in the chat panel). */
export const CHAT_BUBBLE_CHARS = 80;

export interface ChatBubble {
  /** The chat line's id. */
  id: string;
  userId: string;
  text: string;
}

/** A line as its bubble: one line of text, cut with an ellipsis. */
export function bubbleText(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length > CHAT_BUBBLE_CHARS ? `${chars.slice(0, CHAT_BUBBLE_CHARS - 1).join('')}…` : one;
}

/**
 * The bubbles with a new line's: the sender's earlier bubble gives way. `seen`: ids already shown (a line delivered
 * twice shows once). Returns the same list when nothing is to show.
 */
export function addBubble(q: ChatBubble[], m: Pick<ChatMessage, 'id' | 'userId' | 'text'>, seen: ReadonlySet<string>): ChatBubble[] {
  const text = bubbleText(m.text);
  if (!text || seen.has(m.id) || q.some((x) => x.id === m.id)) return q;
  return [...q.filter((x) => x.userId !== m.userId), { id: m.id, userId: m.userId, text }];
}

export function dropBubble(q: ChatBubble[], id: string): ChatBubble[] {
  return q.some((x) => x.id === id) ? q.filter((x) => x.id !== id) : q;
}

/**
 * The bubbles to draw: none with the setting off, none from players hidden on this device (muted or blocked: their
 * lines are hidden in the panel too), and only by a seat its writer still sits at (a spectator's line stays in the panel).
 */
export function seatBubbles(q: ChatBubble[], on: boolean, hidden: ReadonlySet<string>, seats: readonly { seatIndex: number; userId?: string | null }[]): Map<number, ChatBubble> {
  const out = new Map<number, ChatBubble>();
  if (!on) return out;
  for (const b of q) {
    if (hidden.has(b.userId)) continue;
    const seat = seats.find((x) => x.userId === b.userId);
    if (seat) out.set(seat.seatIndex, b);
  }
  return out;
}
