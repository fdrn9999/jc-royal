/**
 * What the table page does so a room from an older game worker (one rolled back, or not updated yet) still keeps a
 * losing hand face down and still shows the cards a player picks. Current rooms need none of it and are never asked.
 */

/**
 * Such a room holds an auto-muck setting per seat, off until a page turns it on, and turns a losing showdown hand over
 * while it is off. Given what was sent on this connection, whether it is open and the setting the room reports for my
 * seat (`undefined` from current rooms, or when not seated), says whether to send `muck: on` now and what is sent after.
 * Once per connection until the room says it is on: a command sent while the connection was down is not kept.
 */
export function legacyMuckStep(sent: boolean, open: boolean, room: boolean | null | undefined): { send: boolean; sent: boolean } {
  if (!open || room === true) return { send: false, sent: false };
  if (room !== false || sent) return { send: false, sent };
  return { send: true, sent: true };
}

/**
 * The single-card commands for a show choice, which every room understands (one from before "both" refuses the word):
 * the chosen cards not already shown or on their way, first card first.
 */
export function cardsToShow(choice: 0 | 1 | 'both', pending: readonly number[], shown: (i: number) => boolean): (0 | 1)[] {
  return (choice === 'both' ? ([0, 1] as const) : [choice]).filter((i) => !pending.includes(i) && !shown(i));
}
