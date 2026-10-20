/**
 * Position names at a hold'em table (BTN, SB, BB, UTG … CO), shared by the lessons and the hand replays. Kept apart from
 * the lessons' data so a replay doesn't load their content.
 */

/**
 * Position names in seat order starting at the button and going clockwise.
 * Middle seats are named from the button backwards: CO, HJ, LJ, MP, UTG+1, and
 * the first seat after the big blind is UTG.
 */
export function positionNames(players: number): string[] {
  if (players < 2 || players > 9) throw new Error('2-9 players');
  if (players === 2) return ['BTN/SB', 'BB'];
  const middle = players - 3;
  const tail = ['CO', 'HJ', 'LJ', 'MP', 'UTG+1'];
  const names: string[] = [];
  for (let k = 0; k < middle; k++) names.push(k === 0 ? 'UTG' : tail[middle - 1 - k]!);
  return ['BTN', 'SB', 'BB', ...names];
}

/**
 * Each dealt seat's position in a recorded hand, from its button and the seats that posted the blinds: the seats from
 * the button clockwise (the engine deals the seats above it first, then from the lowest up to it). Empty where the
 * record doesn't say it plainly — no button stored, or blinds posted where the order doesn't put them (a missed blind,
 * a dead button) — rather than a position guessed.
 */
export function seatPositions(
  seats: readonly number[],
  buttonSeat: number | null,
  actions: readonly { seatIndex: number; type: string }[],
): Map<number, string> {
  const none = new Map<number, string>();
  const n = seats.length;
  if (buttonSeat === null || n < 2 || n > 9 || !seats.includes(buttonSeat)) return none;
  const sorted = [...new Set(seats)].sort((a, b) => a - b);
  if (sorted.length !== n) return none;
  const order = [...sorted.filter((s) => s > buttonSeat), ...sorted.filter((s) => s <= buttonSeat)];
  // The button last in `order`; positionNames starts at the button.
  const fromButton = [order.at(-1)!, ...order.slice(0, -1)];
  const sb = actions.find((a) => a.type === 'post-sb')?.seatIndex;
  const bb = actions.find((a) => a.type === 'post-bb')?.seatIndex;
  const [wantSb, wantBb] = n === 2 ? [fromButton[0], fromButton[1]] : [fromButton[1], fromButton[2]];
  if (sb !== wantSb || bb !== wantBb) return none;
  const names = positionNames(n);
  return new Map(fromButton.map((s, k) => [s, names[k]!]));
}
