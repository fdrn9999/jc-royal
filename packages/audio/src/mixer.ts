/**
 * Which sounds get to play: the table can send a burst (a deal to nine seats, a split pot, an all-in runout) that would
 * only pile into noise. Two rules, both on the time of the request:
 *
 * - The same sound again sooner than its gap is the same sound, louder: it is played once.
 * - Over MAX_VOICES at once, the background sounds (cards and chips) give way. A sound that tells what happened
 *   (an action, the timer, a win, an Academy answer) always plays.
 *
 * Nothing waits for later: a sound is played now or not at all, so nothing piles up to burst out afterwards.
 */
import type { SoundId } from './index';

/** Background: the table moving. Dropped first when too much plays at once. */
export const AMBIENT: ReadonlySet<SoundId> = new Set<SoundId>(['deal', 'flip', 'chip', 'select']);

/** The shortest time (ms) between two plays of one sound. */
export const GAP_MS: Record<SoundId, number> = {
  deal: 45,
  flip: 45,
  chip: 50,
  select: 40,
  check: 80,
  call: 80,
  fold: 80,
  raise: 120,
  allin: 300,
  timer: 400,
  showdown: 400,
  win: 500,
  correct: 150,
  wrong: 150,
  complete: 400,
};

/** About how long each synthesized voice sounds (ms). */
export const LENGTH_MS: Record<SoundId, number> = {
  deal: 120,
  flip: 100,
  chip: 110,
  select: 70,
  check: 160,
  call: 170,
  fold: 130,
  raise: 220,
  allin: 450,
  timer: 240,
  showdown: 420,
  win: 950,
  correct: 320,
  wrong: 230,
  complete: 500,
};

export const MAX_VOICES = 6;

export class Mixer {
  private last = new Map<SoundId, number>();
  private ends: number[] = [];

  /** Whether `id` plays at `now` (ms); if it does, it counts as playing for `length` ms (a recording's own length). */
  admit(id: SoundId, now: number, length = LENGTH_MS[id]): boolean {
    const prev = this.last.get(id);
    if (prev !== undefined && now - prev >= 0 && now - prev < GAP_MS[id]) return false;
    this.ends = this.ends.filter((end) => end > now);
    if (this.ends.length >= MAX_VOICES && AMBIENT.has(id)) return false;
    this.last.set(id, now);
    this.ends.push(now + length);
    return true;
  }

  /** Playing now. */
  voices(now: number): number {
    return this.ends.filter((end) => end > now).length;
  }
}
