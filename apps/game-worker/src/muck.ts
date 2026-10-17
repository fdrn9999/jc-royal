/**
 * The member's account auto-muck as the api pushes it to a seat (lib/room.ts pushMuckEverywhere). Each push carries the
 * settings revision it was saved as, which only grows; pushes run in the background, so two quick saves can arrive in the
 * other order. A push not newer than the last one this seat took is ignored: an older "off" arriving late must not turn
 * a losing hand's cards over at the next showdown. A push without a revision (an api from before revisions were sent)
 * applies as it always did. The player's own 'muck' command does not move the revision.
 *
 * Returns what the room does: 'none' (an older push, or nothing changed), 'save' (only the revision moved) or 'show'
 * (the value changed: save it and send the player's view).
 */
export function takePushedMuck(seat: { autoMuck?: boolean; muckRev?: number }, on: boolean, rev: number | null): 'none' | 'save' | 'show' {
  if (rev !== null) {
    if (seat.muckRev !== undefined && rev <= seat.muckRev) return 'none';
    seat.muckRev = rev;
  }
  if (!!seat.autoMuck !== on) {
    seat.autoMuck = on;
    return 'show';
  }
  return rev !== null ? 'save' : 'none';
}

/** The revision from the internal route's query: a whole number, or null when absent or malformed. */
export function muckRevParam(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}
