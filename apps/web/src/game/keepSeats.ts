import type { TableView } from '@jc/types';

/**
 * The table the server sent, with each seat that reads as it did in the table shown before kept as that same object.
 * A seat is drawn again only when its props change (Seat), and every message from the server is parsed into new
 * objects: at a street most seats are as they were (folded, or out of chips), yet all of them were drawn again
 * (TEST_REPORT). Only what is the same is kept; nothing the server sent is changed.
 */
export function keepSeats(prev: TableView | null, next: TableView): TableView {
  if (!prev || prev.table.id !== next.table.id) return next;
  const before = new Map(prev.seats.map((x) => [x.seatIndex, x]));
  let kept = 0;
  const seats = next.seats.map((x) => {
    const was = before.get(x.seatIndex);
    if (!was || JSON.stringify(was) !== JSON.stringify(x)) return x;
    kept++;
    return was;
  });
  return kept ? { ...next, seats } : next;
}
