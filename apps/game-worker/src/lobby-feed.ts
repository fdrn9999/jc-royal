import type { LobbyLivePatch } from '@jc/types';

/**
 * A table room's feed to the lobby over the realtime hubs (docs/REALTIME.md), apart from the room so it can be tested
 * on its own: the counts every lobby card shows (lobby.table.changed), and which members' own place at the table moved
 * (lobby.mine.changed, to them only). Both follow the room's D1 occupancy write, never run ahead of it.
 */

/** A table's counts reach the lobbies at most this often: a burst (a hand ending, the next one dealt) goes as its last state. */
export const LOBBY_PUSH_MS = 1_000;

/** Each member's place at the table as the lobby reads it (`s` seated, `w<i>` i-th on the waitlist). Table bots have none. */
export function placesOf(seated: readonly string[], waitlist: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  waitlist.forEach((u, i) => m.set(u, `w${i}`));
  for (const u of seated) m.set(u, 's');
  return m;
}

/** The members whose place changed between two writes: sat, stood up, joined or left the waitlist, moved up on it. */
export function placesMoved(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [u, p] of after) if (before.get(u) !== p) out.push(u);
  for (const u of before.keys()) if (!after.has(u)) out.push(u);
  return out;
}

/**
 * Sends the newest patch at once after a quiet second, otherwise when the second is over (as the counts are then), and
 * never the counts it sent last again. Patches come one write at a time (oneAtATime), so each is newer than the one before.
 */
export class LobbyFeed {
  private latest: LobbyLivePatch | null = null;
  private sentKey = '';
  private sentAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (p: LobbyLivePatch) => void,
    private readonly now: () => number = Date.now,
  ) {}

  push(p: LobbyLivePatch) {
    this.latest = p;
    if (this.timer) return;
    const wait = this.sentAt + LOBBY_PUSH_MS - this.now();
    if (wait <= 0) return this.flush();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush() {
    const p = this.latest;
    if (!p) return;
    const { rev: _, ...counts } = p;
    const key = JSON.stringify(counts);
    if (key === this.sentKey) return;
    this.sentKey = key;
    this.sentAt = this.now();
    this.send(p);
  }
}
