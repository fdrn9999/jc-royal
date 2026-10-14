/**
 * Seat geometry. Inspired by Elite-Poker's usePlayerPositions (seats on an
 * ellipse around the felt, own seat fixed at the bottom), but expressed in
 * percentages of the table box so it scales from phones to desktops without
 * measuring the DOM.
 */
export interface Point {
  x: number;
  y: number;
}

export interface SeatGeometry {
  seat: Point;
  bet: Point;
  /** Where the dealer button puck sits for this seat. */
  button: Point;
}

/**
 * Rotate so `anchorSeat` (the viewer's seat, or 0 for spectators) is at the
 * bottom centre; other seats follow clockwise (to the viewer's left).
 */
export function seatLayout(maxSeats: number, anchorSeat: number, portrait: boolean, edgePct = 8): SeatGeometry[] {
  // Seat ring sits slightly outside the felt ellipse; bets sit inside it.
  const rx = portrait ? 43 : 46;
  const ry = portrait ? 40 : 41;
  const clampX = (x: number) => Math.min(100 - edgePct, Math.max(edgePct, x));
  const out: SeatGeometry[] = [];
  for (let seat = 0; seat < maxSeats; seat++) {
    const k = (seat - anchorSeat + maxSeats) % maxSeats;
    const angle = Math.PI / 2 + (k / maxSeats) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    out.push({
      seat: { x: clampX(50 + rx * cos), y: 50 + ry * sin },
      bet: { x: 50 + rx * 0.58 * cos, y: 50 + ry * 0.56 * sin },
      button: { x: 50 + rx * 0.72 * cos + (portrait ? 6 : 4) * Math.cos(angle + Math.PI / 2), y: 50 + ry * 0.72 * sin + 5 * Math.sin(angle + Math.PI / 2) },
    });
  }
  return out;
}

export const POT_POINT: Point = { x: 50, y: 43 };
